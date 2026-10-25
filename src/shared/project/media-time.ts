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
 * Where the media's content lies in its reference clock, with the sync nudge applied:
 * `[startOffsetUs + syncAdjustUs, startOffsetUs + syncAdjustUs + durationUs × clockRatio]`.
 * The end is rounded to the nearest µs, which absorbs float error in `clockRatio`.
 *
 * Rendering uses it: where a clip's reference range falls outside these bounds (a nudge pushed
 * an edge past the file), the render plan draws nothing and plays silence (`render-plan.ts`).
 */
export function mediaRefBounds(media: MediaClock): { startUs: Us; endUs: Us } {
  const startUs = media.startOffsetUs + media.syncAdjustUs;
  return { startUs, endUs: startUs + Math.round(media.durationUs * media.clockRatio) };
}

/**
 * The bounds clips are edited and validated against (invariant 2, trims): the media's extent
 * **without** the sync nudge, `[startOffsetUs, startOffsetUs + durationUs × clockRatio]`.
 * A nudge is non-destructive (R1.42): it never trims, moves or invalidates a clip.
 */
export function mediaEditBounds(media: MediaClock): { startUs: Us; endUs: Us } {
  return mediaRefBounds({ ...media, syncAdjustUs: 0 });
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
