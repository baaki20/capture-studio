/**
 * Timeline geometry (R1.34, R1.39, R1.44): time ↔ pixel mapping, zoom, row layout, hit testing
 * and ruler ticks. Pure; the canvas renderer and the pointer handlers share it, so what is drawn
 * is what is hit.
 *
 * x is in CSS pixels from the left edge of the timeline canvas; y from its top (the ruler is the
 * first `RULER_HEIGHT` pixels). Rows follow `timeline.tracks` order (Screen, Face, Voice,
 * System audio).
 */
import type { Project, Track } from '../../../shared/project/schema';
import { clipEndUs, type TimelineOp } from '../../../shared/project/timeline-ops';

export interface TimelineView {
  /** Zoom: pixels per second of timeline. */
  pxPerSec: number;
  /** Timeline time at x = 0. */
  scrollUs: number;
}

export const RULER_HEIGHT = 28;
export const VIDEO_ROW_HEIGHT = 56;
export const AUDIO_ROW_HEIGHT = 44;
export const ROW_GAP = 2;
/** Zoom range: a 2-hour timeline fits ~1000 px; a 30 fps frame is ~50 px at the top. */
export const MIN_PX_PER_SEC = 0.12;
export const MAX_PX_PER_SEC = 1_500;
/** Pointer distance from a clip edge that grabs the edge (trim). */
export const EDGE_GRAB_PX = 6;
/** Snap distance (R1.39). */
export const SNAP_PX = 8;
/**
 * Keyframe lanes: a strip at the bottom of a row, and the grab distance. The face row shows its
 * layout keyframes (R2.1), the screen row the camera's zoom keyframes (R2.9).
 */
export const KEYFRAME_LANE_PX = 14;
export const KEYFRAME_GRAB_PX = 6;

export function timeToX(view: TimelineView, tUs: number): number {
  return ((tUs - view.scrollUs) * view.pxPerSec) / 1_000_000;
}

export function xToTime(view: TimelineView, x: number): number {
  return Math.round(view.scrollUs + (x * 1_000_000) / view.pxPerSec);
}

export function clampPxPerSec(px: number): number {
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, px));
}

/** Zooms by `factor`, keeping the time under `anchorX` in place (Ctrl+wheel, R1.44). */
export function zoomAround(view: TimelineView, factor: number, anchorX: number): TimelineView {
  const anchorUs = view.scrollUs + (anchorX * 1_000_000) / view.pxPerSec;
  const pxPerSec = clampPxPerSec(view.pxPerSec * factor);
  const scrollUs = Math.max(0, Math.round(anchorUs - (anchorX * 1_000_000) / pxPerSec));
  return { pxPerSec, scrollUs };
}

/** Shows the whole timeline in `widthPx` (Shift+Z). */
export function fitView(durationUs: number, widthPx: number): TimelineView {
  const usable = Math.max(1, widthPx - 24);
  const seconds = Math.max(durationUs / 1_000_000, 1);
  return { pxPerSec: clampPxPerSec(usable / seconds), scrollUs: 0 };
}

/** Keeps the scroll within `[0, duration − half a view]`. */
export function clampScroll(view: TimelineView, durationUs: number, widthPx: number): TimelineView {
  const halfViewUs = (widthPx / 2 / view.pxPerSec) * 1_000_000;
  const max = Math.max(0, durationUs - halfViewUs);
  const scrollUs = Math.round(Math.min(Math.max(0, view.scrollUs), max));
  return scrollUs === view.scrollUs ? view : { ...view, scrollUs };
}

/** Scrolls just enough to show `tUs` (the playhead while playing). */
export function revealTime(view: TimelineView, tUs: number, widthPx: number): TimelineView {
  const x = timeToX(view, tUs);
  if (x >= 0 && x <= widthPx - 16) return view;
  return {
    ...view,
    scrollUs: Math.max(0, Math.round(tUs - (widthPx * 0.1 * 1_000_000) / view.pxPerSec)),
  };
}

/** Snap distance in µs at the current zoom. */
export function snapThresholdUs(view: TimelineView, px = SNAP_PX): number {
  return Math.round((px * 1_000_000) / view.pxPerSec);
}

export interface Row {
  track: Track;
  trackIndex: number;
  top: number;
  height: number;
  /** Camera keyframe times, on the screen row only. */
  cameraKeys?: readonly number[];
}

export type KeyframeLane = 'layout' | 'camera';

/** A keyframe in a lane: the face track's layout keyframe, or a camera keyframe. */
export interface LaneKeyframe {
  lane: KeyframeLane;
  trackId: string;
  tUs: number;
}

export function rowHeight(track: Track): number {
  return track.type === 'video' ? VIDEO_ROW_HEIGHT : AUDIO_ROW_HEIGHT;
}

export function layoutRows(doc: Project): { rows: Row[]; height: number } {
  let top = RULER_HEIGHT + ROW_GAP;
  const screen = doc.timeline.tracks.find((t) => t.type === 'video' && t.layout.kind === 'screen');
  const cameraKeys = (doc.timeline.camera ?? []).map((k) => k.tUs);
  const rows = doc.timeline.tracks.map((track, trackIndex): Row => {
    const height = rowHeight(track);
    const row = { track, trackIndex, top, height, ...(track === screen ? { cameraKeys } : {}) };
    top += height + ROW_GAP;
    return row;
  });
  return { rows, height: top };
}

export type Hit =
  | { kind: 'ruler'; tUs: number }
  | { kind: 'keyframe'; lane: KeyframeLane; trackId: string; keyUs: number; tUs: number }
  | { kind: 'clip'; trackId: string; clipId: string; zone: 'body' | 'start' | 'end'; tUs: number }
  | { kind: 'track'; trackId: string; tUs: number }
  | { kind: 'none'; tUs: number };

/** What is under a pointer at (x, y). Edges win over the body within `EDGE_GRAB_PX`. */
export function hitTest(rows: readonly Row[], view: TimelineView, x: number, y: number): Hit {
  const tUs = xToTime(view, x);
  if (y < RULER_HEIGHT) return { kind: 'ruler', tUs };
  const row = rows.find((r) => y >= r.top && y < r.top + r.height);
  if (!row) return { kind: 'none', tUs };
  const key = keyframeAt(row, view, x, y);
  const lane = rowLane(row);
  if (key !== null && lane) {
    return { kind: 'keyframe', lane, trackId: row.track.id, keyUs: key, tUs };
  }
  let best: { clipId: string; zone: 'body' | 'start' | 'end'; distance: number } | null = null;
  for (const clip of row.track.clips) {
    const x0 = timeToX(view, clip.timelineStartUs);
    const x1 = timeToX(view, clipEndUs(clip));
    if (x < x0 - EDGE_GRAB_PX || x > x1 + EDGE_GRAB_PX) continue;
    // Very narrow clips: the nearer edge wins; otherwise an edge only within its grab zone.
    const dStart = Math.abs(x - x0);
    const dEnd = Math.abs(x - x1);
    const zone: 'body' | 'start' | 'end' =
      x1 - x0 < EDGE_GRAB_PX * 2
        ? dStart <= dEnd
          ? 'start'
          : 'end'
        : dStart <= EDGE_GRAB_PX
          ? 'start'
          : dEnd <= EDGE_GRAB_PX
            ? 'end'
            : 'body';
    if (zone === 'body' && (x < x0 || x > x1)) continue;
    // Between two touching clips, the clip the pointer is inside wins the shared edge.
    const inside = x >= x0 && x <= x1 ? 0 : 0.5;
    const distance = (zone === 'start' ? dStart : zone === 'end' ? dEnd : 0) + inside;
    if (!best || distance < best.distance) best = { clipId: clip.id, zone, distance };
  }
  if (best)
    return { kind: 'clip', trackId: row.track.id, clipId: best.clipId, zone: best.zone, tUs };
  return { kind: 'track', trackId: row.track.id, tUs };
}

/** Which keyframes a row's lane shows: the face's layout, the camera on the screen row. */
export function rowLane(row: Row): KeyframeLane | null {
  const track = row.track;
  if (track.type !== 'video') return null;
  if (track.layout.kind === 'overlay') return 'layout';
  return row.cameraKeys ? 'camera' : null;
}

/** Keyframe times in a row's lane. */
export function rowKeyframes(row: Row): readonly number[] {
  const track = row.track;
  const lane = rowLane(row);
  if (lane === 'camera') return row.cameraKeys ?? [];
  if (lane === 'layout' && track.type === 'video') {
    return (track.layoutKeyframes ?? []).map((k) => k.tUs);
  }
  return [];
}

/** The operation that moves a lane keyframe to `toUs`. */
export function moveKeyframeOp(key: LaneKeyframe, toUs: number): TimelineOp {
  return key.lane === 'camera'
    ? { type: 'moveCameraKeyframe', fromUs: key.tUs, toUs }
    : { type: 'moveLayoutKeyframe', trackId: key.trackId, fromUs: key.tUs, toUs };
}

/** The operation that deletes a lane keyframe. */
export function removeKeyframeOp(key: LaneKeyframe): TimelineOp {
  return key.lane === 'camera'
    ? { type: 'removeCameraKeyframe', tUs: key.tUs }
    : { type: 'removeLayoutKeyframe', trackId: key.trackId, tUs: key.tUs };
}

/** The y of the keyframe lane's centre line in a row. */
export function keyframeLaneY(row: Row): number {
  return row.top + row.height - KEYFRAME_LANE_PX / 2;
}

/** The keyframe nearest to x in the row's keyframe lane, within the grab distance, or null. */
export function keyframeAt(row: Row, view: TimelineView, x: number, y: number): number | null {
  if (y < row.top + row.height - KEYFRAME_LANE_PX) return null;
  let best: { tUs: number; distance: number } | null = null;
  for (const tUs of rowKeyframes(row)) {
    const distance = Math.abs(timeToX(view, tUs) - x);
    if (distance <= KEYFRAME_GRAB_PX && (!best || distance < best.distance)) {
      best = { tUs, distance };
    }
  }
  return best?.tUs ?? null;
}

export interface RulerTick {
  tUs: number;
  major: boolean;
}

const TICK_STEPS_US = [
  1_000_000 / 30,
  100_000,
  250_000,
  500_000,
  1_000_000,
  2_000_000,
  5_000_000,
  10_000_000,
  15_000_000,
  30_000_000,
  60_000_000,
  120_000_000,
  300_000_000,
  600_000_000,
  900_000_000,
  1_800_000_000,
  3_600_000_000,
];

/** Major ticks at least `minMajorPx` apart, with 5 minor ticks per major (when they fit). */
export function rulerTicks(view: TimelineView, widthPx: number, minMajorPx = 90): RulerTick[] {
  const major =
    TICK_STEPS_US.find((step) => (step / 1_000_000) * view.pxPerSec >= minMajorPx) ??
    TICK_STEPS_US[TICK_STEPS_US.length - 1] ??
    1_000_000;
  const minor = major / 5;
  const showMinor = (minor / 1_000_000) * view.pxPerSec >= 6;
  const step = showMinor ? minor : major;
  const start = Math.floor(view.scrollUs / step) * step;
  const end = xToTime(view, widthPx);
  const ticks: RulerTick[] = [];
  for (let i = 0; ; i++) {
    const t = start + i * step;
    if (t > end) break;
    if (t < 0) continue;
    const ratio = t / major;
    ticks.push({ tUs: Math.round(t), major: Math.abs(ratio - Math.round(ratio)) < 1e-6 });
  }
  return ticks;
}
