/** Preload for the on-screen overlay windows (P3 step 6): state from main only. Sandboxed. */
import { contextBridge } from 'electron';
import type { OverlayPreloadApi } from '../shared/ipc/preload-api';
import { preloadBase, subscribe } from './bridge';

const api: OverlayPreloadApi = {
  ...preloadBase(),
  onState: (listener) => subscribe('overlay.state', listener),
};

contextBridge.exposeInMainWorld('csOverlay', api);
