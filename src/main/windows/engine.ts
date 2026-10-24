/**
 * The hidden capture-engine window (§1.3): sandboxed, context-isolated, never shown, and with
 * `backgroundThrottling: false` so timers and capture keep full rate while it is hidden. It is the
 * only window granted media capture (`allowMediaCapture`).
 *
 * `EngineHost` owns the window and its `EngineLink`: it registers the `engine.*` listeners with the
 * router once, creates the window on demand (`ensure()` resolves after `engine.ready`), and
 * forwards `engine.stats`, `engine.levels` and `engine.trackEnded` to subscribers (the session manager). If the
 * engine crashes or is closed, outstanding commands are rejected and the next `ensure()` starts a
 * fresh window.
 */
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { EngineEventPayload } from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';
import { EngineLink } from '../ipc/engine-link';
import type { IpcRouter } from '../ipc/router';
import { allowMediaCapture, secureWebPreferences } from '../security/web-security';
import type { RendererLocation } from './shell';

export const ENGINE_READY_TIMEOUT_MS = 15_000;

export function createEngineWindow(location: RendererLocation): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    title: 'Capture Studio Engine',
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      ...secureWebPreferences(path.join(location.preloadDir, 'engine.cjs')),
      additionalArguments: [`--cs-app-version=${app.getVersion()}`],
      backgroundThrottling: false,
    },
  });
  if (location.devServerUrl) {
    void window.loadURL(new URL('engine/index.html', `${location.devServerUrl}/`).toString());
  } else {
    void window.loadFile(path.join(location.rendererDir, 'engine', 'index.html'));
  }
  return window;
}

type Listener<T> = (payload: T) => void;

interface EngineInstance {
  window: BrowserWindow;
  link: EngineLink;
  ready: Promise<EngineLink>;
}

export interface EngineHostOptions {
  router: IpcRouter;
  renderer: RendererLocation;
  logger: Logger;
  /** Tests inject a fake window. */
  createWindow?: (location: RendererLocation) => BrowserWindow;
  readyTimeoutMs?: number;
}

export class EngineHost {
  private instance: EngineInstance | null = null;
  private markReady: (() => void) | null = null;
  private readonly statsListeners = new Set<Listener<EngineEventPayload<'engine.stats'>>>();
  private readonly endedListeners = new Set<Listener<EngineEventPayload<'engine.trackEnded'>>>();
  private readonly levelListeners = new Set<Listener<EngineEventPayload<'engine.levels'>>>();
  private readonly goneListeners = new Set<Listener<string>>();

  constructor(private readonly options: EngineHostOptions) {
    const { router } = options;
    router.onEngine('engine.ready', (_payload, context) => {
      if (this.instance?.window.webContents.id === context.senderId) this.markReady?.();
    });
    router.onEngine('engine.reply', (reply, context) => {
      if (this.instance?.window.webContents.id === context.senderId) {
        this.instance.link.handleReply(reply);
      }
    });
    router.onEngine('engine.stats', (payload) => this.emit(this.statsListeners, payload));
    router.onEngine('engine.levels', (payload) => this.emit(this.levelListeners, payload));
    router.onEngine('engine.trackEnded', (payload) => {
      options.logger.warn(
        `engine: ${payload.kind} track ${payload.reason}${payload.message ? `: ${payload.message}` : ''}`,
      );
      this.emit(this.endedListeners, payload);
    });
  }

  /** The engine's link, creating the window if needed; resolves once the page is ready. */
  ensure(): Promise<EngineLink> {
    if (this.instance && !this.instance.window.isDestroyed()) return this.instance.ready;
    return this.spawn().ready;
  }

  /** The current link, or null when no engine window exists. */
  get link(): EngineLink | null {
    return this.instance && !this.instance.window.isDestroyed() ? this.instance.link : null;
  }

  onStats(listener: Listener<EngineEventPayload<'engine.stats'>>): () => void {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  onLevels(listener: Listener<EngineEventPayload<'engine.levels'>>): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  onTrackEnded(listener: Listener<EngineEventPayload<'engine.trackEnded'>>): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  /** Called with a reason when the engine window crashes or closes unexpectedly. */
  onGone(listener: Listener<string>): () => void {
    this.goneListeners.add(listener);
    return () => this.goneListeners.delete(listener);
  }

  /** Closes the engine window (app quit). */
  dispose(): void {
    const instance = this.instance;
    this.instance = null;
    if (!instance) return;
    instance.link.dispose('engine closed');
    if (!instance.window.isDestroyed()) instance.window.destroy();
  }

  private spawn(): EngineInstance {
    const { logger } = this.options;
    const window = (this.options.createWindow ?? createEngineWindow)(this.options.renderer);
    const contents = window.webContents;
    const link = new EngineLink(contents);
    const unregister = this.options.router.registerWindow(contents, 'engine');
    const revokeMedia = allowMediaCapture(contents);

    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const ready = new Promise<EngineLink>((resolve, reject) => {
      resolveReady = () => resolve(link);
      rejectReady = reject;
    });
    const timer = setTimeout(
      () => rejectReady(new Error('the capture engine did not become ready')),
      this.options.readyTimeoutMs ?? ENGINE_READY_TIMEOUT_MS,
    );
    this.markReady = () => {
      clearTimeout(timer);
      resolveReady();
    };

    const gone = (reason: string): void => {
      clearTimeout(timer);
      rejectReady(new Error(`capture engine ${reason}`));
      link.dispose(`capture engine ${reason}`);
      unregister();
      revokeMedia();
      if (this.instance?.window === window) {
        this.instance = null;
        this.emit(this.goneListeners, reason);
      }
    };
    contents.on('render-process-gone', (_event, details) => {
      logger.error(`engine: renderer gone (${details.reason})`);
      gone(`crashed (${details.reason})`);
      if (!window.isDestroyed()) window.destroy();
    });
    window.on('closed', () => gone('closed'));

    const instance: EngineInstance = { window, link, ready };
    this.instance = instance;
    ready.catch((error: unknown) => logger.error('engine: start failed', error));
    return instance;
  }

  private emit<T>(listeners: Set<Listener<T>>, payload: T): void {
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        this.options.logger.error('engine: listener failed', error);
      }
    }
  }
}
