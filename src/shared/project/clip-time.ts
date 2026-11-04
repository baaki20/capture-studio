/**
 * How a clip maps timeline time to its media's reference clock (§1.7), with the v2 speed and
 * freeze-frame fields.
 *
 * A clip covers `[timelineStartUs, timelineStartUs + length)` where `length` is `durationUs`
 * when set and the source length (`sourceEndUs − sourceStartUs`) otherwise. Its speed is
 * `source length / length`, so the source range is stretched over the timeline span:
 *
 *   refUs = sourceStartUs + (tUs − timelineStartUs) × speed      (normal clip)
 *   refUs = sourceStartUs                                          (freeze frame)
 *
 * The timeline length is stored rather than the speed so that timeline positions stay exact
 * integers through splits and cuts: only the source side is rounded, by at most 1 µs.
 * With neither field set this is the Phase 1 mapping exactly.
 *
 * `clipHead` and `clipTail` are the two halves of a clip cut at a timeline time; every edit that
 * cuts a clip (split, cut range) goes through them.
 */
import type { Us } from '../time';
import type { Clip } from './schema';

type ClipTiming = Pick<Clip, 'sourceStartUs' | 'sourceEndUs' | 'durationUs' | 'freeze'>;
type PlacedClip = ClipTiming & Pick<Clip, 'timelineStartUs'>;

/** Speed range (§5 P2). */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** Source (reference-clock) length of the clip. */
export function clipSourceDurationUs(clip: Pick<Clip, 'sourceStartUs' | 'sourceEndUs'>): Us {
  return clip.sourceEndUs - clip.sourceStartUs;
}

/** Length of the clip on the timeline. */
export function clipTimelineDurationUs(clip: ClipTiming): Us {
  return clip.durationUs ?? clipSourceDurationUs(clip);
}

/** Playback speed: 1 for a plain clip, 0 for a freeze frame. */
export function clipSpeed(clip: ClipTiming): number {
  if (clip.freeze) return 0;
  if (clip.durationUs === undefined) return 1;
  return clipSourceDurationUs(clip) / clip.durationUs;
}

/** Exact (unrounded) reference time shown at timeline time `tUs`. */
export function clipRefAtExact(clip: PlacedClip, tUs: Us): number {
  if (clip.freeze) return clip.sourceStartUs;
  const offset = tUs - clip.timelineStartUs;
  if (clip.durationUs === undefined) return clip.sourceStartUs + offset;
  return clip.sourceStartUs + (offset * clipSourceDurationUs(clip)) / clip.durationUs;
}

/** Reference time shown at timeline time `tUs`, in integer µs. */
export function clipRefAt(clip: PlacedClip, tUs: Us): Us {
  return Math.round(clipRefAtExact(clip, tUs));
}

/**
 * Timeline time at which the clip shows reference time `refUs` (the inverse of `clipRefAt`).
 * A freeze frame shows only `sourceStartUs`, at its start.
 */
export function clipTimeAtRef(clip: PlacedClip, refUs: Us): Us {
  if (clip.freeze) return clip.timelineStartUs;
  const offset = refUs - clip.sourceStartUs;
  if (clip.durationUs === undefined) return clip.timelineStartUs + offset;
  return clip.timelineStartUs + Math.round((offset * clip.durationUs) / clipSourceDurationUs(clip));
}

/** `durationUs` for a new timeline length: dropped when it equals the source length. */
function withLength<T extends Clip>(clip: T, lengthUs: Us): T {
  const { durationUs: _old, ...rest } = clip;
  const keep = (clip.freeze ?? false) || clipSourceDurationUs(clip) !== lengthUs;
  return (keep ? { ...rest, durationUs: lengthUs } : rest) as T;
}

/**
 * The part of `clip` before timeline time `tUs` (strictly inside the clip). It keeps the clip's
 * ID, link and transition in, and loses its fade-out.
 */
export function clipHead(clip: Clip, tUs: Us): Clip {
  const length = tUs - clip.timelineStartUs;
  const { fadeOutUs: _fade, ...rest } = clip;
  if (clip.freeze) return withLength(rest, length);
  const sourceEndUs =
    clip.durationUs === undefined ? clip.sourceStartUs + length : clipRefAt(clip, tUs);
  return withLength({ ...rest, sourceEndUs }, length);
}

/**
 * The part of `clip` from timeline time `tUs` (strictly inside the clip) to its end. It keeps the
 * clip's ID and link (callers assign new ones where needed) and loses its transition and fade-in.
 */
export function clipTail(clip: Clip, tUs: Us): Clip {
  const length = clip.timelineStartUs + clipTimelineDurationUs(clip) - tUs;
  const { transitionIn: _transition, fadeInUs: _fade, ...rest } = clip;
  if (clip.freeze) return withLength({ ...rest, timelineStartUs: tUs }, length);
  const sourceStartUs =
    clip.durationUs === undefined
      ? clip.sourceStartUs + (tUs - clip.timelineStartUs)
      : clipRefAt(clip, tUs);
  return withLength({ ...rest, timelineStartUs: tUs, sourceStartUs }, length);
}

/**
 * Latest timeline end the clip can be trimmed out to without its source passing `refEndUs` (the
 * media's edit bound). A freeze frame has no source limit.
 */
export function clipMaxEndUs(clip: PlacedClip, refEndUs: Us): Us {
  if (clip.freeze) return Number.POSITIVE_INFINITY;
  const room = refEndUs - clip.sourceStartUs;
  if (clip.durationUs === undefined) return clip.timelineStartUs + room;
  return clip.timelineStartUs + Math.floor((room * clip.durationUs) / clipSourceDurationUs(clip));
}

/** Earliest timeline start the clip can be trimmed out to without its source passing `refStartUs`. */
export function clipMinStartUs(clip: PlacedClip, refStartUs: Us): Us {
  if (clip.freeze) return Number.NEGATIVE_INFINITY;
  const room = clip.sourceStartUs - refStartUs;
  if (clip.durationUs === undefined) return clip.timelineStartUs - room;
  return clip.timelineStartUs - Math.floor((room * clip.durationUs) / clipSourceDurationUs(clip));
}

/** The clip with its end moved to timeline time `endUs`, at the same speed. */
export function clipWithEnd(clip: Clip, endUs: Us): Clip {
  const length = endUs - clip.timelineStartUs;
  if (clip.freeze) return withLength(clip, length);
  if (clip.durationUs === undefined) return { ...clip, sourceEndUs: clip.sourceStartUs + length };
  const sourceLength = Math.round((length * clipSourceDurationUs(clip)) / clip.durationUs);
  return withLength({ ...clip, sourceEndUs: clip.sourceStartUs + sourceLength }, length);
}

/** The clip with its start moved to timeline time `startUs`, at the same speed. */
export function clipWithStart(clip: Clip, startUs: Us): Clip {
  const end = clip.timelineStartUs + clipTimelineDurationUs(clip);
  if (clip.freeze) return withLength({ ...clip, timelineStartUs: startUs }, end - startUs);
  const delta = startUs - clip.timelineStartUs;
  if (clip.durationUs === undefined) {
    return { ...clip, timelineStartUs: startUs, sourceStartUs: clip.sourceStartUs + delta };
  }
  const sourceDelta = Math.round((delta * clipSourceDurationUs(clip)) / clip.durationUs);
  return withLength(
    { ...clip, timelineStartUs: startUs, sourceStartUs: clip.sourceStartUs + sourceDelta },
    end - startUs,
  );
}
