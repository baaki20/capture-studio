/**
 * The recording session manager (§1.5, §4.3.1, §4.3.5; R1.8–R1.20). It owns one session at a time
 * and drives the capture engine, the media utility and the project folder through the state
 * machine in `state-machine.ts`.
 *
 * - **Start** (countdown elapsed): `<projectsDir>/<name>.cstudio/` with `media/`, `cache/` and
 *   `logs/`; `project.json(state:recording)` written atomically; `session.lock` with a heartbeat
 *   every 5 s; one utility stream per acquired track plus the clock port, handed to the engine;
 *   `engine.start`; system audio through `pw-record` in the utility when enabled and capable.
 * - **Clocks:** the engine's session clock has `t0Us` (engine µs). The utility (system audio) runs
 *   on its own clock; `utilityClockOffsetUs` (utility − engine) converts between them. The engine
 *   measures it over the clock port; without that, main's own handshake with the utility is used
 *   (main and engine share the wall-anchored `performance.timeOrigin`).
 * - **Progressive manifest:** `logs/recording.json` holds the recording manifest (streams, pauses,
 *   sync, encoders) and is rewritten on every change and heartbeat, so recovery can rebuild the
 *   project after a crash (§4.3.6).
 * - **Finalize:** `engine.stop` → stop system audio → utility finalize per stream (remux, probe)
 *   → drift fit per audio stream → `projectFromRecording` → `project.json(complete)` → remove the
 *   lock → `library.changed` → open the project. Peaks and thumbnails follow in the background
 *   (`generateCaches`), so finalize time does not grow with them (R1.20); the editor shows them
 *   when they arrive (R1.44).
 * - **Failures:** screen track ended and disk below the stop threshold finalize (R1.15, R1.17);
 *   camera, mic or system ending keeps recording with a notice (R1.16); anything unrecoverable
 *   goes to `failed`, finalizing what it can and marking the project failed with the reason.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  EngineCommandChannel,
  EngineCommandPayload,
  EngineCommandResponse,
  EngineEventPayload,
  EnginePorts,
  EventPayload,
  InvokeResponse,
  RecorderConfig,
  StreamKind,
} from '../../shared/ipc/contract';
import type {
  ClockOffset,
  FinalizedStream,
  JobKind,
  JobResult,
  JobSpec,
  MediaUtilityEvent,
  SystemAudioResult,
} from '../../shared/ipc/media-utility';
import { newId, ulid } from '../../shared/ids';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import { makeFileName, uniqueName } from '../../shared/naming/name-pattern';
import {
  projectFromRecording,
  RECORDING_MANIFEST_VERSION,
  type RecordedStream,
  type RecordingManifest,
} from '../../shared/project/from-recording';
import {
  PROJECT_EXTENSION,
  type Media,
  type NRect,
  type ProjectV1,
  type RecordingInfo,
} from '../../shared/project/schema';
import { VIDEO_SYNC_RATE } from '../../shared/recording/drift';
import type { Settings } from '../../shared/settings/schema';
import type { ActionBus } from '../action-bus';
import type { ProjectStore } from '../projects/project-store';
import { writeFileAtomic } from '../settings/atomic-file';
import type { SettingsPatch } from '../settings/store';
import {
  CACHE_DIR,
  captureSyncFileName,
  expectedStreams,
  fitDrift,
  generateCaches,
  HEARTBEAT_INTERVAL_MS,
  isVideoKind,
  LOGS_DIR,
  MEDIA_DIR,
  parseStreamReports,
  recordedStream,
  removeLock,
  sessionDurationUs,
  shiftCheckpoints,
  syncFileName,
  withState,
  writeLock,
  writeSessionLog,
  type EngineStreamReport,
  type SessionLog,
  type StreamMeta,
} from './assemble';
import { DiskMonitor } from './disk-monitor';
import {
  IllegalTransitionError,
  isCapturing,
  transition,
  type RecordingEvent,
  type RecordingState,
  type StopReason,
} from './state-machine';

export type RecordResult = InvokeResponse<'rec.record'>;

interface StopOutcome {
  reports: EngineStreamReport[];
  system: SystemAudioResult | null;
  engine: EngineCommandResponse<'engine.stop'> | null;
}

const checkpoint = ([t, n]: readonly [number, number]): [number, number] => [
  Math.round(t),
  Math.max(0, Math.round(n)),
];

// ---------------------------------------------------------------------------------------------
// Dependencies

/** The parts of `EngineLink` the manager uses. */
export interface EngineLike {
  command<C extends EngineCommandChannel>(
    channel: C,
    payload: EngineCommandPayload<C>,
    timeoutMs?: number,
  ): Promise<EngineCommandResponse<C>>;
  sendPorts(payload: EnginePorts, ports: readonly unknown[]): void;
}

/** The parts of `MediaUtilityHandle` the manager uses. */
export interface UtilityLike {
  runJob<K extends JobKind>(job: Extract<JobSpec, { kind: K }>): Promise<JobResult<K>>;
  onEvent(listener: (event: MediaUtilityEvent) => void): () => void;
  openStream(streamId: string, kind: StreamKind, dir: string): unknown;
  closeStream(streamId: string): void;
  attachClock(): unknown;
  measureClockOffset(pings?: number): Promise<ClockOffset | null>;
  startSystemAudio(captureId: string, dir: string): void;
  pauseSystemAudio(captureId: string, atUs?: number): void;
  resumeSystemAudio(captureId: string, atUs?: number): void;
  stopSystemAudio(captureId: string): Promise<SystemAudioResult>;
}

/** The screen source main picked (§9.1 path a), or null when the portal was cancelled. */
export interface ScreenSource {
  sourceId: string;
  label?: string;
  /** Upper bounds passed to the engine; Chromium otherwise caps at 1920×1080 (§9.1). */
  maxWidth: number;
  maxHeight: number;
}

/** The region picker's answer: a rect in stream pixels, null for the full frame, or cancelled. */
export type RegionChoice = { rect: NRect | null } | 'cancelled';

export interface SessionEvents {
  state(payload: EventPayload<'rec.state'>): void;
  stats(payload: EventPayload<'rec.stats'>): void;
  notice(payload: EventPayload<'rec.notice'>): void;
  /** Meter levels at about 15 Hz while capturing (R1.12). */
  levels?(payload: EventPayload<'rec.levels'>): void;
  libraryChanged(): void;
  /** A project is ready (complete or recovered): open it per the after-recording setting. */
  projectReady(info: {
    projectId: string;
    root: string;
    name: string;
    afterRecording: Settings['recorder']['afterRecording'];
  }): void;
  /** The project's background peaks and thumbnails are done (R1.44). */
  cachesReady?(info: { projectId: string; root: string }): void;
}

export interface SessionManagerDeps {
  settings: { get(): Settings; patch(patch: SettingsPatch): Promise<Settings> };
  store: ProjectStore;
  utility: UtilityLike;
  /** Resolves with the capture engine (created on demand). */
  engine: () => Promise<EngineLike>;
  selectScreen: () => Promise<ScreenSource | null>;
  /** Region mode (§4.3.7). Without a picker the last matching region (or full frame) is used. */
  pickRegion?: (source: { width: number; height: number }) => Promise<RegionChoice>;
  /**
   * Generates the peaks and thumbnails of a finished project in the background (the shared,
   * low-priority queue in main). Without it, the utility's jobs run one after another.
   */
  generateCaches?: (projectId: string, root: string, media: readonly Media[]) => Promise<void>;
  /** `audio.system` is available. */
  systemAudioAvailable: () => boolean;
  /** Output latency of the default sink in µs (system audio is shifted by it). */
  systemAudioOutputLatencyUs?: () => Promise<number>;
  platform: () => RecordingInfo['platform'];
  appVersion: string;
  events: SessionEvents;
  logger?: Logger;
  /** Disk space probe for the disk monitor (tests). */
  freeBytes?: (dir: string) => Promise<number>;
  now?: () => Date;
  /** Main's monotonic clock in µs (elapsed time). */
  nowUs?: () => number;
  /** Countdown tick (tests shorten it). */
  countdownTickMs?: number;
  heartbeatMs?: number;
  diskIntervalMs?: number;
  /** How long finalize waits for the utility to report each stream closed. */
  streamCloseTimeoutMs?: number;
  engineStopTimeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------
// Session data

interface StreamState {
  kind: StreamKind;
  streamId: string;
  mediaId: string;
  label: string | null;
  encoder: { name: string; hardware: boolean } | null;
  sync: {
    mode: 'shared' | 'arrival-calibrated';
    offsetUs: number;
    clockHandshakeUs: number | null;
    /** System audio: sink output latency added to `startOffsetUs`. */
    outputLatencyUs?: number;
  };
  startOffsetUs: number | null;
  endedEarly: boolean;
  endedAtUs: number | null;
  stats: EngineStreamReport | null;
  closed: boolean;
  /** Audio drift checkpoints received so far (`engine.stats` sends them incrementally). */
  checkpoints: [number, number][];
  nominalRate: number | null;
  /** Checkpoints not yet written to `<kind>.sync.json`. */
  checkpointsDirty: boolean;
}

interface Pause {
  startUs: number;
  endUs: number | null;
}

interface Session {
  sessionId: string;
  config: RecorderConfig;
  engine: EngineLike;
  source: ScreenSource & { widthPx: number; heightPx: number };
  labels: { camera: string | null; mic: string | null };
  hasCamera: boolean;
  hasMic: boolean;
  region: NRect | null;
  // Project folder (set at the first start).
  projectId: string | null;
  name: string | null;
  root: string | null;
  createdAt: string | null;
  // Per start (reset by restart).
  startedAt: string | null;
  t0Us: number | null;
  mainStartUs: number | null;
  utilityOffsetUs: number | null;
  streams: Map<StreamKind, StreamState>;
  pauses: Pause[];
  pausedMainUs: number;
  pauseStartedMainUs: number | null;
  notices: SessionLog['notices'];
  failureReason: string | null;
}

const ABSOLUTE_CLOCK_THRESHOLD_US = 1e12;

function defaultNowUs(): number {
  return (performance.timeOrigin + performance.now()) * 1000;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SessionManager {
  private stateValue: RecordingState = 'idle';
  private config: RecorderConfig | null = null;
  private session: Session | null = null;
  private countdownRemaining: number | null = null;
  private countdownCancel: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private disk: DiskMonitor | null = null;
  /** The in-flight start, awaited by anything that must not overtake it. */
  private starting: Promise<void> | null = null;
  private finishing: Promise<void> | null = null;
  private readonly logger: Logger;
  private readonly offUtility: () => void;
  /** Background cache passes still running (tests wait for them). */
  private readonly cachePasses = new Set<Promise<void>>();
  private noticeCounter = 0;
  private lastFailure: string | null = null;

  constructor(private readonly deps: SessionManagerDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.offUtility = deps.utility.onEvent((event) => this.onUtilityEvent(event));
  }

  get state(): RecordingState {
    return this.stateValue;
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  /** The `rec.state` payload for the current state (windows opened mid-session start from it). */
  status(): EventPayload<'rec.state'> {
    return this.statePayload(null);
  }

  /** Folder of the recording in progress, if any (the library leaves it alone). */
  get activeRoot(): string | null {
    return this.session?.root ?? null;
  }

  /** Resolves when the current finalize (or failure handling) is done. */
  async settled(): Promise<void> {
    await this.starting?.catch(() => undefined);
    await this.finishing;
  }

  /** Resolves when the background peaks and thumbnails of finished projects are done. */
  async cachesSettled(): Promise<void> {
    while (this.cachePasses.size > 0) await Promise.allSettled([...this.cachePasses]);
  }

  dispose(): void {
    this.stopTimers();
    this.offUtility();
  }

  /** Routes recording actions from the CLI, tray and windows (R1.2, R1.3). */
  attach(bus: ActionBus): () => void {
    return bus.on(
      [
        'new-recording',
        'toggle-recording',
        'stop-recording',
        'toggle-pause',
        'pause-recording',
        'resume-recording',
        'abort-recording',
        'restart-recording',
      ],
      (action) => {
        const s = this.stateValue;
        const run = (task: Promise<unknown>) =>
          void task.catch((error: unknown) =>
            this.logger.error(`recording: action ${action.type} failed`, error),
          );
        switch (action.type) {
          case 'new-recording':
            if (this.can({ type: 'configure' })) run(this.configure());
            break;
          case 'toggle-recording':
            if (isCapturing(s)) run(this.stop());
            else if (this.isPreparing()) run(this.cancel());
            else if (this.can({ type: 'configure' })) run(this.record());
            break;
          case 'stop-recording':
            if (isCapturing(s)) run(this.stop());
            else if (this.isPreparing()) run(this.cancel());
            break;
          case 'toggle-pause':
            run(s === 'paused' ? this.resume() : this.pause());
            break;
          case 'pause-recording':
            run(this.pause());
            break;
          case 'resume-recording':
            run(this.resume());
            break;
          case 'abort-recording':
            run(this.abort());
            break;
          case 'restart-recording':
            run(this.restart());
            break;
          default:
            break;
        }
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Commands (rec.*)

  /** `rec.configure`: remembers (and persists) the setup choices; opens the configuring state. */
  async configure(config?: RecorderConfig): Promise<void> {
    if (!this.can({ type: 'configure' })) {
      throw new IllegalTransitionError(this.stateValue, 'configure');
    }
    if (config) {
      this.config = config;
      await this.deps.settings.patch({ recorder: config }).catch((error: unknown) => {
        this.logger.warn('recording: could not persist the setup choices', error);
      });
    } else {
      this.config ??= this.configFromSettings();
    }
    this.fire({ type: 'configure' });
  }

  /** `rec.record`: acquires, picks the region, counts down and starts. */
  async record(): Promise<RecordResult> {
    if (this.stateValue !== 'configuring') {
      if (!this.can({ type: 'configure' })) {
        return { status: 'failed', message: `cannot record while ${this.stateValue}` };
      }
      await this.configure();
    }
    const config = this.config ?? this.configFromSettings();
    this.fire({ type: 'record' });

    let engine: EngineLike;
    let session: Session;
    try {
      engine = await this.deps.engine();
      const source = await this.deps.selectScreen();
      if (!source) return await this.portalCancelled(null);
      if (this.current() !== 'acquiring') return { status: 'cancelled' };

      const acquired = await engine.command(
        'engine.acquire',
        {
          screen: {
            sourceId: source.sourceId,
            maxWidth: source.maxWidth,
            maxHeight: source.maxHeight,
            fps: config.fps,
          },
          camera: config.cameraId ? { deviceId: config.cameraId } : null,
          mic: config.micId
            ? {
                deviceId: config.micId,
                echoCancellation: config.micProcessing.ec,
                noiseSuppression: config.micProcessing.ns,
                autoGainControl: config.micProcessing.agc,
              }
            : null,
        },
        120_000,
      );
      if (acquired.status === 'cancelled' || !acquired.screen) {
        return await this.portalCancelled(engine);
      }
      if (this.current() !== 'acquiring') {
        await this.releaseTracks(engine);
        return { status: 'cancelled' };
      }
      const named = (kind: 'camera' | 'mic') => {
        const label = acquired.warnings?.find((w) => w.kind === kind)?.label;
        return label ? ` (${label})` : '';
      };
      if (config.cameraId && !acquired.camera)
        this.notice(
          'warning',
          `The camera${named('camera')} could not be opened; recording without it.`,
          'camera',
        );
      if (config.micId && !acquired.mic)
        this.notice(
          'warning',
          `The microphone${named('mic')} could not be opened; recording without it.`,
          'mic',
        );

      session = {
        sessionId: newId('session'),
        config,
        engine,
        source: {
          ...source,
          widthPx: acquired.screen.width ?? source.maxWidth,
          heightPx: acquired.screen.height ?? source.maxHeight,
        },
        labels: { camera: acquired.camera?.label ?? null, mic: acquired.mic?.label ?? null },
        hasCamera: acquired.camera !== null,
        hasMic: acquired.mic !== null,
        region: null,
        projectId: null,
        name: null,
        root: null,
        createdAt: null,
        startedAt: null,
        t0Us: null,
        mainStartUs: null,
        utilityOffsetUs: null,
        streams: new Map(),
        pauses: [],
        pausedMainUs: 0,
        pauseStartedMainUs: null,
        notices: [],
        failureReason: null,
      };
      this.session = session;
    } catch (error) {
      this.logger.error('recording: acquisition failed', error);
      await this.failAndSettle(`Could not start capturing: ${message(error)}`);
      return { status: 'failed', message: message(error) };
    }

    const regionMode = config.captureMode === 'region';
    this.fire({ type: 'tracks-ready', region: regionMode });
    if (regionMode) {
      const choice = await this.chooseRegion(session).catch((error: unknown) => {
        this.logger.error('recording: region picker failed', error);
        this.notice('error', `The region picker could not open: ${message(error)}`);
        return 'cancelled' as const;
      });
      if (this.current() !== 'picking-region') return { status: 'cancelled' };
      if (choice === 'cancelled') {
        this.fire({ type: 'cancel' });
        await this.releaseTracks(engine);
        this.session = null;
        return { status: 'cancelled' };
      }
      session.region = choice.rect;
      if (choice.rect) {
        await this.deps.settings
          .patch({
            recorder: {
              lastRegion: {
                sourceWidth: session.source.widthPx,
                sourceHeight: session.source.heightPx,
                rect: choice.rect,
              },
            },
          })
          .catch((error: unknown) =>
            this.logger.warn('recording: could not save the region', error),
          );
      }
      this.fire({ type: 'region-picked' });
    }

    if (!(await this.countdown(config.countdownSec))) return { status: 'cancelled' };
    const started = await this.beginRecording();
    return started ? { status: 'started', sessionId: session.sessionId } : this.failedResult();
  }

  /** Cancels acquisition, the region picker or the countdown (no project remains). */
  async cancel(): Promise<void> {
    if (!this.can({ type: 'cancel' })) return;
    const session = this.session;
    const wasCountdown = this.stateValue === 'countdown';
    this.fire({ type: 'cancel' });
    if (wasCountdown) this.stopCountdown();
    if (session) {
      await this.releaseTracks(session.engine);
      // A restart's countdown already has a folder with discarded media: remove it.
      if (session.root) await this.deleteFolder(session);
    }
    this.session = null;
  }

  async pause(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const session = this.session;
    if (!session || !this.can({ type: 'pause' })) return;
    this.fire({ type: 'pause' });
    session.pauseStartedMainUs = this.mainNowUs();
    const atUs = await session.engine
      .command('engine.pause', {})
      .then((r) => this.toSessionUs(session, r.atUs))
      .catch((error: unknown) => {
        this.logger.warn('recording: engine.pause failed', error);
        return this.mainElapsedWithPausesUs(session);
      });
    session.pauses.push({ startUs: atUs, endUs: null });
    const captureId = this.systemCaptureId(session);
    if (captureId) this.deps.utility.pauseSystemAudio(captureId, this.toUtilityUs(session, atUs));
    this.emitState();
    await this.writeLog(session);
  }

  async resume(): Promise<void> {
    const session = this.session;
    if (!session || !this.can({ type: 'resume' })) return;
    this.fire({ type: 'resume' });
    if (session.pauseStartedMainUs !== null) {
      session.pausedMainUs += this.mainNowUs() - session.pauseStartedMainUs;
      session.pauseStartedMainUs = null;
    }
    const atUs = await session.engine
      .command('engine.resume', {})
      .then((r) => this.toSessionUs(session, r.atUs))
      .catch((error: unknown) => {
        this.logger.warn('recording: engine.resume failed', error);
        return this.mainElapsedWithPausesUs(session);
      });
    const open = session.pauses.findLast((p) => p.endUs === null);
    if (open) open.endUs = Math.max(open.startUs, atUs);
    const captureId = this.systemCaptureId(session);
    if (captureId) this.deps.utility.resumeSystemAudio(captureId, this.toUtilityUs(session, atUs));
    this.emitState();
    await this.writeLog(session);
  }

  /** Stop: finalize into a project (R1.20). */
  async stop(reason: StopReason = 'stop'): Promise<void> {
    await this.starting?.catch(() => undefined);
    if (!this.session || !this.can({ type: 'stop', reason })) return;
    this.fire({ type: 'stop', reason });
    this.finishing = this.finalize(this.session, reason);
    await this.finishing;
  }

  /** Restart: discard the media, keep the folder, count down again with the same setup (R1.18). */
  async restart(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const session = this.session;
    if (!session || !this.can({ type: 'restart' })) return;
    this.fire({ type: 'restart' });
    this.stopTimers();
    await this.stopCapture(session, 'restart');
    // Cancelled or aborted meanwhile: that path already cleaned up.
    if (this.session !== session || this.current() !== 'countdown') return;
    await this.discardMedia(session);
    if (!(await this.countdown(session.config.countdownSec))) return;
    await this.beginRecording();
  }

  /** Abort: everything is deleted; no library entry remains (R1.18). */
  async abort(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const session = this.session;
    if (!this.can({ type: 'abort' })) return;
    const from = this.stateValue;
    this.fire({ type: 'abort' });
    if (from === 'countdown') this.stopCountdown();
    this.stopTimers();
    if (session) {
      if (isCapturing(from)) await this.stopCapture(session, 'abort');
      else await this.releaseTracks(session.engine);
      if (session.root) await this.deleteFolder(session);
    }
    this.session = null;
  }

  /** An unrecoverable error from outside (engine window crashed, utility gone). */
  async reportFatal(reason: string): Promise<void> {
    await this.failAndSettle(reason);
  }

  // -------------------------------------------------------------------------------------------
  // Engine events

  /** `engine.stats` (2 Hz): forwarded as `rec.stats`, and stream facts kept for the manifest. */
  onEngineStats(payload: EngineEventPayload<'engine.stats'>): void {
    const session = this.session;
    if (!session || !isCapturing(this.stateValue)) return;
    const reports = parseStreamReports(payload.streams);
    let changed = false;
    for (const report of reports) {
      const stream = session.streams.get(report.kind);
      if (!stream) continue;
      stream.stats = report;
      changed = this.applyReport(stream, report) || changed;
      if (report.checkpoints && report.checkpoints.length > 0) {
        stream.checkpoints.push(...report.checkpoints.map(checkpoint));
        stream.nominalRate ??=
          report.nominalRate ?? (isVideoKind(stream.kind) ? VIDEO_SYNC_RATE : null);
        stream.checkpointsDirty = true;
      }
    }
    if (changed) void this.writeLog(session);

    const byKind = new Map(reports.map((r) => [r.kind, r]));
    const dropped = (kind: StreamKind): number | null => {
      const r = byKind.get(kind);
      if (!r) return null;
      // The engine's accounting against the delivered rate (§9.3), when it sent one.
      if (r.droppedRatio !== undefined) return Math.min(1, Math.max(0, r.droppedRatio));
      const total = r.framesIn ?? (r.framesEncoded ?? 0) + (r.framesDropped ?? 0);
      return total > 0 ? Math.min(1, (r.framesDropped ?? 0) / total) : 0;
    };
    const level = (kind: StreamKind): number | null => {
      const value = byKind.get(kind)?.level;
      return value === undefined ? null : Math.max(0, value);
    };
    this.deps.events.stats({
      elapsedUs: this.elapsedUs(),
      levels: { mic: session.hasMic ? (level('mic') ?? 0) : null, system: level('system') },
      dropped: {
        screen: dropped('screen') ?? 0,
        camera: session.hasCamera ? (dropped('camera') ?? 0) : null,
      },
      bytesWritten: Math.round(reports.reduce((sum, r) => sum + (r.bytes ?? 0), 0)),
    });
  }

  /** `engine.levels` (about 15 Hz): the mic meter while capturing (R1.12). */
  onEngineLevels(payload: EngineEventPayload<'engine.levels'>): void {
    if (!this.session?.hasMic || !isCapturing(this.stateValue)) return;
    this.deps.events.levels?.({ mic: Math.max(0, payload.mic) });
  }

  /** `engine.trackEnded`: screen → graceful stop (R1.15); others end early (R1.16). */
  onTrackEnded(payload: EngineEventPayload<'engine.trackEnded'>): void {
    const session = this.session;
    if (!session || !isCapturing(this.stateValue)) return;
    if (payload.kind === 'screen') {
      this.notice('info', 'Screen sharing ended; the recording was stopped.', 'screen');
      void this.stop('screen-ended').catch((error: unknown) =>
        this.logger.error('recording: stop after screen end failed', error),
      );
      return;
    }
    const stream = session.streams.get(payload.kind);
    if (!stream || stream.endedEarly) return;
    stream.endedEarly = true;
    stream.endedAtUs = Math.round(this.toSessionUs(session, payload.atUs));
    const device = stream.label ? ` (${stream.label})` : '';
    const what = { screen: 'Screen', camera: 'Camera', mic: 'Microphone', system: 'System audio' }[
      payload.kind
    ];
    this.notice(
      'warning',
      `${what}${device} ${payload.reason === 'error' ? 'failed' : 'disconnected'}; the recording continues without it.`,
      payload.kind,
    );
    void this.writeLog(session);
  }

  // -------------------------------------------------------------------------------------------
  // Internals: transitions and events

  /** The state, read fresh (not narrowed across awaits). */
  private current(): RecordingState {
    return this.stateValue;
  }

  private can(event: RecordingEvent): boolean {
    return transition(this.stateValue, event) !== null;
  }

  private isPreparing(): boolean {
    return ['acquiring', 'picking-region', 'countdown'].includes(this.stateValue);
  }

  private fire(event: RecordingEvent): void {
    const next = transition(this.stateValue, event);
    if (!next) throw new IllegalTransitionError(this.stateValue, event.type);
    this.logger.info(`recording: ${this.stateValue} → ${next.to} (${event.type})`);
    this.stateValue = next.to;
    if (event.type === 'error') {
      this.lastFailure = event.reason;
      if (this.session) this.session.failureReason = event.reason;
    }
    this.emitState(event.type === 'error' ? event.reason : null);
  }

  private emitState(failureReason: string | null = null): void {
    this.deps.events.state(this.statePayload(failureReason));
  }

  private statePayload(failureReason: string | null): EventPayload<'rec.state'> {
    return {
      state: this.stateValue,
      sessionId: this.session?.sessionId ?? null,
      elapsedUs: this.elapsedUs(),
      countdownRemainingSec: this.stateValue === 'countdown' ? this.countdownRemaining : null,
      failureReason: failureReason ?? (this.stateValue === 'failed' ? this.lastFailure : null),
    };
  }

  private notice(
    level: 'info' | 'warning' | 'error',
    text: string,
    stream: StreamKind | null = null,
  ): void {
    this.noticeCounter += 1;
    this.deps.events.notice({
      id: `notice-${String(this.noticeCounter)}`,
      level,
      message: text,
      stream,
    });
    this.session?.notices.push({ at: this.now().toISOString(), level, message: text });
    if (level !== 'info') this.logger.warn(`recording: ${text}`);
  }

  private onUtilityEvent(event: MediaUtilityEvent): void {
    const session = this.session;
    if (!session) return;
    if (event.type === 'stream.closed' || event.type === 'stream.error') {
      for (const stream of session.streams.values()) {
        if (stream.streamId !== event.streamId) continue;
        if (event.type === 'stream.closed') stream.closed = true;
        else if (isCapturing(this.stateValue)) {
          this.notice(
            'error',
            `Writing the ${stream.kind} stream failed: ${event.message}`,
            stream.kind,
          );
        }
      }
    } else if (
      event.type === 'system.first-audio' &&
      event.captureId === this.systemCaptureId(session)
    ) {
      const system = session.streams.get('system');
      if (system && session.t0Us !== null && session.utilityOffsetUs !== null) {
        system.startOffsetUs = Math.round(
          event.firstSampleUs -
            session.utilityOffsetUs -
            session.t0Us +
            (system.sync.outputLatencyUs ?? 0),
        );
        void this.writeLog(session);
      }
    } else if (
      event.type === 'system.level' &&
      event.captureId !== null &&
      event.captureId === this.systemCaptureId(session)
    ) {
      if (isCapturing(this.stateValue)) this.deps.events.levels?.({ system: event.peak });
    } else if (event.type === 'system.error' && event.captureId === this.systemCaptureId(session)) {
      const system = session.streams.get('system');
      if (system && !system.endedEarly && isCapturing(this.stateValue)) {
        system.endedEarly = true;
        this.notice('warning', `System audio stopped: ${event.message}`, 'system');
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: setup

  private configFromSettings(): RecorderConfig {
    const r = this.deps.settings.get().recorder;
    return {
      captureMode: r.captureMode,
      cameraId: r.cameraId,
      micId: r.micId,
      systemAudio: r.systemAudio,
      micProcessing: r.micProcessing,
      fps: r.fps,
      quality: r.quality,
      countdownSec: r.countdownSec,
    };
  }

  private async portalCancelled(engine: EngineLike | null): Promise<RecordResult> {
    if (this.stateValue === 'acquiring') this.fire({ type: 'portal-cancelled' });
    if (engine) await this.releaseTracks(engine);
    this.session = null;
    return { status: 'cancelled' };
  }

  private async chooseRegion(session: Session): Promise<RegionChoice> {
    const size = { width: session.source.widthPx, height: session.source.heightPx };
    if (this.deps.pickRegion) return this.deps.pickRegion(size);
    const last = this.deps.settings.get().recorder.lastRegion;
    const matches = last?.sourceWidth === size.width && last.sourceHeight === size.height;
    return { rect: matches ? last.rect : null };
  }

  /** Resolves true when the countdown elapsed, false when it was cancelled. */
  private countdown(seconds: number): Promise<boolean> {
    const tick = this.deps.countdownTickMs ?? 1000;
    this.countdownRemaining = seconds;
    this.emitState();
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.countdownCancel = () => {
        if (timer) clearTimeout(timer);
        this.countdownCancel = null;
        this.countdownRemaining = null;
        resolve(false);
      };
      const step = (): void => {
        if (this.stateValue !== 'countdown') {
          this.countdownCancel?.();
          return;
        }
        if ((this.countdownRemaining ?? 0) <= 0) {
          this.countdownCancel = null;
          this.countdownRemaining = null;
          resolve(true);
          return;
        }
        timer = setTimeout(() => {
          this.countdownRemaining = (this.countdownRemaining ?? 1) - 1;
          if (this.stateValue === 'countdown') this.emitState();
          step();
        }, tick);
      };
      step();
    });
  }

  private stopCountdown(): void {
    this.countdownCancel?.();
  }

  // -------------------------------------------------------------------------------------------
  // Internals: start

  /** countdown → recording. Returns false when starting failed (the session is then failed). */
  private async beginRecording(): Promise<boolean> {
    const session = this.session;
    if (!session || this.stateValue !== 'countdown') return false;
    this.fire({ type: 'countdown-elapsed' });
    const task = this.startCapture(session);
    this.starting = task;
    try {
      await task;
      return true;
    } catch (error) {
      this.logger.error('recording: start failed', error);
      this.starting = null;
      await this.failAndSettle(`Recording could not start: ${message(error)}`);
      return false;
    } finally {
      if (this.starting === task) this.starting = null;
    }
  }

  private async startCapture(session: Session): Promise<void> {
    const root = session.root ?? (await this.createProjectFolder(session));
    const mediaDir = path.join(root, MEDIA_DIR);
    const settings = this.deps.settings.get();

    // A main-side handshake runs alongside, as the fallback offset.
    const mainOffset = this.deps.utility.measureClockOffset().catch(() => null);

    const kinds: StreamKind[] = ['screen'];
    if (session.hasCamera) kinds.push('camera');
    if (session.hasMic) kinds.push('mic');
    const created = kinds.map((kind) => this.newStream(session, kind));
    session.streams = new Map(created.map((stream) => [stream.kind, stream]));
    session.pauses = [];
    session.pausedMainUs = 0;
    session.pauseStartedMainUs = null;

    const ports = created.map((stream) =>
      this.deps.utility.openStream(stream.streamId, stream.kind, mediaDir),
    );
    const clockPort = this.deps.utility.attachClock();
    session.engine.sendPorts(
      {
        sessionId: session.sessionId,
        streams: created.map((stream) => ({ streamId: stream.streamId, kind: stream.kind })),
        clockPort: true,
      },
      [...ports, clockPort],
    );

    const started = await session.engine.command('engine.start', {
      sessionId: session.sessionId,
      quality: session.config.quality,
      fps: session.config.fps,
      region: session.region,
    });
    session.t0Us = started.t0Us;
    session.mainStartUs = this.mainNowUs();
    session.startedAt = this.now().toISOString();
    for (const entry of parseStreamReports(started.streams)) {
      const stream = session.streams.get(entry.kind);
      if (!stream) continue;
      if (entry.encoder) stream.encoder = entry.encoder;
      this.applyReport(stream, entry);
    }
    session.utilityOffsetUs =
      started.utilityClockOffsetUs ?? started.clock?.offsetUs ?? (await mainOffset)?.offsetUs ?? 0;

    if (session.config.systemAudio) {
      if (this.deps.systemAudioAvailable()) {
        const system = this.newStream(session, 'system');
        system.label = 'System audio';
        system.encoder = { name: 'Opus (FFmpeg libopus)', hardware: false };
        system.sync.clockHandshakeUs = Math.round(session.utilityOffsetUs);
        system.sync.outputLatencyUs = Math.round(
          (await this.deps.systemAudioOutputLatencyUs?.().catch(() => 0)) ?? 0,
        );
        session.streams.set('system', system);
        this.deps.utility.startSystemAudio(system.streamId, mediaDir);
      } else {
        this.notice(
          'warning',
          'System audio is not available on this system; recording without it.',
          'system',
        );
      }
    }

    this.startTimers(session, settings);
    this.emitState();
    await this.writeLog(session);
  }

  private newStream(session: Session, kind: StreamKind): StreamState {
    return {
      kind,
      streamId: `${kind}-${ulid()}`,
      mediaId: newId('media'),
      label:
        kind === 'camera'
          ? session.labels.camera
          : kind === 'mic'
            ? session.labels.mic
            : kind === 'screen'
              ? (session.source.label ?? null)
              : null,
      encoder: null,
      // §9.2 hybrid default until the engine reports its calibration.
      sync: {
        mode: isVideoKind(kind) ? 'shared' : 'arrival-calibrated',
        offsetUs: 0,
        clockHandshakeUs: null,
      },
      startOffsetUs: null,
      endedEarly: false,
      endedAtUs: null,
      stats: null,
      closed: false,
      checkpoints: [],
      nominalRate: null,
      checkpointsDirty: false,
    };
  }

  /** Copies stream facts from an engine report. Returns whether the manifest changed. */
  private applyReport(stream: StreamState, report: EngineStreamReport): boolean {
    let changed = false;
    if (report.startOffsetUs !== undefined && stream.startOffsetUs === null) {
      stream.startOffsetUs = Math.round(report.startOffsetUs);
      changed = true;
    }
    if (report.calibration) {
      const next = {
        mode: report.calibration.mode,
        offsetUs: Math.round(report.calibration.offsetUs),
        clockHandshakeUs:
          report.calibration.clockHandshakeUs == null
            ? stream.sync.clockHandshakeUs
            : Math.round(report.calibration.clockHandshakeUs),
      };
      if (JSON.stringify(next) !== JSON.stringify(stream.sync)) {
        stream.sync = next;
        changed = true;
      }
    }
    if (report.encoder && JSON.stringify(report.encoder) !== JSON.stringify(stream.encoder)) {
      stream.encoder = report.encoder;
      changed = true;
    }
    return changed;
  }

  private async createProjectFolder(session: Session): Promise<string> {
    const settings = this.deps.settings.get();
    const now = this.now();
    const formatted = makeFileName(settings.namePattern, {
      now,
      increment: settings.nameIncrement,
    });
    if (formatted.usedIncrement) {
      await this.deps.settings
        .patch({ nameIncrement: settings.nameIncrement + 1 })
        .catch((error: unknown) => this.logger.warn('recording: name counter not saved', error));
    }
    await fs.mkdir(settings.projectsDir, { recursive: true });
    const taken = new Set((await fs.readdir(settings.projectsDir)).map((n) => n.toLowerCase()));
    const folder = uniqueName(formatted.text, PROJECT_EXTENSION, (c) => taken.has(c.toLowerCase()));
    const root = path.join(settings.projectsDir, folder);
    // `mkdir` without recursive fails if another process took the name meanwhile.
    await fs.mkdir(root);
    await Promise.all(
      [MEDIA_DIR, CACHE_DIR, LOGS_DIR].map((d) =>
        fs.mkdir(path.join(root, d), { recursive: true }),
      ),
    );
    session.root = root;
    session.name = folder.slice(0, -PROJECT_EXTENSION.length);
    session.projectId = newId('project');
    session.createdAt = now.toISOString();
    session.startedAt = now.toISOString();

    await this.writeHeartbeat(session);
    const project = this.buildProject(withState(this.manifest(session), 'recording'));
    if (!project.ok)
      throw new Error(`initial project.json is invalid: ${project.error.issues.join('; ')}`);
    await this.deps.store.write(root, project.value);
    this.deps.events.libraryChanged();
    return root;
  }

  private startTimers(session: Session, settings: Settings): void {
    this.stopTimers();
    this.heartbeat = setInterval(() => {
      void this.writeHeartbeat(session);
      void this.writeLog(session);
      void this.flushSyncFiles(session);
    }, this.deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
    this.disk = new DiskMonitor({
      dir: settings.projectsDir,
      thresholds: settings.disk,
      ...(this.deps.diskIntervalMs ? { intervalMs: this.deps.diskIntervalMs } : {}),
      ...(this.deps.freeBytes ? { freeBytes: this.deps.freeBytes } : {}),
      logger: this.logger,
      onWarn: (free) =>
        this.notice(
          'warning',
          `Low disk space: ${formatBytes(free)} left. The recording stops below ${formatBytes(settings.disk.stopBytes)}.`,
        ),
      onStop: (free) => {
        this.notice(
          'error',
          `Disk space is almost exhausted (${formatBytes(free)} left); the recording was stopped.`,
        );
        void this.stop('disk-low').catch((error: unknown) =>
          this.logger.error('recording: stop on low disk failed', error),
        );
      },
    });
    this.disk.start();
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.disk?.stop();
    this.disk = null;
  }

  /**
   * Writes the drift checkpoints received so far to `media/<kind>.sync.json`, so a recovered
   * recording keeps its drift correction (the engine cannot write files itself).
   */
  private async flushSyncFiles(session: Session): Promise<void> {
    if (!session.root) return;
    for (const stream of session.streams.values()) {
      if (!stream.checkpointsDirty || stream.kind === 'system') continue;
      stream.checkpointsDirty = false;
      await this.writeSyncFile(session.root, stream.kind, stream.nominalRate, stream.checkpoints);
    }
  }

  private async writeSyncFile(
    root: string,
    kind: StreamKind,
    rate: number | null,
    points: readonly [number, number][],
    fileName = syncFileName(kind),
  ): Promise<void> {
    const file = { version: 1, nominalRate: Math.round(rate ?? 48_000), checkpoints: points };
    await writeFileAtomic(path.join(root, MEDIA_DIR, fileName), `${JSON.stringify(file)}\n`, {
      backup: false,
    }).catch((error: unknown) => this.logger.warn(`recording: ${fileName} not written`, error));
  }

  private async writeHeartbeat(session: Session): Promise<void> {
    if (!session.root) return;
    const now = this.now().toISOString();
    await writeLock(session.root, {
      pid: process.pid,
      hostname: os.hostname(),
      sessionId: session.sessionId,
      startedAt: session.startedAt ?? now,
      heartbeatAt: now,
      appVersion: this.deps.appVersion,
    }).catch((error: unknown) => this.logger.warn('recording: heartbeat failed', error));
  }

  // -------------------------------------------------------------------------------------------
  // Internals: clocks

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private mainNowUs(): number {
    return (this.deps.nowUs ?? defaultNowUs)();
  }

  /** Recording time without pauses (R1.12), on main's clock. */
  private elapsedUs(): number {
    const session = this.session;
    if (session?.mainStartUs == null || !isCapturing(this.stateValue)) return 0;
    const pausing =
      session.pauseStartedMainUs === null ? 0 : this.mainNowUs() - session.pauseStartedMainUs;
    return Math.max(
      0,
      Math.round(this.mainNowUs() - session.mainStartUs - session.pausedMainUs - pausing),
    );
  }

  /** Session time including pauses, on main's clock (fallback when the engine gives none). */
  private mainElapsedWithPausesUs(session: Session): number {
    return session.mainStartUs === null
      ? 0
      : Math.max(0, Math.round(this.mainNowUs() - session.mainStartUs));
  }

  /**
   * Engine times → session µs since t0. Absolute engine-clock values (the same domain as
   * `t0Us`) are shifted; values that are already relative (small numbers) pass through.
   */
  private toSessionUs(session: Session, atUs: number): number {
    if (session.t0Us !== null && Math.abs(atUs) > ABSOLUTE_CLOCK_THRESHOLD_US) {
      return Math.max(0, Math.round(atUs - session.t0Us));
    }
    return Math.max(0, Math.round(atUs));
  }

  /** Session µs → utility clock (for system-audio pause and resume). */
  private toUtilityUs(session: Session, sessionUs: number): number {
    return sessionUs + (session.t0Us ?? 0) + (session.utilityOffsetUs ?? 0);
  }

  private systemCaptureId(session: Session): string | null {
    return session.streams.get('system')?.streamId ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Internals: manifest

  private manifest(
    session: Session,
    streams: RecordedStream[] = this.liveStreams(session),
  ): RecordingManifest {
    const durationUs = Math.max(this.mainElapsedWithPausesUs(session), 0);
    const pauses = session.pauses.map((p) => ({
      startUs: p.startUs,
      endUs: p.endUs ?? Math.max(p.startUs, durationUs),
    }));
    return {
      version: RECORDING_MANIFEST_VERSION,
      projectId: session.projectId ?? newId('project'),
      name: session.name ?? 'Recording',
      createdAt: session.createdAt ?? this.now().toISOString(),
      appVersion: this.deps.appVersion,
      recording: {
        state: 'recording',
        sessionId: session.sessionId,
        startedAt: session.startedAt ?? this.now().toISOString(),
        durationUs,
        pauses,
        source: {
          kind: 'monitor',
          ...(session.source.label ? { label: session.source.label } : {}),
          widthPx: session.source.widthPx,
          heightPx: session.source.heightPx,
          region: session.region,
        },
        platform: this.deps.platform(),
      },
      frameRate: session.config.fps,
      streams,
    };
  }

  /** Streams as known while recording (no durations yet). */
  private liveStreams(session: Session): RecordedStream[] {
    return [...session.streams.values()].map((s) =>
      recordedStream(this.meta(session, s), null, null, false),
    );
  }

  private meta(session: Session, s: StreamState): StreamMeta {
    return {
      kind: s.kind,
      mediaId: s.mediaId,
      label: s.label,
      encoder: s.encoder,
      sync: s.sync,
      startOffsetUs: s.startOffsetUs,
      endedEarly: s.endedEarly,
      stats: s.stats,
      frameRate: s.kind === 'screen' ? session.config.fps : null,
    };
  }

  private sessionLog(session: Session): SessionLog {
    return {
      version: 1,
      updatedAt: this.now().toISOString(),
      t0Us: session.t0Us,
      utilityClockOffsetUs: session.utilityOffsetUs,
      systemCaptureId: this.systemCaptureId(session),
      streams: [...session.streams.values()].map((s) => ({
        kind: s.kind,
        streamId: s.streamId,
        mediaId: s.mediaId,
        label: s.label,
        encoder: s.encoder,
        sync: s.sync,
        ...(s.stats?.sync ? { calibrationDetail: s.stats.sync } : {}),
        startOffsetUs: s.startOffsetUs,
        endedEarly: s.endedEarly,
        endedAtUs: s.endedAtUs,
        stats: s.stats
          ? {
              ...(s.stats.framesIn === undefined ? {} : { framesIn: s.stats.framesIn }),
              ...(s.stats.framesEncoded === undefined
                ? {}
                : { framesEncoded: s.stats.framesEncoded }),
              ...(s.stats.framesDropped === undefined
                ? {}
                : { framesDropped: s.stats.framesDropped }),
              ...(s.stats.discontinuities === undefined
                ? {}
                : { discontinuities: s.stats.discontinuities }),
              ...(s.stats.bytes === undefined ? {} : { bytes: s.stats.bytes }),
            }
          : null,
      })),
      notices: session.notices,
      manifest: this.manifest(session),
    };
  }

  private async writeLog(session: Session): Promise<void> {
    if (!session.root || session.projectId === null) return;
    await writeSessionLog(session.root, this.sessionLog(session)).catch((error: unknown) =>
      this.logger.warn('recording: could not write logs/recording.json', error),
    );
  }

  private buildProject(manifest: RecordingManifest) {
    return projectFromRecording(manifest, { now: () => this.now() });
  }

  // -------------------------------------------------------------------------------------------
  // Internals: stop, finalize, discard

  /** Stops the engine and system audio and waits for the stream files to close. */
  private async stopCapture(
    session: Session,
    reason: 'stop' | 'restart' | 'abort',
  ): Promise<StopOutcome> {
    let reports: EngineStreamReport[] = [];
    let engine: EngineCommandResponse<'engine.stop'> | null = null;
    let engineStopped = false;
    try {
      const result = await session.engine.command(
        'engine.stop',
        { reason },
        this.deps.engineStopTimeoutMs ?? 60_000,
      );
      reports = parseStreamReports(result.streams);
      engine = result;
      engineStopped = true;
    } catch (error) {
      this.logger.error(`recording: engine.stop (${reason}) failed`, error);
    }

    let system: SystemAudioResult | null = null;
    const captureId = this.systemCaptureId(session);
    if (captureId) {
      system = await this.deps.utility.stopSystemAudio(captureId).catch((error: unknown) => {
        this.logger.error('recording: stopping system audio failed', error);
        return null;
      });
    }

    // The engine closes each stream over its port; wait for the utility to confirm, then
    // force-close whatever is left (engine failure) so the files are complete on disk.
    const engineStreams = [...session.streams.values()].filter((s) => s.kind !== 'system');
    if (engineStopped && reason === 'stop') {
      const deadline = Date.now() + (this.deps.streamCloseTimeoutMs ?? 10_000);
      while (engineStreams.some((s) => !s.closed) && Date.now() < deadline) await delay(20);
    }
    for (const stream of engineStreams) {
      if (!stream.closed) this.deps.utility.closeStream(stream.streamId);
    }
    return { reports, system, engine };
  }

  private async finalize(session: Session, reason: StopReason): Promise<void> {
    this.stopTimers();
    try {
      const outcome = await this.finishProject(session, 'complete');
      if (!outcome) throw new Error('nothing was finalized');
      if (this.stateValue === 'finalizing') this.fire({ type: 'finalized' });
      this.logger.info(`recording: finalized ${session.root ?? '?'} (${reason})`);
      this.session = null;
      this.deps.events.libraryChanged();
      this.deps.events.projectReady({
        projectId: outcome.projectId,
        root: outcome.root,
        name: session.name ?? path.basename(outcome.root, PROJECT_EXTENSION),
        afterRecording: this.deps.settings.get().recorder.afterRecording,
      });
      this.startCaches(outcome);
    } catch (error) {
      this.logger.error('recording: finalize failed', error);
      await this.failAndSettle(`Finalizing failed: ${message(error)}`, true);
    }
  }

  /**
   * Stops capture, finalizes the files and writes `project.json` in `state`. With `failed`, it
   * keeps whatever it can and never throws for a single stream.
   */
  private async finishProject(
    session: Session,
    state: 'complete' | 'failed',
    failureReason?: string,
  ): Promise<{ projectId: string; root: string; media: readonly Media[] } | null> {
    const root = session.root;
    const projectId = session.projectId;
    if (!root || !projectId) throw new Error('no project folder');
    const mediaDir = path.join(root, MEDIA_DIR);
    const stopped = await this.stopCapture(session, 'stop');

    // Merge the engine's final reports (they carry every checkpoint of each stream).
    for (const report of stopped.reports) {
      const stream = session.streams.get(report.kind);
      if (!stream) continue;
      stream.stats = report;
      this.applyReport(stream, report);
      if (report.endedEarly) stream.endedEarly = true;
      if (report.checkpoints && report.checkpoints.length > 0) {
        stream.checkpoints = report.checkpoints.map(checkpoint);
        stream.nominalRate = report.nominalRate ?? stream.nominalRate;
      }
    }
    // The engine cannot write files: its drift checkpoints go to `<kind>.sync.json` here.
    for (const stream of session.streams.values()) {
      if (stream.kind === 'system' || stream.checkpoints.length === 0) continue;
      await this.writeSyncFile(root, stream.kind, stream.nominalRate, stream.checkpoints);
    }
    // The mic's capture-timestamp series, for offline comparison with the arrival series.
    for (const report of stopped.reports) {
      if (report.kind !== 'mic' || !report.captureCheckpoints?.length) continue;
      await this.writeSyncFile(
        root,
        report.kind,
        report.nominalRate ?? session.streams.get('mic')?.nominalRate ?? null,
        report.captureCheckpoints.map(checkpoint),
        captureSyncFileName(report.kind),
      );
    }
    // The engine's pause list and stop time are authoritative (absolute session µs).
    const t0 = stopped.engine?.t0Us ?? session.t0Us;
    if (stopped.engine?.pauses && t0 != null) {
      session.pauses = stopped.engine.pauses.map((p) => ({
        startUs: Math.max(0, Math.round(p.startUs - t0)),
        endUs: Math.max(0, Math.round(p.endUs - t0)),
      }));
    }
    const stoppedAtUs =
      stopped.engine?.stoppedAtUs != null && t0 != null
        ? Math.max(0, Math.round(stopped.engine.stoppedAtUs - t0))
        : null;
    const system = session.streams.get('system');
    if (system && stopped.system?.firstSampleUs != null && session.t0Us !== null) {
      system.startOffsetUs = Math.round(
        stopped.system.firstSampleUs -
          (session.utilityOffsetUs ?? 0) -
          session.t0Us +
          (system.sync.outputLatencyUs ?? 0),
      );
    }

    const kinds = [...session.streams.keys()];
    let files: FinalizedStream[] = [];
    if (kinds.length > 0) {
      const result = await this.deps.utility.runJob({
        kind: 'finalize',
        dir: mediaDir,
        streams: kinds.map((kind) => ({ kind, expect: expectedStreams(kind) })),
        recovering: state === 'failed',
      });
      files = result.streams;
    }

    const streams: RecordedStream[] = [];
    for (const stream of session.streams.values()) {
      const file = files.find((f) => f.kind === stream.kind) ?? null;
      if (file && !file.ok) {
        this.notice(
          'error',
          `The ${stream.kind} stream could not be finalized: ${file.error ?? 'unknown error'}`,
          stream.kind,
        );
      }
      // System-audio checkpoints are on the utility clock; shift them into session time.
      const sync =
        file?.sync && stream.kind === 'system'
          ? shiftCheckpoints(file.sync, (session.t0Us ?? 0) + (session.utilityOffsetUs ?? 0))
          : (file?.sync ?? null);
      const drift = fitDrift(sync);
      if (drift) {
        this.logger.info(
          `recording: ${stream.kind} drift ${drift.ppm.toFixed(1)} ppm (±${drift.standardErrorPpm.toFixed(1)}), ${drift.decision}`,
        );
      }
      streams.push(recordedStream(this.meta(session, stream), file, drift, false));
    }
    if (state === 'failed' && !streams.some((s) => s.status === 'ok')) {
      await this.deleteFolder(session);
      return null;
    }

    const base = this.manifest(session, streams);
    // The engine's stop time is the session length; streams that ran longer extend it.
    const durationUs =
      stoppedAtUs === null
        ? sessionDurationUs(streams, base.recording.durationUs)
        : Math.max(stoppedAtUs, sessionDurationUs(streams, 0));
    const manifest = withState(
      {
        ...base,
        recording: {
          ...base.recording,
          durationUs,
          pauses: session.pauses.map((p) => ({ startUs: p.startUs, endUs: p.endUs ?? durationUs })),
        },
      },
      state,
      failureReason,
    );
    const built = this.buildProject(manifest);
    if (!built.ok)
      throw new Error(`project is invalid: ${built.error.issues.slice(0, 3).join('; ')}`);
    await this.deps.store.write(root, built.value);
    await writeSessionLog(root, { ...this.sessionLog(session), manifest }).catch(() => undefined);
    await removeLock(root);
    return { projectId, root, media: built.value.media };
  }

  /** Peaks and thumbnails after the project is ready, off the finalize path (R1.20, R1.44). */
  private startCaches(outcome: { projectId: string; root: string; media: readonly Media[] }): void {
    const { projectId, root, media } = outcome;
    const started = Date.now();
    const run = this.deps.generateCaches
      ? this.deps.generateCaches(projectId, root, media)
      : generateCaches(this.deps.utility, root, media, this.logger);
    const pass: Promise<void> = run
      .then(() => {
        this.logger.info(
          `recording: peaks and thumbnails of ${projectId} ready after ${String(Date.now() - started)} ms`,
        );
        this.deps.events.cachesReady?.({ projectId, root });
      })
      .catch((error: unknown) => this.logger.warn('recording: background caches failed', error))
      .finally(() => this.cachePasses.delete(pass));
    this.cachePasses.add(pass);
  }

  /** → failed: finalize what is possible and mark the project failed; delete an empty one. */
  private async failAndSettle(reason: string, alreadyFinalizing = false): Promise<void> {
    if (!alreadyFinalizing && !this.can({ type: 'error', reason })) return;
    const wasCapturing = isCapturing(this.stateValue) || alreadyFinalizing;
    if (this.can({ type: 'error', reason })) this.fire({ type: 'error', reason });
    this.notice('error', reason);
    this.stopCountdown();
    this.stopTimers();
    const session = this.session;
    const task = (async () => {
      if (!session) return;
      // Nothing was recorded (the engine never started): release everything, keep nothing.
      if (!session.root || !wasCapturing || session.t0Us === null) {
        if (session.streams.size > 0) await this.stopCapture(session, 'abort');
        else await this.releaseTracks(session.engine);
        if (session.root) await this.deleteFolder(session);
        return;
      }
      try {
        const outcome = await this.finishProject(session, 'failed', reason);
        this.deps.events.libraryChanged();
        if (outcome) this.startCaches(outcome);
      } catch (error) {
        this.logger.error('recording: could not finalize the failed session', error);
        await this.markFailed(session, reason);
      }
    })();
    this.finishing = task;
    await task;
    this.session = null;
  }

  /** Last resort: the recording project.json gets state `failed`; the lock goes. */
  private async markFailed(session: Session, reason: string): Promise<void> {
    if (!session.root || !session.projectId) return;
    await this.deps.store
      .update(session.projectId, (doc: ProjectV1) =>
        doc.recording
          ? { ...doc, recording: { ...doc.recording, state: 'failed', failureReason: reason } }
          : doc,
      )
      .catch((error: unknown) =>
        this.logger.error('recording: could not mark the project failed', error),
      );
    await removeLock(session.root).catch(() => undefined);
  }

  private async releaseTracks(engine: EngineLike): Promise<void> {
    await engine
      .command('engine.stop', { reason: 'abort' }, 10_000)
      .catch((error: unknown) => this.logger.warn('recording: releasing tracks failed', error));
  }

  /** Restart: delete the media written so far; the folder, project.json and lock stay. */
  private async discardMedia(session: Session): Promise<void> {
    if (!session.root) return;
    const mediaDir = path.join(session.root, MEDIA_DIR);
    await fs.rm(mediaDir, { recursive: true, force: true });
    await fs.mkdir(mediaDir, { recursive: true });
    session.streams = new Map();
    session.pauses = [];
    session.t0Us = null;
    session.mainStartUs = null;
    await this.writeLog(session);
  }

  private async deleteFolder(session: Session): Promise<void> {
    if (!session.root) return;
    const { root, projectId } = session;
    await fs
      .rm(root, { recursive: true, force: true })
      .catch((error: unknown) => this.logger.error(`recording: could not delete ${root}`, error));
    if (projectId) this.deps.store.unregister(projectId);
    session.root = null;
    session.projectId = null;
    this.deps.events.libraryChanged();
  }

  private failedResult(): RecordResult {
    return { status: 'failed', message: this.lastFailure ?? 'Recording could not start' };
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${String(Math.round(bytes / 1e6))} MB`;
}
