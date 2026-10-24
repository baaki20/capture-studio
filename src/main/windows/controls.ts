/**
 * The recording controls window (R1.10–R1.12): a small always-on-top window with the countdown,
 * the elapsed timer, pause/resume, stop, restart and abort, the meters, the dropped-frame
 * indicator and notices. It follows the recorder state (`controls-policy.ts`).
 *
 * The window is part of the screen, so it shows up in a full-screen recording unless it is
 * excluded: where `ui.excludeFromCapture` is available it uses content protection, and otherwise
 * it is minimized when recording starts (R1.11, `minimizeControlsOnStart`). GNOME ignores
 * always-on-top (`ui.alwaysOnTop`); the flag is set anyway.
 */
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { Logger } from '../../shared/logger';
import type { IpcRouter } from '../ipc/router';
import type { RecordingState } from '../recording/state-machine';
import { secureWebPreferences } from '../security/web-security';
import { controlsWindowAction } from './controls-policy';
import { loadRendererPage, type RendererLocation } from './shell';

export interface ControlsHostOptions {
  router: IpcRouter;
  renderer: RendererLocation;
  logger: Logger;
  /** R1.11 decision for the current settings and capabilities. */
  minimizeOnStart: () => boolean;
  /** `ui.excludeFromCapture` is available (content protection). */
  excludeFromCapture: () => boolean;
}

export function createControlsWindow(location: RendererLocation): BrowserWindow {
  const window = new BrowserWindow({
    width: 440,
    height: 200,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    title: 'Recording – Capture Studio',
    backgroundColor: '#1b1d22',
    webPreferences: {
      ...secureWebPreferences(path.join(location.preloadDir, 'controls.cjs')),
      additionalArguments: [`--cs-app-version=${app.getVersion()}`],
    },
  });
  loadRendererPage(window, location, 'controls');
  return window;
}

export class ControlsWindowHost {
  private window: BrowserWindow | null = null;
  private ready = false;
  private previous: RecordingState | null = null;
  /** What the window should look like once its page is ready. */
  private pending: 'show' | 'minimize' | null = null;

  constructor(private readonly options: ControlsHostOptions) {}

  /** Applies a recorder state change. */
  onState(state: RecordingState): void {
    const action = controlsWindowAction(this.previous, state, this.options.minimizeOnStart());
    this.previous = state;
    switch (action) {
      case 'show':
        this.apply('show');
        break;
      case 'minimize':
        this.apply('minimize');
        break;
      case 'hide':
        this.pending = null;
        if (this.window && !this.window.isDestroyed()) this.window.hide();
        break;
      case 'none':
        break;
    }
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private apply(mode: 'show' | 'minimize'): void {
    const window = this.ensure();
    if (!this.ready) {
      this.pending = mode;
      return;
    }
    if (mode === 'show') {
      if (window.isMinimized()) window.restore();
      window.show();
    } else {
      window.minimize();
    }
  }

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = createControlsWindow(this.options.renderer);
    this.window = window;
    this.ready = false;
    const unregister = this.options.router.registerWindow(window.webContents, 'controls');
    if (this.options.excludeFromCapture()) window.setContentProtection(true);
    window.once('ready-to-show', () => {
      this.ready = true;
      const pending = this.pending;
      this.pending = null;
      if (pending) this.apply(pending);
    });
    // Closed by the user mid-recording: it comes back with the next state change (pause from the
    // tray or CLI, finalizing); the tray and `--action` keep working meanwhile.
    window.on('closed', () => {
      unregister();
      if (this.window === window) this.window = null;
    });
    this.options.logger.info('controls: window created');
    return window;
  }
}
