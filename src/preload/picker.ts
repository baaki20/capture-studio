/** Preload for the region picker window (R1.9). Sandboxed. */
import { contextBridge } from 'electron';
import type { PickerPreloadApi } from '../shared/ipc/preload-api';
import { invoke, preloadBase } from './bridge';

const api: PickerPreloadApi = {
  ...preloadBase(),
  settings: {
    get: () => invoke('settings.get'),
  },
  load: () => invoke('picker.load'),
  submit: (selection) => invoke('picker.submit', selection),
  cancel: () => invoke('picker.cancel'),
};

contextBridge.exposeInMainWorld('csPicker', api);
