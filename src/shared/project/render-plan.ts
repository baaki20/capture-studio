/**
 * Render plan (§1.7, §4.3.8, §4.3.9): a pure function from a project (and a time) to what is
 * drawn and heard. **The preview compositor and the export graph both consume it**, which is
 * what makes them agree geometrically (R1.48).
 *
 * Video:
 * - `layersAt(doc, tUs)`: the visible video layers at timeline time `tUs`, bottom to top. Each has
 *   an integer source rect in file pixels (crop applied), an integer destination rect on the
 *   canvas, a mask (shape + radius in canvas px), a mirror flag and the file-local time to show.
 *   The preview worker calls it once per output frame.
 * - `segments(doc)`: `[0, timelineDuration)` cut into intervals in which the layer set does not
 *   change. Inside a segment each layer's file time is linear in timeline time
 *   (`layerFileTimeUs`). `layersAt` and `segments` agree at every time.
 * - `videoTrackPlans(doc)`: per visible video track, clip and gap pieces covering the whole
 *   timeline in order: the input for the export's per-track `trim … concat` chains (§4.3.9 step 2).
 *
 * Audio:
 * - `audioSegments(doc)`: one entry per audio clip with its timeline placement, file-local in/out,
 *   clock ratio and gain after mute and solo (audible clips only, unless asked). The placement is
 *   the clip's covered part (`clipCoverage`), so a nudged clip may start later or end earlier.
 *
 * Masks:
 * - `maskCoverage` is the anti-aliased coverage function for rectangle, rounded and circle masks
 *   (a signed-distance field with a 1-px smoothstep). `MASK_COVERAGE_GLSL` is the same function
 *   for the WebGL2 compositor, and `maskAlpha` rasterizes it for the export's mask PNG.
 *
 * Conventions: integer µs; destination rects have even sizes (yuv420p export) and lie inside the
 * canvas; screen layers are fit with "contain" and centred (letterboxed in the background colour);
 * a clip covers `[timelineStartUs, end)`.
 *
 * Sync nudges are non-destructive (R1.42): a clip keeps its un-nudged range, and where the nudged
 * mapping falls outside the media file (`clipCoverage`), the plan has no layer (a gap: the
 * background, or the track below) and no audio (silence). `layersAt`, `segments`,
 * `videoTrackPlans` and `audioSegments` all apply the same coverage. Offline media (status `missing` or `failed`) still get
 * layers with `offline: true`, so the preview can draw a placeholder; export must refuse them
 * (R1.29). A video media without a known picture size cannot be placed and gets no layer.
 */
import type { Us } from '../time';
import {
  clampRectToFrame,
  overlayDestRect,
  overlayRadiusPx,
  overlaySourceRect,
  roundEven,
  type PixelRect,
  type Size,
} from './face-layout';
import { mediaRefBounds, refToFileUs, refToFileUsExact, type MediaClock } from './media-time';
import type { Clip, Media, NRect, ProjectV1, Track, VideoTrack } from './schema';
import { clipAt, clipEndUs, timelineDurationUs } from './timeline-ops';

export type { PixelRect } from './face-layout';

export type MaskShape = 'rectangle' | 'rounded' | 'circle';

export interface LayerMask {
  shape: MaskShape;
  /** Corner radius in canvas pixels (0 for a rectangle, half the short side for a circle). */
  radiusPx: number;
}

/** Where and how one clip's picture is drawn; constant for the whole clip in P1. */
export interface LayerGeometry {
  trackId: string;
  /** Index in `timeline.tracks` (bottom-to-top render order). */
  trackIndex: number;
  kind: 'screen' | 'overlay';
  clipId: string;
  mediaId: string;
  /** Integer rect in the media's file pixels. */
  sourceRect: NRect;
  /** Integer rect in canvas pixels, even-sized, inside the canvas. */
  destRect: PixelRect;
  mask: LayerMask;
  /** Flip horizontally (U axis). */
  mirror: boolean;
  /** The media file is missing or failed: draw a placeholder; export must refuse. */
  offline: boolean;
}

export interface VideoLayer extends LayerGeometry {
  /** Reference-clock time shown. */
  refTimeUs: Us;
  /** File-local time to decode (`media-time.ts`), integer µs. */
  fileTimeUs: Us;
}

export interface SegmentLayer extends LayerGeometry {
  /** The media's clock, for `layerFileTimeUs` and exact FFmpeg seconds. */
  clock: MediaClock;
  /** Reference-clock time at the segment start and end. */
  refStartUs: Us;
  refEndUs: Us;
  /** File-local time at the segment start and end, integer µs. */
  fileStartUs: Us;
  fileEndUs: Us;
}

export interface Segment {
  startUs: Us;
  endUs: Us;
  /** Bottom to top; empty in a gap (background only). */
  layers: SegmentLayer[];
}

export type TrackPiece =
  | { kind: 'clip'; startUs: Us; endUs: Us; layer: SegmentLayer }
  | { kind: 'gap'; startUs: Us; endUs: Us };

export interface VideoTrackPlan {
  trackId: string;
  trackIndex: number;
  /** In timeline order, contiguous, covering `[0, timelineDuration)`. */
  pieces: TrackPiece[];
}

export interface AudioSegment {
  trackId: string;
  trackIndex: number;
  clipId: string;
  mediaId: string;
  timelineStartUs: Us;
  timelineEndUs: Us;
  refStartUs: Us;
  refEndUs: Us;
  /** File-local in and out, integer µs. */
  fileStartUs: Us;
  fileEndUs: Us;
  /** Exact file-local seconds, for FFmpeg `atrim`. */
  fileStartSeconds: number;
  fileEndSeconds: number;
  /** Reference µs per file µs; play at `1 / clockRatio` (preview) or `asetrate` (export). */
  clockRatio: number;
  /** Track gain in dB (meaningful when `audible`). */
  gainDb: number;
  /** `10^(gainDb/20)` when audible, else 0. */
  linearGain: number;
  /** False when muted, or when another track is soloed and this one is not. */
  audible: boolean;
  offline: boolean;
}

// ---------------------------------------------------------------------------------------------
// Geometry

export function isOfflineMedia(media: Media): boolean {
  return media.status === 'missing' || media.status === 'failed';
}

/** "Contain" fit of a source size into the canvas, centred, even-sized. */
export function containRect(source: Size, canvas: Size): PixelRect {
  const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
  const width = Math.min(canvas.width, roundEven(source.width * scale));
  const height = Math.min(canvas.height, roundEven(source.height * scale));
  return {
    x: Math.floor((canvas.width - width) / 2),
    y: Math.floor((canvas.height - height) / 2),
    width,
    height,
  };
}

/** Geometry of a clip on a video track, or null when its media has no known picture size. */
export function layerGeometry(
  doc: ProjectV1,
  track: VideoTrack,
  trackIndex: number,
  clip: Clip,
  media: Media,
): LayerGeometry | null {
  if (!media.video) return null;
  const frame = { width: media.video.width, height: media.video.height };
  const canvas = doc.timeline.canvas;
  const base = {
    trackId: track.id,
    trackIndex,
    clipId: clip.id,
    mediaId: media.id,
    offline: isOfflineMedia(media),
  };
  const layout = track.layout;
  if (layout.kind === 'screen') {
    const sourceRect = layout.crop
      ? clampRectToFrame(layout.crop, frame)
      : { x: 0, y: 0, width: frame.width, height: frame.height };
    return {
      ...base,
      kind: 'screen',
      sourceRect,
      destRect: containRect(sourceRect, canvas),
      mask: { shape: 'rectangle', radiusPx: 0 },
      mirror: false,
    };
  }
  const destRect = overlayDestRect(layout, canvas, frame);
  return {
    ...base,
    kind: 'overlay',
    sourceRect: overlaySourceRect(layout, frame),
    destRect,
    mask: { shape: layout.shape, radiusPx: overlayRadiusPx(layout, destRect) },
    mirror: layout.mirror,
  };
}

function mediaMap(doc: ProjectV1): Map<string, Media> {
  return new Map(doc.media.map((m) => [m.id, m]));
}

function clockOf(media: Media): MediaClock {
  return {
    startOffsetUs: media.startOffsetUs,
    syncAdjustUs: media.syncAdjustUs,
    clockRatio: media.clockRatio,
    durationUs: media.durationUs,
  };
}

function visibleVideoTracks(doc: ProjectV1): { track: VideoTrack; trackIndex: number }[] {
  const result: { track: VideoTrack; trackIndex: number }[] = [];
  doc.timeline.tracks.forEach((track, trackIndex) => {
    if (track.type === 'video' && !track.hidden) result.push({ track, trackIndex });
  });
  return result;
}

function refAt(clip: Clip, tUs: Us): Us {
  return clip.sourceStartUs + (tUs - clip.timelineStartUs);
}

/**
 * The part of a clip, in timeline µs, where the media file has content under the current sync
 * nudge: the clip's span intersected with `mediaRefBounds`. Null when a nudge moved the file
 * entirely away from the clip. Without a nudge it is the whole clip (invariant 2).
 */
export function clipCoverage(clip: Clip, media: MediaClock): { startUs: Us; endUs: Us } | null {
  const bounds = mediaRefBounds(media);
  const refStart = Math.max(clip.sourceStartUs, bounds.startUs);
  const refEnd = Math.min(clip.sourceEndUs, bounds.endUs);
  if (refEnd <= refStart) return null;
  return {
    startUs: clip.timelineStartUs + (refStart - clip.sourceStartUs),
    endUs: clip.timelineStartUs + (refEnd - clip.sourceStartUs),
  };
}

function covers(clip: Clip, media: MediaClock, tUs: Us): boolean {
  const span = clipCoverage(clip, media);
  return span !== null && tUs >= span.startUs && tUs < span.endUs;
}

// ---------------------------------------------------------------------------------------------
// Video

/** Visible video layers at timeline time `tUs`, bottom to top. */
export function layersAt(doc: ProjectV1, tUs: Us): VideoLayer[] {
  const media = mediaMap(doc);
  const layers: VideoLayer[] = [];
  for (const { track, trackIndex } of visibleVideoTracks(doc)) {
    const clip = clipAt(track, tUs);
    const m = clip ? media.get(clip.mediaId) : undefined;
    if (!clip || !m || !covers(clip, m, tUs)) continue;
    const geometry = layerGeometry(doc, track, trackIndex, clip, m);
    if (!geometry) continue;
    const refTimeUs = refAt(clip, tUs);
    layers.push({ ...geometry, refTimeUs, fileTimeUs: refToFileUs(m, refTimeUs) });
  }
  return layers;
}

function segmentLayer(
  doc: ProjectV1,
  track: VideoTrack,
  trackIndex: number,
  clip: Clip,
  media: Media,
  startUs: Us,
  endUs: Us,
): SegmentLayer | null {
  const geometry = layerGeometry(doc, track, trackIndex, clip, media);
  if (!geometry) return null;
  const refStartUs = refAt(clip, startUs);
  const refEndUs = refAt(clip, endUs);
  return {
    ...geometry,
    clock: clockOf(media),
    refStartUs,
    refEndUs,
    fileStartUs: refToFileUs(media, refStartUs),
    fileEndUs: refToFileUs(media, refEndUs),
  };
}

/** Timeline intervals over which the visible layer set is constant, covering `[0, duration)`. */
export function segments(doc: ProjectV1): Segment[] {
  const duration = timelineDurationUs(doc);
  if (duration === 0) return [];
  const tracks = visibleVideoTracks(doc);
  const media = mediaMap(doc);
  const cuts = new Set<Us>([0, duration]);
  for (const { track } of tracks) {
    for (const clip of track.clips) {
      // The layer set changes where a clip's covered part starts and ends (the whole clip
      // unless a sync nudge moved the file away from an edge).
      const m = media.get(clip.mediaId);
      const span = m ? clipCoverage(clip, m) : null;
      if (span) {
        cuts.add(span.startUs);
        cuts.add(span.endUs);
      } else if (!m) {
        cuts.add(clip.timelineStartUs);
        cuts.add(clipEndUs(clip));
      }
    }
  }
  const times = [...cuts].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);
  const result: Segment[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const startUs = times[i] ?? 0;
    const endUs = times[i + 1] ?? duration;
    const layers: SegmentLayer[] = [];
    for (const { track, trackIndex } of tracks) {
      const clip = clipAt(track, startUs);
      const m = clip ? media.get(clip.mediaId) : undefined;
      if (!clip || !m || !covers(clip, m, startUs)) continue;
      const layer = segmentLayer(doc, track, trackIndex, clip, m, startUs, endUs);
      if (layer) layers.push(layer);
    }
    result.push({ startUs, endUs, layers });
  }
  return result;
}

/** The segment containing `tUs` (binary search), or null outside `[0, duration)`. */
export function segmentAt(list: readonly Segment[], tUs: Us): Segment | null {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = list[mid];
    if (!seg) break;
    if (tUs < seg.startUs) hi = mid - 1;
    else if (tUs >= seg.endUs) lo = mid + 1;
    else return seg;
  }
  return null;
}

/** File-local time of a segment layer at timeline time `tUs` inside the segment. */
export function layerFileTimeUs(segment: Segment, layer: SegmentLayer, tUs: Us): Us {
  return refToFileUs(layer.clock, layer.refStartUs + (tUs - segment.startUs));
}

/** The layers of a segment at `tUs`, in the same form `layersAt` returns. */
export function segmentLayersAt(segment: Segment, tUs: Us): VideoLayer[] {
  return segment.layers.map((layer) => {
    const {
      clock: _clock,
      refStartUs,
      refEndUs: _re,
      fileStartUs: _fs,
      fileEndUs: _fe,
      ...g
    } = layer;
    const refTimeUs = refStartUs + (tUs - segment.startUs);
    return { ...g, refTimeUs, fileTimeUs: refToFileUs(layer.clock, refTimeUs) };
  });
}

/** Per visible video track: clip and gap pieces covering `[0, duration)` (export step 2). */
export function videoTrackPlans(doc: ProjectV1): VideoTrackPlan[] {
  const duration = timelineDurationUs(doc);
  const media = mediaMap(doc);
  return visibleVideoTracks(doc).map(({ track, trackIndex }) => {
    const pieces: TrackPiece[] = [];
    let cursor = 0;
    for (const clip of track.clips) {
      const m = media.get(clip.mediaId);
      const span = m ? clipCoverage(clip, m) : null;
      if (!m || !span) continue;
      const { startUs, endUs } = span;
      const layer = segmentLayer(doc, track, trackIndex, clip, m, startUs, endUs);
      if (!layer) continue;
      if (startUs > cursor) pieces.push({ kind: 'gap', startUs: cursor, endUs: startUs });
      pieces.push({ kind: 'clip', startUs, endUs, layer });
      cursor = endUs;
    }
    if (duration > cursor) pieces.push({ kind: 'gap', startUs: cursor, endUs: duration });
    return { trackId: track.id, trackIndex, pieces };
  });
}

// ---------------------------------------------------------------------------------------------
// Audio

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/** Whether a track is heard, given mute and solo across all audio tracks. */
export function isTrackAudible(doc: ProjectV1, track: Track): boolean {
  if (track.type !== 'audio' || track.muted) return false;
  const anySolo = doc.timeline.tracks.some((t) => t.type === 'audio' && t.solo);
  return !anySolo || track.solo;
}

/**
 * One entry per audio clip, in track then timeline order. Inaudible clips (muted, or not soloed
 * while another track is) are left out unless `includeInaudible` is set.
 */
export function audioSegments(
  doc: ProjectV1,
  options: { includeInaudible?: boolean } = {},
): AudioSegment[] {
  const media = mediaMap(doc);
  const result: AudioSegment[] = [];
  doc.timeline.tracks.forEach((track, trackIndex) => {
    if (track.type !== 'audio') return;
    const audible = isTrackAudible(doc, track);
    if (!audible && !options.includeInaudible) return;
    for (const clip of track.clips) {
      const m = media.get(clip.mediaId);
      const span = m ? clipCoverage(clip, m) : null;
      if (!m || !span) continue;
      const refStartUs = refAt(clip, span.startUs);
      const refEndUs = refAt(clip, span.endUs);
      const fileStart = refToFileUsExact(m, refStartUs);
      const fileEnd = refToFileUsExact(m, refEndUs);
      result.push({
        trackId: track.id,
        trackIndex,
        clipId: clip.id,
        mediaId: m.id,
        timelineStartUs: span.startUs,
        timelineEndUs: span.endUs,
        refStartUs,
        refEndUs,
        fileStartUs: Math.round(fileStart),
        fileEndUs: Math.round(fileEnd),
        fileStartSeconds: fileStart / 1_000_000,
        fileEndSeconds: fileEnd / 1_000_000,
        clockRatio: m.clockRatio,
        gainDb: track.gainDb,
        linearGain: audible ? dbToLinear(track.gainDb) : 0,
        audible,
        offline: isOfflineMedia(m),
      });
    }
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Masks

/** GLSL `smoothstep`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Signed distance (px; negative inside) from point (x, y) to a `width × height` rounded rect
 * with corner radius `radius`, all in the rect's own pixel space (origin top-left).
 */
export function roundedRectDistance(
  width: number,
  height: number,
  radius: number,
  x: number,
  y: number,
): number {
  const r = Math.min(Math.max(radius, 0), Math.min(width, height) / 2);
  const qx = Math.abs(x - width / 2) - (width / 2 - r);
  const qy = Math.abs(y - height / 2) - (height / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Effective corner radius of a mask on a `width × height` rect. */
export function maskRadius(mask: LayerMask, width: number, height: number): number {
  if (mask.shape === 'rectangle') return 0;
  if (mask.shape === 'circle') return Math.min(width, height) / 2;
  return mask.radiusPx;
}

/**
 * Anti-aliased coverage (0–1) of the mask at point (x, y) of a `width × height` rect. Sample
 * pixel centres (`i + 0.5`). Rectangles are fully covered; rounded and circle edges get a 1-px
 * smoothstep. Identical to `MASK_COVERAGE_GLSL`.
 */
export function maskCoverage(
  mask: LayerMask,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const d = roundedRectDistance(width, height, maskRadius(mask, width, height), x, y);
  return 1 - smoothstep(-0.5, 0.5, d);
}

/** The mask as 8-bit alpha, row-major, `width × height` (for the export's mask PNG). */
export function maskAlpha(mask: LayerMask, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      out[j * width + i] = Math.round(maskCoverage(mask, width, height, i + 0.5, j + 0.5) * 255);
    }
  }
  return out;
}

/**
 * `maskCoverage` in GLSL ES 3.00. `p` is the fragment position inside the destination rect in
 * pixels (origin top-left, pixel centres at .5), `size` the rect size, `radius` from `maskRadius`.
 */
export const MASK_COVERAGE_GLSL = `
float csMaskCoverage(vec2 p, vec2 size, float radius) {
  float r = clamp(radius, 0.0, 0.5 * min(size.x, size.y));
  vec2 q = abs(p - 0.5 * size) - (0.5 * size - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  return 1.0 - smoothstep(-0.5, 0.5, d);
}
`;
