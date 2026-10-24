/**
 * The capture engine (§1.3, §1.5, §4.3.2, §9.1–9.3): track acquisition, the session clock,
 * encoder selection, one pipeline worker per stream, sync calibration, pause/resume, stats and
 * stop. It runs in the hidden engine window and is driven by main over the `engine.*` commands.
 *
 * Lifecycle:
 * 1. `acquire` opens the screen (the `desktopCapturer` source main picked, §9.1), then the optional
 *    camera and mic, reads their real properties from the first samples, and pre-selects video
 *    encoders (the 1 s warm-up happens here, not at start).
 * 2. Main wires one MessagePort per stream to the media utility (and a clock port) and sends them
 *    on `engine.ports`; `start` waits for the session's ports, measures the engine ↔ utility clock
 *    offset, sets `t0` and starts a worker per stream.
 * 3. Workers post their 2 s warm-up samples; the engine calibrates all tracks together (hybrid
 *    mode) and sends each worker its offset. Stats are relayed at 2 Hz.
 * 4. `stop` stops the workers (flush, finalize, port close), calibrates with every sample, and
 *    returns each stream's result. A `restart` keeps the tracks for the next take.
 *
 * A track that ends (GNOME stop-sharing, unplugged device) is reported once on
 * `engine.trackEnded`; main decides (screen → graceful stop, R1.15; camera/mic → that component
 * ends, R1.16). Its worker finalizes its own file at that point.
 */
import {
  EnginePortsSchema,
  type EngineClock,
  type EngineCommandPayload,
  type EngineCommandResponse,
  type EnginePorts,
  type StreamKind,
} from '../../shared/ipc/contract';
import type { EnginePreloadApi } from '../../shared/ipc/preload-api';
import type { CalibrationSample } from '../../shared/recording/sync-calibrator';
import type { Us } from '../../shared/time';
import {
  audioEncoderConfig,
  selectVideoEncoder,
  type Quality,
  type SelectedVideoEncoder,
  type VideoStreamRole,
} from './encoder-select';
import { resolveCalibration } from './pipeline/calibration';
import { measureClockOffset } from './pipeline/clock-handshake';
import { sessionNowUs } from './pipeline/clock';
import {
  CAMERA_IDEAL,
  CONTENT_HINTS,
  cameraConstraints,
  describeError,
  isCancelError,
  micConstraints,
  screenConstraints,
} from './pipeline/constraints';
import { PauseSchedule } from './pipeline/pause-gate';
import { CachedEncoderProbe } from './pipeline/probe-cache';
import { missingResult, streamResult } from './pipeline/results';
import { STATS_INTERVAL_MS, StatsAggregator } from './pipeline/stats';
import type { EngineToWorker, WorkerInit, WorkerResult, WorkerToEngine } from './protocol';
import { probeAudioTrack, probeVideoTrack, snapshotVideoTrack } from './track-probe';
import { audioChunks, videoFrames } from './track-processor';
import { createWebCodecsProbe } from './webcodecs-probe';

type AcquirePayload = EngineCommandPayload<'engine.acquire'>;
type AcquireResult = EngineCommandResponse<'engine.acquire'>;
type StartPayload = EngineCommandPayload<'engine.start'>;
type StartResult = EngineCommandResponse<'engine.start'>;
type StopResult = EngineCommandResponse<'engine.stop'>;
type SnapshotResult = EngineCommandResponse<'engine.snapshot'>;
type TrackInfo = NonNullable<AcquireResult['screen']>;
type AcquireWarning = NonNullable<AcquireResult['warnings']>[number];

export const PORTS_TIMEOUT_MS = 5_000;
export const RESULT_TIMEOUT_MS = 20_000;
/** Calibrate with whatever arrived if a track never completes its window (it may be silent). */
export const CALIBRATION_FALLBACK_MS = 4_000;

interface VideoTrack {
  kind: 'screen' | 'camera';
  stream: MediaStream;
  track: MediaStreamTrack;
  label: string;
  width: number;
  height: number;
  deliveredFps: number | null;
  /** The rate the encoder and backpressure use (screen: 30/60; camera: 30). */
  fps: number;
  /** Screen: the last frame seen at acquisition, for the region picker (closed on release). */
  still: ImageBitmap | null;
}

interface AudioTrack {
  kind: 'mic';
  stream: MediaStream;
  track: MediaStreamTrack;
  label: string;
  sampleRate: number;
  channels: number;
}

type AcquiredTrack = VideoTrack | AudioTrack;

interface Acquisition {
  tracks: Map<StreamKind, AcquiredTrack>;
  /** Kinds already reported on `engine.trackEnded`. */
  ended: Set<StreamKind>;
  cleanup: (() => void)[];
}

interface DeliveredPorts {
  payload: EnginePorts;
  streams: { streamId: string; kind: StreamKind; port: MessagePort }[];
  clock: MessagePort | null;
}

interface StreamRun {
  streamId: string;
  kind: StreamKind;
  worker: Worker;
  samples: CalibrationSample[] | null;
  result: WorkerResult | null;
  resolveResult: (result: WorkerResult) => void;
  done: Promise<WorkerResult>;
  encoder: { name: string; hardware: boolean };
}

interface Session {
  sessionId: string;
  t0Us: Us;
  runs: Map<string, StreamRun>;
  pauses: PauseSchedule;
  stats: StatsAggregator;
  statsTimer: ReturnType<typeof setInterval>;
  calibrationTimer: ReturnType<typeof setTimeout>;
  calibrated: boolean;
  clockPort: MessagePort | null;
}

export class CaptureEngine {
  private acquisition: Acquisition | null = null;
  private session: Session | null = null;
  private readonly delivered = new Map<string, DeliveredPorts>();
  private readonly portWaiters = new Map<string, (ports: DeliveredPorts) => void>();
  private readonly probe = new CachedEncoderProbe(createWebCodecsProbe());

  constructor(private readonly api: EnginePreloadApi) {}

  // -------------------------------------------------------------------------------------------
  // Acquisition (§4.3.2)

  async acquire(payload: AcquirePayload): Promise<AcquireResult> {
    if (this.session) throw new Error('engine.acquire: a recording is in progress');
    this.release();
    const acquisition: Acquisition = { tracks: new Map(), ended: new Set(), cleanup: [] };
    const warnings: AcquireWarning[] = [];

    let screenStream: MediaStream;
    try {
      screenStream = await navigator.mediaDevices.getUserMedia(
        screenConstraints(payload.screen) as unknown as MediaStreamConstraints,
      );
    } catch (error) {
      if (isCancelError(error)) {
        console.info(`engine: screen acquisition cancelled (${describeError(error)})`);
        return { status: 'cancelled', screen: null, camera: null, mic: null, warnings };
      }
      throw new Error(`screen capture failed: ${describeError(error)}`, { cause: error });
    }
    const screenTrack = firstTrack(screenStream, 'video');
    screenTrack.contentHint = CONTENT_HINTS.screen;
    this.acquisition = acquisition;

    try {
      const [screen, camera, mic] = await Promise.all([
        this.addVideo(acquisition, 'screen', screenStream, screenTrack, payload.screen.fps),
        payload.camera
          ? this.openCamera(acquisition, payload.camera, warnings)
          : Promise.resolve(null),
        payload.mic ? this.openMic(acquisition, payload.mic, warnings) : Promise.resolve(null),
      ]);
      // Pre-select encoders with the real sizes; the warm-up result is cached for `start`.
      const screenEncoder = await this.selectEncoder(screen, 'standard');
      if (!screenEncoder.ok) throw new Error(screenEncoder.message);
      let cameraInfo: TrackInfo | null = camera ? trackInfo(camera) : null;
      if (camera) {
        const cameraEncoder = await this.selectEncoder(camera, 'standard');
        if (!cameraEncoder.ok) {
          warnings.push({ kind: 'camera', message: cameraEncoder.message });
          this.dropTrack(acquisition, 'camera');
          cameraInfo = null;
        }
      }
      return {
        status: 'ready',
        screen: trackInfo(screen),
        camera: cameraInfo,
        mic: mic ? trackInfo(mic) : null,
        warnings,
      };
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private async openCamera(
    acquisition: Acquisition,
    camera: NonNullable<AcquirePayload['camera']>,
    warnings: AcquireWarning[],
  ): Promise<VideoTrack | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(camera));
      const track = firstTrack(stream, 'video');
      track.contentHint = CONTENT_HINTS.camera;
      return await this.addVideo(acquisition, 'camera', stream, track, CAMERA_IDEAL.frameRate);
    } catch (error) {
      warnings.push({ kind: 'camera', message: `camera unavailable: ${describeError(error)}` });
      this.dropTrack(acquisition, 'camera');
      return null;
    }
  }

  private async openMic(
    acquisition: Acquisition,
    mic: NonNullable<AcquirePayload['mic']>,
    warnings: AcquireWarning[],
  ): Promise<AudioTrack | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(micConstraints(mic));
      const track = firstTrack(stream, 'audio');
      track.contentHint = CONTENT_HINTS.mic;
      this.watch(acquisition, 'mic', track);
      const probe = await probeAudioTrack(track);
      const audio: AudioTrack = {
        kind: 'mic',
        stream,
        track,
        label: track.label,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
      };
      acquisition.tracks.set('mic', audio);
      return audio;
    } catch (error) {
      warnings.push({ kind: 'mic', message: `microphone unavailable: ${describeError(error)}` });
      this.dropTrack(acquisition, 'mic');
      return null;
    }
  }

  private async addVideo(
    acquisition: Acquisition,
    kind: 'screen' | 'camera',
    stream: MediaStream,
    track: MediaStreamTrack,
    fps: number,
  ): Promise<VideoTrack> {
    // Registered before probing so a track that ends meanwhile is still released and reported.
    acquisition.tracks.set(kind, {
      kind,
      stream,
      track,
      label: track.label,
      width: 2,
      height: 2,
      deliveredFps: null,
      fps,
      still: null,
    });
    this.watch(acquisition, kind, track);
    const probe = await probeVideoTrack(track, undefined, kind === 'screen');
    const video: VideoTrack = {
      kind,
      stream,
      track,
      label: track.label,
      width: probe.width,
      height: probe.height,
      deliveredFps: probe.deliveredFps,
      fps,
      still: probe.still ?? null,
    };
    acquisition.tracks.set(kind, video);
    return video;
  }

  /** Reports a track's end once per acquisition (R1.15, R1.16). */
  private watch(acquisition: Acquisition, kind: StreamKind, track: MediaStreamTrack): void {
    const onEnded = (): void => {
      if (acquisition.ended.has(kind)) return;
      acquisition.ended.add(kind);
      console.warn(`engine: ${kind} track ended`);
      this.api.sendTrackEnded({ kind, reason: 'ended', atUs: sessionNowUs() });
    };
    track.addEventListener('ended', onEnded);
    acquisition.cleanup.push(() => track.removeEventListener('ended', onEnded));
  }

  private dropTrack(acquisition: Acquisition, kind: StreamKind): void {
    const entry = acquisition.tracks.get(kind);
    if (!entry) return;
    acquisition.tracks.delete(kind);
    acquisition.ended.add(kind);
    for (const track of entry.stream.getTracks()) track.stop();
  }

  private async selectEncoder(
    video: VideoTrack,
    quality: Quality,
  ): Promise<{ ok: true; selected: SelectedVideoEncoder } | { ok: false; message: string }> {
    const role: VideoStreamRole = video.kind;
    const result = await selectVideoEncoder(
      { role, quality, sourceWidth: video.width, sourceHeight: video.height, fps: video.fps },
      this.probe,
    );
    if (result.ok) {
      console.info(
        `engine: ${video.kind} encoder ${result.value.encoder.name} ${result.value.config.codec} ` +
          `${String(result.value.config.width)}x${String(result.value.config.height)}@${String(video.fps)}`,
      );
      return { ok: true, selected: result.value };
    }
    const tried = result.error.attempts.map((a) => `${a.candidate}: ${a.outcome}`).join(', ');
    return { ok: false, message: `no usable ${video.kind} encoder (${tried})` };
  }

  /** Stops every acquired track. */
  release(): void {
    const acquisition = this.acquisition;
    this.acquisition = null;
    if (!acquisition) return;
    for (const fn of acquisition.cleanup) fn();
    for (const entry of acquisition.tracks.values()) {
      if (entry.kind !== 'mic') entry.still?.close();
      for (const track of entry.stream.getTracks()) track.stop();
    }
  }

  /** `engine.snapshot`: the acquired screen's current frame for the region picker (§4.3.7). */
  async snapshot(): Promise<SnapshotResult> {
    const screen = this.acquisition?.tracks.get('screen');
    if (screen?.kind !== 'screen') throw new Error('engine.snapshot: no screen is acquired');
    return snapshotVideoTrack(screen.track, screen.still);
  }

  // -------------------------------------------------------------------------------------------
  // Ports (`engine.ports`, delivered by the preload as a window message)

  receivePorts(payload: unknown, ports: readonly MessagePort[]): void {
    const parsed = EnginePortsSchema.safeParse(payload);
    if (!parsed.success) {
      console.error('engine: malformed engine.ports message');
      for (const port of ports) port.close();
      return;
    }
    const expected = parsed.data.streams.length + (parsed.data.clockPort ? 1 : 0);
    if (ports.length !== expected) {
      console.error(
        `engine: engine.ports expected ${String(expected)} ports, got ${String(ports.length)}`,
      );
      for (const port of ports) port.close();
      return;
    }
    const streams = parsed.data.streams.map((s, i) => {
      const port = ports[i];
      if (!port) throw new Error('engine.ports: missing port'); // length checked above
      return { ...s, port };
    });
    const delivered: DeliveredPorts = {
      payload: parsed.data,
      streams,
      clock: parsed.data.clockPort ? (ports[streams.length] ?? null) : null,
    };
    const previous = this.delivered.get(parsed.data.sessionId);
    if (previous) closePorts(previous);
    const waiter = this.portWaiters.get(parsed.data.sessionId);
    if (waiter) {
      this.portWaiters.delete(parsed.data.sessionId);
      waiter(delivered);
    } else {
      this.delivered.set(parsed.data.sessionId, delivered);
    }
  }

  private waitForPorts(sessionId: string): Promise<DeliveredPorts> {
    const ready = this.delivered.get(sessionId);
    if (ready) {
      this.delivered.delete(sessionId);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.portWaiters.delete(sessionId);
        reject(
          new Error(
            `engine.start: no engine.ports for ${sessionId} within ${String(PORTS_TIMEOUT_MS)} ms`,
          ),
        );
      }, PORTS_TIMEOUT_MS);
      this.portWaiters.set(sessionId, (ports) => {
        clearTimeout(timer);
        resolve(ports);
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Start

  async start(payload: StartPayload): Promise<StartResult> {
    if (this.session) throw new Error('engine.start: already recording');
    const acquisition = this.acquisition;
    const screen = acquisition?.tracks.get('screen');
    if (!acquisition || screen?.kind !== 'screen') {
      throw new Error('engine.start: nothing acquired');
    }
    if (screen.track.readyState === 'ended')
      throw new Error('engine.start: the screen track ended');

    const ports = await this.waitForPorts(payload.sessionId);
    // Match ports to live tracks. A port without a live track is closed (an empty file).
    const plan: { streamId: string; track: AcquiredTrack; port: MessagePort }[] = [];
    for (const s of ports.streams) {
      const track = acquisition.tracks.get(s.kind);
      if (!track || track.track.readyState === 'ended') {
        console.warn(`engine: no live ${s.kind} track for stream ${s.streamId}; closing its port`);
        s.port.postMessage({ type: 'close' });
        s.port.close();
        continue;
      }
      plan.push({ streamId: s.streamId, track, port: s.port });
    }
    if (!plan.some((p) => p.track.kind === 'screen')) {
      for (const p of plan) p.port.close();
      ports.clock?.close();
      throw new Error('engine.start: no stream port for the screen');
    }

    // Encoders for the chosen quality (warm-ups are cached from acquire).
    const encoders = new Map<string, SelectedVideoEncoder>();
    for (const p of plan) {
      if (p.track.kind === 'mic') continue;
      const picked = await this.selectEncoder(p.track, payload.quality);
      if (!picked.ok) {
        if (p.track.kind === 'screen') {
          for (const q of plan) q.port.close();
          ports.clock?.close();
          throw new Error(picked.message);
        }
        console.warn(`engine: ${picked.message}; camera not recorded`);
        p.port.postMessage({ type: 'close' });
        p.port.close();
        continue;
      }
      encoders.set(p.streamId, picked.selected);
    }

    let clock: EngineClock | null = null;
    if (ports.clock) {
      clock = await measureClockOffset(ports.clock, { nowUs: sessionNowUs });
      if (clock) {
        console.info(
          `engine: utility clock offset ${clock.offsetUs.toFixed(0)} µs (rtt ${clock.rttUs.toFixed(0)} µs, ${String(clock.samples)} samples)`,
        );
      } else {
        console.warn('engine: the media utility did not answer the clock handshake');
      }
    }

    const t0Us = sessionNowUs();
    const session: Session = {
      sessionId: payload.sessionId,
      t0Us,
      runs: new Map(),
      pauses: new PauseSchedule(),
      stats: new StatsAggregator(),
      statsTimer: setInterval(() => this.sendStats(), STATS_INTERVAL_MS),
      calibrationTimer: setTimeout(() => this.calibrateLive(true), CALIBRATION_FALLBACK_MS),
      calibrated: false,
      clockPort: ports.clock,
    };
    this.session = session;

    const streams: StartResult['streams'] = [];
    for (const p of plan) {
      if (p.track.kind === 'mic') {
        const config = {
          ...audioEncoderConfig('microphone', p.track.channels),
          sampleRate: p.track.sampleRate,
        };
        const init: WorkerInit = {
          type: 'init',
          media: 'audio',
          streamId: p.streamId,
          kind: 'mic',
          port: p.port,
          t0Us,
          readable: audioChunks(p.track.track),
          role: 'microphone',
          config,
        };
        const encoder = { name: 'Opus (WebCodecs)', hardware: false };
        this.launch(session, init, encoder);
        streams.push({
          kind: 'mic',
          streamId: p.streamId,
          encoder,
          codec: 'opus',
          sampleRate: config.sampleRate,
          channels: config.numberOfChannels,
        });
        continue;
      }
      const selected = encoders.get(p.streamId);
      if (!selected) continue;
      const init: WorkerInit = {
        type: 'init',
        media: 'video',
        streamId: p.streamId,
        kind: p.track.kind,
        port: p.port,
        t0Us,
        readable: videoFrames(p.track.track),
        fps: p.track.fps,
        family: selected.candidate.family,
        config: selected.config,
        encoder: selected.encoder,
        sourceWidth: p.track.width,
        sourceHeight: p.track.height,
      };
      this.launch(session, init, selected.encoder);
      streams.push({
        kind: p.track.kind,
        streamId: p.streamId,
        encoder: selected.encoder,
        codec: selected.config.codec,
        width: selected.config.width,
        height: selected.config.height,
        sourceWidth: p.track.width,
        sourceHeight: p.track.height,
      });
    }
    return { t0Us, streams, clock, ...(clock ? { utilityClockOffsetUs: clock.offsetUs } : {}) };
  }

  private launch(
    session: Session,
    init: WorkerInit,
    encoder: { name: string; hardware: boolean },
  ): void {
    const worker =
      init.media === 'video'
        ? new Worker(new URL('./workers/video-pipeline.worker.ts', import.meta.url), {
            type: 'module',
            name: `cs-${init.kind}`,
          })
        : new Worker(new URL('./workers/audio-pipeline.worker.ts', import.meta.url), {
            type: 'module',
            name: `cs-${init.kind}`,
          });
    let resolveResult: (result: WorkerResult) => void = () => undefined;
    const done = new Promise<WorkerResult>((resolve) => {
      resolveResult = resolve;
    });
    const run: StreamRun = {
      streamId: init.streamId,
      kind: init.kind,
      worker,
      samples: null,
      result: null,
      resolveResult,
      done,
      encoder,
    };
    session.runs.set(init.streamId, run);
    worker.onmessage = (event: MessageEvent<WorkerToEngine>) => {
      this.onWorkerMessage(session, run, event.data);
    };
    worker.onerror = (event) => {
      console.error(`engine: ${init.kind} worker error: ${event.message}`);
    };
    worker.postMessage(init satisfies EngineToWorker, [init.readable, init.port]);
  }

  private onWorkerMessage(session: Session, run: StreamRun, message: WorkerToEngine): void {
    switch (message.type) {
      case 'stats':
        session.stats.update(message.stats);
        return;
      case 'level':
        if (run.kind === 'mic') this.api.sendLevels({ atUs: sessionNowUs(), mic: message.peak });
        return;
      case 'calibration-samples':
        run.samples = message.samples;
        this.calibrateLive(false);
        return;
      case 'failed':
        console.error(`engine: ${run.kind} pipeline failed: ${message.message}`);
        this.reportEnded(run.kind, 'error', message.atUs, message.message);
        return;
      case 'input-ended':
        // Usually reported by the track's `ended` event already; this covers the rest.
        this.reportEnded(run.kind, 'ended', message.atUs);
        return;
      case 'result':
        run.result = message.result;
        session.stats.update(message.result.stats);
        run.resolveResult(message.result);
        return;
      case 'log':
        console[message.level](`engine/${run.kind}: ${message.message}`);
        return;
    }
  }

  private reportEnded(
    kind: StreamKind,
    reason: 'ended' | 'error',
    atUs: Us,
    message?: string,
  ): void {
    const acquisition = this.acquisition;
    if (acquisition?.ended.has(kind)) return;
    acquisition?.ended.add(kind);
    this.api.sendTrackEnded({ kind, reason, atUs, ...(message === undefined ? {} : { message }) });
  }

  /**
   * Calibrates the live tracks once every running track has posted its warm-up samples (or, with
   * `force`, with whatever has arrived) and sends each worker its offset for the pause gate.
   */
  private calibrateLive(force: boolean): void {
    const session = this.session;
    if (!session || session.calibrated) return;
    const runs = [...session.runs.values()];
    const waiting = runs.some((r) => r.samples === null && r.result === null);
    if (waiting && !force) return;
    const tracks = runs
      .filter((r) => r.samples !== null)
      .map((r) => ({ streamId: r.streamId, kind: r.kind, samples: r.samples ?? [] }));
    if (tracks.length === 0) return;
    const resolved = resolveCalibration(tracks);
    if (resolved.error) {
      console.warn(`engine: live calibration failed: ${resolved.error}`);
      return;
    }
    session.calibrated = !waiting;
    for (const run of runs) {
      const sync = resolved.byStream.get(run.streamId);
      if (sync && run.result === null) {
        run.worker.postMessage({
          type: 'calibration',
          offsetUs: sync.offsetUs,
        } satisfies EngineToWorker);
      }
    }
  }

  private sendStats(): void {
    const session = this.session;
    if (!session || session.stats.size === 0) return;
    this.api.sendStats(session.stats.drain(sessionNowUs()));
  }

  // -------------------------------------------------------------------------------------------
  // Pause, resume, stop

  pause(payload: EngineCommandPayload<'engine.pause'>): { atUs: Us } {
    const session = this.requireSession('engine.pause');
    const atUs = payload.atUs ?? sessionNowUs();
    if (session.pauses.pause(atUs)) this.broadcast(session, { type: 'pause', atUs });
    return { atUs };
  }

  resume(payload: EngineCommandPayload<'engine.resume'>): { atUs: Us } {
    const session = this.requireSession('engine.resume');
    const atUs = payload.atUs ?? sessionNowUs();
    if (session.pauses.resume(atUs)) this.broadcast(session, { type: 'resume', atUs });
    return { atUs };
  }

  async stop(payload: EngineCommandPayload<'engine.stop'>): Promise<StopResult> {
    const session = this.session;
    if (!session) {
      if (payload.reason !== 'restart') this.release();
      return { streams: [] };
    }
    const stoppedAtUs = sessionNowUs();
    session.pauses.resume(stoppedAtUs);
    this.broadcast(session, { type: 'stop', atUs: stoppedAtUs });

    const runs = [...session.runs.values()];
    const results = await Promise.all(runs.map((run) => this.awaitResult(run, stoppedAtUs)));
    clearInterval(session.statsTimer);
    clearTimeout(session.calibrationTimer);
    for (const run of runs) run.worker.terminate();
    session.clockPort?.close();
    this.session = null;

    const resolved = resolveCalibration(
      runs.map((run, i) => ({
        streamId: run.streamId,
        kind: run.kind,
        samples: run.samples ?? results[i]?.samples ?? [],
      })),
    );
    if (resolved.error) console.warn(`engine: calibration failed: ${resolved.error}`);

    const streams = results.map((result) =>
      streamResult(result, resolved.byStream.get(result.streamId) ?? null, session.t0Us),
    );
    if (payload.reason !== 'restart') this.release();
    return {
      streams,
      t0Us: session.t0Us,
      stoppedAtUs,
      pauses: session.pauses.spansUntil(stoppedAtUs),
      ...(resolved.result
        ? {
            calibration: {
              policy: resolved.result.policy,
              clockMode: resolved.result.clockMode,
              sharedOffsetUs:
                resolved.result.sharedOffsetUs === null
                  ? null
                  : Math.round(resolved.result.sharedOffsetUs),
            },
          }
        : {}),
    };
  }

  private async awaitResult(run: StreamRun, stoppedAtUs: Us): Promise<WorkerResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), RESULT_TIMEOUT_MS);
    });
    const result = await Promise.race([run.done, timeout]);
    clearTimeout(timer);
    if (result) return result;
    console.error(
      `engine: ${run.kind} worker gave no result within ${String(RESULT_TIMEOUT_MS)} ms`,
    );
    return missingResult(run.streamId, run.kind, run.encoder, stoppedAtUs);
  }

  private broadcast(session: Session, message: EngineToWorker): void {
    for (const run of session.runs.values()) {
      if (run.result === null) run.worker.postMessage(message);
    }
  }

  private requireSession(channel: string): Session {
    if (!this.session) throw new Error(`${channel}: not recording`);
    return this.session;
  }
}

function firstTrack(stream: MediaStream, kind: 'video' | 'audio'): MediaStreamTrack {
  const track = kind === 'video' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error(`no ${kind} track in the stream`);
  }
  return track;
}

function trackInfo(track: AcquiredTrack): TrackInfo {
  if (track.kind === 'mic') {
    return { label: track.label, sampleRate: track.sampleRate, channels: track.channels };
  }
  return {
    label: track.label,
    width: track.width,
    height: track.height,
    ...(track.deliveredFps !== null && track.deliveredFps > 0
      ? { frameRate: track.deliveredFps }
      : {}),
  };
}

function closePorts(ports: DeliveredPorts): void {
  for (const s of ports.streams) s.port.close();
  ports.clock?.close();
}
