/**
 * Face-overlay geometry (§2.5, R1.41): presets, clamping and rects in canvas pixels.
 *
 * An `OverlayLayout` stores the overlay as fractions of the canvas (`centerX`, `centerY`,
 * `width`), so it survives a canvas resize. Everything here turns that into integer pixel rects
 * and back. The preview compositor and the export graph both get their rects from
 * `render-plan.ts`, which calls these functions, so the overlay lands on the same pixels in both
 * (R1.48).
 *
 * Conventions:
 * - `frame` is the face media's picture size in file pixels (`Media.video`).
 * - The source rect is `layout.crop` (or the full frame) and, for a circle, the centred square
 *   inside it.
 * - The destination keeps the source aspect: its width is `layout.width × canvas.width`, its
 *   height follows. Both are rounded to even pixels (yuv420p export) and the rect is clamped
 *   fully inside the canvas.
 *
 * API for the inspector and on-canvas handles:
 * - `clampOverlayLayout(layout, canvas, frame)`: what every layout edit passes through (the
 *   `setLayout` op calls it), so the overlay always stays fully inside the canvas.
 * - `applyCornerPreset(layout, corner, canvas, frame)`, `FACE_SIZE_PRESETS`.
 * - `overlayDestRect(layout, canvas, frame)`: the bounding box to draw and hit-test.
 * - `layoutFromDestRect(layout, rect, canvas, frame)`: a dragged or resized box back to a layout.
 */
import type { NRect, OverlayLayout } from './schema';

export interface Size {
  width: number;
  height: number;
}

/** An integer pixel rectangle; unlike `NRect`, x and y may be any integer. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const FACE_CORNERS: readonly Corner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

/** Size slider bounds (R1.41): fraction of the canvas width. */
export const FACE_WIDTH_MIN = 0.05;
export const FACE_WIDTH_MAX = 0.5;
/** Rounded-rectangle radius bounds: fraction of the overlay's short side. */
export const FACE_RADIUS_MIN = 0;
export const FACE_RADIUS_MAX = 0.5;
/** Corner-preset margin: fraction of the canvas's short side (matches `defaultFaceLayout`). */
export const FACE_MARGIN = 0.03;

export const FACE_SIZE_PRESETS = { small: 0.12, medium: 0.2, large: 0.3 } as const;
export type FaceSizePreset = keyof typeof FACE_SIZE_PRESETS;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Rounds to the nearest even integer, at least 2. */
export function roundEven(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Clamps an integer rect inside `frame` (at least 1 × 1). */
export function clampRectToFrame(rect: NRect, frame: Size): NRect {
  const fw = Math.max(1, Math.floor(frame.width));
  const fh = Math.max(1, Math.floor(frame.height));
  const x = clamp(Math.round(rect.x), 0, fw - 1);
  const y = clamp(Math.round(rect.y), 0, fh - 1);
  return {
    x,
    y,
    width: clamp(Math.round(rect.width), 1, fw - x),
    height: clamp(Math.round(rect.height), 1, fh - y),
  };
}

/**
 * The part of the face picture the overlay shows, in file pixels: the crop (or the full frame),
 * and for a circle the centred square inside it.
 */
export function overlaySourceRect(layout: OverlayLayout, frame: Size): NRect {
  const base = layout.crop
    ? clampRectToFrame(layout.crop, frame)
    : { x: 0, y: 0, width: Math.floor(frame.width), height: Math.floor(frame.height) };
  if (layout.shape !== 'circle') return base;
  const side = Math.min(base.width, base.height);
  return {
    x: base.x + Math.floor((base.width - side) / 2),
    y: base.y + Math.floor((base.height - side) / 2),
    width: side,
    height: side,
  };
}

/** Height ÷ width of the overlay (1 for a circle). */
export function overlayAspect(layout: OverlayLayout, frame: Size): number {
  const src = overlaySourceRect(layout, frame);
  return src.height / src.width;
}

/** Largest `width` fraction whose overlay still fits the canvas height. */
function maxWidthFraction(canvas: Size, aspect: number): number {
  return Math.min(FACE_WIDTH_MAX, canvas.height / aspect / canvas.width);
}

/**
 * Makes a layout valid and fully inside the canvas: width within 5–50 % (and short enough for
 * the canvas height), radius within 0–0.5, centre such that the overlay does not cross an edge.
 */
export function clampOverlayLayout(
  layout: OverlayLayout,
  canvas: Size,
  frame: Size,
): OverlayLayout {
  const aspect = overlayAspect(layout, frame);
  const width = clamp(
    layout.width,
    FACE_WIDTH_MIN,
    Math.max(FACE_WIDTH_MIN, maxWidthFraction(canvas, aspect)),
  );
  const halfW = width / 2;
  const halfH = (width * canvas.width * aspect) / 2 / canvas.height;
  return {
    ...layout,
    width,
    cornerRadius: clamp(layout.cornerRadius, FACE_RADIUS_MIN, FACE_RADIUS_MAX),
    centerX: clamp(layout.centerX, Math.min(0.5, halfW), Math.max(0.5, 1 - halfW)),
    centerY: clamp(layout.centerY, Math.min(0.5, halfH), Math.max(0.5, 1 - halfH)),
    crop: layout.crop ? clampRectToFrame(layout.crop, frame) : null,
  };
}

/** Overlay size in canvas pixels: even, and never larger than the canvas. */
export function overlaySizePx(layout: OverlayLayout, canvas: Size, frame: Size): Size {
  const aspect = overlayAspect(layout, frame);
  const widthPx = layout.width * canvas.width;
  const width = Math.min(roundEven(widthPx), canvas.width);
  const height = Math.min(roundEven(widthPx * aspect), canvas.height);
  return { width, height };
}

/** The overlay's bounding box on the canvas, in integer canvas pixels, fully inside it. */
export function overlayDestRect(layout: OverlayLayout, canvas: Size, frame: Size): PixelRect {
  const { width, height } = overlaySizePx(layout, canvas, frame);
  const x = clamp(Math.round(layout.centerX * canvas.width - width / 2), 0, canvas.width - width);
  const y = clamp(
    Math.round(layout.centerY * canvas.height - height / 2),
    0,
    canvas.height - height,
  );
  return { x, y, width, height };
}

/** Corner radius in canvas pixels of a destination rect (0 for a plain rectangle). */
export function overlayRadiusPx(layout: OverlayLayout, dest: Size): number {
  const short = Math.min(dest.width, dest.height);
  if (layout.shape === 'circle') return short / 2;
  if (layout.shape === 'rounded') return clamp(layout.cornerRadius, 0, 0.5) * short;
  return 0;
}

/** Moves the overlay into a corner, `FACE_MARGIN` of the canvas's short side from both edges. */
export function applyCornerPreset(
  layout: OverlayLayout,
  corner: Corner,
  canvas: Size,
  frame: Size,
  margin = FACE_MARGIN,
): OverlayLayout {
  const clamped = clampOverlayLayout(layout, canvas, frame);
  const size = overlaySizePx(clamped, canvas, frame);
  const marginPx = margin * Math.min(canvas.width, canvas.height);
  const left = corner === 'top-left' || corner === 'bottom-left';
  const top = corner === 'top-left' || corner === 'top-right';
  const cx = left ? marginPx + size.width / 2 : canvas.width - marginPx - size.width / 2;
  const cy = top ? marginPx + size.height / 2 : canvas.height - marginPx - size.height / 2;
  return clampOverlayLayout(
    { ...clamped, centerX: cx / canvas.width, centerY: cy / canvas.height },
    canvas,
    frame,
  );
}

/** Sets the size from a preset, keeping the centre (then clamping). */
export function applySizePreset(
  layout: OverlayLayout,
  preset: FaceSizePreset,
  canvas: Size,
  frame: Size,
): OverlayLayout {
  return clampOverlayLayout({ ...layout, width: FACE_SIZE_PRESETS[preset] }, canvas, frame);
}

/**
 * A layout whose overlay matches a box dragged or resized on the canvas. The aspect is locked
 * (R1.41), so only the box's width and centre are used; the result is clamped.
 */
export function layoutFromDestRect(
  layout: OverlayLayout,
  rect: { x: number; y: number; width: number; height: number },
  canvas: Size,
  frame: Size,
): OverlayLayout {
  return clampOverlayLayout(
    {
      ...layout,
      width: rect.width / canvas.width,
      centerX: (rect.x + rect.width / 2) / canvas.width,
      centerY: (rect.y + rect.height / 2) / canvas.height,
    },
    canvas,
    frame,
  );
}
