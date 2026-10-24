/** Preload for the recording controls window (R1.12). Sandboxed. */
import { contextBridge } from 'electron';
import type { ControlsPreloadApi } from '../shared/ipc/preload-api';
import { invoke, preloadBase, subscribe } from './bridge';

const api: ControlsPreloadApi = {
  ...preloadBase(),
  caps: {
    get: () => invoke('caps.get'),
    onChanged: (listener) => subscribe('caps.changed', listener),
  },
  settings: {
    get: () => invoke('settings.get'),
    patch: (patch) => invoke('settings.patch', patch),
  },
  rec: {
    pause: () => invoke('rec.pause'),
    resume: () => invoke('rec.resume'),
    stop: () => invoke('rec.stop'),
    restart: () => invoke('rec.restart'),
    abort: () => invoke('rec.abort'),
    status: () => invoke('rec.status'),
    onState: (listener) => subscribe('rec.state', listener),
    onStats: (listener) => subscribe('rec.stats', listener),
    onNotice: (listener) => subscribe('rec.notice', listener),
    onLevels: (listener) => subscribe('rec.levels', listener),
  },
};

contextBridge.exposeInMainWorld('csControls', api);
