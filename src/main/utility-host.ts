/**
 * Starts and supervises the media utility process (§1.3), and wires MessagePorts so encoded
 * bytes go from the capture engine straight to the utility's stream writers, never through main.
 *
 * - `openStream` creates a `MessageChannelMain`: one end goes to the utility (`stream.open`),
 *   the other is returned for the engine (`EngineLink.sendPorts`).
 * - `attachClock` does the same for the engine ↔ utility clock handshake (§9.5).
 * - `runJob` wraps the job protocol in a promise with progress and cancel.
 * - An unexpected exit fails outstanding jobs and restarts the utility (at most 3 times a minute).
 */
import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from 'electron';
import mediaUtilityPath from '../utility/media/index?modulePath';
import type { StreamKind } from '../shared/ipc/contract';
import {
  estimateClockOffset,
  JOB_RESULT_SCHEMAS,
  MediaUtilityEventSchema,
  type ClockOffset,
  type ClockSample,
  type JobKind,
  type JobResult,
  type JobSpec,
  type MediaUtilityEvent,
  type MediaUtilityRequest,
  type SystemAudioResult,
} from '../shared/ipc/media-utility';
import type { Logger } from '../shared/logger';
import type { FfmpegLocation } from './ffmpeg/locate';

export interface RunJobOptions {
  onProgress?: (fraction: number | null) => void;
  signal?: AbortSignal;
}

export interface MediaUtilityHandle {
  readonly process: UtilityProcess;
  send(request: MediaUtilityRequest, ports?: MessagePortMain[]): void;
  onEvent(listener: (event: MediaUtilityEvent) => void): () => void;
  /** Resolves with the FFmpeg version (or the reason it is unusable) after `init`. */
  ready(): Promise<{ ffmpegVersion: string | null; error: string | null }>;
  runJob<K extends JobKind>(
    job: Extract<JobSpec, { kind: K }>,
    options?: RunJobOptions,
  ): Promise<JobResult<K>>;
  /** Opens `<dir>/<kind>.rec.mp4` in the utility; returns the port the engine's muxer writes to. */
  openStream(streamId: string, kind: StreamKind, dir: string): MessagePortMain;
  /** Force-closes a stream (abort, engine crash). */
  closeStream(streamId: string): void;
  /** Returns a port that answers `clock.ping` with the utility's clock (for the engine). */
  attachClock(): MessagePortMain;
  /** Measures the utility clock against main's (same formula) with a few pings. */
  measureClockOffset(pings?: number): Promise<ClockOffset | null>;
  startSystemAudio(captureId: string, dir: string): void;
  pauseSystemAudio(captureId: string, atUs?: number): void;
  resumeSystemAudio(captureId: string, atUs?: number): void;
  stopSystemAudio(captureId: string): Promise<SystemAudioResult>;
  /** Starts or stops the setup panel's system-audio meter (`system.level` with a null id). */
  monitorSystemAudio(enabled: boolean): void;
  /** Stops the utility for good (app quit). */
  stop(): void;
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

function nowUs(): number {
  return (performance.timeOrigin + performance.now()) * 1000;
}

export function startMediaUtility(
  ffmpeg: FfmpegLocation | null,
  logger: Logger,
): MediaUtilityHandle {
  const listeners = new Set<(event: MediaUtilityEvent) => void>();
  const restarts: number[] = [];
  let child: UtilityProcess;
  let stopping = false;
  let nextId = 1;
  let readyState: Promise<{ ffmpegVersion: string | null; error: string | null }>;

  const emit = (event: MediaUtilityEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        logger.error('media utility: listener failed', error);
      }
    }
  };

  const spawn = (): void => {
    child = utilityProcess.fork(mediaUtilityPath, [], {
      serviceName: 'Capture Studio Media',
      stdio: 'inherit',
    });
    readyState = new Promise((resolve) => {
      const off = handle.onEvent((event) => {
        if (event.type !== 'ready') return;
        off();
        resolve({ ffmpegVersion: event.ffmpegVersion, error: event.error });
      });
      if (!ffmpeg) resolve({ ffmpegVersion: null, error: 'FFmpeg was not found' });
    });

    child.on('message', (message: unknown) => {
      const parsed = MediaUtilityEventSchema.safeParse(message);
      if (!parsed.success) {
        logger.warn('media utility: rejected malformed message', parsed.error.issues);
        return;
      }
      emit(parsed.data);
    });
    child.once('spawn', () => {
      if (ffmpeg)
        child.postMessage({ type: 'init', ffmpegPath: ffmpeg.ffmpeg, ffprobePath: ffmpeg.ffprobe });
    });
    child.on('exit', (code) => {
      logger.info(`media utility exited with code ${String(code)}`);
      if (stopping) return;
      const now = Date.now();
      while (restarts.length && now - (restarts[0] ?? 0) > RESTART_WINDOW_MS) restarts.shift();
      // Outstanding promises listen for this pseudo-event to fail fast.
      emit({
        type: 'job.error',
        jobId: '*',
        message: `media utility exited (${String(code)})`,
        cancelled: false,
      });
      if (restarts.length >= MAX_RESTARTS) {
        logger.error('media utility: crashed too often, not restarting');
        return;
      }
      restarts.push(now);
      spawn();
    });
  };

  const handle: MediaUtilityHandle = {
    get process() {
      return child;
    },
    send: (request, ports) => child.postMessage(request, ports),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready: () => readyState,

    runJob<K extends JobKind>(job: Extract<JobSpec, { kind: K }>, options: RunJobOptions = {}) {
      const jobId = `job-${String(nextId++)}`;
      return new Promise<JobResult<K>>((resolve, reject) => {
        const onAbort = (): void => handle.send({ type: 'job.cancel', jobId });
        const off = handle.onEvent((event) => {
          if (event.type === 'job.progress' && event.jobId === jobId) {
            options.onProgress?.(event.fraction);
            return;
          }
          if (event.type === 'job.done' && event.jobId === jobId) {
            cleanup();
            const parsed = JOB_RESULT_SCHEMAS[job.kind].safeParse(event.result);
            if (parsed.success) resolve(parsed.data as JobResult<K>);
            else reject(new Error(`${job.kind}: off-contract result`));
            return;
          }
          if (event.type === 'job.error' && (event.jobId === jobId || event.jobId === '*')) {
            cleanup();
            reject(Object.assign(new Error(event.message), { cancelled: event.cancelled }));
          }
        });
        const cleanup = (): void => {
          off();
          options.signal?.removeEventListener('abort', onAbort);
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        handle.send({ type: 'job', jobId, job });
      });
    },

    openStream(streamId, kind, dir) {
      const { port1, port2 } = new MessageChannelMain();
      handle.send({ type: 'stream.open', streamId, kind, dir }, [port1]);
      return port2;
    },
    closeStream: (streamId) => handle.send({ type: 'stream.close', streamId }),
    attachClock() {
      const { port1, port2 } = new MessageChannelMain();
      handle.send({ type: 'clock.attach' }, [port1]);
      return port2;
    },

    async measureClockOffset(pings = 5) {
      const samples: ClockSample[] = [];
      for (let i = 0; i < pings; i += 1) {
        const id = nextId++;
        const sample = await new Promise<ClockSample | null>((resolve) => {
          const timer = setTimeout(() => {
            off();
            resolve(null);
          }, 1000);
          const off = handle.onEvent((event) => {
            if (event.type !== 'clock.pong' || event.id !== id) return;
            clearTimeout(timer);
            off();
            resolve({ sentUs: event.sentUs, remoteUs: event.utilityUs, receivedUs: nowUs() });
          });
          handle.send({ type: 'clock.ping', id, sentUs: nowUs() });
        });
        if (sample) samples.push(sample);
      }
      return estimateClockOffset(samples);
    },

    startSystemAudio: (captureId, dir) => handle.send({ type: 'system.start', captureId, dir }),
    pauseSystemAudio: (captureId, atUs) =>
      handle.send({ type: 'system.pause', captureId, ...(atUs === undefined ? {} : { atUs }) }),
    resumeSystemAudio: (captureId, atUs) =>
      handle.send({ type: 'system.resume', captureId, ...(atUs === undefined ? {} : { atUs }) }),
    stopSystemAudio(captureId) {
      return new Promise<SystemAudioResult>((resolve, reject) => {
        const off = handle.onEvent((event) => {
          if (event.type === 'system.stopped' && event.captureId === captureId) {
            off();
            resolve(event.result);
          } else if (event.type === 'job.error' && event.jobId === '*') {
            off();
            reject(new Error(event.message));
          }
        });
        handle.send({ type: 'system.stop', captureId });
      });
    },

    monitorSystemAudio: (enabled) => handle.send({ type: 'system.monitor', enabled }),

    stop() {
      stopping = true;
      child.kill();
    },
  };

  handle.onEvent((event) => {
    if (event.type === 'ready') {
      if (event.error) logger.error(`media utility: FFmpeg unavailable: ${event.error}`);
      else
        logger.info(
          `media utility ready (pid ${String(child.pid)}), FFmpeg ${event.ffmpegVersion ?? '?'}`,
        );
    } else if (event.type === 'stream.error' || event.type === 'system.error') {
      logger.warn(`media utility: ${event.type}: ${event.message}`);
    }
  });

  spawn();
  return handle;
}
