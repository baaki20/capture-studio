/** Messages between the editor page and the preview worker (`preview.worker.ts`). */
import type { ProjectV1 } from '../../../shared/project/schema';
import type { LumaProbe, PixelCapture } from './compositor-webgl';

export type PreviewRequest =
  | { type: 'init'; canvas: OffscreenCanvas }
  /** The document to render (after every edit) and the `cs-media://` URL of each media. */
  | { type: 'doc'; doc: ProjectV1; mediaUrls: Record<string, string> }
  /** Render timeline time `tUs`; `playing` lets the worker decode ahead and skip late frames. */
  | { type: 'render'; tUs: number; playing: boolean }
  /** Render `tUs` now and report the picture's luma (tests, diagnostics). */
  | { type: 'probe'; id: number; tUs: number }
  /** Render `tUs` now and send the picture back (preview/export parity test, R1.48). */
  | { type: 'capture'; id: number; tUs: number }
  | { type: 'dispose' };

export interface PreviewStats {
  frames: number;
  bytes: number;
  decoders: number;
  inserted: number;
  closed: number;
  /** Frames drawn with a stand-in because the exact one was not decoded yet. */
  inexact: number;
}

export type PreviewEvent =
  | { type: 'ready' }
  /**
   * A frame was drawn for `tUs`; `exact` is false while some layer shows a stand-in. `playing`
   * repeats the request's flag (re-renders after a decoded frame arrives are not playing).
   */
  | { type: 'rendered'; tUs: number; exact: boolean; playing: boolean; stats: PreviewStats }
  | { type: 'probe'; id: number; result: LumaProbe & { exact: boolean } }
  | { type: 'capture'; id: number; result: (PixelCapture & { exact: boolean }) | null }
  | { type: 'media-error'; mediaId: string; message: string }
  | { type: 'error'; message: string };
