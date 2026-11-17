/**
 * On-screen overlay windows (P3 step 6, plan §1.6): transparent, click-through, always-on-top
 * windows that cover the recorded display.
 *
 * - **Recording frame** (Region mode): a dashed border just outside the region while recording,
 *   so the user sees what is recorded. It is excluded from capture where `ui.excludeFromCapture`
 *   is available; elsewhere it still never shows in a cropped recording, because it is drawn
 *   outside the region.
 * - **Live highlighter** (D11, off by default): a circle around the pointer, polled at 60 Hz. It
 *   is meant to be recorded, so it is never excluded from capture.
 *
 * Both need a display to cover (`displayId`), so neither appears on Wayland, where apps cannot
 * place windows on a given monitor.
 */
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { OverlayState } from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';
import type { NRect } from '../../shared/project/schema';
import type { IpcRouter } from '../ipc/router';
import { secureWebPreferences } from '../security/web-security';
import { loadRendererPage, type RendererLocation } from './shell';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How often the highlighter follows the pointer. */
export const HIGHLIGHTER_HZ = 60;

/** What is being recorded, for the overlays; null while nothing is. */
export interface OverlayCapture {
  /** The recorded display in DIPs (`screen.getAllDisplays()`). */
  display: Rect;
  /** The source frame in pixels, which the region is in. */
  source: { width: number; height: number };
  /** Region mode's rectangle in source pixels; null for the full frame. */
  region: NRect | null;
  highlighter: boolean;
}

/** The region in the overlay window's CSS pixels (the window covers the display). */
export function frameRect(
  capture: Pick<OverlayCapture, 'display' | 'source' | 'region'>,
): Rect | null {
  const { region, display, source } = capture;
  if (!region) return null;
  const sx = display.width / source.width;
  const sy = display.height / source.height;
  return {
    x: region.x * sx,
    y: region.y * sy,
    width: region.width * sx,
    height: region.height * sy,
  };
}

/** The pointer in the window's CSS pixels, or null when it is on another display. */
export function cursorInDisplay(
  point: { x: number; y: number },
  display: Rect,
): { x: number; y: number } | null {
  const x = point.x - display.x;
  const y = point.y - display.y;
  if (x < 0 || y < 0 || x >= display.width || y >= display.height) return null;
  return { x, y };
}

export interface OverlayWindowLike {
  readonly webContents: {
    readonly id: number;
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
  setIgnoreMouseEvents(ignore: boolean): void;
  setContentProtection(enable: boolean): void;
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void;
  showInactive(): void;
  once(event: 'ready-to-show', listener: () => void): unknown;
  isDestroyed(): boolean;
  destroy(): void;
}

export function createOverlayWindow(location: RendererLocation, bounds: Rect): BrowserWindow {
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    enableLargerThanScreen: true,
    title: 'Capture Studio overlay',
    webPreferences: {
      ...secureWebPreferences(path.join(location.preloadDir, 'overlay.cjs')),
      additionalArguments: [`--cs-app-version=${app.getVersion()}`],
    },
  });
  loadRendererPage(window, location, 'overlay');
  return window;
}

export interface OverlayHostOptions {
  router: Pick<IpcRouter, 'registerWindow' | 'send'>;
  renderer: RendererLocation;
  logger: Logger;
  /** `ui.excludeFromCapture` is available (the frame then stays out of every recording). */
  excludeFromCapture: () => boolean;
  /** `screen.getCursorScreenPoint()` (DIPs). */
  cursorPoint: () => { x: number; y: number };
  /** Tests inject fakes. */
  createWindow?: (location: RendererLocation, bounds: Rect) => OverlayWindowLike;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface Shown {
  window: OverlayWindowLike;
  unregister: () => void;
  state: OverlayState;
  ready: boolean;
}

export class RecordingOverlays {
  private frame: Shown | null = null;
  private highlighter: Shown | null = null;
  private timer: unknown = null;
  private key: string | null = null;

  constructor(private readonly options: OverlayHostOptions) {}

  /** Shows the overlays for a capture, or hides them (null). Repeated calls are cheap. */
  update(capture: OverlayCapture | null): void {
    const key = capture ? JSON.stringify(capture) : null;
    if (key === this.key) return;
    this.key = key;
    this.hide();
    if (!capture) return;
    const rect = frameRect(capture);
    if (rect) {
      this.frame = this.open(capture.display, { frame: rect, cursor: null }, true);
      this.options.logger.info('overlays: recording frame shown');
    }
    if (capture.highlighter) {
      const highlighter = this.open(capture.display, { frame: null, cursor: null }, false);
      this.highlighter = highlighter;
      const every =
        this.options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
      this.timer = every(() => {
        const cursor = cursorInDisplay(this.options.cursorPoint(), capture.display);
        const last = highlighter.state.cursor;
        if (cursor?.x === last?.x && cursor?.y === last?.y) return;
        this.push(highlighter, { frame: null, cursor });
      }, 1000 / HIGHLIGHTER_HZ);
      this.options.logger.info('overlays: live highlighter on');
    }
  }

  hide(): void {
    if (this.timer !== null) {
      const clear =
        this.options.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
      clear(this.timer);
      this.timer = null;
    }
    for (const shown of [this.frame, this.highlighter]) {
      if (!shown) continue;
      shown.unregister();
      if (!shown.window.isDestroyed()) shown.window.destroy();
    }
    this.frame = null;
    this.highlighter = null;
  }

  dispose(): void {
    this.key = null;
    this.hide();
  }

  private open(display: Rect, state: OverlayState, protect: boolean): Shown {
    const window = (this.options.createWindow ?? createOverlayWindow)(
      this.options.renderer,
      display,
    );
    const unregister = this.options.router.registerWindow(window.webContents, 'overlay');
    window.setIgnoreMouseEvents(true);
    window.setAlwaysOnTop(true, 'screen-saver');
    if (protect && this.options.excludeFromCapture()) window.setContentProtection(true);
    const shown: Shown = { window, unregister, state, ready: false };
    window.once('ready-to-show', () => {
      shown.ready = true;
      window.showInactive();
      this.push(shown, shown.state);
    });
    return shown;
  }

  private push(shown: Shown, state: OverlayState): void {
    shown.state = state;
    if (!shown.ready || shown.window.isDestroyed()) return;
    this.options.router.send(shown.window.webContents, 'overlay.state', state);
  }
}
