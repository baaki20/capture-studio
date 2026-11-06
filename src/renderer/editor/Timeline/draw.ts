/**
 * Draws the timeline on a 2D canvas (§4.2 "canvas renderer + React chrome"): ruler with
 * timecodes, In/Out marks, clips with thumbnails (video) or waveforms (audio), selection and
 * link highlights, offline clips, parts a sync nudge left uncovered, face layout keyframes
 * (diamonds in the face row's lane), annotation objects (bars on the object rows, coloured by
 * family), the snap guide and the playhead. Geometry comes from `geometry.ts`, so drawing and hit testing agree.
 */
import { clipRefAtExact } from '../../../shared/project/clip-time';
import { clipCoverage } from '../../../shared/project/render-plan';
import { objectLabel } from '../../../shared/project/objects';
import type { Clip, Media, Project, TimelineObject } from '../../../shared/project/schema';
import { clipEndUs } from '../../../shared/project/timeline-ops';
import { formatTimecode } from '../../../shared/time';
import { refToFileUsExact } from '../../../shared/project/media-time';
import {
  KEYFRAME_LANE_PX,
  OBJECT_LANE_PX,
  RULER_HEIGHT,
  objectBarTop,
  keyframeLaneY,
  rowKeyframes,
  rowLane,
  type LaneKeyframe,
  type ObjectRow,
  rulerTicks,
  timeToX,
  type Row,
  type TimelineView,
} from './geometry';
import type { MediaAssets } from './media-assets';
import { thumbCell } from './thumbnails';
import { columnPeaks } from './waveform';

export interface TimelinePalette {
  background: string;
  ruler: string;
  rulerText: string;
  tick: string;
  row: string;
  rowLocked: string;
  video: string;
  audio: string;
  clipBorder: string;
  selected: string;
  linked: string;
  wave: string;
  offline: string;
  uncovered: string;
  marks: string;
  playhead: string;
  snap: string;
  keyframe: string;
  keyframeLane: string;
  /** Object bars: text, callouts, privacy regions. */
  objectText: string;
  objectCallout: string;
  objectPrivacy: string;
}

export const DARK_PALETTE: TimelinePalette = {
  background: '#16181d',
  ruler: '#1f2229',
  rulerText: '#9aa0ad',
  tick: '#3a3f4b',
  row: '#1c1f25',
  rowLocked: '#191b20',
  video: '#2f5d8a',
  audio: '#2f7a5c',
  clipBorder: '#0b0c0f',
  selected: '#f2c94c',
  linked: '#c9a43a',
  wave: 'rgba(230, 245, 238, 0.85)',
  offline: '#7a2f2f',
  uncovered: 'rgba(0, 0, 0, 0.45)',
  marks: 'rgba(242, 201, 76, 0.16)',
  playhead: '#ff5b5b',
  snap: '#7fd1ff',
  keyframe: '#e8e9ee',
  keyframeLane: 'rgba(0, 0, 0, 0.35)',
  objectText: '#6b4fa3',
  objectCallout: '#a3593a',
  objectPrivacy: '#4a5563',
};

export interface DrawInput {
  doc: Project;
  rows: readonly Row[];
  view: TimelineView;
  width: number;
  height: number;
  selection: ReadonlySet<string>;
  /** Linked partners of the selection (drawn with a softer outline). */
  linkedToSelection: ReadonlySet<string>;
  playheadUs: number;
  snapUs: number | null;
  /** Object track rows (above the video rows); none when absent. */
  objectRows?: readonly ObjectRow[];
  /** The selected annotation object, if any. */
  selectedObject?: string | null;
  /** The selected lane keyframe, if any. */
  selectedKeyframe?: LaneKeyframe | null;
  assets: MediaAssets | null;
  palette?: TimelinePalette;
}

/** A row's keyframe lane: a strip with a diamond per keyframe (the selected one filled). */
function drawKeyframes(
  ctx: CanvasRenderingContext2D,
  input: DrawInput,
  p: TimelinePalette,
  row: Row,
): void {
  const keys = rowKeyframes(row);
  if (keys.length === 0) return;
  ctx.fillStyle = p.keyframeLane;
  ctx.fillRect(0, row.top + row.height - KEYFRAME_LANE_PX, input.width, KEYFRAME_LANE_PX);
  const y = keyframeLaneY(row);
  const r = KEYFRAME_LANE_PX / 2 - 2;
  for (const tUs of keys) {
    const x = timeToX(input.view, tUs);
    if (x < -r || x > input.width + r) continue;
    const selected =
      input.selectedKeyframe?.lane === rowLane(row) &&
      input.selectedKeyframe.trackId === row.track.id &&
      input.selectedKeyframe.tUs === tUs;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fillStyle = selected ? p.selected : p.keyframe;
    ctx.fill();
    ctx.strokeStyle = p.clipBorder;
    ctx.stroke();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function drawTimeline(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const p = input.palette ?? DARK_PALETTE;
  const { doc, view, width, height } = input;
  const fps = doc.timeline.frameRate;
  ctx.fillStyle = p.background;
  ctx.fillRect(0, 0, width, height);

  // Ruler.
  ctx.fillStyle = p.ruler;
  ctx.fillRect(0, 0, width, RULER_HEIGHT);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (const tick of rulerTicks(view, width)) {
    const x = Math.round(timeToX(view, tick.tUs)) + 0.5;
    ctx.strokeStyle = p.tick;
    ctx.beginPath();
    ctx.moveTo(x, tick.major ? 12 : 20);
    ctx.lineTo(x, RULER_HEIGHT);
    ctx.stroke();
    if (tick.major) {
      ctx.fillStyle = p.rulerText;
      ctx.fillText(formatTimecode(tick.tUs, fps).replace(/^00:/, ''), x + 3, 2);
    }
  }

  // Rows and clips.
  const media = new Map(doc.media.map((m) => [m.id, m]));
  for (const row of input.rows) {
    ctx.fillStyle = row.track.locked ? p.rowLocked : p.row;
    ctx.fillRect(0, row.top, width, row.height);
    for (const clip of row.track.clips) {
      const x0 = timeToX(view, clip.timelineStartUs);
      const x1 = timeToX(view, clipEndUs(clip));
      if (x1 < 0 || x0 > width) continue;
      drawClip(ctx, input, p, row, clip, media.get(clip.mediaId) ?? null, x0, x1);
    }
    drawKeyframes(ctx, input, p, row);
  }

  for (const row of input.objectRows ?? []) {
    ctx.fillStyle = row.track.locked ? p.rowLocked : p.row;
    ctx.fillRect(0, row.top, width, row.height);
    for (const item of row.track.items) {
      const x0 = timeToX(view, item.inUs);
      const x1 = timeToX(view, item.outUs);
      if (x1 < 0 || x0 > width) continue;
      drawObjectBar(ctx, input, p, row, item, x0, x1);
    }
  }

  // In/Out marks.
  const { inUs, outUs } = doc.timeline.marks;
  if (inUs !== null || outUs !== null) {
    const a = timeToX(view, inUs ?? 0);
    const b = outUs === null ? width : timeToX(view, outUs);
    ctx.fillStyle = p.marks;
    ctx.fillRect(a, 0, Math.max(0, b - a), height);
    ctx.strokeStyle = p.selected;
    for (const [t, label] of [
      [inUs, 'I'],
      [outUs, 'O'],
    ] as const) {
      if (t === null) continue;
      const x = Math.round(timeToX(view, t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillStyle = p.selected;
      ctx.fillText(label, x + 3, RULER_HEIGHT - 12);
    }
  }

  if (input.snapUs !== null) {
    const x = Math.round(timeToX(view, input.snapUs)) + 0.5;
    ctx.strokeStyle = p.snap;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, RULER_HEIGHT);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Playhead.
  const px = Math.round(timeToX(view, input.playheadUs)) + 0.5;
  if (px >= 0 && px <= width) {
    ctx.strokeStyle = p.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = p.playhead;
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px, 8);
    ctx.fill();
  }
}

function objectColor(p: TimelinePalette, item: TimelineObject): string {
  if (item.kind === 'text') return p.objectText;
  if (item.kind === 'blur' || item.kind === 'pixelate') return p.objectPrivacy;
  return p.objectCallout;
}

function drawObjectBar(
  ctx: CanvasRenderingContext2D,
  input: DrawInput,
  p: TimelinePalette,
  row: ObjectRow,
  item: TimelineObject,
  x0: number,
  x1: number,
): void {
  const top = objectBarTop(row, item.id);
  const h = OBJECT_LANE_PX - 2;
  const left = Math.max(x0, -4);
  const right = Math.min(x1, input.width + 4);
  const w = Math.max(1, right - left);
  ctx.save();
  roundRect(ctx, left, top, w, h);
  ctx.fillStyle = objectColor(p, item);
  ctx.globalAlpha = row.track.hidden ? 0.45 : 1;
  ctx.fill();
  ctx.clip();
  if (w > 24) {
    ctx.fillStyle = '#f3f4f6';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(objectLabel(item), Math.max(left, 0) + 6, top + h / 2);
  }
  ctx.restore();
  if (input.selectedObject === item.id) {
    ctx.strokeStyle = p.selected;
    ctx.lineWidth = 2;
    roundRect(ctx, left + 1, top + 1, w - 2, h - 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  input: DrawInput,
  p: TimelinePalette,
  row: Row,
  clip: Clip,
  media: Media | null,
  x0: number,
  x1: number,
): void {
  const top = row.top + 2;
  const h = row.height - 4;
  const left = Math.max(x0, -4);
  const right = Math.min(x1, input.width + 4);
  const w = Math.max(1, right - left);
  const offline = !media || media.status === 'missing' || media.status === 'failed';

  ctx.save();
  roundRect(ctx, left, top, w, h);
  ctx.fillStyle = offline ? p.offline : row.track.type === 'video' ? p.video : p.audio;
  ctx.fill();
  ctx.clip();

  if (media && !offline) {
    if (row.track.type === 'video') drawThumbnails(ctx, input, clip, media, left, right, top, h);
    else drawWaveform(ctx, input, p, clip, media, left, right, top, h);
    // Parts the nudged media does not cover render as gaps (R1.42).
    const span = clipCoverage(clip, media);
    ctx.fillStyle = p.uncovered;
    if (!span) ctx.fillRect(left, top, w, h);
    else {
      const a = timeToX(input.view, span.startUs);
      const b = timeToX(input.view, span.endUs);
      if (a > x0) ctx.fillRect(x0, top, a - x0, h);
      if (b < x1) ctx.fillRect(b, top, x1 - b, h);
    }
  }
  if (offline && w > 40) {
    ctx.fillStyle = '#ffd7d7';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Offline', left + 6, top + h / 2);
  }
  ctx.restore();

  const selected = input.selection.has(clip.id);
  const linked = !selected && input.linkedToSelection.has(clip.id);
  roundRect(ctx, x0 + 0.5, top + 0.5, Math.max(1, x1 - x0 - 1), h - 1);
  ctx.strokeStyle = selected ? p.selected : linked ? p.linked : p.clipBorder;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.stroke();
  ctx.lineWidth = 1;
}

function fileUsAt(clip: Clip, media: Media, tUs: number): number {
  return refToFileUsExact(media, clipRefAtExact(clip, tUs));
}

function drawThumbnails(
  ctx: CanvasRenderingContext2D,
  input: DrawInput,
  clip: Clip,
  media: Media,
  left: number,
  right: number,
  top: number,
  h: number,
): void {
  const thumbs = input.assets?.thumbs.get(media.id);
  if (!thumbs) return;
  const tileW = (thumbs.index.tileWidth / thumbs.index.tileHeight) * h;
  const x0 = timeToX(input.view, clip.timelineStartUs);
  const first = Math.max(0, Math.floor((left - x0) / tileW));
  for (let i = first; x0 + i * tileW < right; i++) {
    const x = x0 + i * tileW;
    const centerUs = Math.round(
      input.view.scrollUs + ((x + tileW / 2) * 1_000_000) / input.view.pxPerSec,
    );
    const cell = thumbCell(thumbs.index, fileUsAt(clip, media, centerUs));
    const sheet = cell ? thumbs.sheets[cell.sheet] : null;
    if (!cell || !sheet) continue;
    ctx.drawImage(sheet, cell.sx, cell.sy, cell.sw, cell.sh, x, top, tileW, h);
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillRect(left, top, right - left, h);
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  input: DrawInput,
  p: TimelinePalette,
  clip: Clip,
  media: Media,
  left: number,
  right: number,
  top: number,
  h: number,
): void {
  const peaks = input.assets?.peaks.get(media.id);
  if (!peaks) return;
  const columns = Math.max(0, Math.floor(right - left));
  const t0 = input.view.scrollUs + (left * 1_000_000) / input.view.pxPerSec;
  const t1 = input.view.scrollUs + (right * 1_000_000) / input.view.pxPerSec;
  const values = columnPeaks(peaks, fileUsAt(clip, media, t0), fileUsAt(clip, media, t1), columns);
  const mid = top + h / 2;
  const half = h / 2 - 2;
  ctx.fillStyle = p.wave;
  for (let c = 0; c < columns; c++) {
    const min = values[c * 2] ?? 0;
    const max = values[c * 2 + 1] ?? 0;
    const y0 = mid - max * half;
    const y1 = mid - min * half;
    ctx.fillRect(left + c, y0, 1, Math.max(1, y1 - y0));
  }
}
