/**
 * Editing camera zoom and pan keyframes (v2, R2.9). Pure functions from the timeline's camera
 * keyframes to new keyframes; the timeline operations (`setCameraKeyframe`,
 * `removeCameraKeyframe`, `moveCameraKeyframe`, `setCameraZoom`) validate their input and call
 * these. `scene.ts` resolves the rect at a time (`cameraRectAt`).
 *
 * Model: a keyframe holds the part of the canvas that fills the frame (`rect`, canvas fractions)
 * and its easing shapes the change to the next keyframe (`hold` keeps it, then jumps). Before the
 * first keyframe the first one applies, so when the first keyframe is added later than 0, an
 * anchor at 0 keeps the full frame (`hold`) until then. Without keyframes the camera shows the
 * full frame. The editor makes rects with the canvas's aspect (`cameraRect`), so the picture is
 * never stretched; the operations accept any rect inside the canvas.
 *
 * `setCameraZoom` zooms over a range: the rect applies on `[start, end)`, entered and left with an
 * eased change of `easeUs` (0 = a cut), and the camera returns to what it showed at `end`.
 *
 * A held zoom is one shot: changing a keyframe's rect also changes the following keyframes it holds into
 * (`setCameraRect`), so panning inside a zoomed range moves the whole range.
 */
import type { Us } from '../time';
import { interpolate, lerpRect } from './easing';
import { removeKeyframe, moveKeyframe, keyframesThroughCut } from './layout-keyframes';
import type { CameraKeyframe, Easing, FRect } from './schema';

export { removeKeyframe, moveKeyframe, keyframesThroughCut };

/** Closest zoom: the rect is a quarter of the canvas side. */
export const CAMERA_ZOOM_MAX = 4;
/** Longest eased change into or out of a zoomed range. */
export const CAMERA_EASE_MAX_US = 2_000_000;
/** Easing of a camera keyframe added without one. */
export const DEFAULT_CAMERA_EASING: Easing = 'ease-in-out';

export const FULL_CAMERA: FRect = { x: 0, y: 0, width: 1, height: 1 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The rect for a zoom (1 = the full frame) centred on (`centerX`, `centerY`) in canvas fractions,
 * moved inside the canvas. It keeps the canvas's aspect.
 */
export function cameraRect(zoom: number, centerX: number, centerY: number): FRect {
  const size = 1 / clamp(zoom, 1, CAMERA_ZOOM_MAX);
  return {
    x: clamp(centerX - size / 2, 0, 1 - size),
    y: clamp(centerY - size / 2, 0, 1 - size),
    width: size,
    height: size,
  };
}

/** Zoom and centre of a rect (the inverse of `cameraRect` for rects it makes). */
export function cameraView(rect: FRect): { zoom: number; centerX: number; centerY: number } {
  return {
    zoom: 1 / Math.max(rect.width, rect.height),
    centerX: rect.x + rect.width / 2,
    centerY: rect.y + rect.height / 2,
  };
}

/**
 * A rect moved and sized to lie inside the canvas, with sides of at least `1 / CAMERA_ZOOM_MAX`;
 * null when it is not a finite rect.
 */
export function clampCameraRect(rect: FRect): FRect | null {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const w = clamp(width, 1 / CAMERA_ZOOM_MAX, 1);
  const h = clamp(height, 1 / CAMERA_ZOOM_MAX, 1);
  return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), width: w, height: h };
}

/** The camera rect at `tUs` (interpolated); the full frame without keyframes. */
export function cameraAt(keys: readonly CameraKeyframe[] | undefined, tUs: Us): FRect {
  if (!keys || keys.length === 0) return FULL_CAMERA;
  return interpolate(keys, tUs, (k) => k.rect, lerpRect) ?? FULL_CAMERA;
}

/** The keyframe in effect at `tUs` (the latest at or before it; the first before any). */
export function cameraKeyAt(
  keys: readonly CameraKeyframe[] | undefined,
  tUs: Us,
): CameraKeyframe | null {
  if (!keys || keys.length === 0) return null;
  let found = keys[0] ?? null;
  for (const key of keys) {
    if (key.tUs > tUs) break;
    found = key;
  }
  return found;
}

function sameRect(a: FRect, b: FRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sorted(keys: CameraKeyframe[]): CameraKeyframe[] {
  return keys.sort((a, b) => a.tUs - b.tUs);
}

/**
 * Sets the keyframe at `tUs`: changes the one there, or adds one that starts from the rect shown
 * at `tUs` (and, for the first keyframe after 0, the full-frame anchor at 0). A new rect also
 * goes to the keyframes this one holds into (see the file comment).
 */
export function upsertCameraKeyframe(
  keys: readonly CameraKeyframe[] | undefined,
  tUs: Us,
  change: { rect?: FRect; easing?: Easing },
): CameraKeyframe[] {
  const list = [...(keys ?? [])];
  const index = list.findIndex((k) => k.tUs === tUs);
  const existing = list[index];
  if (existing) {
    if (change.rect) {
      // The held run: following keyframes with the same rect that this one holds into.
      for (let i = index + 1; i < list.length; i++) {
        const prev = list[i - 1];
        const next = list[i];
        if (prev?.easing !== 'hold' || !next || !sameRect(next.rect, existing.rect)) break;
        list[i] = { ...next, rect: change.rect };
      }
    }
    list[index] = {
      tUs,
      rect: change.rect ?? existing.rect,
      easing: change.easing ?? existing.easing,
    };
    return list;
  }
  const shown = cameraAt(list, tUs);
  if (list.length === 0 && tUs > 0) list.push({ tUs: 0, rect: FULL_CAMERA, easing: 'hold' });
  list.push({
    tUs,
    rect: change.rect ?? shown,
    easing: change.easing ?? DEFAULT_CAMERA_EASING,
  });
  return sorted(list);
}

/**
 * The camera on `rect` over `[startUs, endUs)`. Keyframes inside the range are replaced; the
 * change in and out takes `easeUs` (0 = a cut), ending at `startUs` and starting at
 * `endUs − easeUs`, and after `endUs` the camera shows what it showed there before.
 */
export function cameraZoomRange(
  keys: readonly CameraKeyframe[] | undefined,
  startUs: Us,
  endUs: Us,
  rect: FRect,
  easeUs: Us,
): CameraKeyframe[] {
  const list = keys ?? [];
  const before = cameraAt(list, Math.max(0, startUs - Math.max(easeUs, 1)));
  const after = cameraAt(list, endUs);
  const afterEasing = cameraKeyAt(list, endUs)?.easing ?? 'hold';
  const lead = Math.min(startUs, Math.max(easeUs, 1));
  const enterAt = startUs - lead;
  const kept = list.filter((k) => k.tUs < enterAt || k.tUs > endUs);
  const added: CameraKeyframe[] = [];
  if (startUs > 0) {
    added.push({ tUs: enterAt, rect: before, easing: easeUs > 0 ? DEFAULT_CAMERA_EASING : 'hold' });
  }
  const leaveAt = endUs - easeUs;
  added.push({ tUs: startUs, rect, easing: 'hold' });
  if (easeUs > 0 && leaveAt > startUs) {
    added.push({ tUs: leaveAt, rect, easing: DEFAULT_CAMERA_EASING });
  }
  added.push({
    tUs: endUs,
    rect: after,
    easing: afterEasing,
  });
  return sorted([...kept, ...added]);
}
