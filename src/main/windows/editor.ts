/**
 * Editor windows (§1.3, §4.5 steps 16–18): one window per project, opened from the library's
 * "Open" (`editor.open`) and after a recording when "After recording" is "open editor" (R1.20).
 * Opening a project that already has a window focuses it.
 *
 * The page reads the project id from its `?project=` query. Before the window closes, main asks
 * the page to flush its autosave (`window.__csEditorFlush`), waiting at most `FLUSH_TIMEOUT_MS`,
 * so the last edits reach `project.json` (R1.28).
 */
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { Logger } from '../../shared/logger';
import type { IpcRouter } from '../ipc/router';
import { secureWebPreferences } from '../security/web-security';
import { focusWindow, loadRendererPage, type RendererLocation } from './shell';

export const FLUSH_TIMEOUT_MS = 3_000;

export interface EditorHostOptions {
  router: IpcRouter;
  renderer: RendererLocation;
  logger: Logger;
  /** Tests inject a fake window. */
  createWindow?: (location: RendererLocation, projectId: string) => BrowserWindow;
}

export function createEditorWindow(location: RendererLocation, projectId: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'Editor – Capture Studio',
    backgroundColor: '#1b1d22',
    webPreferences: {
      ...secureWebPreferences(path.join(location.preloadDir, 'editor.cjs')),
      additionalArguments: [`--cs-app-version=${app.getVersion()}`],
    },
  });
  window.once('ready-to-show', () => window.show());
  loadRendererPage(window, location, 'editor', { project: projectId });
  return window;
}

export class EditorWindowHost {
  private readonly windows = new Map<string, BrowserWindow>();
  /** Set once every window was flushed for quitting; close handlers then let windows go. */
  private released = false;

  constructor(private readonly options: EditorHostOptions) {}

  /** True once `releaseForQuit` has run: windows close without flushing again. */
  get isReleased(): boolean {
    return this.released;
  }

  /** The open editor windows' project ids. */
  get openProjects(): string[] {
    return [...this.windows.keys()];
  }

  /** Opens (or focuses) the editor for a project. */
  open(projectId: string): BrowserWindow {
    const existing = this.windows.get(projectId);
    if (existing && !existing.isDestroyed()) {
      focusWindow(existing);
      return existing;
    }
    const window = (this.options.createWindow ?? createEditorWindow)(
      this.options.renderer,
      projectId,
    );
    this.windows.set(projectId, window);
    const unregister = this.options.router.registerWindow(window.webContents, 'editor');
    let flushed = false;
    window.on('close', (event) => {
      if (flushed || this.released || window.webContents.isDestroyed()) return;
      event.preventDefault();
      flushed = true;
      void this.flush(window).finally(() => {
        if (!window.isDestroyed()) window.close();
      });
    });
    window.on('closed', () => {
      unregister();
      if (this.windows.get(projectId) === window) this.windows.delete(projectId);
    });
    this.options.logger.info(`editor: opened ${projectId}`);
    return window;
  }

  /**
   * Before quitting: saves every editor page, then lets the windows close without asking again.
   * Resolves at once (false) when there is nothing to flush.
   */
  async releaseForQuit(): Promise<boolean> {
    if (this.released || this.windows.size === 0) {
      this.released = true;
      return false;
    }
    await Promise.all([...this.windows.values()].map((w) => this.flush(w)));
    this.released = true;
    return true;
  }

  private async flush(window: BrowserWindow): Promise<void> {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), FLUSH_TIMEOUT_MS),
    );
    try {
      const result: unknown = await Promise.race([
        window.webContents.executeJavaScript(
          'typeof window.__csEditorFlush === "function" ? window.__csEditorFlush() : null',
          true,
        ),
        timeout,
      ]);
      if (result === 'timeout') this.options.logger.warn('editor: autosave flush timed out');
    } catch (error) {
      this.options.logger.warn('editor: autosave flush failed', error);
    }
  }
}
