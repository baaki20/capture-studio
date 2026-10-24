/**
 * Mapping between a media's reference clock and its file-local time (§1.7, §4.4.1):
 *
 *   fileUs = (refUs − startOffsetUs − syncAdjustUs) / clockRatio
 *
 * The reference clock is the session clock for recorded media and the file's own time for
 * imported media. A sync nudge changes only `syncAdjustUs`, so clip positions never move.
 */
import type { Us } from '../time';

/** The fields of `Media` that define its clock. */
export interface MediaClock {
  startOffsetUs: Us;
  syncAdjustUs: Us;
  clockRatio: number;
  durationUs: Us;
}

/** Exact (unrounded) file-local time in µs. Use for derived values like FFmpeg seconds. */
export function refToFileUsExact(media: MediaClock, refUs: Us): number {
  return (refUs - media.startOffsetUs - media.syncAdjustUs) / media.clockRatio;
}

/** File-local time in integer µs. */
export function refToFileUs(media: MediaClock, refUs: Us): Us {
  return Math.round(refToFileUsExact(media, refUs));
}

/** Reference-clock time in integer µs for a file-local time. */
export function fileToRefUs(media: MediaClock, fileUs: Us): Us {
  return Math.round(fileUs * media.clockRatio + media.startOffsetUs + media.syncAdjustUs);
}

/** File-local seconds, for FFmpeg `trim`/`atrim` arguments. */
export function refToFileSeconds(media: MediaClock, refUs: Us): number {
  return refToFileUsExact(media, refUs) / 1_000_000;
}

/**
 * The media's extent in its reference clock:
 * `[startOffsetUs + syncAdjustUs, startOffsetUs + syncAdjustUs + durationUs × clockRatio]`.
 * The end is rounded to the nearest µs, which absorbs float error in `clockRatio`.
 */
export function mediaRefBounds(media: MediaClock): { startUs: Us; endUs: Us } {
  const startUs = media.startOffsetUs + media.syncAdjustUs;
  return { startUs, endUs: startUs + Math.round(media.durationUs * media.clockRatio) };
}

/** File-local range covered by a clip's `[sourceStartUs, sourceEndUs)`. */
export function clipFileRangeUs(
  media: MediaClock,
  clip: { sourceStartUs: Us; sourceEndUs: Us },
): { startUs: Us; endUs: Us } {
  return {
    startUs: refToFileUs(media, clip.sourceStartUs),
    endUs: refToFileUs(media, clip.sourceEndUs),
  };
}
