/**
 * The waveform peaks cache format (R1.44): `cache/<mediaId>.peaks` holds little-endian Int16
 * `[min, max]` pairs, one pair per 10 ms of the file, with no header. Written by
 * `utility/media/peaks.ts`; read by the timeline waveform and by silence detection.
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
