/**
 * How the render preload hands the frame-render export's start message and frame port to the
 * render page (as `engine-window.ts` does for the engine): contextBridge cannot carry ports, so
 * the preload re-posts them as a same-window message. Kept free of zod so the preload bundle
 * stays small; the page validates the payload (`RenderStartSchema`).
 */

export const RENDER_START_CHANNEL = 'render.start';
export const RENDER_START_MESSAGE = 'cs:render.start';

/** `event.data` of the window message; the frame port is `event.ports[0]`. Check `event.source === window`. */
export interface RenderStartWindowMessage {
  type: typeof RENDER_START_MESSAGE;
  payload: unknown;
}
