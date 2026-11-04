/**
 * Preload for the hidden render window of the frame-render export (§1.7, D4). Sandboxed. It only
 * re-posts main's start message with the frame port to the page (see
 * `shared/ipc/render-window.ts`); the page talks to nothing else.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  RENDER_START_CHANNEL,
  RENDER_START_MESSAGE,
  type RenderStartWindowMessage,
} from '../shared/ipc/render-window';

/** The isolated world's `window` (the preload tsconfig has no DOM types). */
const isolatedWindow = globalThis as unknown as {
  postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void;
};

ipcRenderer.on(RENDER_START_CHANNEL, (event: IpcRendererEvent, payload: unknown) => {
  const message: RenderStartWindowMessage = { type: RENDER_START_MESSAGE, payload };
  // The page is file:// (or the dev server), so '*' is the only usable target origin; the page
  // checks `event.source === window`.
  isolatedWindow.postMessage(message, '*', event.ports);
});
