/**
 * Audio pipeline worker (mic, §1.5, §4.3.3):
 * `ReadableStream<AudioData>` → stamp (arrival-calibrated against the chunk's end) → continuity
 * (gaps over 50 ms filled with silence, overlaps dropped) and the pause gate (paused samples
 * replaced by exact-length silence) → `AudioEncoder` (Opus) → fragmented MP4 → stream port.
 *
 * The file is one continuous sample stream: its time is `samplesWritten / sampleRate`. A drift
 * checkpoint `(arrival session µs, cumulative samples)` is kept about once a second: the chunk of
 * that second that arrived earliest relative to its samples (`CheckpointLog`).
 *
 * A second series, from the chunks' capture timestamps instead of their arrival, is kept for
 * offline comparison only (`captureCheckpoints`, written as `media/mic.sync-capture.json`; the
 * drift fit does not use it). It is collected in media time (jump-corrected timestamp of the
 * chunk's end) and mapped to session time with the stamper's final offset when the stream ends.
 *
 * The peak of the recorded samples is also posted as `level` at about 15 Hz for the live meters
 * (R1.6, R1.12); paused spans are silence, so the meter drops to zero while paused.
 */
import { AudioContinuity } from '../../../shared/recording/audio-continuity';
import { CheckpointLog } from '../../../shared/recording/drift';
import { audioEncoderConfig, type AudioEncoderConfigLike } from '../encoder-select';
import { layoutAudioOps, peakOf, sourceChannel, type AudioSegment } from '../pipeline/audio-render';
import { TimestampRebaser } from '../pipeline/timestamp-rebase';
import type { AudioInit, WorkerResult } from '../protocol';
import { StreamMuxer } from './muxer';
import { describe, PipelineBase, post, servePipeline } from './pipeline-base';

const OPUS_FRAME_US = 20_000;
/** Meter updates at about 15 Hz (R1.12 asks for at least 10). */
const LEVEL_INTERVAL_US = 1_000_000 / 15;

class AudioPipeline extends PipelineBase<AudioData> {
  protected readonly muxer: StreamMuxer;
  private readonly encoder: AudioEncoder;
  /** Created with the continuity planner, once the real sample rate is known. */
  private checkpointLog: CheckpointLog | null = null;
  /** Capture-timestamp checkpoints `(media µs of the chunk's end, cumulative samples)`. */
  private captureLog: CheckpointLog | null = null;
  private config: AudioEncoderConfigLike | null = null;
  private continuity: AudioContinuity | null = null;
  /** Pause and resume calls before the first chunk, replayed into the continuity planner. */
  private readonly pending: { pause: boolean; atUs: number }[] = [];
  private configuring: Promise<void> | null = null;
  private readonly rebaser = new TimestampRebaser();
  /** This chunk's timestamp after jump correction (set by `calibrationReference`). */
  private chunkTimestampUs: number | null = null;
  private levelPeak = 0;
  private lastLevelUs = Number.NEGATIVE_INFINITY;

  constructor(private readonly audio: AudioInit) {
    super(audio);
    this.muxer = new StreamMuxer(this.forwarder, { media: 'audio' });
    this.encoder = new AudioEncoder({
      output: (chunk, meta) => {
        this.counters.framesEncoded += 1;
        this.muxer.add(chunk, meta, OPUS_FRAME_US);
      },
      error: (error) => this.fail(`encoder error: ${describe(error)}`),
    });
  }

  protected setUp(): Promise<void> {
    // The encoder is configured from the first chunk (its real rate and channel count).
    return Promise.resolve();
  }

  protected calibrationReference(data: AudioData, arrivalUs: number): number {
    const rebased = this.rebaser.map(arrivalUs, data.timestamp, data.duration);
    if (rebased.jumped) {
      post({
        type: 'log',
        level: 'warn',
        message: `mic timestamps jumped by ${String(Math.round((rebased.timestampUs - data.timestamp) / 1000))} ms; re-anchored`,
      });
    }
    this.chunkTimestampUs = rebased.timestampUs;
    return rebased.timestampUs + data.duration;
  }

  protected handle(data: AudioData, arrivalUs: number): void {
    try {
      if (this.failure !== null) {
        this.counters.framesDropped += 1;
        return;
      }
      const continuity = this.ensureConfigured(data);
      const sampleRate = continuity.sampleRate;
      const frames = data.numberOfFrames;
      const durationUs = (frames * 1_000_000) / sampleRate;
      const timestampUs = this.chunkTimestampUs ?? data.timestamp;
      const sessionUs = this.stamper.toSession(timestampUs, arrivalUs - durationUs);
      const before = continuity.framesWritten;
      const plan = continuity.plan({ timeUs: timestampUs, frames, sessionUs });
      this.firstTimestampUs ??= continuity.startUs;
      this.counters.discontinuities = continuity.discontinuities;
      if (plan.dropped) this.counters.framesDropped += 1;
      for (const segment of layoutAudioOps(plan.ops, before, sampleRate)) {
        this.encodeSegment(data, segment);
      }
      this.counters.samplesWritten = continuity.framesWritten;
      const checkpoint = this.checkpointLog?.offer(arrivalUs, continuity.framesWritten);
      if (checkpoint) this.counters.addCheckpoint(checkpoint);
      this.captureLog?.offer(timestampUs + durationUs, continuity.framesWritten);
      this.postLevel(arrivalUs);
    } catch (error) {
      this.fail(`encode failed: ${describe(error)}`);
    } finally {
      data.close();
    }
  }

  /** Configures the encoder and the continuity planner from the first chunk. */
  private ensureConfigured(data: AudioData): AudioContinuity {
    if (this.continuity) return this.continuity;
    const config: AudioEncoderConfigLike = {
      ...audioEncoderConfig(this.audio.role, data.numberOfChannels),
      sampleRate: data.sampleRate,
    };
    this.config = config;
    this.encoder.configure(config);
    // Surface an unsupported rate early instead of failing silently later.
    this.configuring = AudioEncoder.isConfigSupported(config).then((support) => {
      if (support.supported !== true) {
        this.fail(
          `Opus at ${String(config.sampleRate)} Hz × ${String(config.numberOfChannels)} is unsupported`,
        );
      }
    });
    const continuity = new AudioContinuity({ sampleRate: data.sampleRate });
    for (const event of this.pending) {
      if (event.pause) continuity.pause(event.atUs);
      else continuity.resume(event.atUs);
    }
    this.pending.length = 0;
    this.continuity = continuity;
    this.checkpointLog = new CheckpointLog(data.sampleRate);
    this.captureLog = new CheckpointLog(data.sampleRate);
    return continuity;
  }

  private encodeSegment(source: AudioData, segment: AudioSegment): void {
    const config = this.config;
    if (!config) return;
    const channels = config.numberOfChannels;
    const planar = new Float32Array(segment.frames * channels);
    if (segment.type === 'copy') {
      const planes: Float32Array[] = [];
      for (let c = 0; c < channels; c += 1) {
        const plane = planar.subarray(c * segment.frames, (c + 1) * segment.frames);
        source.copyTo(plane, {
          planeIndex: sourceChannel(c, source.numberOfChannels),
          frameOffset: segment.fromFrame,
          frameCount: segment.frames,
          format: 'f32-planar',
        });
        planes.push(plane);
      }
      const peak = peakOf(planes);
      this.counters.notePeak(peak);
      if (peak > this.levelPeak) this.levelPeak = peak;
    } else {
      this.counters.silenceSamples += segment.frames;
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: config.sampleRate,
      numberOfFrames: segment.frames,
      numberOfChannels: channels,
      timestamp: segment.timestampUs,
      data: planar,
    });
    try {
      this.encoder.encode(data);
    } finally {
      data.close();
    }
  }

  private postLevel(arrivalUs: number): void {
    if (arrivalUs - this.lastLevelUs < LEVEL_INTERVAL_US) return;
    this.lastLevelUs = arrivalUs;
    post({ type: 'level', streamId: this.audio.streamId, peak: this.levelPeak });
    this.levelPeak = 0;
  }

  protected encodeQueueSize(): number {
    return this.encoder.state === 'closed' ? 0 : this.encoder.encodeQueueSize;
  }

  protected async flushEncoder(): Promise<void> {
    // The last second's checkpoint is held until its interval closes.
    const last = this.checkpointLog?.flush();
    if (last) this.counters.addCheckpoint(last);
    this.captureLog?.flush();
    try {
      await this.configuring;
      if (this.encoder.state === 'configured') await this.encoder.flush();
    } finally {
      if (this.encoder.state !== 'closed') this.encoder.close();
    }
  }

  protected snapshotExtras() {
    return {};
  }

  /** The capture-timestamp series in session time (final stamper offset), or empty. */
  private captureCheckpoints(): [number, number][] {
    const offset = this.stamper.offsetUs;
    if (offset === null || !this.captureLog) return [];
    return this.captureLog.checkpoints.map(([t, n]) => [Math.round(t + offset), n]);
  }

  protected resultDetails(): Pick<
    WorkerResult,
    'encoder' | 'codec' | 'video' | 'audio' | 'checkpoints' | 'captureCheckpoints'
  > {
    const config = this.config ?? this.audio.config;
    return {
      captureCheckpoints: this.captureCheckpoints(),
      encoder: { name: 'Opus (WebCodecs)', hardware: false },
      codec: 'opus',
      video: null,
      audio: {
        sampleRate: config.sampleRate,
        channels: config.numberOfChannels,
        samplesWritten: this.counters.samplesWritten,
        silenceSamples: this.counters.silenceSamples,
      },
      checkpoints: this.counters.checkpoints.map(([a, b]) => [a, b] as const),
    };
  }

  pause(atUs: number): void {
    if (this.continuity) this.continuity.pause(atUs);
    else this.pending.push({ pause: true, atUs });
  }

  resume(atUs: number): void {
    if (this.continuity) this.continuity.resume(atUs);
    else this.pending.push({ pause: false, atUs });
  }
}

servePipeline<AudioData>((init) => new AudioPipeline(init as AudioInit));
