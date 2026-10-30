/**
 * Picture comparison for the preview/export parity test (R1.48) and the Wayland region check
 * (W6): luma planes, SSIM and colour-keyed bounding boxes, on top-down RGB(A) buffers.
 */

export interface Picture {
  width: number;
  height: number;
  /** Top-down rows, `channels` bytes per pixel. */
  data: Uint8Array;
  channels: 3 | 4;
}

/** BT.709 luma, 0–255, one value per pixel. */
export function lumaPlane(p: Picture): Float64Array {
  const out = new Float64Array(p.width * p.height);
  for (let i = 0, j = 0; i < out.length; i++, j += p.channels) {
    out[i] =
      0.2126 * (p.data[j] ?? 0) + 0.7152 * (p.data[j + 1] ?? 0) + 0.0722 * (p.data[j + 2] ?? 0);
  }
  return out;
}

/**
 * Mean SSIM of two pictures' luma over 8×8 windows with a stride of 4 (Wang et al. 2004
 * constants for 8-bit data). Throws when the sizes differ.
 */
export function ssim(a: Picture, b: Picture, window = 8, stride = 4): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `size mismatch: ${String(a.width)}×${String(a.height)} vs ${String(b.width)}×${String(b.height)}`,
    );
  }
  const x = lumaPlane(a);
  const y = lumaPlane(b);
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const n = window * window;
  let total = 0;
  let count = 0;
  for (let top = 0; top + window <= a.height; top += stride) {
    for (let left = 0; left + window <= a.width; left += stride) {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let r = 0; r < window; r++) {
        const row = (top + r) * a.width + left;
        for (let c = 0; c < window; c++) {
          const vx = x[row + c] ?? 0;
          const vy = y[row + c] ?? 0;
          sx += vx;
          sy += vy;
          sxx += vx * vx;
          syy += vy * vy;
          sxy += vx * vy;
        }
      }
      const mx = sx / n;
      const my = sy / n;
      const vx = sxx / n - mx * mx;
      const vy = syy / n - my * my;
      const cov = sxy / n - mx * my;
      total += ((2 * mx * my + c1) * (2 * cov + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2));
      count++;
    }
  }
  return count ? total / count : 1;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bounding box of the pixels matching `key` inside `within` (canvas pixels), or null. A row or
 * column counts only with at least `minRun` matching pixels, so compression speckle is ignored.
 */
export function keyedBox(
  p: Picture,
  key: (r: number, g: number, b: number) => boolean,
  within: Box = { x: 0, y: 0, width: p.width, height: p.height },
  minRun = 3,
): Box | null {
  const x0 = Math.max(0, Math.floor(within.x));
  const y0 = Math.max(0, Math.floor(within.y));
  const x1 = Math.min(p.width, Math.ceil(within.x + within.width));
  const y1 = Math.min(p.height, Math.ceil(within.y + within.height));
  const cols = new Uint32Array(p.width);
  const rows = new Uint32Array(p.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const j = (y * p.width + x) * p.channels;
      if (key(p.data[j] ?? 0, p.data[j + 1] ?? 0, p.data[j + 2] ?? 0)) {
        cols[x] = (cols[x] ?? 0) + 1;
        rows[y] = (rows[y] ?? 0) + 1;
      }
    }
  }
  const first = (a: Uint32Array, from: number, to: number) => {
    for (let i = from; i < to; i++) if ((a[i] ?? 0) >= minRun) return i;
    return -1;
  };
  const last = (a: Uint32Array, from: number, to: number) => {
    for (let i = to - 1; i >= from; i--) if ((a[i] ?? 0) >= minRun) return i;
    return -1;
  };
  const left = first(cols, x0, x1);
  const top = first(rows, y0, y1);
  if (left < 0 || top < 0) return null;
  const right = last(cols, x0, x1);
  const bottom = last(rows, y0, y1);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Largest difference between the edges of two boxes, px. */
export function boxDistance(a: Box, b: Box): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}
