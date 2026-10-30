/**
 * Video pipeline worker (screen or camera, §4.3.3):
 * `ReadableStream<VideoFrame>` → stamp → pause gate (paused frames are not encoded) →
 * backpressure (drop when the encode queue exceeds 2 × fps) → `VideoEncoder` (keyframe cadence
 * ≤ 1 s) → fragmented MP4 → stream port → media utility.
 *
 * File time is `timestamp − first encoded timestamp`, so the file keeps Chromium's capture
 * timing (VFR); the engine maps it to the session clock with the calibrated offset
 * (`startOffsetUs`). Frames larger than the encoder size (sources above 1440p, §8) are scaled
 * through an `OffscreenCanvas`.
 *
 * A still screen sends no frames on Wayland, and a fragment is only written when the next frame
 * arrives, so a crash during a still stretch would lose it. When nothing has arrived for
 * `REPEAT_AFTER_US`, the last frame is encoded again to keep fragments closing (R1.21).
 */
import { CheckpointLog, VIDEO_SYNC_RATE } from '../../../shared/recording/drift';
import { FrameRateMeter } from '../encoder-select';
import { PauseSchedule } from '../pipeline/pause-gate';
import { sessionNowUs } from '../pipeline/clock';
import { KeyframeCadence, shouldDropForBackpressure } from '../pipeline/video-policy';
import type { VideoInit, WorkerResult } from '../protocol';
import { StreamMuxer } from './muxer';
import { describe, PipelineBase, servePipeline } from './pipeline-base';

/** Repeat the last frame once nothing has arrived for this long. */
const REPEAT_AFTER_US = 600_000;
/** Repeats stay this far behind the clock, so the next real frame still sorts after them. */
const REPEAT_LAG_US = 100_000;
const REPEAT_CHECK_MS = 200;

class VideoPipeline extends PipelineBase<VideoFrame> {
  protected readonly muxer: StreamMuxer;
  private readonly encoder: VideoEncoder;
  private readonly pauses = new PauseSchedule();
  private readonly meter = new FrameRateMeter();
  private readonly checkpointLog = new CheckpointLog(VIDEO_SYNC_RATE);
  private readonly cadence: KeyframeCadence;
  private readonly frameDurationUs: number;
  private scaler: OffscreenCanvasRenderingContext2D | null = null;
  /** The latest source frame (file time and arrival), kept for repeats on a still screen. */
  private last: { frame: VideoFrame; fileUs: number; arrivalUs: number } | null = null;
  private lastFileUs = -1;
  private repeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly video: VideoInit) {
    super(video, video.fps);
    this.frameDurationUs = Math.round(1_000_000 / video.fps);
    this.cadence = new KeyframeCadence(this.frameDurationUs);
    this.muxer = new StreamMuxer(this.forwarder, { media: 'video', family: video.family });
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.counters.framesEncoded += 1;
        if (chunk.type === 'key') this.cadence.observedKey(chunk.timestamp);
        this.muxer.add(chunk, meta, this.frameDurationUs);
      },
      error: (error) => this.fail(`encoder error: ${describe(error)}`),
    });
  }

  protected setUp(): Promise<void> {
    this.encoder.configure(this.video.config);
    this.repeatTimer = setInterval(() => this.repeatLast(), REPEAT_CHECK_MS);
    return Promise.resolve();
  }

  protected calibrationReference(frame: VideoFrame, _arrivalUs: number): number {
    return frame.timestamp;
  }

  protected handle(frame: VideoFrame, arrivalUs: number): void {
    try {
      this.meter.onFrame(frame.timestamp);
      if (this.failure !== null) {
        this.counters.framesDropped += 1;
        return;
      }
      const sessionUs = this.stamper.toSession(frame.timestamp, arrivalUs);
      if (this.pauses.isPaused(sessionUs)) {
        this.counters.framesPaused += 1;
        // Not encoded, but a still screen after the resume repeats what is on it now.
        if (this.firstTimestampUs !== null)
          this.keep(frame.clone(), frame.timestamp - this.firstTimestampUs, arrivalUs);
        return;
      }
      if (
        this.encoder.state !== 'configured' ||
        shouldDropForBackpressure(this.encoder.encodeQueueSize, this.video.fps)
      ) {
        this.counters.framesDropped += 1;
        return;
      }
      this.firstTimestampUs ??= frame.timestamp;
      // After a repeat, a real frame must still come later in the file.
      const fileUs = Math.max(frame.timestamp - this.firstTimestampUs, this.lastFileUs + 1);
      if (frame.timestamp < this.firstTimestampUs) {
        this.counters.framesDropped += 1;
        return;
      }
      // Drift checkpoint: when the frame arrived against its capture timestamp (file time).
      const checkpoint = this.checkpointLog.offer(arrivalUs, Math.round(fileUs));
      if (checkpoint) this.counters.addCheckpoint(checkpoint);
      const input = this.prepare(frame, fileUs);
      try {
        this.encode(input, fileUs);
        this.keep(frame.clone(), fileUs, arrivalUs);
      } finally {
        input.close();
      }
    } catch (error) {
      this.fail(`encode failed: ${describe(error)}`);
    } finally {
      frame.close();
    }
  }

  private encode(input: VideoFrame, fileUs: number): void {
    this.encoder.encode(input, { keyFrame: this.cadence.next(fileUs) });
    this.lastFileUs = fileUs;
  }

  private keep(frame: VideoFrame | null, fileUs = 0, arrivalUs = 0): void {
    this.last?.frame.close();
    this.last = frame ? { frame, fileUs, arrivalUs } : null;
  }

  /** Encodes the last frame again when the source has been still for `REPEAT_AFTER_US`. */
  private repeatLast(): void {
    const last = this.last;
    if (!last || this.failure !== null || this.encoder.state !== 'configured') return;
    const nowUs = sessionNowUs();
    // The repeat lands `REPEAT_LAG_US` back, which must not fall inside a pause either.
    const pausedAt = (us: number) => this.pauses.isPaused(us);
    if (
      nowUs - last.arrivalUs < REPEAT_AFTER_US ||
      pausedAt(nowUs) ||
      pausedAt(nowUs - REPEAT_LAG_US)
    )
      return;
    if (shouldDropForBackpressure(this.encoder.encodeQueueSize, this.video.fps)) return;
    const fileUs = last.fileUs + (nowUs - last.arrivalUs) - REPEAT_LAG_US;
    if (fileUs <= this.lastFileUs) return;
    let repeat: VideoFrame | null = null;
    try {
      repeat = this.prepare(last.frame, fileUs);
      this.encode(repeat, fileUs);
      last.fileUs = fileUs + REPEAT_LAG_US;
      last.arrivalUs = nowUs;
    } catch (error) {
      this.fail(`repeat failed: ${describe(error)}`);
    } finally {
      repeat?.close();
    }
  }

  /** A frame at file time `fileUs`, scaled to the encoder size when the source differs. */
  private prepare(frame: VideoFrame, fileUs: number): VideoFrame {
    const { width, height } = this.video.config;
    const init = { timestamp: fileUs, duration: frame.duration ?? this.frameDurationUs };
    if (frame.displayWidth === width && frame.displayHeight === height) {
      return new VideoFrame(frame, init);
    }
    if (!this.scaler) {
      this.scaler = new OffscreenCanvas(width, height).getContext('2d');
      if (!this.scaler) throw new Error('no 2D context for scaling');
    }
    this.scaler.drawImage(frame, 0, 0, width, height);
    return new VideoFrame(this.scaler.canvas, init);
  }

  protected encodeQueueSize(): number {
    return this.encoder.state === 'closed' ? 0 : this.encoder.encodeQueueSize;
  }

  protected async flushEncoder(): Promise<void> {
    // The last second's checkpoint is held until its interval closes.
    if (this.repeatTimer) clearInterval(this.repeatTimer);
    this.repeatTimer = null;
    this.keep(null);
    const last = this.checkpointLog.flush();
    if (last) this.counters.addCheckpoint(last);
    try {
      if (this.encoder.state === 'configured') await this.encoder.flush();
    } finally {
      if (this.encoder.state !== 'closed') this.encoder.close();
    }
  }

  protected snapshotExtras() {
    return {
      deliveredFps: this.meter.fps,
      activeUs: this.pauses.activeUs(this.video.t0Us, sessionNowUs()),
    };
  }

  protected resultDetails(): Pick<
    WorkerResult,
    'encoder' | 'codec' | 'video' | 'audio' | 'checkpoints'
  > {
    const { config } = this.video;
    return {
      encoder: this.video.encoder,
      codec: config.codec,
      video: {
        width: config.width,
        height: config.height,
        sourceWidth: this.video.sourceWidth,
        sourceHeight: this.video.sourceHeight,
        frameRate: this.video.fps,
        deliveredFps: this.meter.fps,
      },
      audio: null,
      checkpoints: this.counters.checkpoints.map(([a, b]) => [a, b] as const),
    };
  }

  pause(atUs: number): void {
    this.pauses.pause(atUs);
  }

  resume(atUs: number): void {
    this.pauses.resume(atUs);
  }
}

servePipeline<VideoFrame>((init) => new VideoPipeline(init as VideoInit));
