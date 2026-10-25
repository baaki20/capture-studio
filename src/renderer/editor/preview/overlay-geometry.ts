/**
 * On-canvas face-overlay handles (R1.41): mapping between the displayed preview and canvas
 * pixels, hit testing the box and its corner handles, and the dragged box (move, or a corner
 * resize with the aspect locked and the opposite corner fixed). Pure; the result goes through
 * `layoutFromDestRect`, which keeps the overlay inside the canvas.
 */
import type { PixelRect } from '../../../shared/project/face-layout';

export interface Size {
  width: number;
  height: number;
}

export type OverlayHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/** Handle hit size in display px. */
export const HANDLE_PX = 10;
/** Smallest overlay width while resizing, in canvas px (the layout clamps further). */
export const MIN_DRAG_WIDTH = 16;

export interface DisplayTransform {
  /** Display px per canvas px. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** How a canvas of `canvas` size is shown in a `container` with "contain" fit, centred. */
export function containTransform(container: Size, canvas: Size): DisplayTransform {
  const scale = Math.min(container.width / canvas.width, container.height / canvas.height);
  return {
    scale,
    offsetX: (container.width - canvas.width * scale) / 2,
    offsetY: (container.height - canvas.height * scale) / 2,
  };
}

export function canvasToDisplay(t: DisplayTransform, rect: PixelRect): PixelRect {
  return {
    x: t.offsetX + rect.x * t.scale,
    y: t.offsetY + rect.y * t.scale,
    width: rect.width * t.scale,
    height: rect.height * t.scale,
  };
}

export function displayToCanvas(
  t: DisplayTransform,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: (x - t.offsetX) / t.scale, y: (y - t.offsetY) / t.scale };
}

/** Which part of a displayed box is at (x, y), or null. Corners win within `HANDLE_PX`. */
export function hitOverlay(
  box: PixelRect,
  x: number,
  y: number,
  handlePx = HANDLE_PX,
): OverlayHandle | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= handlePx;
  const left = near(x, box.x);
  const right = near(x, box.x + box.width);
  const top = near(y, box.y);
  const bottom = near(y, box.y + box.height);
  if (top && left) return 'nw';
  if (top && right) return 'ne';
  if (bottom && left) return 'sw';
  if (bottom && right) return 'se';
  if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return 'move';
  return null;
}

/**
 * The box after dragging `handle` by (dx, dy) canvas px from `start`. Corner drags keep the
 * opposite corner fixed and the aspect (height ÷ width) locked; the width follows the larger of
 * the horizontal and the aspect-scaled vertical movement.
 */
export function dragOverlayRect(
  start: PixelRect,
  handle: OverlayHandle,
  dx: number,
  dy: number,
): PixelRect {
  if (handle === 'move') return { ...start, x: start.x + dx, y: start.y + dy };
  const aspect = start.height / start.width;
  const sx = handle === 'ne' || handle === 'se' ? 1 : -1;
  const sy = handle === 'sw' || handle === 'se' ? 1 : -1;
  const fromX = start.width + sx * dx;
  const fromY = (start.height + sy * dy) / aspect;
  const width = Math.max(
    MIN_DRAG_WIDTH,
    Math.abs(fromX - start.width) >= Math.abs(fromY - start.width) ? fromX : fromY,
  );
  const height = width * aspect;
  const x = sx > 0 ? start.x : start.x + start.width - width;
  const y = sy > 0 ? start.y : start.y + start.height - height;
  return { x, y, width, height };
}
