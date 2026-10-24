/**
 * Helpers shared by the sandboxed preloads. Only types come from the contract, so no zod is
 * bundled here; main validates every payload (`main/ipc/router.ts`).
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
} from '../shared/ipc/contract';
import type { PreloadBase, Unsubscribe } from '../shared/ipc/preload-api';

const APP_VERSION_ARG = '--cs-app-version=';

export function preloadBase(): PreloadBase {
  return {
    platform: process.platform,
    versions: {
      app:
        process.argv.find((a) => a.startsWith(APP_VERSION_ARG))?.slice(APP_VERSION_ARG.length) ??
        'unknown',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  };
}

export function invoke<C extends InvokeChannel>(
  channel: C,
  ...payload: undefined extends InvokeRequest<C> ? [] : [InvokeRequest<C>]
): Promise<InvokeResponse<C>> {
  return ipcRenderer.invoke(channel, ...payload) as Promise<InvokeResponse<C>>;
}

export function subscribe<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void,
): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, payload: EventPayload<C>): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}
