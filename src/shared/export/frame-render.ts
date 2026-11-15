/**
 * The frame-render export path (§1.7, plan decision D4): which projects use it, which timeline
 * time each output frame shows, and the layout of the raw yuv420p frames the export renderer
 * streams to FFmpeg. Main, the media utility and the renderer all use these, so they agree on
 * frame count, timing and bytes.
 *
 * - **Path choice (D4).** A project that uses any v2 visual feature is rendered frame by frame by
 *   the shared WebGL compositor; a Phase 1 project keeps the FFmpeg filter graph, whose output
 *   (and golden tests) stay as they were. Audio is a filter graph in both.
 * - **Frame times.** Output frame k shows timeline time `round(k × 10⁶ / F)`. For each video layer
 *   the renderer shows the source frame *nearest* to the layer's file time, as FFmpeg's `fps`
 *   filter does (`round=near`): the latest frame earlier than half an output frame after it.
 * - **Frame bytes.** yuv420p, BT.709 limited range: the Y plane (W × H), then U and V
 *   (W/2 × H/2 each), rows top to bottom, no padding. The GPU writes the three planes packed four
 *   samples per RGBA texel into one target (`yuvTarget`); `unpackYuv` turns the read-back into
 *   frame bytes.
 */
import type { ExportOptions } from '../ipc/contract';
import { cursorEffectsActive } from '../project/cursor-effects';
import type { Project } from '../project/schema';
import { exportSize } from './presets';

export interface FrameSpec {
  /** Output size, even. */
  width: number;
  height: number;
  fps: number;
  /** Frames in the export: `round(duration × F)`, as the filter graph counts them. */
  frames: number;
}

/** Export frame rate for the dialog's choice. */
export function exportFps(doc: Project, options: Pick<ExportOptions, 'fps'>): number {
  return options.fps === 'project' ? doc.timeline.frameRate : options.fps;
}

/** Frames in `durationUs` at `fps` (rounded, as in the filter graph). */
export function frameCount(durationUs: number, fps: number): number {
  return Math.round((durationUs * fps) / 1_000_000);
}

export function frameSpec(
  doc: Project,
  options: Pick<ExportOptions, 'fps' | 'resolution'>,
  durationUs: number,
): FrameSpec {
  const fps = exportFps(doc, options);
  return {
    ...exportSize(doc.timeline.canvas, options.resolution),
    fps,
    frames: frameCount(durationUs, fps),
  };
}

/** Timeline time shown by output frame `k`. */
export function frameTimeUs(k: number, fps: number): number {
  return Math.round((k * 1_000_000) / fps);
}

/**
 * The file time to look a decoded frame up at (latest frame at or before it) so that a layer at
 * file time `fileTimeUs` shows the source frame nearest to it: anything earlier than half an
 * output frame later.
 */
export function pickTimeUs(fileTimeUs: number, fps: number): number {
  return fileTimeUs + Math.ceil(500_000 / fps) - 1;
}

/**
 * Whether the project uses a v2 visual feature, so the export must render frames (D4). Audio-only
 * v2 fields (gain, volume keyframes, cleanup) and markers do not count: audio is a filter graph
 * on both paths.
 */
export function needsFrameRender(doc: Project): boolean {
  const { timeline } = doc;
  if (timeline.beautify) return true;
  if (cursorEffectsActive(doc)) return true;
  if ((timeline.camera?.length ?? 0) > 0) return true;
  if (timeline.objectTracks?.some((track) => track.items.length > 0)) return true;
  for (const track of timeline.tracks) {
    if (track.type !== 'video') continue;
    if ((track.layoutKeyframes?.length ?? 0) > 0) return true;
    const { layout } = track;
    if (layout.kind === 'overlay') {
      if ((layout.zoom ?? 1) !== 1 || layout.border || layout.shadow) return true;
    }
    for (const clip of track.clips) {
      if (clip.speed !== undefined || clip.freeze || clip.transitionIn) return true;
      if (clip.fadeInUs || clip.fadeOutUs) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// yuv420p frames

/** Bytes of one yuv420p frame. */
export function yuvFrameBytes(width: number, height: number): number {
  return width * height + 2 * (width / 2) * (height / 2);
}

export interface YuvTarget {
  /** Size of the RGBA render target holding the three packed planes. */
  width: number;
  height: number;
  /** Texels per row used by the Y plane and by each chroma plane. */
  lumaTexels: number;
  chromaTexels: number;
}

/**
 * The packed render target for a W × H frame: four samples per RGBA texel; Y in rows [0, H),
 * U in rows [H, 3H/2), V in rows [3H/2, 2H). Row r of the target is row r of its plane (the GPU
 * writes and reads back bottom-up, so plane rows need no flipping).
 */
export function yuvTarget(width: number, height: number): YuvTarget {
  const lumaTexels = Math.ceil(width / 4);
  return { width: lumaTexels, height: 2 * height, lumaTexels, chromaTexels: Math.ceil(width / 8) };
}

/** Frame bytes from the read-back of the packed target (`width × height × 4`, bottom-up rows). */
export function unpackYuv(
  readback: Uint8Array,
  width: number,
  height: number,
  out: Uint8Array = new Uint8Array(yuvFrameBytes(width, height)),
): Uint8Array {
  const target = yuvTarget(width, height);
  const stride = target.width * 4;
  if (readback.length < stride * target.height) {
    throw new Error(`unpackYuv: read-back of ${String(readback.length)} bytes is too short`);
  }
  let o = 0;
  for (let r = 0; r < height; r++) {
    out.set(readback.subarray(r * stride, r * stride + width), o);
    o += width;
  }
  const cw = width / 2;
  for (let r = 0; r < height; r++) {
    // Rows H .. 3H/2 are U, then V.
    out.set(readback.subarray((height + r) * stride, (height + r) * stride + cw), o);
    o += cw;
  }
  return out;
}

/** BT.709 luma coefficients. */
export const KR = 0.2126;
export const KB = 0.0722;
export const KG = 1 - KR - KB;

/**
 * R'G'B' in [0, 1] to limited-range BT.709 Y'CbCr codes (the reference for the shader below).
 */
export function rgbToYuv709(r: number, g: number, b: number): [number, number, number] {
  const y = KR * r + KG * g + KB * b;
  const pb = (b - y) / (2 * (1 - KB));
  const pr = (r - y) / (2 * (1 - KR));
  const code = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return [code(16 + 219 * y), code(128 + 224 * pb), code(128 + 224 * pr)];
}

const glslFloat = (n: number) => n.toFixed(8);

/** GLSL of `rgbToYuv709`, as 0–1 values for an 8-bit target. */
export const YUV709_GLSL = `
float csLuma(vec3 c) {
  return dot(c, vec3(${glslFloat(KR)}, ${glslFloat(KG)}, ${glslFloat(KB)}));
}
vec3 csYuv709(vec3 c) {
  float y = csLuma(c);
  float pb = (c.b - y) / ${glslFloat(2 * (1 - KB))};
  float pr = (c.r - y) / ${glslFloat(2 * (1 - KR))};
  return vec3(16.0 + 219.0 * y, 128.0 + 224.0 * pb, 128.0 + 224.0 * pr) / 255.0;
}
`;
