/**
 * Auto-zoom on clicks (v3, R3.11, acceptance d): proposes camera zooms around the clicks in the
 * cursor tracks. Pure: the editor shows the proposals, and the `addCameraZooms` operation adds
 * the ones the user keeps as ordinary camera keyframes (one undo step), which they then edit or
 * remove like any others.
 *
 * - Every press on a visible screen clip counts, at the timeline time the clip shows it (speed
 *   included; freeze frames and clips without a cursor track have none).
 * - Presses less than `mergeGapUs` apart form one zoom: it starts `leadUs` before the first and
 *   ends `holdUs` after the last, eased in and out over `easeUs`. Zooms that would overlap merge.
 * - The zoom centres on the middle of the presses on the canvas (before any camera) and zooms
 *   by `zoom`, less when the presses are spread wider than the zoomed view can show; spreads
 *   that need less than `MIN_ZOOM` give no zoom.
 * - A range that already holds camera keyframes is left alone (manual zooms win).
 */
import type { Us } from '../time';
import { CAMERA_EASE_MAX_US, CAMERA_ZOOM_MAX, cameraRect } from './camera-keyframes';
import { clipTimeAtRef, clipTimelineDurationUs } from './clip-time';
import { cursorMediaFor, type CursorTracks } from './cursor-effects';
import { fileToRefUs } from './media-time';
import { layersAt } from './render-plan';
import type { FRect, Project } from './schema';
import { timelineDurationUs } from './timeline-ops';

export interface AutoZoomOptions {
  zoom: number;
  leadUs: Us;
  holdUs: Us;
  mergeGapUs: Us;
  easeUs: Us;
  /** Only presses in `[inUs, outUs)` (the in/out marks, for instance). */
  range?: { inUs: Us; outUs: Us };
}

export const DEFAULT_AUTO_ZOOM: AutoZoomOptions = {
  zoom: 2,
  leadUs: 600_000,
  holdUs: 1_200_000,
  mergeGapUs: 1_500_000,
  easeUs: 400_000,
};

/** Below this the zoom is not worth it. */
export const MIN_ZOOM = 1.25;
/** Margin kept around the presses inside the zoomed view (fraction of the view). */
const SPREAD_FILL = 0.7;

export interface AutoZoomProposal {
  startUs: Us;
  endUs: Us;
  rect: FRect;
  easeUs: Us;
  /** Presses it covers. */
  clicks: number;
}

interface PlacedClick {
  tUs: Us;
  /** Canvas fractions. */
  x: number;
  y: number;
}

/** Every press on a visible screen clip, by timeline time, positioned on the canvas. */
export function timelineClicks(doc: Project, tracks: CursorTracks): PlacedClick[] {
  // Positions on the canvas before any camera.
  const flat: Project = { ...doc, timeline: { ...doc.timeline, camera: undefined } };
  const { width: cw, height: ch } = doc.timeline.canvas;
  const out: PlacedClick[] = [];
  doc.timeline.tracks.forEach((track) => {
    if (track.type !== 'video' || track.hidden || track.layout.kind !== 'screen') return;
    for (const clip of track.clips) {
      if (clip.freeze) continue;
      const cursor = cursorMediaFor(doc, clip.mediaId);
      const data = cursor && tracks.get(cursor.id);
      const screen = doc.media.find((m) => m.id === clip.mediaId);
      if (!cursor || !data || !screen?.video) continue;
      const clipEnd = clip.timelineStartUs + clipTimelineDurationUs(clip);
      for (const press of data.clicks) {
        const refUs = fileToRefUs(cursor, press.tUs);
        if (refUs < clip.sourceStartUs || refUs >= clip.sourceEndUs) continue;
        const tUs = clipTimeAtRef(clip, refUs);
        if (tUs < clip.timelineStartUs || tUs >= clipEnd) continue;
        // The topmost layer showing this clip then (another track may cover it; that is fine).
        const layer = layersAt(flat, tUs).find((l) => l.clipId === clip.id);
        if (!layer) continue;
        const { sourceRect: src, destRect: dst } = layer;
        const px = (press.x * screen.video.width) / data.header.width;
        const py = (press.y * screen.video.height) / data.header.height;
        if (px < src.x || py < src.y || px >= src.x + src.width || py >= src.y + src.height) {
          continue;
        }
        out.push({
          tUs,
          x: (dst.x + ((px - src.x) * dst.width) / src.width) / cw,
          y: (dst.y + ((py - src.y) * dst.height) / src.height) / ch,
        });
      }
    }
  });
  return out.sort((a, b) => a.tUs - b.tUs);
}

/** Camera zooms around the clicks (see the file comment). */
export function proposeAutoZoom(
  doc: Project,
  tracks: CursorTracks,
  options: Partial<AutoZoomOptions> = {},
): AutoZoomProposal[] {
  const o = { ...DEFAULT_AUTO_ZOOM, ...options };
  const zoom = Math.min(CAMERA_ZOOM_MAX, Math.max(1, o.zoom));
  const easeUs = Math.min(CAMERA_EASE_MAX_US, Math.max(0, o.easeUs));
  const duration = timelineDurationUs(doc);
  const clicks = timelineClicks(doc, tracks).filter(
    (c) => !o.range || (c.tUs >= o.range.inUs && c.tUs < o.range.outUs),
  );
  // Groups of presses close in time; groups whose zooms would touch merge too.
  const groups: PlacedClick[][] = [];
  for (const click of clicks) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    const touching =
      last && (click.tUs - last.tUs <= o.mergeGapUs || click.tUs - o.leadUs <= last.tUs + o.holdUs);
    if (group && touching) group.push(click);
    else groups.push([click]);
  }
  const keys = doc.timeline.camera ?? [];
  const proposals: AutoZoomProposal[] = [];
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;
    const startUs = Math.max(0, first.tUs - o.leadUs);
    const endUs = Math.min(duration, last.tUs + o.holdUs);
    if (endUs <= startUs) continue;
    if (keys.some((k) => k.tUs >= startUs - easeUs && k.tUs <= endUs)) continue;
    const xs = group.map((c) => c.x);
    const ys = group.map((c) => c.y);
    const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const fit = spread > 0 ? SPREAD_FILL / spread : Number.POSITIVE_INFINITY;
    const z = Math.min(zoom, fit);
    if (z < MIN_ZOOM) continue;
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    proposals.push({
      startUs,
      endUs,
      rect: cameraRect(z, cx, cy),
      easeUs: Math.min(easeUs, Math.floor((endUs - startUs) / 2)),
      clicks: group.length,
    });
  }
  return proposals;
}
