/**
 * Region-picker geometry (§4.3.7, R1.9). Everything is in **stream pixels** of the chosen source,
 * independent of display scaling: the picker draws the frozen frame with `object-fit: contain`
 * and maps pointer positions (CSS pixels of its window) back through `clientToSource`.
 *
 * While the user drags, rectangles are kept as fractional `Box`es; `finalizeRegion` turns one into
 * the recorded region: clamped to the frame, even position and size, at least 64 × 64.
 */
import type { NRect } from '../project/schema';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** An axis-aligned rectangle with fractional coordinates. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** R1.9: the smallest region, in source pixels. */
export const MIN_REGION_SIZE = 64;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const evenFloor = (value: number): number => Math.floor(value / 2) * 2;
const evenRound = (value: number): number => Math.round(value / 2) * 2;

/** Where a `source`-sized image lands inside `container` with `object-fit: contain`. */
export function containBox(container: Size, source: Size): Box & { scale: number } {
  const scale = Math.min(container.width / source.width, container.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
    scale,
  };
}

/** A point in the container (CSS pixels) → stream pixels, clamped to the frame. */
export function clientToSource(point: Point, container: Size, source: Size): Point {
  const box = containBox(container, source);
  return {
    x: clamp((point.x - box.x) / box.scale, 0, source.width),
    y: clamp((point.y - box.y) / box.scale, 0, source.height),
  };
}

/** A stream-pixel rectangle → container CSS pixels (for drawing the selection). */
export function sourceToClient(rect: Box, container: Size, source: Size): Box {
  const box = containBox(container, source);
  return {
    x: box.x + rect.x * box.scale,
    y: box.y + rect.y * box.scale,
    width: rect.width * box.scale,
    height: rect.height * box.scale,
  };
}

/**
 * The rectangle spanned from `anchor` to `current`, inside the frame. With `square`, the side is
 * the larger of the two extents, shrunk to what fits in the drag direction.
 */
export function rectFromCorners(anchor: Point, current: Point, source: Size, square = false): Box {
  const a = { x: clamp(anchor.x, 0, source.width), y: clamp(anchor.y, 0, source.height) };
  const c = { x: clamp(current.x, 0, source.width), y: clamp(current.y, 0, source.height) };
  if (!square) {
    return {
      x: Math.min(a.x, c.x),
      y: Math.min(a.y, c.y),
      width: Math.abs(c.x - a.x),
      height: Math.abs(c.y - a.y),
    };
  }
  const dirX = c.x >= a.x ? 1 : -1;
  const dirY = c.y >= a.y ? 1 : -1;
  const room = Math.min(dirX > 0 ? source.width - a.x : a.x, dirY > 0 ? source.height - a.y : a.y);
  const side = Math.min(Math.max(Math.abs(c.x - a.x), Math.abs(c.y - a.y)), room);
  return {
    x: dirX > 0 ? a.x : a.x - side,
    y: dirY > 0 ? a.y : a.y - side,
    width: side,
    height: side,
  };
}

/** The corner (or edge midpoint) opposite `handle`, which stays fixed while resizing. */
function anchorFor(rect: Box, handle: Handle): Point {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return {
    x: handle.includes('w') ? right : rect.x,
    y: handle.includes('n') ? bottom : rect.y,
  };
}

/** Drags one of the 8 handles to `point`. Edge handles change one axis only. */
export function resizeRect(
  rect: Box,
  handle: Handle,
  point: Point,
  source: Size,
  square = false,
): Box {
  const anchor = anchorFor(rect, handle);
  const horizontal = handle.includes('e') || handle.includes('w');
  const vertical = handle.includes('n') || handle.includes('s');
  const target = {
    x: horizontal ? point.x : handle.includes('w') ? rect.x : rect.x + rect.width,
    y: vertical ? point.y : handle.includes('n') ? rect.y : rect.y + rect.height,
  };
  if (horizontal && vertical) return rectFromCorners(anchor, target, source, square);
  const next = rectFromCorners(anchor, target, source, false);
  if (!square) return next;
  // An edge handle with Shift: the other side follows, kept inside the frame.
  if (horizontal) {
    const side = Math.min(next.width, source.height - next.y);
    return { ...next, width: side, height: side };
  }
  const side = Math.min(next.height, source.width - next.x);
  return { ...next, width: side, height: side };
}

/** Moves a rectangle by (dx, dy), keeping it inside the frame. */
export function moveRect(rect: Box, dx: number, dy: number, source: Size): Box {
  return {
    ...rect,
    x: clamp(rect.x + dx, 0, Math.max(0, source.width - rect.width)),
    y: clamp(rect.y + dy, 0, Math.max(0, source.height - rect.height)),
  };
}

/**
 * Which part of the selection is under `point` (stream pixels): a handle within `tolerance`, the
 * inside (move), or nothing.
 */
export function hitTest(point: Point, rect: Box, tolerance: number): Handle | 'move' | null {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const positions: Record<Handle, Point> = {
    nw: { x: left, y: top },
    n: { x: midX, y: top },
    ne: { x: right, y: top },
    e: { x: right, y: midY },
    se: { x: right, y: bottom },
    s: { x: midX, y: bottom },
    sw: { x: left, y: bottom },
    w: { x: left, y: midY },
  };
  for (const handle of HANDLES) {
    const p = positions[handle];
    if (near(point.x, p.x) && near(point.y, p.y)) return handle;
  }
  if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return 'move';
  return null;
}

/**
 * The region as recorded (R1.9): clamped to the frame, even x, y, width and height, and at least
 * 64 × 64 source pixels (or the whole frame when it is smaller than that).
 */
export function finalizeRegion(rect: Box, source: Size): NRect {
  const maxWidth = Math.max(2, evenFloor(source.width));
  const maxHeight = Math.max(2, evenFloor(source.height));
  const x0 = clamp(rect.x, 0, source.width);
  const y0 = clamp(rect.y, 0, source.height);
  const x1 = clamp(rect.x + rect.width, 0, source.width);
  const y1 = clamp(rect.y + rect.height, 0, source.height);
  const width = clamp(evenRound(x1 - x0), Math.min(MIN_REGION_SIZE, maxWidth), maxWidth);
  const height = clamp(evenRound(y1 - y0), Math.min(MIN_REGION_SIZE, maxHeight), maxHeight);
  // Growing to the minimum may push the rect past the far edge: shift it back inside.
  const x = evenFloor(clamp(Math.round(x0), 0, source.width - width));
  const y = evenFloor(clamp(Math.round(y0), 0, source.height - height));
  return { x, y, width, height };
}

/** The whole frame as a region (even size). */
export function fullFrameRegion(source: Size): NRect {
  return finalizeRegion({ x: 0, y: 0, width: source.width, height: source.height }, source);
}

/** True when `rect` covers the whole frame (the recorder then stores no crop). */
export function isFullFrame(rect: NRect, source: Size): boolean {
  const full = fullFrameRegion(source);
  return rect.x === 0 && rect.y === 0 && rect.width >= full.width && rect.height >= full.height;
}

/** The persisted last region, offered only when it was taken from a same-size source (R1.9). */
export function matchingLastRegion(
  last: { sourceWidth: number; sourceHeight: number; rect: NRect } | null,
  source: Size,
): NRect | null {
  if (!last) return null;
  if (last.sourceWidth !== source.width || last.sourceHeight !== source.height) return null;
  return finalizeRegion(last.rect, source);
}
