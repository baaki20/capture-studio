/**
 * Editing face layout keyframes (v2, R2.1–R2.2). Pure functions from a track's keyframes to new
 * keyframes; the timeline operations (`setLayoutKeyframe`, `removeLayoutKeyframe`,
 * `moveLayoutKeyframe`, `setFaceMode`) validate their input and call these. `scene.ts` resolves
 * what the keyframes show.
 *
 * Model: a keyframe holds a mode and an overlay layout at a timeline time, and its easing shapes
 * the change to the next keyframe (`hold` keeps it, then jumps). Before the first keyframe the
 * first one applies, so when a track's first keyframe is added later than 0, an anchor keyframe
 * at 0 keeps the static layout (`hold`) until then. Without keyframes the track's static
 * `layout` applies in overlay mode. Times are unique and sorted (an invariant).
 *
 * `setFaceMode` is the per-segment layout: the mode applies on `[start, end)`, entered and left
 * with an eased change of `easeUs` (0 = a cut), and the layout returns to what it was at `end`.
 *
 * Cuts and ripple deletes move keyframes with the content (`keyframesThroughCut`).
 */
import type { Us } from '../time';
import { keyframeSpan } from './easing';
import type { Easing, FaceMode, LayoutKeyframe, OverlayLayout } from './schema';

/** Longest eased change into or out of a face-mode segment. */
export const FACE_EASE_MAX_US = 2_000_000;
/** Easing of a keyframe added without one. */
export const DEFAULT_FACE_EASING: Easing = 'ease-in-out';

export interface FaceKeyState {
  mode: FaceMode;
  layout: OverlayLayout;
}

/**
 * The keyframe in effect at `tUs` (the latest at or before it; the first before any), or the
 * static layout in overlay mode. Mid-change, this is the keyframe the change starts from.
 */
export function faceKeyAt(
  keys: readonly LayoutKeyframe[] | undefined,
  tUs: Us,
): LayoutKeyframe | null {
  return keys && keys.length > 0 ? (keyframeSpan(keys, tUs)?.from ?? null) : null;
}

/** Mode and layout in effect at `tUs` (see `faceKeyAt`). */
export function faceStateAt(
  keys: readonly LayoutKeyframe[] | undefined,
  layout: OverlayLayout,
  tUs: Us,
): FaceKeyState {
  const key = faceKeyAt(keys, tUs);
  return key ? { mode: key.mode, layout: key.layout } : { mode: 'overlay', layout };
}

function sorted(keys: LayoutKeyframe[]): LayoutKeyframe[] {
  return keys.sort((a, b) => a.tUs - b.tUs);
}

export interface KeyframeChange {
  mode?: FaceMode;
  /** The whole layout of the keyframe (already merged and clamped by the caller). */
  layout?: OverlayLayout;
  easing?: Easing;
}

/**
 * Sets the keyframe at `tUs`: changes the one there, or adds one that starts from the state in
 * effect at `tUs` (and, for a track's first keyframe after 0, the anchor at 0).
 */
export function upsertKeyframe(
  keys: readonly LayoutKeyframe[] | undefined,
  layout: OverlayLayout,
  tUs: Us,
  change: KeyframeChange,
): LayoutKeyframe[] {
  const list = [...(keys ?? [])];
  const index = list.findIndex((k) => k.tUs === tUs);
  const existing = list[index];
  if (existing) {
    list[index] = {
      tUs,
      mode: change.mode ?? existing.mode,
      layout: change.layout ?? existing.layout,
      easing: change.easing ?? existing.easing,
    };
    return list;
  }
  const base = faceStateAt(list, layout, tUs);
  if (list.length === 0 && tUs > 0) {
    list.push({ tUs: 0, mode: 'overlay', layout, easing: 'hold' });
  }
  list.push({
    tUs,
    mode: change.mode ?? base.mode,
    layout: change.layout ?? base.layout,
    easing: change.easing ?? DEFAULT_FACE_EASING,
  });
  return sorted(list);
}

/** Without the keyframe at `tUs`; null when none is there. Undefined when none are left. */
export function removeKeyframe(
  keys: readonly LayoutKeyframe[] | undefined,
  tUs: Us,
): LayoutKeyframe[] | undefined | null {
  const list = keys ?? [];
  if (!list.some((k) => k.tUs === tUs)) return null;
  const rest = list.filter((k) => k.tUs !== tUs);
  return rest.length > 0 ? rest : undefined;
}

/**
 * The keyframe at `fromUs` moved to `toUs` (it may pass others). Null when there is none at
 * `fromUs`, or another one already sits at `toUs`.
 */
export function moveKeyframe(
  keys: readonly LayoutKeyframe[] | undefined,
  fromUs: Us,
  toUs: Us,
): LayoutKeyframe[] | null {
  const list = [...(keys ?? [])];
  const index = list.findIndex((k) => k.tUs === fromUs);
  const key = list[index];
  if (!key) return null;
  if (fromUs !== toUs && list.some((k) => k.tUs === toUs)) return null;
  list[index] = { ...key, tUs: toUs };
  return sorted(list);
}

/**
 * The face in `mode` on `[startUs, endUs)` (per-segment layout). Keyframes inside the segment
 * are replaced; the change in and out takes `easeUs` (0 = a cut), ending at `startUs` and
 * starting at `endUs − easeUs`. The layout (geometry and style) stays the one in effect before
 * the segment, and after `endUs` the face returns to what it showed there.
 */
export function faceModeSegment(
  keys: readonly LayoutKeyframe[] | undefined,
  layout: OverlayLayout,
  startUs: Us,
  endUs: Us,
  mode: FaceMode,
  easeUs: Us,
): LayoutKeyframe[] {
  const list = keys ?? [];
  const before = faceStateAt(list, layout, Math.max(0, startUs - 1));
  const after = faceKeyAt(list, endUs);
  const lead = Math.min(startUs, Math.max(easeUs, 1));
  const enterAt = startUs - lead;
  const kept = list.filter((k) => k.tUs < enterAt || k.tUs > endUs);
  const easeIn: Easing = easeUs > 0 ? DEFAULT_FACE_EASING : 'hold';
  const added: LayoutKeyframe[] = [];
  if (startUs > 0) {
    // The state before the segment, held (or eased) into it.
    added.push({ tUs: enterAt, mode: before.mode, layout: before.layout, easing: easeIn });
  }
  const leaveAt = endUs - easeUs;
  const holdsUntilLeave = easeUs > 0 && leaveAt > startUs;
  added.push({ tUs: startUs, mode, layout: before.layout, easing: 'hold' });
  if (holdsUntilLeave) {
    added.push({ tUs: leaveAt, mode, layout: before.layout, easing: DEFAULT_FACE_EASING });
  }
  added.push({
    tUs: endUs,
    mode: after?.mode ?? 'overlay',
    layout: after?.layout ?? layout,
    easing: after?.easing ?? 'hold',
  });
  return sorted([...kept, ...added]);
}

/**
 * Keyframes after removing `[a, b)` from the timeline: later ones move left by `b − a`, ones
 * inside are dropped, and if any were, the last of them moves to `a` so the face shows after the
 * cut what it showed at `b`. Undefined when none are left.
 */
export function keyframesThroughCut(
  keys: readonly LayoutKeyframe[] | undefined,
  a: Us,
  b: Us,
): LayoutKeyframe[] | undefined {
  if (!keys || keys.length === 0) return undefined;
  const removed = b - a;
  const out: LayoutKeyframe[] = [];
  let lastInside: LayoutKeyframe | null = null;
  for (const key of keys) {
    if (key.tUs < a) out.push(key);
    else if (key.tUs < b) lastInside = key;
  }
  const after = keys.filter((k) => k.tUs >= b).map((k) => ({ ...k, tUs: k.tUs - removed }));
  if (lastInside && !after.some((k) => k.tUs === a)) out.push({ ...lastInside, tUs: a });
  out.push(...after);
  return out.length > 0 ? out : undefined;
}
