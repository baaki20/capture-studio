import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FACE_CORNERS,
  FACE_MARGIN,
  FACE_SIZE_PRESETS,
  FACE_WIDTH_MAX,
  FACE_WIDTH_MIN,
  applyCornerPreset,
  applySizePreset,
  clampOverlayLayout,
  clampRectToFrame,
  layoutFromDestRect,
  overlayDestRect,
  overlayRadiusPx,
  overlaySourceRect,
  roundEven,
} from '../../src/shared/project/face-layout';
import { defaultFaceLayout } from '../../src/shared/project/from-recording';
import type { OverlayLayout } from '../../src/shared/project/schema';

const CANVAS = { width: 1920, height: 1080 };
const CAMERA = { width: 1280, height: 720 };

function layout(overrides: Partial<OverlayLayout> = {}): OverlayLayout {
  return {
    kind: 'overlay',
    centerX: 0.5,
    centerY: 0.5,
    width: 0.2,
    shape: 'circle',
    cornerRadius: 0.12,
    mirror: false,
    crop: null,
    ...overrides,
  };
}

describe('source rect', () => {
  it('uses a centred square for a circle and the full frame otherwise', () => {
    expect(overlaySourceRect(layout(), CAMERA)).toEqual({ x: 280, y: 0, width: 720, height: 720 });
    expect(overlaySourceRect(layout({ shape: 'rectangle' }), CAMERA)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it('applies the crop, clamped to the frame, and squares it for a circle', () => {
    const crop = { x: 100, y: 100, width: 400, height: 200 };
    expect(overlaySourceRect(layout({ shape: 'rounded', crop }), CAMERA)).toEqual(crop);
    expect(overlaySourceRect(layout({ crop }), CAMERA)).toEqual({
      x: 200,
      y: 100,
      width: 200,
      height: 200,
    });
    expect(clampRectToFrame({ x: 1200, y: 700, width: 500, height: 500 }, CAMERA)).toEqual({
      x: 1200,
      y: 700,
      width: 80,
      height: 20,
    });
  });
});

describe('destination rect', () => {
  it('is even-sized, keeps the aspect and sits at the centre', () => {
    expect(overlayDestRect(layout(), CANVAS, CAMERA)).toEqual({
      x: 768,
      y: 348,
      width: 384,
      height: 384,
    });
    const rect = overlayDestRect(layout({ shape: 'rectangle', width: 0.25 }), CANVAS, CAMERA);
    expect(rect).toEqual({ x: 720, y: 405, width: 480, height: 270 });
    expect(roundEven(269.9)).toBe(270);
    expect(roundEven(0.4)).toBe(2);
  });

  it('matches the recorder default layout corner', () => {
    const rect = overlayDestRect(defaultFaceLayout(CANVAS), CANVAS, CAMERA);
    const margin = FACE_MARGIN * 1080;
    expect(Math.abs(rect.x + rect.width - (1920 - margin))).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.y + rect.height - (1080 - margin))).toBeLessThanOrEqual(1);
  });

  it('computes the corner radius in pixels', () => {
    expect(overlayRadiusPx(layout(), { width: 384, height: 384 })).toBe(192);
    expect(
      overlayRadiusPx(layout({ shape: 'rounded', cornerRadius: 0.25 }), {
        width: 480,
        height: 270,
      }),
    ).toBe(67.5);
    expect(overlayRadiusPx(layout({ shape: 'rectangle' }), { width: 480, height: 270 })).toBe(0);
  });
});

describe('clamping (R1.41: always fully inside the canvas)', () => {
  it('limits the width to 5–50 % and pulls the centre inside', () => {
    expect(clampOverlayLayout(layout({ width: 0.01 }), CANVAS, CAMERA).width).toBe(FACE_WIDTH_MIN);
    const big = clampOverlayLayout(layout({ width: 0.9, centerX: 0, centerY: 1 }), CANVAS, CAMERA);
    expect(big.width).toBe(FACE_WIDTH_MAX);
    // A 960 px circle on a 1080 px high canvas: the centre must be at least 480 px from edges.
    expect(big.centerX).toBeCloseTo(0.25);
    expect(big.centerY).toBeCloseTo(1 - 480 / 1080);
  });

  it('shrinks an overlay that would be taller than a wide canvas', () => {
    const wide = { width: 3840, height: 1080 };
    const clamped = clampOverlayLayout(layout({ width: 0.5 }), wide, CAMERA);
    expect(clamped.width * wide.width).toBeLessThanOrEqual(1080 + 1e-6);
  });

  it('keeps any layout inside any canvas (property)', () => {
    fc.assert(
      fc.property(
        fc.record({
          centerX: fc.double({ min: -1, max: 2, noNaN: true }),
          centerY: fc.double({ min: -1, max: 2, noNaN: true }),
          width: fc.double({ min: 0, max: 1, noNaN: true }),
          shape: fc.constantFrom('rectangle' as const, 'rounded' as const, 'circle' as const),
          cornerRadius: fc.double({ min: -1, max: 2, noNaN: true }),
        }),
        fc.integer({ min: 32, max: 3840 }).map((n) => n * 2),
        fc.integer({ min: 32, max: 2160 }).map((n) => n * 2),
        fc.integer({ min: 16, max: 1920 }),
        fc.integer({ min: 16, max: 1920 }),
        (fields, cw, ch, fw, fh) => {
          const canvas = { width: cw, height: ch };
          const frame = { width: fw, height: fh };
          const clamped = clampOverlayLayout(layout(fields), canvas, frame);
          expect(clamped.width).toBeGreaterThanOrEqual(FACE_WIDTH_MIN);
          expect(clamped.width).toBeLessThanOrEqual(FACE_WIDTH_MAX);
          expect(clamped.cornerRadius).toBeGreaterThanOrEqual(0);
          expect(clamped.cornerRadius).toBeLessThanOrEqual(0.5);
          const rect = overlayDestRect(clamped, canvas, frame);
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(cw);
          expect(rect.y + rect.height).toBeLessThanOrEqual(ch);
          expect(Number.isInteger(rect.x) && Number.isInteger(rect.y)).toBe(true);
          // Clamping is idempotent.
          expect(clampOverlayLayout(clamped, canvas, frame)).toEqual(clamped);
        },
      ),
    );
  });
});

describe('presets', () => {
  it('places the overlay in each corner with the margin', () => {
    const margin = Math.round(FACE_MARGIN * 1080);
    for (const corner of FACE_CORNERS) {
      const rect = overlayDestRect(
        applyCornerPreset(layout(), corner, CANVAS, CAMERA),
        CANVAS,
        CAMERA,
      );
      const left = corner.endsWith('left');
      const top = corner.startsWith('top');
      expect(Math.abs((left ? rect.x : 1920 - rect.x - rect.width) - margin)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs((top ? rect.y : 1080 - rect.y - rect.height) - margin)).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it('sets the size from a preset', () => {
    expect(applySizePreset(layout(), 'large', CANVAS, CAMERA).width).toBe(FACE_SIZE_PRESETS.large);
  });

  it('turns a dragged box back into a layout', () => {
    const l = layout({ shape: 'rectangle' });
    const rect = { x: 100, y: 50, width: 480, height: 270 };
    const next = layoutFromDestRect(l, rect, CANVAS, CAMERA);
    expect(overlayDestRect(next, CANVAS, CAMERA)).toEqual(rect);
  });
});
