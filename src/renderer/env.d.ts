/// <reference types="vite/client" />
import type {
  ControlsPreloadApi,
  EditorPreloadApi,
  EnginePreloadApi,
  PickerPreloadApi,
  ShellPreloadApi,
} from '../shared/ipc/preload-api';

declare global {
  /** Each global exists only in its own window (see `shared/ipc/preload-api.ts`). */
  interface Window {
    readonly captureStudio: ShellPreloadApi;
    readonly csControls: ControlsPreloadApi;
    readonly csPicker: PickerPreloadApi;
    readonly csEditor: EditorPreloadApi;
    readonly csEngine: EnginePreloadApi;
  }
}
