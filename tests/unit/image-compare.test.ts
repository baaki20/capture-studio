/**
 * Picture comparison helpers of the parity test (R1.48) and W6: SSIM and keyed bounding boxes.
 */
import { describe, expect, it } from 'vitest';
import { boxDistance, keyedBox, ssim, type Picture } from '../sync/image';

function picture(width: number, height: number, fill: (x: number, y: number) => number[]): Picture {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 3);
  }
  return { width, height, data, channels: 3 };
}

const texture = (x: number, y: number) => {
  const v = (x * 37 + y * 11 + ((x * y) % 7) * 20) % 256;
  return [v, v, v];
};

describe('ssim', () => {
  it('is 1 for identical pictures and drops with noise and shifts', () => {
    const a = picture(64, 48, texture);
    expect(ssim(a, a)).toBeCloseTo(1, 10);
    const noisy = picture(64, 48, (x, y) =>
      texture(x, y).map((v) => Math.min(255, v + ((x + y) % 3) * 4)),
    );
    const s = ssim(a, noisy);
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThan(0.9);
    const shifted = picture(64, 48, (x, y) => texture(x + 1, y));
    expect(ssim(a, shifted)).toBeLessThan(0.9);
    expect(() => ssim(a, picture(32, 48, texture))).toThrow('size mismatch');
  });
});

describe('keyedBox', () => {
  const magenta = (r: number, g: number, b: number) => r > 180 && g < 80 && b > 180;
  const p = picture(100, 80, (x, y) =>
    x >= 20 && x < 50 && y >= 10 && y < 40
      ? [255, 0, 255]
      : x === 90 && y === 5
        ? [255, 0, 255]
        : [0, 0, 0],
  );

  it('finds the keyed region and ignores single stray pixels', () => {
    const box = keyedBox(p, magenta);
    expect(box).toEqual({ x: 20, y: 10, width: 30, height: 30 });
    expect(keyedBox(p, magenta, { x: 60, y: 0, width: 40, height: 80 })).toBeNull();
    expect(boxDistance(box!, { x: 21, y: 10, width: 30, height: 32 })).toBe(2);
  });
});
