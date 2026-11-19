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
 * `REPEAT_AFTER_US`, the last frame is encoded again to keep fragments closing (R1.21). The
 * Uneven sources also make fragments run long, so screen keyframes fall due early and
 * the last frame is repeated as soon as a repeat would reach that time: fragments stay within the
 * 1 s interval (R1.13, `stillRepeatAt`). The
 * screen pipeline draws each frame into its own canvas for that: holding the captured frame
 * itself would keep a capture buffer from the source's small pool and starve it (seen on the
 * camera: 28 → 12 fps). The camera never goes still, so it keeps nothing.
 */
import { CheckpointLog, VIDEO_SYNC_RATE } from '../../../shared/recording/drift';
import { clampCrop, letterboxRect } from '../../../shared/recording/region';
import { FrameRateMeter } from '../encoder-select';
import { PauseSchedule } from '../pipeline/pause-gate';
import { sessionNowUs } from '../pipeline/clock';
import {
  KEYFRAME_INTERVAL_US,
  KeyframeCadence,
  shouldDropForBackpressure,
  stillRepeatAt,
} from '../pipeline/video-policy';
import type { VideoInit, WorkerResult } from '../protocol';
import { StreamMuxer } from './muxer';
import { describe, PipelineBase, servePipeline } from './pipeline-base';

/** Repeat the last frame once nothing has arrived for this long. */
const REPEAT_AFTER_US = 600_000;
/** Repeats stay this far behind the clock, so the next real frame still sorts after them. */
const REPEAT_LAG_US = 100_000;
const REPEAT_CHECK_MS = 100;
/** A repeat made as a due keyframe stays only this far behind (R1.13). */
const KEY_REPEAT_LAG_US = 30_000;
/** Screen keyframes fall due this much early: the check period, the key lag and timer lateness. */
const SCREEN_KEY_EARLY_US = 200_000;

class VideoPipeline extends PipelineBase<VideoFrame> {
  protected readonly muxer: StreamMuxer;
  private readonly encoder: VideoEncoder;
  private readonly pauses = new PauseSchedule();
  private readonly meter = new FrameRateMeter();
  private readonly checkpointLog = new CheckpointLog(VIDEO_SYNC_RATE);
  private readonly cadence: KeyframeCadence;
  private readonly frameDurationUs: number;
  private scaler: OffscreenCanvasRenderingContext2D | null = null;
  /** File time and arrival of the latest screen frame, whose image is in `still`. */
  private last: { fileUs: number; arrivalUs: number } | null = null;
  /** A copy of the latest screen frame at the encoder size, for repeats. */
  private still: OffscreenCanvasRenderingContext2D | null = null;
  private lastFileUs = -1;
  private repeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly video: VideoInit) {
    super(video, video.fps);
    this.frameDurationUs = Math.round(1_000_000 / video.fps);
    // Screen keyframes fall due early for the repeat timer (the camera never goes still).
    this.cadence = new KeyframeCadence(
      this.frameDurationUs,
      KEYFRAME_INTERVAL_US,
      video.kind === 'screen' ? SCREEN_KEY_EARLY_US : 0,
    );
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
    if (this.video.kind === 'screen')
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
      const sessionUs =
        this.stamper.toSession(frame.timestamp, arrivalUs) - this.video.captureLatencyUs;
      if (this.pauses.isPaused(sessionUs)) {
        this.counters.framesPaused += 1;
        // Not encoded, but a still screen after the resume repeats what is on it now.
        if (this.firstTimestampUs !== null)
          this.keep(frame, frame.timestamp - this.firstTimestampUs, arrivalUs);
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
        this.keep(frame, fileUs, arrivalUs);
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

  /** Copies a screen frame for repeats (the caller still owns and closes `frame`). */
  private keep(frame: VideoFrame, fileUs: number, arrivalUs: number): void {
    if (this.video.kind !== 'screen') return;
    const { width, height } = this.video.config;
    if (!this.still) {
      this.still = new OffscreenCanvas(width, height).getContext('2d');
      if (!this.still) return;
    }
    this.draw(this.still, frame);
    this.last = { fileUs, arrivalUs };
  }

  /**
   * Draws `frame` into a canvas of the encoder size: the crop (crop at record time) or the whole
   * frame, scaled to fit and centred. A window resized mid-recording keeps its aspect ratio
   * inside black bars instead of being stretched (P2, acceptance f).
   */
  private draw(context: OffscreenCanvasRenderingContext2D, frame: VideoFrame): void {
    const { width, height } = this.video.config;
    const size = { width: frame.displayWidth, height: frame.displayHeight };
    const source = (this.video.crop && clampCrop(this.video.crop, size)) ?? {
      x: 0,
      y: 0,
      ...size,
    };
    const target = letterboxRect(source, { width, height });
    if (target.width !== width || target.height !== height) {
      context.fillStyle = '#000';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(
      frame,
      source.x,
      source.y,
      source.width,
      source.height,
      target.x,
      target.y,
      target.width,
      target.height,
    );
  }

  /**
   * Encodes the last frame again when the source has been still for `REPEAT_AFTER_US`, or as
   * soon as the repeat reaches the keyframe due time (`stillRepeatAt`).
   */
  private repeatLast(): void {
    const last = this.last;
    const still = this.still;
    if (!last || !still || this.failure !== null || this.encoder.state !== 'configured') return;
    const nowUs = sessionNowUs();
    // The repeat lands `REPEAT_LAG_US` back, which must not fall inside a pause either.
    const pausedAt = (us: number) => this.pauses.isPaused(us);
    if (pausedAt(nowUs) || pausedAt(nowUs - REPEAT_LAG_US)) return;
    const fileUs = stillRepeatAt({
      lastFileUs: last.fileUs,
      stillForUs: nowUs - last.arrivalUs,
      dueAtUs: this.cadence.dueAtUs(),
      lastEncodedUs: this.lastFileUs,
      lagUs: REPEAT_LAG_US,
      keyLagUs: KEY_REPEAT_LAG_US,
      repeatAfterUs: REPEAT_AFTER_US,
    });
    if (fileUs === null) return;
    if (shouldDropForBackpressure(this.encoder.encodeQueueSize, this.video.fps)) return;
    let repeat: VideoFrame | null = null;
    try {
      repeat = new VideoFrame(still.canvas, { timestamp: fileUs, duration: this.frameDurationUs });
      this.encode(repeat, fileUs);
      // As if a frame had arrived now at the clock's file time.
      last.fileUs = last.fileUs + (nowUs - last.arrivalUs);
      last.arrivalUs = nowUs;
    } catch (error) {
      this.fail(`repeat failed: ${describe(error)}`);
    } finally {
      repeat?.close();
    }
  }

  /**
   * A frame at file time `fileUs`, drawn at the encoder size when the source differs (scaled,
   * cropped, or letterboxed after a window resize).
   */
  private prepare(frame: VideoFrame, fileUs: number): VideoFrame {
    const { width, height } = this.video.config;
    const init = { timestamp: fileUs, duration: frame.duration ?? this.frameDurationUs };
    if (!this.video.crop && frame.displayWidth === width && frame.displayHeight === height) {
      return new VideoFrame(frame, init);
    }
    if (!this.scaler) {
      this.scaler = new OffscreenCanvas(width, height).getContext('2d');
      if (!this.scaler) throw new Error('no 2D context for scaling');
    }
    this.draw(this.scaler, frame);
    return new VideoFrame(this.scaler.canvas, init);
  }

  protected encodeQueueSize(): number {
    return this.encoder.state === 'closed' ? 0 : this.encoder.encodeQueueSize;
  }

  protected async flushEncoder(): Promise<void> {
    // The last second's checkpoint is held until its interval closes.
    if (this.repeatTimer) clearInterval(this.repeatTimer);
    this.repeatTimer = null;
    this.last = null;
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
