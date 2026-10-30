/**
 * Main-process bootstrap: platform switches, sandbox, logging, single instance with `--action`
 * forwarding, security guards, persistent stores, the IPC router, capabilities, the media
 * utility, the `cs-media://` protocol, the recording session manager with the capture engine,
 * the region picker and controls windows, the library and recovery, the tray and the shell
 * window.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { BrowserWindow } from 'electron';
import {
  app,
  BrowserWindow as ElectronWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  Notification,
  protocol,
  safeStorage,
  shell,
  webContents,
} from 'electron';
import type { FfmpegEncoderReport } from '../shared/capabilities/types';
import type { Media, RecordingInfo } from '../shared/project/schema';
import { SecondInstanceDataSchema, type SecondInstanceData } from '../shared/ipc/actions';
import { ActionBus } from './action-bus';
import { appMenuTemplate } from './app-menu';
import { CapabilityService, defaultExec } from './capabilities/detect';
import { estimateSinkOutputLatencyUs } from './system-audio/linux-latency';
import { inferOzonePlatform } from './capabilities/linux';
import { parseCliArgs } from './cli';
import {
  FreeSpaceOverride,
  HARNESS_SOCKET_ENV,
  HarnessChannel,
} from './diagnostics/harness-channel';
import { harnessCommands, windowRole } from './diagnostics/harness-commands';
import { MetricsSampler } from './diagnostics/metrics-sampler';
import { locateFfmpeg, type FfmpegLocation } from './ffmpeg/locate';
import { registerCoreHandlers } from './ipc/core-handlers';
import { registerEditorHandlers } from './ipc/editor-handlers';
import { registerExportHandlers, type ExportService } from './ipc/export-handlers';
import { IpcRouter } from './ipc/router';
import { registerSessionHandlers } from './ipc/session-handlers';
import { applyForceX11, DEV_ONLY_ENV, readLaunchEnv, x11Relaunch } from './launch-env';
import { forwardRendererConsole, initLogging } from './logging';
import {
  createMediaHandler,
  MEDIA_SCHEME,
  MEDIA_SCHEME_PRIVILEGES,
  ProjectRootRegistry,
} from './projects/media-protocol';
import { CacheJobs } from './projects/cache-jobs';
import { EditorMedia, markMediaPresence } from './projects/editor-media';
import { Library } from './projects/library';
import { ProjectStore } from './projects/project-store';
import { freeBytes } from './recording/disk-monitor';
import { RecoveryService } from './recording/recovery';
import { SessionManager } from './recording/session-manager';
import { QuitGuard } from './quit-guard';
import { screenPickerOptions } from './display-media';
import { selectScreenSource } from './screen-source';
import { isActive, type RecordingState } from './recording/state-machine';
import { SecretStore } from './secrets/secret-store';
import { allowMediaCapture, installSecurityGuards, isAppUrl } from './security/web-security';
import { SettingsStore } from './settings/store';
import { createTray, type AppTray, type TrayRecordingState } from './tray';
import { startMediaUtility, type MediaUtilityHandle } from './utility-host';
import { ControlsWindowHost } from './windows/controls';
import { shouldMinimizeOnStart } from './windows/controls-policy';
import { EditorWindowHost } from './windows/editor';
import { EngineHost } from './windows/engine';
import { RegionPickerHost } from './windows/picker';
import { SourcePickerHost } from './windows/source-picker';
import { createShellWindow, focusWindow, type RendererLocation } from './windows/shell';

/** Launch switches; development and test ones only in an unpackaged build (S-1). */
const launch = readLaunchEnv(process.env, app.isPackaged, HARNESS_SOCKET_ENV);

// Escape hatch for XWayland when native Wayland misbehaves (§4.7 risk 13): relaunch once with
// the switch on the real command line (see launch-env.ts), then keep children off Wayland.
const relaunchX11 = launch.forceX11
  ? x11Relaunch(process.argv, process.execPath, process.env)
  : null;
if (relaunchX11) {
  app.relaunch(relaunchX11);
  app.exit(0);
}
const forcedX11 = launch.forceX11 && applyForceX11(app.commandLine, process.env);
/**
 * Test mode (§4.6.3; never in a packaged build): end-to-end tests run on an X11 Electron with
 * fake devices and must never open the ScreenCast portal, so the PipeWire capturer stays off.
 */
const testMode = launch.testMode;
/** Cancelling the portal makes `getSources` reject (R1.8; see screen-source.ts). */
const usesPortal =
  process.platform === 'linux' && !testMode && process.env.XDG_SESSION_TYPE === 'wayland';

// Screen capture through the ScreenCast portal on Wayland (§9.1, spike S1; see display-media.ts).
if (process.platform === 'linux' && !testMode)
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

// Tests and development can isolate profile data (settings, logs, single-instance lock).
if (launch.userDataDir) app.setPath('userData', launch.userDataDir);

// Every renderer is sandboxed, whatever its webPreferences say (§1.3).
app.enableSandbox();

// Must happen before 'ready' (§4.3.10).
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: MEDIA_SCHEME_PRIVILEGES },
]);

const log = initLogging();
forwardRendererConsole();
if (launch.forceX11) {
  log.info(
    forcedX11
      ? 'CS_FORCE_X11: running on X11 (XWayland)'
      : 'CS_FORCE_X11 ignored: no X display (DISPLAY is not set)',
  );
}
if (app.isPackaged) {
  const ignored = DEV_ONLY_ENV.filter((name) => process.env[name]);
  if (ignored.length > 0) log.warn(`ignoring development variables: ${ignored.join(', ')}`);
}

const renderer: RendererLocation = {
  ...(launch.rendererUrl ? { devServerUrl: launch.rendererUrl } : {}),
  rendererDir: path.join(import.meta.dirname, '../renderer'),
  preloadDir: path.join(import.meta.dirname, '../preload'),
};

/** Recording, tray and CLI actions (R1.2–R1.4); the session manager subscribes in `start`. */
const actionBus = new ActionBus(log);
/** Project folders `cs-media://` may serve; the project store registers them. */
const projectRoots = new ProjectRootRegistry();

const router = new IpcRouter({ ipcMain, logger: log, isAppUrl: (url) => isAppUrl(url, renderer) });

let shellWindow: BrowserWindow | null = null;
let tray: AppTray | null = null;
let mediaUtility: MediaUtilityHandle | null = null;
let engineHost: EngineHost | null = null;
let sessionManager: SessionManager | null = null;
let controlsHost: ControlsWindowHost | null = null;
let exportService: ExportService | null = null;
/** One editor window per project (steps 16–18). */
const editorHost = new EditorWindowHost({ router, renderer, logger: log });
/** Stops the setup panel's system-audio meter (set once the utility exists). */
let stopSystemMonitor: () => void = () => undefined;
let trayStateValue: TrayRecordingState = 'idle';

/** Quitting during a recording asks (or, for SIGTERM, saves) first (finding F-7). */
const quitGuard = new QuitGuard({
  recorder: () => sessionManager,
  ask: async () => {
    const parent = ElectronWindow.getFocusedWindow();
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Capture Studio',
      message: 'A recording is in progress.',
      detail: 'Save it before quitting, or discard it?',
      buttons: ['Stop and save', 'Discard', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  },
  quit: () => app.quit(),
  logger: log,
});

/**
 * Without a tray the app quits when nothing is left open while idle (R1.3): no main window, no
 * editor (F-8: closing the main window must not take an open editor with it). The hidden engine
 * window would otherwise keep the app alive.
 */
function quitIfNothingOpen(): void {
  if (tray || quitGuard.isQuitting) return;
  if (shellWindow && !shellWindow.isDestroyed()) return;
  if (editorHost.openProjects.length > 0) return;
  if (isActive(sessionManager?.state ?? 'idle')) return;
  quitGuard.quitInteractively();
}
editorHost.onAllClosed(quitIfNothingOpen);
/** Test-only control channel for the Wayland harness and e2e tests (unpackaged builds only). */
const harnessSocket = launch.harnessSocket;
let harness: HarnessChannel | null = null;

/** Process memory and dropped frames every minute while recording (§4.6.4; R1.22, R1.23). */
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const metrics = new MetricsSampler({
  getAppMetrics: () => app.getAppMetrics(),
  labelPid: (pid) => {
    const contents = webContents.getAllWebContents().find((wc) => wc.getOSProcessId() === pid);
    return contents ? windowRole(contents.getURL()) : null;
  },
  eventLoopDelayMs: () => {
    const max = eventLoopDelay.max / 1e6;
    eventLoopDelay.reset();
    return Number.isFinite(max) ? Math.round(max * 10) / 10 : null;
  },
  // Shorter sampling for harness dry runs (unpackaged builds only).
  ...(launch.metricsIntervalMs ? { intervalMs: launch.metricsIntervalMs } : {}),
  logger: log,
});

function trayState(state: RecordingState): TrayRecordingState {
  if (state === 'recording' || state === 'paused') return state;
  return isActive(state) ? 'busy' : 'idle';
}

/** A folder dialog parented to the calling window; the chosen folder or null. */
async function chooseDirectory(
  senderId: number,
  options: Electron.OpenDialogOptions,
): Promise<string | null> {
  const sender = webContents.fromId(senderId);
  const parent = sender ? ElectronWindow.fromWebContents(sender) : null;
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function showShell(): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    focusWindow(shellWindow);
    return;
  }
  const window = createShellWindow(renderer);
  shellWindow = window;
  const unregister = router.registerWindow(window.webContents, 'shell');
  // Camera and mic previews and meters in the setup panel (R1.5). The engine reopens the
  // devices for recording once the panel has released them.
  const revokeMedia = allowMediaCapture(window.webContents, { display: false });
  window.on('closed', () => {
    unregister();
    revokeMedia();
    stopSystemMonitor();
    shellWindow = null;
    quitIfNothingOpen();
  });
}

actionBus.on(['open-library'], () => showShell());
actionBus.on(['quit'], () => quitGuard.quitInteractively());
// New recording opens the shell, which hosts the setup panel; the session manager handles the
// recording actions themselves.
actionBus.on(['new-recording'], () => showShell());

const cli = parseCliArgs(process.argv);
if (cli.error) log.warn(`cli: ${cli.error}`);

async function start(): Promise<void> {
  // Needs the default session, so it runs after 'ready' but before any window exists.
  installSecurityGuards(renderer, log);
  // Ctrl+Q and File → Quit ask about a recording in progress (F-7).
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(appMenuTemplate(() => quitGuard.quitInteractively())),
  );

  log.info(
    `Capture Studio ${app.getVersion()} (Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ` +
      `${process.platform}/${process.env.XDG_SESSION_TYPE ?? 'unknown session'}, packaged=${String(app.isPackaged)})`,
  );

  const settings = await SettingsStore.open({
    dir: app.getPath('userData'),
    defaults: {
      projectsDir: path.join(app.getPath('videos'), 'Capture Studio'),
      exportsDir: path.join(app.getPath('videos'), 'Capture Studio', 'Exports'),
    },
    logger: log,
  });
  if (settings.loadNotice) log.warn(`settings: ${settings.loadNotice.message}`);

  const secrets = await SecretStore.open({
    dir: app.getPath('userData'),
    safeStorage,
    logger: log,
  });
  log.info(
    `secrets: backend ${secrets.status.backend}, ${secrets.status.persistent ? 'persistent' : 'session-only'}`,
  );

  const located = await locateFfmpeg({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    env: process.env,
  });
  const ffmpeg: FfmpegLocation | null = located.ok ? located.value : null;
  if (!located.ok) log.error(located.error.message);

  const devOrigin = renderer.devServerUrl ? new URL(renderer.devServerUrl).origin : null;
  protocol.handle(
    MEDIA_SCHEME,
    createMediaHandler({
      registry: projectRoots,
      logger: log,
      allowedOrigins: devOrigin ? [devOrigin] : ['file://', 'null'],
    }),
  );

  const capabilities = new CapabilityService(
    {
      platform: process.platform,
      env: process.env,
      ozonePlatform:
        process.platform === 'linux'
          ? inferOzonePlatform(
              process.env,
              app.commandLine.getSwitchValue('ozone-platform') || null,
            )
          : null,
      secrets: secrets.status,
      encoders: null,
    },
    log,
  );
  capabilities.onChange((report) => router.broadcast('caps.changed', report));

  mediaUtility = startMediaUtility(ffmpeg, log);
  const utility = mediaUtility;
  let ffmpegVersion: string | null = null;
  let ffmpegError: string | null = located.ok ? null : located.error.message;
  let encoders: FfmpegEncoderReport | null = null;
  let encoderProbe: Promise<FfmpegEncoderReport> | null = null;

  const probeEncoders = (): Promise<FfmpegEncoderReport> => {
    encoderProbe ??= utility.runJob({ kind: 'encoders.probe' }).then(
      async (report) => {
        encoders = report;
        await capabilities.setEncoderReport(report);
        return report;
      },
      (error: unknown) => {
        encoderProbe = null;
        throw error;
      },
    );
    return encoderProbe;
  };

  void utility.ready().then(({ ffmpegVersion: version, error }) => {
    ffmpegVersion = version;
    ffmpegError = error ?? ffmpegError;
    if (version) {
      probeEncoders().catch((e: unknown) => log.warn('encoder probe failed', e));
      void utility.measureClockOffset().then((offset) => {
        if (offset) {
          log.info(
            `media utility clock offset ${offset.offsetUs.toFixed(0)} µs (rtt ${offset.rttUs.toFixed(0)} µs)`,
          );
        }
      });
    }
  });

  registerCoreHandlers({
    router,
    capabilities,
    settings,
    probeEncoders,
    writeClipboard: (text) => clipboard.writeText(text),
    // Settings → folders: chosen here, never sent as paths by the renderer (§1.3).
    chooseFolder: async (which, senderId) => {
      const current = settings.get()[which];
      await fs.mkdir(current, { recursive: true }).catch(() => undefined);
      return chooseDirectory(senderId, {
        title: which === 'projectsDir' ? 'Projects folder' : 'Exports folder',
        defaultPath: current,
        properties: ['openDirectory', 'createDirectory'],
      });
    },
    diagnostics: () => ({
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        ffmpeg: ffmpegVersion,
      },
      paths: {
        ffmpeg: ffmpeg?.ffmpeg ?? null,
        ffprobe: ffmpeg?.ffprobe ?? null,
        logFile: log.transports.file.getFile().path,
        userData: app.getPath('userData'),
        projectsDir: settings.get().projectsDir,
      },
      ffmpegError,
      encoders,
      secrets: secrets.status,
      launch: {
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        appPath: app.getAppPath(),
        appImage: process.env.APPIMAGE,
      },
    }),
  });

  const store = new ProjectStore({ registry: projectRoots, logger: log });
  const libraryChanged = (): void => void router.broadcast('library.changed', undefined);
  const platform = (): RecordingInfo['platform'] => ({
    os: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
    ...(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.XDG_SESSION_TYPE === 'x11'
      ? { session: process.env.XDG_SESSION_TYPE }
      : {}),
    ...(process.env.XDG_CURRENT_DESKTOP ? { desktop: process.env.XDG_CURRENT_DESKTOP } : {}),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    ffmpeg: ffmpegVersion ?? 'unknown',
  });
  engineHost = new EngineHost({ router, renderer, logger: log });
  const engine = engineHost;
  const capabilityAvailable = (key: 'ui.excludeFromCapture' | 'audio.system'): boolean =>
    ['available', 'degraded'].includes(
      capabilities.current()?.capabilities[key].state ?? 'unavailable',
    );
  const picker = new RegionPickerHost({
    router,
    renderer,
    logger: log,
    snapshot: async () => (await engine.ensure()).command('engine.snapshot', {}),
    lastRegion: () => settings.get().recorder.lastRegion,
  });
  // X11 with several screens: an in-app picker (R1.53); Wayland uses the portal's own.
  const sourcePicker = new SourcePickerHost({
    renderer,
    logger: log,
    stateFile: path.join(app.getPath('userData'), 'source-picker.json'),
  });
  const controls = new ControlsWindowHost({
    router,
    renderer,
    logger: log,
    minimizeOnStart: () =>
      shouldMinimizeOnStart(
        settings.get().recorder.minimizeControlsOnStart,
        capabilityAvailable('ui.excludeFromCapture'),
      ),
    excludeFromCapture: () => capabilityAvailable('ui.excludeFromCapture'),
  });
  controlsHost = controls;

  // The setup panel's system-audio meter runs only while the recorder is idle (R1.5).
  let systemMonitor = false;
  const setSystemMonitor = (enabled: boolean): void => {
    const next = enabled && capabilityAvailable('audio.system');
    if (next === systemMonitor) return;
    systemMonitor = next;
    utility.monitorSystemAudio(next);
  };
  stopSystemMonitor = () => setSystemMonitor(false);
  utility.onEvent((event) => {
    if (event.type === 'system.level' && event.captureId === null && systemMonitor) {
      router.broadcast('rec.levels', { system: event.peak });
    }
  });

  // The disk monitor's probe; the control channel can override it (R1.17 tests).
  const freeSpace = new FreeSpaceOverride(freeBytes);

  /**
   * Peaks and thumbnails: one low-priority queue for finalize's background pass and the editor's
   * requests (R1.20, R1.44); held while a recording captures.
   */
  const caches = new CacheJobs({ runJob: (job) => utility.runJob(job), logger: log });
  const generateCaches = async (
    projectId: string,
    root: string,
    media: readonly Media[],
  ): Promise<void> => {
    await caches.generateAll(projectId, root, media);
    libraryChanged();
    router.broadcast('media.cachesReady', { projectId });
  };

  const manager = new SessionManager({
    settings,
    store,
    utility,
    engine: () => engine.ensure(),
    // Cancelling the portal returns to the panel without an error (R1.8).
    selectScreen: () =>
      selectScreenSource(
        (options) => desktopCapturer.getSources(options),
        {
          fps: settings.get().recorder.fps,
          portal: usesPortal,
          ...screenPickerOptions({
            portal: usesPortal,
            commandLine: app.commandLine,
            choose: (sources, initialId) => sourcePicker.choose(sources, initialId),
          }),
        },
        log,
      ),
    pickRegion: (source) => picker.pick(source),
    systemAudioAvailable: () => capabilityAvailable('audio.system'),
    systemAudioOutputLatencyUs: () => estimateSinkOutputLatencyUs(defaultExec),
    platform,
    appVersion: app.getVersion(),
    logger: log,
    freeBytes: freeSpace.probe,
    generateCaches,
    events: {
      state: (payload) => {
        caches.setHeld(isActive(payload.state) && payload.state !== 'finalizing');
        if (isActive(payload.state)) setSystemMonitor(false);
        if (payload.state !== 'picking-region') picker.cancel();
        router.broadcast('rec.state', payload);
        controls.onState(payload.state);
        trayStateValue = trayState(payload.state);
        tray?.setState(trayStateValue);
        if (!['recording', 'paused'].includes(payload.state)) void metrics.stop();
        harness?.broadcast('state', { ...payload, root: sessionManager?.activeRoot ?? null });
      },
      stats: (payload) => {
        router.broadcast('rec.stats', payload);
        // Engine stats flow once the project folder exists: sample that session.
        const root = sessionManager?.activeRoot ?? null;
        const sessionId = sessionManager?.sessionId ?? null;
        if (root && sessionId && metrics.root !== root) {
          metrics.start(root, sessionId);
          harness?.broadcast('session', { root, sessionId });
        }
        metrics.noteStats(payload);
        harness?.broadcast('stats', payload);
      },
      notice: (payload) => {
        router.broadcast('rec.notice', payload);
        harness?.broadcast('notice', payload);
      },
      levels: (payload) => void router.broadcast('rec.levels', payload),
      libraryChanged,
      projectReady: ({ projectId, root, name, afterRecording }) => {
        // R1.20: the editor opens unless "After recording" is "show in library".
        log.info(`recording: project ${projectId} ready at ${root} (after: ${afterRecording})`);
        harness?.broadcast('project-ready', { projectId, root, name, afterRecording });
        // Saved because the app is quitting (F-7): nothing to open.
        if (quitGuard.isQuitting) return;
        const openEditor = (): void => void editorHost.open(projectId);
        if (afterRecording === 'open-editor') openEditor();
        else showShell();
        router.broadcast('rec.completed', { projectId, name, afterRecording });
        if (Notification.isSupported()) {
          const notification = new Notification({ title: 'Recording saved', body: name });
          notification.on('click', openEditor);
          notification.show();
        }
      },
    },
  });
  sessionManager = manager;
  manager.attach(actionBus);
  engine.onStats((payload) => manager.onEngineStats(payload));
  engine.onLevels((payload) => manager.onEngineLevels(payload));
  engine.onTrackEnded((payload) => manager.onTrackEnded(payload));
  engine.onGone((reason) => {
    if (isActive(manager.state)) void manager.reportFatal(`The capture engine ${reason}.`);
  });

  const library = new Library({
    store,
    projectsDir: () => settings.get().projectsDir,
    trashItem: (fullPath) => shell.trashItem(fullPath),
    showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
    openPath: (fullPath) => shell.openPath(fullPath),
    busyRoots: () => (manager.activeRoot ? [manager.activeRoot] : []),
    importedRoots: () => settings.get().library.importedRoots,
    setImportedRoots: async (importedRoots) => {
      await settings.patch({ library: { importedRoots } });
    },
    logger: log,
  });
  const recovery = new RecoveryService({
    store,
    utility,
    generateCaches,
    projectsDir: () => settings.get().projectsDir,
    trashItem: (fullPath) => shell.trashItem(fullPath),
    appVersion: app.getVersion(),
    platform,
    activeRoot: () => manager.activeRoot,
    logger: log,
  });
  registerSessionHandlers({
    router,
    manager,
    logger: log,
    library,
    store,
    recovery,
    libraryChanged,
    monitorSystem: (enabled) => {
      if (!enabled || !isActive(manager.state)) setSystemMonitor(enabled);
    },
    chooseImportFolder: (senderId) =>
      chooseDirectory(senderId, {
        title: 'Import a Capture Studio project (.cstudio folder)',
        defaultPath: settings.get().projectsDir,
        properties: ['openDirectory'],
      }),
  });

  const editorMedia = new EditorMedia({
    store,
    findRoot: (id) => library.findRoot(id),
    caches,
    chooseFile: async (media, senderId) => {
      const sender = webContents.fromId(senderId);
      const parent = sender ? ElectronWindow.fromWebContents(sender) : null;
      const options: Electron.OpenDialogOptions = {
        title: `Relink ${media.path}`,
        properties: ['openFile'],
        filters: [
          media.kind === 'video'
            ? { name: 'Video', extensions: ['mp4', 'm4v', 'webm', 'mkv', 'mov'] }
            : { name: 'Audio', extensions: ['mp4', 'm4a', 'webm', 'ogg', 'opus', 'wav'] },
        ],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    logger: log,
  });
  registerEditorHandlers({
    router,
    media: editorMedia,
    openEditor: async (id) => {
      if (!(await library.findRoot(id))) throw new Error(`project ${id} was not found`);
      editorHost.open(id);
    },
  });

  exportService = registerExportHandlers({
    router,
    runExport: (job, options) => utility.runJob(job, options),
    checkMedia: (root, doc) => markMediaPresence(root, doc),
    findRoot: (id) => library.findRoot(id),
    readProject: async (root) => (await store.read(root))?.doc ?? null,
    settings: () => settings.get(),
    probeEncoders,
    showSaveDialog: async ({ defaultPath, senderId }) => {
      const sender = webContents.fromId(senderId);
      const parent = sender ? ElectronWindow.fromWebContents(sender) : null;
      const options: Electron.SaveDialogOptions = {
        title: 'Export video',
        defaultPath,
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
    openPath: (fullPath) => shell.openPath(fullPath),
    logger: log,
  });

  const caps = await capabilities.refresh();
  if (caps.capabilities['ui.tray'].state === 'available')
    tray = createTray(actionBus, {
      // Abort's confirmation can be turned off in Settings (R1.12); Restart always asks.
      shouldConfirm: (kind) => kind === 'restart' || settings.get().recorder.confirmAbort,
    });

  if (harnessSocket) {
    harness = new HarnessChannel({
      socketPath: harnessSocket,
      logger: log,
      handlers: harnessCommands({
        status: () => ({
          ...manager.status(),
          root: manager.activeRoot,
          pid: process.pid,
          projectsDir: settings.get().projectsDir,
          tray: { present: tray !== null, state: trayStateValue },
          freeBytesOverride: freeSpace.current,
        }),
        dispatch: (type) => actionBus.dispatch({ type, source: 'cli' }),
        settings,
        freeSpace,
        recovery: {
          list: () => recovery.list(),
          recover: async (id) => {
            const result = await recovery.recover(id);
            libraryChanged();
            return result;
          },
        },
        openEditor: async (id) => {
          if (!(await library.findRoot(id))) throw new Error(`project ${id} was not found`);
          editorHost.open(id);
        },
        metrics: () => metrics.snapshot(),
        capabilities: () => capabilities.current(),
        closeShell: () => shellWindow?.close(),
        // Harness quits never wait for a dialog: a recording is saved.
        quit: () => quitGuard.quitWithoutAsking(),
      }),
    });
    await harness.start().catch((error: unknown) => {
      log.error('harness: control channel failed to start', error);
      harness = null;
    });
  }

  showShell();
  if (cli.action) actionBus.dispatch({ type: cli.action, source: 'cli' });
}

const secondInstanceData: SecondInstanceData = { action: cli.action };

if (relaunchX11 || !app.requestSingleInstanceLock(secondInstanceData)) {
  // Relaunching for X11, or another instance is running: it receives our action through
  // 'second-instance' (R1.2).
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _cwd, additionalData) => {
    const forwarded = SecondInstanceDataSchema.safeParse(additionalData);
    const action = forwarded.success ? forwarded.data.action : parseCliArgs(argv).action;
    if (!app.isReady()) return;
    if (action) actionBus.dispatch({ type: action, source: 'cli' });
    else showShell();
  });

  app.on('window-all-closed', () => {
    // With a tray the app keeps running in it; without one, closing the window quits (R1.3).
    if (!tray) quitGuard.quitInteractively();
  });

  // A recording in progress is saved, discarded or kept first (F-7); then editors save their
  // last edits before the app quits (R1.28).
  app.on('before-quit', (event) => {
    if (!quitGuard.isQuitting)
      log.info(`quit requested (recorder ${sessionManager?.state ?? 'idle'})`);
    if (!quitGuard.beforeQuit(event)) return;
    if (editorHost.isReleased || editorHost.openProjects.length === 0) return;
    event.preventDefault();
    void editorHost.releaseForQuit().then(() => app.quit());
  });

  app.on('will-quit', () => {
    void metrics.stop();
    void harness?.close();
    tray?.destroy();
    controlsHost?.dispose();
    sessionManager?.dispose();
    engineHost?.dispose();
    exportService?.dispose();
    mediaUtility?.stop();
    router.dispose();
  });

  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      log.error('startup failed', error);
      app.exit(1);
    });
}
