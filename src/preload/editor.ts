/** Preload for the editor window. Sandboxed. */
import { contextBridge } from 'electron';
import type { EditorPreloadApi } from '../shared/ipc/preload-api';
import { invoke, preloadBase, subscribe } from './bridge';

const api: EditorPreloadApi = {
  ...preloadBase(),
  caps: {
    get: () => invoke('caps.get'),
    onChanged: (listener) => subscribe('caps.changed', listener),
  },
  settings: {
    get: () => invoke('settings.get'),
    patch: (patch) => invoke('settings.patch', patch),
  },
  project: {
    open: (id) => invoke('project.open', { id }),
    save: (request) => invoke('project.save', request),
    relink: (id, mediaId) => invoke('project.relink', { id, mediaId }),
    reveal: (id) => invoke('library.reveal', { id }),
  },
  media: {
    peaks: (projectId, mediaId) => invoke('media.peaks', { projectId, mediaId }),
    thumbs: (projectId, mediaId) => invoke('media.thumbs', { projectId, mediaId }),
    onCachesReady: (listener) => subscribe('media.cachesReady', listener),
  },
  export: {
    probeEncoders: () => invoke('export.probeEncoders'),
    start: (request) => invoke('export.start', request),
    target: (projectId) => invoke('export.target', { projectId }),
    chooseOutput: (projectId) => invoke('export.chooseOutput', { projectId }),
    reveal: (jobId) => invoke('export.reveal', { jobId }),
    open: (jobId) => invoke('export.open', { jobId }),
    cancel: (jobId) => invoke('export.cancel', { jobId }),
    onProgress: (listener) => subscribe('export.progress', listener),
    onDone: (listener) => subscribe('export.done', listener),
    onError: (listener) => subscribe('export.error', listener),
  },
};

contextBridge.exposeInMainWorld('csEditor', api);
