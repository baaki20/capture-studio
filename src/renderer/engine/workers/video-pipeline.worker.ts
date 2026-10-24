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
 */
import { FrameRateMeter } from '../encoder-select';
import { PauseSchedule } from '../pipeline/pause-gate';
import { sessionNowUs } from '../pipeline/clock';
import { KeyframeCadence, shouldDropForBackpressure } from '../pipeline/video-policy';
import type { VideoInit, WorkerResult } from '../protocol';
import { StreamMuxer } from './muxer';
import { describe, PipelineBase, servePipeline } from './pipeline-base';

class VideoPipeline extends PipelineBase<VideoFrame> {
  protected readonly muxer: StreamMuxer;
  private readonly encoder: VideoEncoder;
  private readonly pauses = new PauseSchedule();
  private readonly meter = new FrameRateMeter();
  private readonly cadence: KeyframeCadence;
  private readonly frameDurationUs: number;
  private scaler: OffscreenCanvasRenderingContext2D | null = null;

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
      const fileUs = frame.timestamp - this.firstTimestampUs;
      if (fileUs < 0) {
        this.counters.framesDropped += 1;
        return;
      }
      const input = this.prepare(frame, fileUs);
      try {
        this.encoder.encode(input, { keyFrame: this.cadence.next(fileUs) });
      } finally {
        input.close();
      }
    } catch (error) {
      this.fail(`encode failed: ${describe(error)}`);
    } finally {
      frame.close();
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
      checkpoints: [],
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
