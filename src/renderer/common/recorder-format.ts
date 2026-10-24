/**
 * Formatting for the recorder UI (setup panel and controls window): the elapsed timer, meter
 * levels and frame rates. Pure functions, unit-tested.
 */

const US_PER_SECOND = 1_000_000;

/** The meter's floor: anything quieter shows as empty. */
export const METER_FLOOR_DB = -60;

/** Elapsed recording time as `MM:SS`, or `H:MM:SS` from one hour on (whole seconds, floored). */
export function formatElapsed(us: number): string {
  const total = Math.max(0, Math.floor(us / US_PER_SECOND));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${String(h)}:${String(m).padStart(2, '0')}:${ss}`;
  return `${String(m).padStart(2, '0')}:${ss}`;
}

/**
 * The timer between updates: `elapsedUs` was true at `receivedAtMs`, and keeps running only while
 * recording (pauses are excluded, R1.12).
 */
export function liveElapsedUs(
  elapsedUs: number,
  receivedAtMs: number,
  running: boolean,
  nowMs: number,
): number {
  if (!running) return elapsedUs;
  return elapsedUs + Math.max(0, nowMs - receivedAtMs) * 1000;
}

/** Linear peak (0–1) → dBFS; silence is −Infinity. */
export function peakToDb(peak: number): number {
  return peak > 0 ? 20 * Math.log10(Math.min(1, peak)) : Number.NEGATIVE_INFINITY;
}

/** How full the meter bar is (0–1): linear in dB from `METER_FLOOR_DB` to 0 dBFS. */
export function meterFraction(peak: number, floorDb = METER_FLOOR_DB): number {
  const db = peakToDb(peak);
  if (!Number.isFinite(db) || db <= floorDb) return 0;
  return Math.min(1, (db - floorDb) / -floorDb);
}

/** `-12 dB`, or `-∞ dB` for silence. */
export function formatDb(peak: number): string {
  const db = peakToDb(peak);
  return Number.isFinite(db) ? `${String(Math.round(db))} dB` : '-∞ dB';
}

/** A measured frame rate for display, or a placeholder while it is being measured. */
export function formatFps(fps: number | null): string {
  if (fps === null || !Number.isFinite(fps) || fps <= 0) return 'measuring…';
  return `${fps.toFixed(1)} fps`;
}

/** Dropped-frame ratio as a percentage with one decimal. */
export function formatPercent(ratio: number): string {
  return `${(Math.max(0, ratio) * 100).toFixed(1)} %`;
}
