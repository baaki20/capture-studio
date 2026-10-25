/**
 * Geometry of the preview compositor (pure; unit-tested): the background colour, destination
 * quads in clip space, texture coordinates of source rects (with mirror), and mask uniforms from
 * the render plan's layers.
 */
import type { NRect } from '../../../shared/project/schema';
import { maskRadius, type PixelRect, type VideoLayer } from '../../../shared/project/render-plan';

export interface Size {
  width: number;
  height: number;
}

/** `#RRGGBB` or `#RRGGBBAA` as 0–1 RGBA (black when malformed). */
export function parseHexColor(color: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(color);
  if (!m) return [0, 0, 0, 1];
  const channel = (hex: string | undefined, fallback: number) =>
    hex === undefined ? fallback : parseInt(hex, 16) / 255;
  return [channel(m[1], 0), channel(m[2], 0), channel(m[3], 0), channel(m[4], 1)];
}

/**
 * Clip-space corners of a destination rect for a TRIANGLE_STRIP in the order top-left,
 * top-right, bottom-left, bottom-right.
 */
export function quadVertices(dest: PixelRect, canvas: Size): Float32Array {
  const x0 = (dest.x / canvas.width) * 2 - 1;
  const x1 = ((dest.x + dest.width) / canvas.width) * 2 - 1;
  const y0 = 1 - (dest.y / canvas.height) * 2;
  const y1 = 1 - ((dest.y + dest.height) / canvas.height) * 2;
  return new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]);
}

/**
 * Texture coordinates of a source rect (in the media's pixels; v = 0 is the top row) for the
 * same corner order. Mirror swaps left and right.
 */
export function quadUvs(source: NRect, media: Size, mirror: boolean): Float32Array {
  let u0 = source.x / media.width;
  let u1 = (source.x + source.width) / media.width;
  const v0 = source.y / media.height;
  const v1 = (source.y + source.height) / media.height;
  if (mirror) [u0, u1] = [u1, u0];
  return new Float32Array([u0, v0, u1, v0, u0, v1, u1, v1]);
}

/** Mask uniforms of a layer: its rect in canvas px and the effective corner radius. */
export function maskUniforms(layer: Pick<VideoLayer, 'destRect' | 'mask'>): {
  rect: [number, number, number, number];
  radius: number;
} {
  const { x, y, width, height } = layer.destRect;
  return { rect: [x, y, width, height], radius: maskRadius(layer.mask, width, height) };
}
