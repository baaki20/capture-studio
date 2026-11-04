/**
 * Keyframe interpolation (v2): face layouts, camera, volume and object boxes all use it, and the
 * preview and both export paths call the same functions, so a keyframed value is the same
 * number everywhere (§5 P2 acceptance b).
 *
 * A keyframe holds a value at `tUs` and the curve (`easing`) from there to the next keyframe.
 * Before the first keyframe the value is the first one's; after the last, the last one's.
 * `hold` keeps the value until the next keyframe and then jumps.
 */
import type { Us } from '../time';
import type { Easing, FRect } from './schema';

export interface Keyframe {
  tUs: Us;
  easing: Easing;
}

/** Eased progress for linear progress `x` in [0, 1]. */
export function ease(easing: Easing, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  switch (easing) {
    case 'linear':
      return t;
    case 'ease-in':
      return t * t * t;
    case 'ease-out':
      return 1 - (1 - t) ** 3;
    case 'ease-in-out':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    case 'hold':
      return t >= 1 ? 1 : 0;
  }
}

/**
 * The two keyframes around `tUs` and the eased progress between them. `from` and `to` are the
 * same keyframe before the first, after the last, or with a single keyframe. Null when empty.
 * `keys` must be sorted by `tUs` (an invariant of the project).
 */
export function keyframeSpan<K extends Keyframe>(
  keys: readonly K[],
  tUs: Us,
): { from: K; to: K; progress: number } | null {
  const first = keys[0];
  if (!first) return null;
  if (tUs <= first.tUs) return { from: first, to: first, progress: 0 };
  // Binary search for the last keyframe at or before tUs.
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((keys[mid]?.tUs ?? 0) <= tUs) lo = mid;
    else hi = mid - 1;
  }
  const from = keys[lo] ?? first;
  const to = keys[lo + 1];
  if (!to) return { from, to: from, progress: 0 };
  const x = (tUs - from.tUs) / (to.tUs - from.tUs);
  return { from, to, progress: ease(from.easing, x) };
}

/** Interpolated value at `tUs`, or null when there are no keyframes. */
export function interpolate<K extends Keyframe, V>(
  keys: readonly K[],
  tUs: Us,
  value: (key: K) => V,
  mix: (a: V, b: V, progress: number) => V,
): V | null {
  const span = keyframeSpan(keys, tUs);
  if (!span) return null;
  if (span.from === span.to || span.progress === 0) return value(span.from);
  if (span.progress === 1) return value(span.to);
  return mix(value(span.from), value(span.to), span.progress);
}

export function lerp(a: number, b: number, progress: number): number {
  return a + (b - a) * progress;
}

/** Interpolates each side of a rectangle (fractions or pixels). */
export function lerpRect<R extends FRect>(a: R, b: R, progress: number): FRect {
  return {
    x: lerp(a.x, b.x, progress),
    y: lerp(a.y, b.y, progress),
    width: lerp(a.width, b.width, progress),
    height: lerp(a.height, b.height, progress),
  };
}
