/**
 * Draws the timeline on a 2D canvas (§4.2 "canvas renderer + React chrome"): ruler with
 * timecodes, In/Out marks, clips with thumbnails (video) or waveforms (audio), selection and
 * link highlights, offline clips, parts a sync nudge left uncovered, the snap guide and the
 * playhead. Geometry comes from `geometry.ts`, so drawing and hit testing agree.
 */
import { clipCoverage } from '../../../shared/project/render-plan';
import type { Clip, Media, ProjectV1 } from '../../../shared/project/schema';
import { clipEndUs } from '../../../shared/project/timeline-ops';
import { formatTimecode } from '../../../shared/time';
import { refToFileUsExact } from '../../../shared/project/media-time';
import { RULER_HEIGHT, rulerTicks, timeToX, type Row, type TimelineView } from './geometry';
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
};

export interface DrawInput {
  doc: ProjectV1;
  rows: readonly Row[];
  view: TimelineView;
  width: number;
  height: number;
  selection: ReadonlySet<string>;
  /** Linked partners of the selection (drawn with a softer outline). */
  linkedToSelection: ReadonlySet<string>;
  playheadUs: number;
  snapUs: number | null;
  assets: MediaAssets | null;
  palette?: TimelinePalette;
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
  return refToFileUsExact(media, clip.sourceStartUs + (tUs - clip.timelineStartUs));
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
