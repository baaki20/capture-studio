/** Form helpers of the Settings view (kept apart from the component so they are unit-tested). */
import { makeFileName } from '../../shared/naming/name-pattern';

export const GB = 1e9;
export const MB = 1e6;

/** Disk thresholds as typed (GB for the warning, MB for the stop), checked before saving. */
export function parseDiskThresholds(
  warnGb: string,
  stopMb: string,
): { warnBytes: number; stopBytes: number } | string {
  const warn = Number(warnGb);
  const stop = Number(stopMb);
  if (warnGb.trim() === '' || !Number.isFinite(warn) || warn < 0) {
    return 'The warning threshold must be a number of GB.';
  }
  if (stopMb.trim() === '' || !Number.isFinite(stop) || stop < 0) {
    return 'The stop threshold must be a number of MB.';
  }
  const warnBytes = Math.round(warn * GB);
  const stopBytes = Math.round(stop * MB);
  if (stopBytes >= warnBytes) return 'The stop threshold must be below the warning threshold.';
  return { warnBytes, stopBytes };
}

/** The folder name a pattern gives right now, or null for an empty pattern. */
export function namePreview(pattern: string, increment: number, now = new Date()): string | null {
  if (pattern.trim() === '') return null;
  return `${makeFileName(pattern, { now, increment }).text}.cstudio`;
}
