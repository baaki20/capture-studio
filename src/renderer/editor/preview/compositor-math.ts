/**
 * Geometry of the preview compositor (pure; unit-tested): the background gradient, destination
 * quads in clip space, texture coordinates of source rects (with mirror), and mask uniforms from
 * the render plan's layers.
 */
import type { NRect } from '../../../shared/project/schema';
import { maskRadius, type PixelRect, type VideoLayer } from '../../../shared/project/render-plan';
import type { RectF, Scene, SceneLayer, SceneShadow } from '../../../shared/project/scene';

export interface Size {
  width: number;
  height: number;
}

/**
 * One layer to draw. Generic in the picture type so code that only arranges layers (the export
 * render loop) needs no DOM types; the WebGL compositor takes `TexImageSource` pictures.
 */
export interface CompositeItemOf<F> {
  /**
   * `opacity` multiplies the layer (1 when absent); `border` is drawn inside the mask's edge and
   * `shadow` under the layer (scene layers, `sceneAt`).
   */
  layer: VideoLayer & Partial<Pick<SceneLayer, 'opacity' | 'border' | 'shadow'>>;
  /** The decoded picture, or null for a placeholder. */
  frame: F | null;
  /** The media's picture size (`Media.video`), the space of `layer.sourceRect`. */
  mediaSize: Size;
}

/**
 * One object to draw above the layers (`objectDrawPlan` in `shared/project/objects.ts`), generic
 * in the picture type like `CompositeItemOf`:
 * - `image`: a picture drawn with canvas 2D (text, callouts), premultiplied, placed 1:1 at
 *   `rect`; `key` identifies the picture, so the compositor uploads it once;
 * - `blur` / `pixelate`: a region of what is drawn so far, blurred or in blocks.
 */
export type CompositeObjectOf<I> =
  | { kind: 'image'; key: string; image: I; rect: RectF; opacity: number }
  | { kind: 'blur'; rect: RectF; radiusPx: number; opacity: number }
  | { kind: 'pixelate'; rect: RectF; blockPx: number; opacity: number };

/** Largest blur reach in pixels the shader samples (taps on each side). */
export const MAX_BLUR_PX = 128;

/**
 * Normalised Gaussian weights for taps 0…n of a blur reaching `radiusPx` (σ = radius / 3), as the
 * blur shader computes them.
 */
export function blurWeights(radiusPx: number): number[] {
  const n = Math.min(MAX_BLUR_PX, Math.ceil(radiusPx));
  const sigma = Math.max(radiusPx / 3, 0.5);
  const raw = Array.from({ length: n + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = raw.reduce((sum, w, i) => sum + (i === 0 ? w : 2 * w), 0);
  return raw.map((w) => w / total);
}

/**
 * The pixel a pixelate block samples for output pixel (`x`, `y`) (top-down, whole pixels): the
 * centre of its block, blocks of `blockPx` starting at the region's top-left corner.
 */
export function pixelateSample(
  rect: RectF,
  blockPx: number,
  x: number,
  y: number,
  canvas: Size,
): [number, number] {
  const at = (p: number, origin: number, size: number, limit: number) => {
    const cell = Math.floor((p + 0.5 - origin) / blockPx);
    const centre = origin + (cell + 0.5) * blockPx;
    const inside = Math.min(origin + size - 0.5, Math.max(origin + 0.5, centre));
    return Math.min(limit - 1, Math.max(0, Math.floor(inside)));
  };
  return [at(x, rect.x, rect.width, canvas.width), at(y, rect.y, rect.height, canvas.height)];
}

/** What is drawn under every layer: a colour, or a beautify gradient. */
export type SceneBackground = Scene['background'];

/**
 * The axis of a linear gradient at `angleDeg` over a canvas, as CSS `linear-gradient` defines
 * it: 0° runs bottom to top, 90° left to right, 180° top to bottom. `dir` is a unit vector in
 * top-down pixels; the gradient line passes through the centre and is `length` px long, so the
 * corners get exactly the end colours.
 */
export function gradientAxis(
  angleDeg: number,
  canvas: Size,
): { dirX: number; dirY: number; length: number } {
  const a = (angleDeg * Math.PI) / 180;
  const dirX = Math.sin(a);
  const dirY = -Math.cos(a);
  return {
    dirX,
    dirY,
    length: Math.max(1e-6, Math.abs(canvas.width * dirX) + Math.abs(canvas.height * dirY)),
  };
}

/** 0–1 along the gradient at a pixel centre (`x`, `y` top-down), as `csGradientT` computes. */
export function gradientT(angleDeg: number, canvas: Size, x: number, y: number): number {
  const { dirX, dirY, length } = gradientAxis(angleDeg, canvas);
  const t = ((x - canvas.width / 2) * dirX + (y - canvas.height / 2) * dirY) / length + 0.5;
  return Math.min(1, Math.max(0, t));
}

/** GLSL of `gradientT` (p top-down at the pixel centre; dir and length from `gradientAxis`). */
export const GRADIENT_GLSL = `
float csGradientT(vec2 p, vec2 size, vec2 dir, float len) {
  return clamp(dot(p - 0.5 * size, dir) / len + 0.5, 0.0, 1.0);
}
`;

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
export function quadVertices(dest: RectF, canvas: Size): Float32Array {
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

/** The smallest blur the shadow shader uses (an edge of `smoothstep(-b, b)` needs b > 0). */
export const MIN_SHADOW_BLUR_PX = 0.5;

/**
 * Where a layer's drop shadow is drawn: the mask's rect moved by the offset (`maskRect`), and the
 * quad covering it with the blur on every side (`quad`). The shadow fades over `±blur` px around
 * the moved mask's edge.
 */
export function shadowGeometry(
  dest: PixelRect,
  shadow: SceneShadow,
): { maskRect: RectF; quad: RectF; blur: number } {
  const blur = Math.max(MIN_SHADOW_BLUR_PX, shadow.blurPx);
  const maskRect = {
    x: dest.x + shadow.offsetXPx,
    y: dest.y + shadow.offsetYPx,
    width: dest.width,
    height: dest.height,
  };
  const pad = blur + 1;
  return {
    maskRect,
    quad: {
      x: maskRect.x - pad,
      y: maskRect.y - pad,
      width: maskRect.width + 2 * pad,
      height: maskRect.height + 2 * pad,
    },
    blur,
  };
}

/** Mask uniforms of a layer: its rect in canvas px and the effective corner radius. */
export function maskUniforms(layer: Pick<VideoLayer, 'destRect' | 'mask'>): {
  rect: [number, number, number, number];
  radius: number;
} {
  const { x, y, width, height } = layer.destRect;
  return { rect: [x, y, width, height], radius: maskRadius(layer.mask, width, height) };
}
