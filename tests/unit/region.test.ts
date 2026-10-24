import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clientToSource,
  containBox,
  finalizeRegion,
  fullFrameRegion,
  hitTest,
  isFullFrame,
  matchingLastRegion,
  MIN_REGION_SIZE,
  moveRect,
  rectFromCorners,
  resizeRect,
  sourceToClient,
} from '../../src/shared/recording/region';

const HD = { width: 1920, height: 1080 };

describe('region picker geometry (§4.3.7, R1.9)', () => {
  it('letterboxes a wide source in a tall window (object-fit: contain)', () => {
    const box = containBox({ width: 1000, height: 1000 }, HD);
    expect(box.scale).toBeCloseTo(1000 / 1920);
    expect(box.x).toBeCloseTo(0);
    expect(box.width).toBeCloseTo(1000);
    expect(box.height).toBeCloseTo(562.5);
    expect(box.y).toBeCloseTo((1000 - 562.5) / 2);
  });

  it('pillarboxes a 4:3 source in a 16:9 window', () => {
    const box = containBox({ width: 1600, height: 900 }, { width: 1024, height: 768 });
    expect(box.y).toBe(0);
    expect(box.height).toBe(900);
    expect(box.width).toBeCloseTo(1200);
    expect(box.x).toBeCloseTo(200);
  });

  it('maps pointer positions to stream pixels across the letterbox bars', () => {
    const container = { width: 1000, height: 1000 };
    const top = (1000 - 562.5) / 2;
    const origin = clientToSource({ x: 0, y: top }, container, HD);
    expect(origin.x).toBeCloseTo(0);
    expect(origin.y).toBeCloseTo(0);
    const far = clientToSource({ x: 1000, y: top + 562.5 }, container, HD);
    expect(far.x).toBeCloseTo(1920);
    expect(far.y).toBeCloseTo(1080);
    // Pointer on the bars or off the window clamps to the frame edge.
    expect(clientToSource({ x: 500, y: 5 }, container, HD).y).toBe(0);
    expect(clientToSource({ x: -40, y: 999 }, container, HD)).toEqual({ x: 0, y: 1080 });
  });

  it('works under fractional display scaling (1920×1080 physical stream, 1536×864 CSS window)', () => {
    // At 125 % the fullscreen picker is 1536 × 864 CSS px; the portal stream is physical pixels.
    const container = { width: 1536, height: 864 };
    expect(containBox(container, HD).scale).toBeCloseTo(0.8);
    expect(clientToSource({ x: 768, y: 432 }, container, HD)).toEqual({ x: 960, y: 540 });
    const p = clientToSource({ x: 100.4, y: 50.2 }, container, HD);
    expect(p.x).toBeCloseTo(125.5);
    expect(p.y).toBeCloseTo(62.75);
    const back = sourceToClient({ x: 125.5, y: 62.75, width: 800, height: 400 }, container, HD);
    expect(back.x).toBeCloseTo(100.4);
    expect(back.width).toBeCloseTo(640);
  });

  it('round-trips client ↔ source for any window size inside the frame', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 4000 }),
        fc.integer({ min: 200, max: 3000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (w, h, fx, fy) => {
          const container = { width: w, height: h };
          const box = containBox(container, HD);
          const client = { x: box.x + fx * box.width, y: box.y + fy * box.height };
          const p = clientToSource(client, container, HD);
          const back = sourceToClient({ ...p, width: 0, height: 0 }, container, HD);
          expect(back.x).toBeCloseTo(client.x, 6);
          expect(back.y).toBeCloseTo(client.y, 6);
        },
      ),
    );
  });

  it('builds a rect from two corners in any drag direction, and squares it with Shift', () => {
    expect(rectFromCorners({ x: 500, y: 400 }, { x: 100, y: 100 }, HD)).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    });
    expect(rectFromCorners({ x: 100, y: 100 }, { x: 500, y: 200 }, HD, true)).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 400,
    });
    // A square that would leave the frame is limited by the room in the drag direction.
    expect(rectFromCorners({ x: 1800, y: 100 }, { x: 1900, y: 600 }, HD, true)).toEqual({
      x: 1800,
      y: 100,
      width: 120,
      height: 120,
    });
  });

  it('resizes with corner and edge handles, keeping the opposite side fixed', () => {
    const rect = { x: 100, y: 100, width: 400, height: 300 };
    expect(resizeRect(rect, 'se', { x: 700, y: 600 }, HD)).toEqual({
      x: 100,
      y: 100,
      width: 600,
      height: 500,
    });
    expect(resizeRect(rect, 'w', { x: 50, y: 999 }, HD)).toEqual({
      x: 50,
      y: 100,
      width: 450,
      height: 300,
    });
    expect(resizeRect(rect, 'n', { x: 0, y: 150 }, HD)).toEqual({
      x: 100,
      y: 150,
      width: 400,
      height: 250,
    });
    // Dragging past the opposite edge flips the rect instead of making it negative.
    expect(resizeRect(rect, 'e', { x: 40, y: 0 }, HD)).toEqual({
      x: 40,
      y: 100,
      width: 60,
      height: 300,
    });
    // Shift with a corner: a square, as large as the room towards the frame edge allows.
    expect(resizeRect(rect, 'nw', { x: 0, y: 0 }, HD, true)).toEqual({
      x: 100,
      y: 0,
      width: 400,
      height: 400,
    });
  });

  it('moves a rect without leaving the frame', () => {
    const rect = { x: 100, y: 100, width: 400, height: 300 };
    expect(moveRect(rect, -500, 2000, HD)).toEqual({ x: 0, y: 780, width: 400, height: 300 });
  });

  it('hit-tests handles before the inside', () => {
    const rect = { x: 100, y: 100, width: 400, height: 300 };
    expect(hitTest({ x: 103, y: 98 }, rect, 5)).toBe('nw');
    expect(hitTest({ x: 300, y: 401 }, rect, 5)).toBe('s');
    expect(hitTest({ x: 300, y: 250 }, rect, 5)).toBe('move');
    expect(hitTest({ x: 50, y: 50 }, rect, 5)).toBeNull();
  });

  it('finalizes to an even, clamped region of at least 64 × 64 source pixels', () => {
    expect(finalizeRegion({ x: 10.6, y: 21.2, width: 301.3, height: 199.9 }, HD)).toEqual({
      x: 10,
      y: 20,
      width: 302,
      height: 200,
    });
    // Too small: grown to the minimum.
    expect(finalizeRegion({ x: 500, y: 500, width: 3, height: 10 }, HD)).toEqual({
      x: 500,
      y: 500,
      width: MIN_REGION_SIZE,
      height: MIN_REGION_SIZE,
    });
    // Growing at the far edge shifts the region back inside.
    expect(finalizeRegion({ x: 1900, y: 1070, width: 10, height: 10 }, HD)).toEqual({
      x: 1856,
      y: 1016,
      width: 64,
      height: 64,
    });
    // Outside the frame: clamped.
    expect(finalizeRegion({ x: -50, y: -50, width: 3000, height: 3000 }, HD)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it('keeps every finalized region inside the frame, even and at least 64 px', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 64, max: 5000 }),
        fc.integer({ min: 64, max: 3000 }),
        fc.double({ min: -500, max: 6000, noNaN: true }),
        fc.double({ min: -500, max: 6000, noNaN: true }),
        fc.double({ min: 0, max: 6000, noNaN: true }),
        fc.double({ min: 0, max: 6000, noNaN: true }),
        (W, H, x, y, width, height) => {
          const r = finalizeRegion({ x, y, width, height }, { width: W, height: H });
          for (const v of [r.x, r.y, r.width, r.height]) expect(v % 2).toBe(0);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.width).toBeLessThanOrEqual(W);
          expect(r.y + r.height).toBeLessThanOrEqual(H);
          expect(r.width).toBeGreaterThanOrEqual(64);
          expect(r.height).toBeGreaterThanOrEqual(64);
        },
      ),
    );
  });

  it('handles odd-sized frames (the full frame rounds down to even)', () => {
    const odd = { width: 1365, height: 767 };
    expect(fullFrameRegion(odd)).toEqual({ x: 0, y: 0, width: 1364, height: 766 });
    expect(isFullFrame(fullFrameRegion(odd), odd)).toBe(true);
    expect(isFullFrame({ x: 2, y: 0, width: 1362, height: 766 }, odd)).toBe(false);
  });

  it('offers the last region only for a source of the same size', () => {
    const last = {
      sourceWidth: 1920,
      sourceHeight: 1080,
      rect: { x: 100, y: 50, width: 640, height: 360 },
    };
    expect(matchingLastRegion(last, HD)).toEqual(last.rect);
    expect(matchingLastRegion(last, { width: 2560, height: 1440 })).toBeNull();
    expect(matchingLastRegion(null, HD)).toBeNull();
  });
});
