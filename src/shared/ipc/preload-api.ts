/**
 * The APIs the preloads expose to each window. Types only: preloads and renderers import them
 * with `import type`. Each window gets its own global:
 *
 * | Window   | Global                    |
 * |----------|---------------------------|
 * | shell    | `window.captureStudio`    |
 * | controls | `window.csControls`       |
 * | picker   | `window.csPicker`         |
 * | editor   | `window.csEditor`         |
 * | engine   | `window.csEngine`         |
 */
import type { CapabilityReport } from '../capabilities/types';
import type { Settings } from '../settings/schema';
import type {
  EngineCommandChannel,
  EngineCommandPayload,
  EngineCommandResponse,
  EngineEventPayload,
  EventPayload,
  InvokeRequest,
  InvokeResponse,
} from './contract';

export type Unsubscribe = () => void;
type Listener<T> = (payload: T) => void;

export interface PreloadBase {
  readonly platform: string;
  readonly versions: {
    readonly app: string;
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}

export interface CapsApi {
  get(): Promise<CapabilityReport>;
  onChanged(listener: Listener<EventPayload<'caps.changed'>>): Unsubscribe;
}

export interface SettingsApi {
  get(): Promise<Settings>;
  patch(patch: InvokeRequest<'settings.patch'>): Promise<Settings>;
}

export interface RecordingEventsApi {
  /** The current state, for windows that open mid-session. */
  status(): Promise<EventPayload<'rec.state'>>;
  onState(listener: Listener<EventPayload<'rec.state'>>): Unsubscribe;
  onStats(listener: Listener<EventPayload<'rec.stats'>>): Unsubscribe;
  onNotice(listener: Listener<EventPayload<'rec.notice'>>): Unsubscribe;
  /** Meter levels at about 15 Hz (R1.6, R1.12). */
  onLevels(listener: Listener<EventPayload<'rec.levels'>>): Unsubscribe;
}

export interface RecordingControlApi extends RecordingEventsApi {
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  abort(): Promise<void>;
}

export interface ShellPreloadApi extends PreloadBase {
  readonly caps: CapsApi & { refresh(): Promise<CapabilityReport> };
  readonly settings: SettingsApi & {
    /** Main's folder dialog for the projects or exports folder; null when cancelled. */
    chooseFolder(
      which: InvokeRequest<'settings.chooseFolder'>['which'],
    ): Promise<InvokeResponse<'settings.chooseFolder'>>;
    /** The settings-recovery notice, once per launch (R1.50). */
    takeLoadNotice(): Promise<InvokeResponse<'settings.takeLoadNotice'>>;
  };
  readonly rec: RecordingControlApi & {
    configure(config: InvokeRequest<'rec.configure'>): Promise<void>;
    record(): Promise<InvokeResponse<'rec.record'>>;
    /** Starts or stops the setup panel's system-audio meter. */
    monitorSystem(enabled: boolean): Promise<void>;
    onCompleted(listener: Listener<EventPayload<'rec.completed'>>): Unsubscribe;
  };
  readonly library: {
    list(): Promise<InvokeResponse<'library.list'>>;
    rename(id: string, name: string): Promise<InvokeResponse<'library.rename'>>;
    trash(id: string): Promise<InvokeResponse<'library.trash'>>;
    reveal(id: string): Promise<void>;
    /** Main's folder dialog; adds an existing `.cstudio` project. Null when cancelled. */
    import(): Promise<InvokeResponse<'library.import'>>;
    openFolder(): Promise<void>;
    onChanged(listener: () => void): Unsubscribe;
  };
  readonly project: {
    open(id: string): Promise<InvokeResponse<'project.open'>>;
    /** Opens the project in the editor window. */
    edit(id: string): Promise<void>;
  };
  readonly recovery: {
    list(): Promise<InvokeResponse<'recovery.list'>>;
    recover(id: string): Promise<InvokeResponse<'recovery.recover'>>;
    discard(id: string, action: 'trash' | 'leave'): Promise<void>;
  };
  readonly diag: {
    get(): Promise<InvokeResponse<'diag.get'>>;
    /** Puts the report on the clipboard (main does the copy) and returns its text. */
    copyReport(): Promise<InvokeResponse<'diag.copyReport'>>;
  };
}

export interface ControlsPreloadApi extends PreloadBase {
  readonly caps: CapsApi;
  readonly settings: SettingsApi;
  readonly rec: RecordingControlApi;
}

export interface PickerPreloadApi extends PreloadBase {
  readonly settings: Pick<SettingsApi, 'get'>;
  /** The frozen frame and the matching last region. */
  load(): Promise<InvokeResponse<'picker.load'>>;
  submit(selection: InvokeRequest<'picker.submit'>): Promise<void>;
  cancel(): Promise<void>;
}

export interface EditorPreloadApi extends PreloadBase {
  readonly caps: CapsApi;
  readonly settings: SettingsApi;
  readonly project: {
    open(id: string): Promise<InvokeResponse<'project.open'>>;
    save(request: InvokeRequest<'project.save'>): Promise<InvokeResponse<'project.save'>>;
    relink(id: string, mediaId: string): Promise<InvokeResponse<'project.relink'>>;
    reveal(id: string): Promise<void>;
  };
  readonly media: {
    peaks(projectId: string, mediaId: string): Promise<InvokeResponse<'media.peaks'>>;
    thumbs(projectId: string, mediaId: string): Promise<InvokeResponse<'media.thumbs'>>;
    /** A project's background peaks and thumbnails are done (optional for test doubles). */
    onCachesReady?(listener: Listener<EventPayload<'media.cachesReady'>>): Unsubscribe;
  };
  readonly export: {
    probeEncoders(): Promise<InvokeResponse<'export.probeEncoders'>>;
    start(request: InvokeRequest<'export.start'>): Promise<InvokeResponse<'export.start'>>;
    /** Where the project's export will be written (chosen or default). */
    target(projectId: string): Promise<InvokeResponse<'export.target'>>;
    /** Native save dialog; null when cancelled. */
    chooseOutput(projectId: string): Promise<InvokeResponse<'export.chooseOutput'>>;
    /** After `export.done`. */
    reveal(jobId: string): Promise<void>;
    open(jobId: string): Promise<void>;
    cancel(jobId: string): Promise<void>;
    onProgress(listener: Listener<EventPayload<'export.progress'>>): Unsubscribe;
    onDone(listener: Listener<EventPayload<'export.done'>>): Unsubscribe;
    onError(listener: Listener<EventPayload<'export.error'>>): Unsubscribe;
  };
}

export type EngineCommandHandler<C extends EngineCommandChannel> = (
  payload: EngineCommandPayload<C>,
) => EngineCommandResponse<C> | Promise<EngineCommandResponse<C>>;

/**
 * The capture engine's API. Commands from main are answered by the handler's return value (or
 * rejection). MessagePorts for the stream writers arrive as a window message; see
 * `shared/ipc/engine-window.ts`.
 */
export interface EnginePreloadApi extends PreloadBase {
  /** Registers the handler for one command channel (one handler per channel). */
  onCommand<C extends EngineCommandChannel>(
    channel: C,
    handler: EngineCommandHandler<C>,
  ): Unsubscribe;
  /** Tells main the engine page is ready for commands. */
  ready(): void;
  sendStats(stats: EngineEventPayload<'engine.stats'>): void;
  sendTrackEnded(event: EngineEventPayload<'engine.trackEnded'>): void;
  sendLevels(levels: EngineEventPayload<'engine.levels'>): void;
}
