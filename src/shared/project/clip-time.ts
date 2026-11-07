/**
 * How a clip maps timeline time to its media's reference clock (§1.7), with the v2 speed and
 * freeze-frame fields:
 *
 *   refUs = sourceStartUs + (tUs − timelineStartUs) × speed      (normal clip)
 *   refUs = sourceStartUs                                          (freeze frame)
 *
 * A clip with `speed` or `freeze` stores its timeline length (`durationUs`) as well as the exact
 * speed. Timeline positions therefore stay exact integers through splits, trims and cuts, and
 * every new source time is derived from the exact speed, so rounding never accumulates: the
 * source length stays within 2 µs of `durationUs × speed` (an invariant). Without either field a
 * clip is a Phase 1 clip and its timeline length is its source length.
 *
 * `clipHead` and `clipTail` are the two halves of a clip cut at a timeline time; `clipWithStart`
 * and `clipWithEnd` trim. Every edit that changes a clip's extent goes through them.
 */
import type { Us } from '../time';
import type { Clip } from './schema';

type ClipTiming = Pick<Clip, 'sourceStartUs' | 'sourceEndUs' | 'speed' | 'durationUs' | 'freeze'>;
type PlacedClip = ClipTiming & Pick<Clip, 'timelineStartUs'>;
/** What the reference time inside a clip depends on. */
export type ClipRefTiming = Pick<Clip, 'timelineStartUs' | 'sourceStartUs' | 'speed' | 'freeze'>;

/** Speed range (§5 P2). */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
/** How far a sped-up clip's source length may stray from `durationUs × speed` (rounding). */
export const SPEED_SLACK_US = 2;

/** True when the clip's timeline length is stored (`durationUs`) rather than derived. */
function hasStoredLength(clip: ClipTiming): boolean {
  return clip.speed !== undefined || clip.freeze === true;
}

/** Source (reference-clock) length of the clip. */
export function clipSourceDurationUs(clip: Pick<Clip, 'sourceStartUs' | 'sourceEndUs'>): Us {
  return clip.sourceEndUs - clip.sourceStartUs;
}

/** Length of the clip on the timeline. */
export function clipTimelineDurationUs(clip: ClipTiming): Us {
  if (hasStoredLength(clip) && clip.durationUs !== undefined) return clip.durationUs;
  return clipSourceDurationUs(clip);
}

/** Playback speed: 1 for a plain clip, 0 for a freeze frame. */
export function clipSpeed(clip: Pick<Clip, 'speed' | 'freeze'>): number {
  if (clip.freeze) return 0;
  return clip.speed ?? 1;
}

/** Exact (unrounded) reference time shown at timeline time `tUs`. */
export function clipRefAtExact(clip: ClipRefTiming, tUs: Us): number {
  if (clip.freeze) return clip.sourceStartUs;
  return clip.sourceStartUs + (tUs - clip.timelineStartUs) * (clip.speed ?? 1);
}

/** Reference time shown at timeline time `tUs`, in integer µs. */
export function clipRefAt(clip: ClipRefTiming, tUs: Us): Us {
  return Math.round(clipRefAtExact(clip, tUs));
}

/**
 * Timeline time at which the clip shows reference time `refUs` (the inverse of `clipRefAt`).
 * A freeze frame shows only `sourceStartUs`, at its start.
 */
export function clipTimeAtRef(clip: PlacedClip, refUs: Us): Us {
  if (clip.freeze) return clip.timelineStartUs;
  const offset = refUs - clip.sourceStartUs;
  if (clip.speed === undefined) return clip.timelineStartUs + offset;
  return clip.timelineStartUs + Math.round(offset / clip.speed);
}

/** Source length for a timeline length at the clip's speed (freeze: unchanged). */
function sourceLengthFor(clip: ClipTiming, lengthUs: Us): Us {
  if (clip.freeze) return clipSourceDurationUs(clip);
  return clip.speed === undefined ? lengthUs : Math.round(lengthUs * clip.speed);
}

function withStoredLength(clip: Clip, lengthUs: Us): Clip {
  return fitTransition(hasStoredLength(clip) ? { ...clip, durationUs: lengthUs } : clip, lengthUs);
}

/** The clip with its transition shortened to fit a clip `lengthUs` long (an invariant). */
export function fitTransition(clip: Clip, lengthUs: Us): Clip {
  const t = clip.transitionIn;
  return t && t.durationUs > lengthUs
    ? { ...clip, transitionIn: { ...t, durationUs: Math.max(1, lengthUs) } }
    : clip;
}

/**
 * A clip whose start moved (tail or trimmed start): for a sped-up clip the source end is derived
 * again from the new start, so the rounding error stays within 1.5 µs instead of adding up over
 * edits. It never moves past the old source end, which keeps it inside the media.
 */
function withNewStart(clip: Clip, timelineStartUs: Us, sourceStartUs: Us, lengthUs: Us): Clip {
  const moved = { ...clip, timelineStartUs, sourceStartUs };
  if (clip.speed === undefined || clip.freeze) return withStoredLength(moved, lengthUs);
  const sourceEndUs = Math.min(clip.sourceEndUs, sourceStartUs + sourceLengthFor(clip, lengthUs));
  return fitTransition({ ...moved, sourceEndUs, durationUs: lengthUs }, lengthUs);
}

/**
 * The part of `clip` before timeline time `tUs` (strictly inside the clip). It keeps the clip's
 * ID, link and transition in, and loses its fade-out.
 */
export function clipHead(clip: Clip, tUs: Us): Clip {
  const length = tUs - clip.timelineStartUs;
  const { fadeOutUs: _fade, ...rest } = clip;
  if (clip.freeze) return withStoredLength(rest, length);
  return withStoredLength(
    { ...rest, sourceEndUs: clip.sourceStartUs + sourceLengthFor(clip, length) },
    length,
  );
}

/**
 * The part of `clip` from timeline time `tUs` (strictly inside the clip) to its end. It keeps the
 * clip's ID and link (callers assign new ones where needed) and loses its transition and fade-in.
 */
export function clipTail(clip: Clip, tUs: Us): Clip {
  const offset = tUs - clip.timelineStartUs;
  const length = clipTimelineDurationUs(clip) - offset;
  const { transitionIn: _transition, fadeInUs: _fade, ...rest } = clip;
  const sourceStartUs = clip.freeze
    ? clip.sourceStartUs
    : clip.sourceStartUs + sourceLengthFor(clip, offset);
  return withNewStart(rest, tUs, sourceStartUs, length);
}

/**
 * Latest timeline end the clip can be trimmed out to without its source passing `refEndUs` (the
 * media's edit bound). A freeze frame has no source limit.
 */
export function clipMaxEndUs(clip: PlacedClip, refEndUs: Us): Us {
  if (clip.freeze) return Number.POSITIVE_INFINITY;
  const room = refEndUs - clip.sourceStartUs;
  if (clip.speed === undefined) return clip.timelineStartUs + room;
  return clip.timelineStartUs + Math.floor(room / clip.speed);
}

/** Earliest timeline start the clip can be trimmed out to without its source passing `refStartUs`. */
export function clipMinStartUs(clip: PlacedClip, refStartUs: Us): Us {
  if (clip.freeze) return Number.NEGATIVE_INFINITY;
  const room = clip.sourceStartUs - refStartUs;
  if (clip.speed === undefined) return clip.timelineStartUs - room;
  return clip.timelineStartUs - Math.floor(room / clip.speed);
}

/** The clip with its end moved to timeline time `endUs`, at the same speed. */
export function clipWithEnd(clip: Clip, endUs: Us): Clip {
  const length = endUs - clip.timelineStartUs;
  if (clip.freeze) return withStoredLength(clip, length);
  return withStoredLength(
    { ...clip, sourceEndUs: clip.sourceStartUs + sourceLengthFor(clip, length) },
    length,
  );
}

/** The clip with its start moved to timeline time `startUs`, at the same speed. */
export function clipWithStart(clip: Clip, startUs: Us): Clip {
  const end = clip.timelineStartUs + clipTimelineDurationUs(clip);
  const delta = startUs - clip.timelineStartUs;
  const sourceStartUs = clip.freeze
    ? clip.sourceStartUs
    : clip.sourceStartUs + (clip.speed === undefined ? delta : Math.round(delta * clip.speed));
  return withNewStart(clip, startUs, sourceStartUs, end - startUs);
}
