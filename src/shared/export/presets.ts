/**
 * Export presets shared by the export dialog and the graph builder (R1.45, §4.3.9 step 6):
 * output size per resolution choice and the x264 preset and CRF per quality.
 */
import type { ExportOptions } from '../ipc/contract';

export type ExportQuality = ExportOptions['quality'];
export type ExportResolution = ExportOptions['resolution'];

/** Preset and CRF per quality (§4.3.9 step 6). */
export const QUALITY_SETTINGS = {
  draft: { preset: 'veryfast', crf: 28 },
  standard: { preset: 'medium', crf: 21 },
  high: { preset: 'slow', crf: 18 },
} as const satisfies Record<ExportQuality, { preset: string; crf: number }>;

/** Rounds to the nearest even integer, at least 2. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Export size for a resolution choice (R1.45): the canvas, or the canvas scaled so its short
 * side is 1080 or 720, aspect preserved, even.
 */
export function exportSize(
  canvas: { width: number; height: number },
  resolution: ExportResolution,
): { width: number; height: number } {
  if (resolution === 'canvas') return { width: canvas.width, height: canvas.height };
  const short = resolution === '1080p' ? 1080 : 720;
  const scale = short / Math.min(canvas.width, canvas.height);
  return { width: even(canvas.width * scale), height: even(canvas.height * scale) };
}
