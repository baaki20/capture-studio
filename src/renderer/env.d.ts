/// <reference types="vite/client" />
import type {
  ControlsPreloadApi,
  EditorPreloadApi,
  EnginePreloadApi,
  PickerPreloadApi,
  ShellPreloadApi,
} from '../shared/ipc/preload-api';
import type { ProjectV1 } from '../shared/project/schema';

/**
 * Editor diagnostics and test hooks (editor window only, set by `editor/App.tsx`). They expose
 * nothing the page does not already have.
 */
interface EditorDebugApi {
  /** The current project document. */
  doc(): ProjectV1 | null;
  ui(): { playheadUs: number; playing: boolean; selection: string[]; snapping: boolean };
  /** Renders the playhead (or `tUs`) and measures the preview picture. */
  probePreview(tUs?: number): Promise<{ meanLuma: number; nonBlack: number; exact: boolean }>;
  saveStatus(): string;
}

declare global {
  /** Each global exists only in its own window (see `shared/ipc/preload-api.ts`). */
  interface Window {
    readonly captureStudio: ShellPreloadApi;
    readonly csControls: ControlsPreloadApi;
    readonly csPicker: PickerPreloadApi;
    readonly csEditor: EditorPreloadApi;
    readonly csEngine: EnginePreloadApi;
    csEditorDebug?: EditorDebugApi;
    /** Main calls it (executeJavaScript) before closing an editor window: saves now. */
    __csEditorFlush?: () => Promise<void>;
  }
}
