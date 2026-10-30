import type { SourcePickerPreloadApi } from '../../shared/ipc/source-picker';

declare global {
  interface Window {
    /** Only in the source-picker window (`preload/source-picker.ts`). */
    csSourcePicker?: SourcePickerPreloadApi;
  }
}

export {};
