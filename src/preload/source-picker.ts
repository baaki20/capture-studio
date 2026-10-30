/** Preload for the screen-source picker window (R1.53). Sandboxed. */
import { contextBridge, ipcRenderer } from 'electron';
import {
  SOURCE_PICKER_CHANNELS,
  type SourcePickerLoad,
  type SourcePickerPreloadApi,
} from '../shared/ipc/source-picker';

const api: SourcePickerPreloadApi = {
  load: () => ipcRenderer.invoke(SOURCE_PICKER_CHANNELS.load) as Promise<SourcePickerLoad>,
  choose: async (id) => {
    await ipcRenderer.invoke(SOURCE_PICKER_CHANNELS.choose, { id });
  },
  cancel: async () => {
    await ipcRenderer.invoke(SOURCE_PICKER_CHANNELS.cancel);
  },
};

contextBridge.exposeInMainWorld('csSourcePicker', api);
