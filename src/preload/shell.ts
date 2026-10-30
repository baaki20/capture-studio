/**
 * Preload for the shell window (library, setup, settings, diagnostics). Runs sandboxed: only
 * `contextBridge`/`ipcRenderer` and a reduced `process` are available.
 */
import { contextBridge } from 'electron';
import type { ShellPreloadApi } from '../shared/ipc/preload-api';
import { invoke, preloadBase, subscribe } from './bridge';

const api: ShellPreloadApi = {
  ...preloadBase(),
  caps: {
    get: () => invoke('caps.get'),
    refresh: () => invoke('caps.refresh'),
    onChanged: (listener) => subscribe('caps.changed', listener),
  },
  settings: {
    get: () => invoke('settings.get'),
    patch: (patch) => invoke('settings.patch', patch),
    chooseFolder: (which) => invoke('settings.chooseFolder', { which }),
    takeLoadNotice: () => invoke('settings.takeLoadNotice'),
  },
  rec: {
    configure: (config) => invoke('rec.configure', config),
    record: () => invoke('rec.record'),
    pause: () => invoke('rec.pause'),
    resume: () => invoke('rec.resume'),
    stop: () => invoke('rec.stop'),
    restart: () => invoke('rec.restart'),
    abort: () => invoke('rec.abort'),
    status: () => invoke('rec.status'),
    monitorSystem: (enabled) => invoke('rec.monitorSystem', { enabled }),
    onState: (listener) => subscribe('rec.state', listener),
    onStats: (listener) => subscribe('rec.stats', listener),
    onNotice: (listener) => subscribe('rec.notice', listener),
    onLevels: (listener) => subscribe('rec.levels', listener),
    onCompleted: (listener) => subscribe('rec.completed', listener),
  },
  library: {
    list: () => invoke('library.list'),
    rename: (id, name) => invoke('library.rename', { id, name }),
    trash: (id) => invoke('library.trash', { id }),
    reveal: (id) => invoke('library.reveal', { id }),
    import: () => invoke('library.import'),
    openFolder: () => invoke('library.openFolder'),
    onChanged: (listener) => subscribe('library.changed', () => listener()),
  },
  project: {
    open: (id) => invoke('project.open', { id }),
    edit: (id) => invoke('editor.open', { id }),
  },
  recovery: {
    list: () => invoke('recovery.list'),
    recover: (id) => invoke('recovery.recover', { id }),
    discard: (id, action) => invoke('recovery.discard', { id, action }),
  },
  diag: {
    get: () => invoke('diag.get'),
    copyReport: () => invoke('diag.copyReport'),
  },
};

contextBridge.exposeInMainWorld('captureStudio', api);
