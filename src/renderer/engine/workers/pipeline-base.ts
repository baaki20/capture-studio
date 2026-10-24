/**
 * What the video and audio pipeline workers share (§4.3.3): the read loop over the transferred
 * `ReadableStream`, stop and failure handling, the 2 Hz stats timer, calibration warm-up samples,
 * and the finish sequence (flush encoder → finalize muxer → close the port → post `result`).
 *
 * Every `VideoFrame`/`AudioData` read from the stream is handed to `handle`, which must close it
 * exactly once (it does so in a `finally`).
 */
import type { EngineStreamResult, EngineStreamStats } from '../../../shared/ipc/contract';
import type { StreamStats } from '../../../shared/ipc/media-utility';
import {
  CalibrationWindow,
  type CalibrationSample,
} from '../../../shared/recording/sync-calibrator';
import type { Us } from '../../../shared/time';
import { sessionNowUs } from '../pipeline/clock';
import { PortWriteForwarder } from '../pipeline/port-sink';
import { SessionStamper } from '../pipeline/stamp';
import { STATS_INTERVAL_MS, StreamCounters, type StreamState } from '../pipeline/stats';
import type { EngineToWorker, WorkerInit, WorkerResult, WorkerToEngine } from '../protocol';
import type { StreamMuxer } from './muxer';

interface WorkerScope {
  postMessage(message: WorkerToEngine): void;
  onmessage: ((event: MessageEvent<EngineToWorker>) => void) | null;
}

export const scope = self as unknown as WorkerScope;

export function post(message: WorkerToEngine): void {
  scope.postMessage(message);
}

export function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type StopCause = 'stop' | 'ended' | 'failed';

export abstract class PipelineBase<T extends VideoFrame | AudioData> {
  protected readonly counters: StreamCounters;
  protected readonly stamper = new SessionStamper();
  protected readonly forwarder: PortWriteForwarder;
  protected abstract readonly muxer: StreamMuxer;
  protected firstTimestampUs: Us | null = null;
  protected failure: string | null = null;

  private readonly window = new CalibrationWindow();
  private samplesPosted = false;
  private reader: ReadableStreamDefaultReader<T> | null = null;
  private cause: StopCause | null = null;
  private endedAtUs: Us | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private finishing: Promise<void> | null = null;

  constructor(
    protected readonly init: WorkerInit,
    requestedFps?: number,
  ) {
    this.counters = new StreamCounters({
      kind: init.kind,
      streamId: init.streamId,
      ...(requestedFps === undefined ? {} : { requestedFps }),
    });
    this.forwarder = new PortWriteForwarder(init.port, (message) =>
      post({ type: 'log', level: 'warn', message: `${init.kind}: writer: ${message}` }),
    );
  }

  /** Configures the encoder (may be deferred to the first sample). */
  protected abstract setUp(): Promise<void>;
  /** Processes one sample and closes it exactly once. */
  protected abstract handle(sample: T, arrivalUs: Us): void;
  protected abstract encodeQueueSize(): number;
  /** Flushes and closes the encoder. */
  protected abstract flushEncoder(): Promise<void>;
  protected abstract snapshotExtras(): { deliveredFps?: number | null; activeUs?: Us };
  protected abstract resultDetails(): Pick<
    WorkerResult,
    'encoder' | 'codec' | 'video' | 'audio' | 'checkpoints'
  >;
  abstract pause(atUs: Us): void;
  abstract resume(atUs: Us): void;

  async run(readable: ReadableStream<T>): Promise<void> {
    this.reader = readable.getReader();
    this.statsTimer = setInterval(() => this.postStats(), STATS_INTERVAL_MS);
    try {
      await this.muxer.start();
      await this.setUp();
    } catch (error) {
      this.fail(`set-up failed: ${describe(error)}`);
    }
    while (!this.isStopped()) {
      let next: ReadableStreamReadResult<T>;
      try {
        next = await this.reader.read();
      } catch (error) {
        if (!this.isStopped()) this.fail(`read failed: ${describe(error)}`);
        break;
      }
      if (next.done) break;
      const arrivalUs = sessionNowUs();
      if (this.isStopped()) {
        next.value.close();
        break;
      }
      this.counters.framesIn += 1;
      this.collect(next.value, arrivalUs);
      this.handle(next.value, arrivalUs);
      if (this.muxer.error !== null) this.fail(`muxer failed: ${describe(this.muxer.error)}`);
    }
    if (this.cause === null) {
      this.cause = 'ended';
      this.endedAtUs = sessionNowUs();
      post({ type: 'input-ended', streamId: this.init.streamId, atUs: this.endedAtUs });
    }
    await this.finish();
  }

  /** True once stop, failure or the end of input was decided. */
  private isStopped(): boolean {
    return this.cause !== null;
  }

  /** The calibrated offset from the engine (replaces the provisional one). */
  calibrate(offsetUs: Us): void {
    this.stamper.calibrate(offsetUs);
  }

  /** Stops taking input; `run` then finishes and posts the result. */
  stop(atUs: Us): void {
    if (this.cause !== null) return;
    this.cause = 'stop';
    this.endedAtUs = atUs;
    void this.reader?.cancel().catch(() => undefined);
  }

  protected fail(message: string): void {
    if (this.failure !== null) return;
    this.failure = message;
    const atUs = sessionNowUs();
    post({ type: 'failed', streamId: this.init.streamId, message, atUs });
    if (this.cause === null) {
      this.cause = 'failed';
      this.endedAtUs = atUs;
      void this.reader?.cancel().catch(() => undefined);
    }
  }

  /**
   * Called once per sample before `handle`: returns the value arrival is measured against (the
   * frame timestamp, or an audio chunk's end after jump correction).
   */
  protected abstract calibrationReference(sample: T, arrivalUs: Us): Us;

  private collect(sample: T, arrivalUs: Us): void {
    const referenceUs = this.calibrationReference(sample, arrivalUs);
    this.stamper.observe(arrivalUs, referenceUs);
    if (this.samplesPosted) return;
    this.window.add({ arrivalUs, timestampUs: referenceUs });
    if (this.window.isComplete(arrivalUs)) this.postSamples();
  }

  private postSamples(): void {
    if (this.samplesPosted) return;
    this.samplesPosted = true;
    post({
      type: 'calibration-samples',
      streamId: this.init.streamId,
      samples: [...this.window.samples],
    });
  }

  private state(): StreamState {
    if (this.failure !== null) return 'failed';
    if (this.cause !== null) return 'finished';
    return this.counters.framesIn > 0 ? 'recording' : 'starting';
  }

  private snapshot(): EngineStreamStats {
    this.counters.bytes = this.forwarder.bytes;
    return this.counters.snapshot({
      state: this.state(),
      queueDepth: this.encodeQueueSize(),
      ...this.snapshotExtras(),
    });
  }

  private postStats(): void {
    post({ type: 'stats', stats: this.snapshot() });
  }

  private finish(): Promise<void> {
    this.finishing ??= this.doFinish();
    return this.finishing;
  }

  private async doFinish(): Promise<void> {
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    try {
      await this.flushEncoder();
    } catch (error) {
      this.failure ??= `encoder flush failed: ${describe(error)}`;
    }
    try {
      await this.muxer.finalize();
    } catch (error) {
      this.failure ??= `muxer finalize failed: ${describe(error)}`;
      await this.muxer.cancel().catch(() => undefined);
    }
    let writer: StreamStats | null = null;
    try {
      writer = await this.forwarder.close();
    } catch (error) {
      this.failure ??= `closing the stream port failed: ${describe(error)}`;
    }
    const samples: CalibrationSample[] = this.samplesPosted ? [] : [...this.window.samples];
    const status: EngineStreamResult['status'] =
      this.failure !== null
        ? 'failed'
        : this.counters.framesEncoded === 0
          ? 'empty'
          : this.cause === 'ended'
            ? 'ended-early'
            : 'ok';
    const final = this.snapshot();
    post({
      type: 'result',
      result: {
        streamId: this.init.streamId,
        kind: this.init.kind,
        status,
        endedEarly: this.cause === 'ended',
        endedAtUs: this.endedAtUs,
        error: this.failure ?? this.forwarder.error,
        firstTimestampUs: this.firstTimestampUs,
        writer,
        stats: final,
        samples,
        ...this.resultDetails(),
      },
    });
  }
}

/** Wires a worker's message handler to a pipeline created on `init`. */
export function servePipeline<T extends VideoFrame | AudioData>(
  create: (init: WorkerInit) => PipelineBase<T>,
): void {
  let pipeline: PipelineBase<T> | null = null;
  scope.onmessage = (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init': {
        if (pipeline) {
          post({ type: 'log', level: 'error', message: 'pipeline already initialised' });
          return;
        }
        const init = message;
        pipeline = create(init);
        void pipeline
          .run(init.readable as unknown as ReadableStream<T>)
          .catch((error: unknown) =>
            post({ type: 'log', level: 'error', message: `pipeline crashed: ${describe(error)}` }),
          );
        return;
      }
      case 'calibration':
        pipeline?.calibrate(message.offsetUs);
        return;
      case 'pause':
        pipeline?.pause(message.atUs);
        return;
      case 'resume':
        pipeline?.resume(message.atUs);
        return;
      case 'stop':
        pipeline?.stop(message.atUs);
        return;
    }
  };
}
