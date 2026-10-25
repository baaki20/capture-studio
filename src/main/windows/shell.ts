/** The shell window: library, setup, settings and diagnostics (Phase 1 starts as a minimal shell). */
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { secureWebPreferences } from '../security/web-security';

export interface RendererLocation {
  /** Vite dev-server URL in development (`ELECTRON_RENDERER_URL`). */
  devServerUrl?: string;
  /** Folder holding the built renderer pages. */
  rendererDir: string;
  /** Folder holding the built preload scripts. */
  preloadDir: string;
}

export function createShellWindow(location: RendererLocation): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Capture Studio',
    backgroundColor: '#1b1d22',
    webPreferences: {
      ...secureWebPreferences(path.join(location.preloadDir, 'shell.cjs')),
      additionalArguments: [`--cs-app-version=${app.getVersion()}`],
    },
  });

  window.once('ready-to-show', () => window.show());
  loadRendererPage(window, location, 'shell');
  return window;
}

/** Loads `<page>/index.html` from the dev server or the built renderer folder. */
export function loadRendererPage(
  window: BrowserWindow,
  location: RendererLocation,
  page: 'shell' | 'controls' | 'picker' | 'editor' | 'engine',
  query: Record<string, string> = {},
): void {
  if (location.devServerUrl) {
    const url = new URL(`${page}/index.html`, `${location.devServerUrl}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(path.join(location.rendererDir, page, 'index.html'), { query });
  }
}

export function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
