/// <reference types="vite/client" />
import type {
  ControlsPreloadApi,
  EditorPreloadApi,
  EnginePreloadApi,
  PickerPreloadApi,
  ShellPreloadApi,
} from '../shared/ipc/preload-api';
import type { ProjectV1 } from '../shared/project/schema';
import type { AudioCounters } from './editor/audio/scheduler';
import type { PreviewCounterValues } from './editor/preview/playback-counters';

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
  /** Renders `tUs` and returns the composited picture, RGBA top-down, base64 (R1.48 parity). */
  capturePreview(
    tUs: number,
  ): Promise<{ width: number; height: number; exact: boolean; rgbaBase64: string } | null>;
  /** Late video frames and audio underruns since the last reset (§4.6.4). */
  playbackCounters(): {
    video: PreviewCounterValues | null;
    audio: AudioCounters;
  };
  resetPlaybackCounters(): void;
  /** Starts playback at normal speed (from `fromUs` when given); `pause` stops it. */
  play(fromUs?: number): void;
  pause(): void;
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
