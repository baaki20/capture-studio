/**
 * Preload for the hidden capture-engine window (§1.3). Sandboxed.
 *
 * - Commands from main (`engine.acquire`, `engine.start`, …) arrive as `{requestId, payload}`;
 *   the registered handler's result goes back on `engine.reply`.
 * - `engine.ports` MessagePorts are re-posted to the page as a window message, because
 *   contextBridge cannot carry ports (see `shared/ipc/engine-window.ts`).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  EngineCommandChannel,
  EngineCommandEnvelope,
  EngineEventChannel,
  EngineEventPayload,
  EnginePorts,
  EngineReply,
} from '../shared/ipc/contract';
import { ENGINE_PORTS_MESSAGE, type EnginePortsWindowMessage } from '../shared/ipc/engine-window';
import type { EngineCommandHandler, EnginePreloadApi } from '../shared/ipc/preload-api';
import { preloadBase } from './bridge';

function send<C extends EngineEventChannel>(channel: C, payload: EngineEventPayload<C>): void {
  ipcRenderer.send(channel, payload);
}

function reply(message: EngineReply): void {
  send('engine.reply', message);
}

const api: EnginePreloadApi = {
  ...preloadBase(),
  onCommand<C extends EngineCommandChannel>(channel: C, handler: EngineCommandHandler<C>) {
    const listener = (_event: IpcRendererEvent, envelope: EngineCommandEnvelope<C>): void => {
      const { requestId } = envelope;
      Promise.resolve()
        .then(() => handler(envelope.payload))
        .then(
          (value) => reply({ requestId, ok: true, value }),
          (error: unknown) =>
            reply({
              requestId,
              ok: false,
              error: { message: error instanceof Error ? error.message : String(error) },
            }),
        );
    };
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  ready: () => send('engine.ready', undefined),
  sendStats: (stats) => send('engine.stats', stats),
  sendTrackEnded: (event) => send('engine.trackEnded', event),
  sendLevels: (levels) => send('engine.levels', levels),
};

/** The isolated world's `window` (the preload tsconfig has no DOM types). */
const isolatedWindow = globalThis as unknown as {
  postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void;
};

ipcRenderer.on('engine.ports', (event: IpcRendererEvent, payload: EnginePorts) => {
  const message: EnginePortsWindowMessage = { type: ENGINE_PORTS_MESSAGE, payload };
  // The page is file:// (or the dev server), so '*' is the only usable target origin; the page
  // must check `event.source === window`.
  isolatedWindow.postMessage(message, '*', event.ports);
});

contextBridge.exposeInMainWorld('csEngine', api);
