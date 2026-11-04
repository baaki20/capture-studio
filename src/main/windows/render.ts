/**
 * The hidden render window of the frame-render export (§1.7, D4): one per export, sandboxed,
 * never shown, `backgroundThrottling: false`. Main wires a `MessageChannelMain` between it and
 * the media utility; the window gets the snapshot, the frame spec and one end
 * (`shared/ipc/render-window.ts`), and the utility's end is returned for the export job.
 *
 * Closing the handle destroys the window. If the window crashes or closes, its end of the port
 * closes and the utility fails the export with "The render window closed."
 */
import path from 'node:path';
import { app, BrowserWindow, MessageChannelMain, type MessagePortMain } from 'electron';
import type { RenderStart } from '../../shared/ipc/render-port';
import { RENDER_START_CHANNEL } from '../../shared/ipc/render-window';
import type { Logger } from '../../shared/logger';
import { secureWebPreferences } from '../security/web-security';
import type { RendererLocation } from './shell';

export const RENDER_READY_TIMEOUT_MS = 15_000;

export interface FrameRendererHandle {
  /** The utility's end of the frame port. */
  port: MessagePortMain;
  close(): void;
}

export function createRenderWindow(location: RendererLocation): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    title: 'Capture Studio Render',
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      ...secureWebPreferences(path.join(location.preloadDir, 'render.cjs')),
      additionalArguments: [`--cs-app-version=${app.getVersion()}`],
      backgroundThrottling: false,
    },
  });
  if (location.devServerUrl) {
    void window.loadURL(new URL('render/index.html', `${location.devServerUrl}/`).toString());
  } else {
    void window.loadFile(path.join(location.rendererDir, 'render', 'index.html'));
  }
  return window;
}

/** Opens a render window, waits for its page, and starts it with `start`. */
export async function openFrameRenderer(
  location: RendererLocation,
  start: RenderStart,
  logger: Logger,
  timeoutMs = RENDER_READY_TIMEOUT_MS,
): Promise<FrameRendererHandle> {
  const window = createRenderWindow(location);
  const close = (): void => {
    if (!window.isDestroyed()) window.destroy();
  };
  const contents = window.webContents;
  contents.on('render-process-gone', (_event, details) => {
    logger.warn(`render window gone: ${details.reason}`);
  });
  // Errors and warnings reach the log through `forwardRendererConsole`; this adds the page's
  // summary line (frames, time, inexact frames).
  contents.on('console-message', (event) => {
    if (event.level === 'info') logger.info(`render window: ${event.message}`);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The render window did not load.')),
        timeoutMs,
      );
      contents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      contents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer);
        reject(new Error(`The render window did not load: ${description} (${String(code)}).`));
      });
    });
  } catch (error) {
    close();
    throw error;
  }
  const { port1, port2 } = new MessageChannelMain();
  contents.postMessage(RENDER_START_CHANNEL, start, [port1]);
  return { port: port2, close };
}
