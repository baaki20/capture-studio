/**
 * Waveform peaks (R1.44): `cache/<mediaId>.peaks` holds little-endian Int16 `[min, max]` pairs,
 * one pair per 10 ms of the file (`utility/media/peaks.ts`). These helpers fold them into one
 * `[min, max]` per pixel column for a clip's file range. Pure.
 */
export const PEAK_WINDOW_US = 10_000;

/** Parses the peaks file (an even number of Int16 values). */
export function parsePeaks(bytes: ArrayBuffer): Int16Array {
  const count = Math.floor(bytes.byteLength / 4) * 2;
  const view = new DataView(bytes);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/**
 * `[min, max]` per column (−1..1) for the file range `[fromFileUs, toFileUs)` split into
 * `columns` equal parts. Columns outside the file are 0.
 */
export function columnPeaks(
  peaks: Int16Array,
  fromFileUs: number,
  toFileUs: number,
  columns: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, columns) * 2);
  const pairs = peaks.length / 2;
  if (columns <= 0 || pairs === 0 || toFileUs <= fromFileUs) return out;
  const span = (toFileUs - fromFileUs) / columns;
  for (let c = 0; c < columns; c++) {
    const a = Math.max(0, Math.floor((fromFileUs + c * span) / PEAK_WINDOW_US));
    const b = Math.min(
      pairs,
      Math.max(a + 1, Math.ceil((fromFileUs + (c + 1) * span) / PEAK_WINDOW_US)),
    );
    let min = 0;
    let max = 0;
    for (let i = a; i < b; i++) {
      min = Math.min(min, peaks[i * 2] ?? 0);
      max = Math.max(max, peaks[i * 2 + 1] ?? 0);
    }
    out[c * 2] = min / 32768;
    out[c * 2 + 1] = max / 32767;
  }
  return out;
}
