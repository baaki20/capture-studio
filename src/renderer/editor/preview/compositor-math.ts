/**
 * Geometry of the preview compositor (pure; unit-tested): the background colour, destination
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
 * The colour cleared under every layer. A gradient background (beautify) is drawn by its own
 * pass from step 4; until then its first colour stands in.
 */
export function sceneBackgroundColor(scene: Pick<Scene, 'background'>): string {
  const bg = scene.background;
  return bg.type === 'color' ? bg.color : bg.from;
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
