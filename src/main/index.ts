/**
 * Main-process bootstrap: platform switches, sandbox, logging, single instance with `--action`
 * forwarding, security guards, persistent stores, the IPC router, capabilities, the media
 * utility, the `cs-media://` protocol, the recording session manager with the capture engine,
 * the region picker and controls windows, the library and recovery, the tray and the shell
 * window.
 */
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  app,
  BrowserWindow as ElectronWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Notification,
  protocol,
  safeStorage,
  shell,
  webContents,
} from 'electron';
import type { FfmpegEncoderReport } from '../shared/capabilities/types';
import type { RecordingInfo } from '../shared/project/schema';
import { SecondInstanceDataSchema, type SecondInstanceData } from '../shared/ipc/actions';
import { ActionBus } from './action-bus';
import { CapabilityService, defaultExec } from './capabilities/detect';
import { estimateSinkOutputLatencyUs } from './system-audio/linux-latency';
import { inferOzonePlatform } from './capabilities/linux';
import { parseCliArgs } from './cli';
import { pickScreenSource } from './display-media';
import { locateFfmpeg, type FfmpegLocation } from './ffmpeg/locate';
import { registerCoreHandlers } from './ipc/core-handlers';
import { registerEditorHandlers } from './ipc/editor-handlers';
import { registerExportHandlers, type ExportService } from './ipc/export-handlers';
import { IpcRouter } from './ipc/router';
import { registerSessionHandlers } from './ipc/session-handlers';
import { forwardRendererConsole, initLogging } from './logging';
import {
  createMediaHandler,
  MEDIA_SCHEME,
  MEDIA_SCHEME_PRIVILEGES,
  ProjectRootRegistry,
} from './projects/media-protocol';
import { EditorMedia } from './projects/editor-media';
import { Library } from './projects/library';
import { ProjectStore } from './projects/project-store';
import { RecoveryService } from './recording/recovery';
import { SessionManager } from './recording/session-manager';
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
import { createShellWindow, focusWindow, type RendererLocation } from './windows/shell';

// Escape hatch for XWayland when native Wayland misbehaves (§4.7 risk 13). Must run before ready.
if (process.env.CS_FORCE_X11 === '1') {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
/**
 * Test mode (§4.6.3; never in a packaged build): end-to-end tests run on an X11 Electron with
 * fake devices and must never open the ScreenCast portal, so the PipeWire capturer stays off.
 */
const testMode = !app.isPackaged && process.env.CS_TEST === '1';

// Screen capture through the ScreenCast portal on Wayland (§9.1, spike S1; see display-media.ts).
if (process.platform === 'linux' && !testMode)
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

// Tests and development can isolate profile data (settings, logs, single-instance lock).
if (!app.isPackaged && process.env.CS_USER_DATA_DIR) {
  app.setPath('userData', process.env.CS_USER_DATA_DIR);
}

// Every renderer is sandboxed, whatever its webPreferences say (§1.3).
app.enableSandbox();

// Must happen before 'ready' (§4.3.10).
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: MEDIA_SCHEME_PRIVILEGES },
]);

const log = initLogging();
forwardRendererConsole();

const renderer: RendererLocation = {
  ...(process.env.ELECTRON_RENDERER_URL ? { devServerUrl: process.env.ELECTRON_RENDERER_URL } : {}),
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

function trayState(state: RecordingState): TrayRecordingState {
  if (state === 'recording' || state === 'paused') return state;
  return isActive(state) ? 'busy' : 'idle';
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
    // The hidden engine window would keep the app alive: without a tray, closing the main
    // window while idle quits (R1.3).
    if (!tray && !isActive(sessionManager?.state ?? 'idle')) app.quit();
  });
}

actionBus.on(['open-library'], () => showShell());
actionBus.on(['quit'], () => app.quit());
// New recording opens the shell, which hosts the setup panel; the session manager handles the
// recording actions themselves.
actionBus.on(['new-recording'], () => showShell());

const cli = parseCliArgs(process.argv);
if (cli.error) log.warn(`cli: ${cli.error}`);

async function start(): Promise<void> {
  // Needs the default session, so it runs after 'ready' but before any window exists.
  installSecurityGuards(renderer, log);

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

  const manager = new SessionManager({
    settings,
    store,
    utility,
    engine: () => engine.ensure(),
    selectScreen: async () => {
      const pick = await pickScreenSource((options) => desktopCapturer.getSources(options), {
        fps: settings.get().recorder.fps,
      });
      if (pick.status === 'failed') throw new Error(pick.message);
      if (pick.status === 'cancelled') return null;
      return {
        sourceId: pick.screen.sourceId,
        label: pick.source.name,
        maxWidth: pick.screen.maxWidth,
        maxHeight: pick.screen.maxHeight,
      };
    },
    pickRegion: (source) => picker.pick(source),
    systemAudioAvailable: () => capabilityAvailable('audio.system'),
    systemAudioOutputLatencyUs: () => estimateSinkOutputLatencyUs(defaultExec),
    platform,
    appVersion: app.getVersion(),
    logger: log,
    events: {
      state: (payload) => {
        if (isActive(payload.state)) setSystemMonitor(false);
        if (payload.state !== 'picking-region') picker.cancel();
        router.broadcast('rec.state', payload);
        controls.onState(payload.state);
        tray?.setState(trayState(payload.state));
      },
      stats: (payload) => void router.broadcast('rec.stats', payload),
      notice: (payload) => void router.broadcast('rec.notice', payload),
      levels: (payload) => void router.broadcast('rec.levels', payload),
      libraryChanged,
      projectReady: ({ projectId, root, name, afterRecording }) => {
        // R1.20: the editor opens unless "After recording" is "show in library".
        log.info(`recording: project ${projectId} ready at ${root} (after: ${afterRecording})`);
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
    logger: log,
  });
  const recovery = new RecoveryService({
    store,
    utility,
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
    library,
    store,
    recovery,
    libraryChanged,
    monitorSystem: (enabled) => {
      if (!enabled || !isActive(manager.state)) setSystemMonitor(enabled);
    },
  });

  const editorMedia = new EditorMedia({
    store,
    findRoot: (id) => library.findRoot(id),
    runJob: (job) => utility.runJob(job),
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
  if (caps.capabilities['ui.tray'].state === 'available') tray = createTray(actionBus);

  showShell();
  if (cli.action) actionBus.dispatch({ type: cli.action, source: 'cli' });
}

const secondInstanceData: SecondInstanceData = { action: cli.action };

if (!app.requestSingleInstanceLock(secondInstanceData)) {
  // Another instance is running; it receives our action through 'second-instance' (R1.2).
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
    if (!tray) app.quit();
  });

  // Editors save their last edits before the app quits (R1.28).
  app.on('before-quit', (event) => {
    if (editorHost.isReleased || editorHost.openProjects.length === 0) return;
    event.preventDefault();
    void editorHost.releaseForQuit().then(() => app.quit());
  });

  app.on('will-quit', () => {
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
