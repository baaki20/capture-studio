/**
 * Cursor effects (v3, R3.10–R3.12): smoothing, size, hide, click rings and a highlight, drawn
 * from a screen media's cursor track (`cursor-track.ts`). Pure: which effects a project can use
 * and why not, and the draw plans of the effects at a scene's time. The rasteriser
 * (`renderer/editor/preview/object-raster.ts`) draws the plans with canvas 2D and the compositor
 * places them, in the preview and the export alike, so both show the same pixels.
 *
 * Mapping: a screen layer showing media M at reference time r draws the effects of M's cursor
 * track at the track's file time for r (its own clock fields, so a sync nudge moves it with the
 * picture). Positions in M's pixels go through the layer's source and destination rects, which
 * already include crop, beautify padding and the camera. Nothing is drawn while the cursor tip is
 * outside the layer, nor outside the track's duration. A transition's outgoing picture draws no
 * effects (only the incoming one).
 *
 * The drawn cursor (an arrow of our own design) replaces the system cursor, so it is only drawn,
 * smoothed, resized or hidden when the track says the video does not already show the system
 * cursor (`inVideo: false`). Rings and the highlight are drawn either way.
 *
 * Draw order, bottom to top: highlight, rings, cursor. The effects are drawn above the video
 * layers and below the timeline objects.
 */
import { clicksShowingAt, positionAt, type CursorTrack, type Point } from './cursor-track';
import { refToFileUsExact } from './media-time';
import type { PxRect } from './objects';
import type { Scene } from './scene';
import type { CursorEffects, Media, Project } from './schema';

/** Loaded cursor tracks by cursor media ID. */
export type CursorTracks = ReadonlyMap<string, CursorTrack>;

export const DEFAULT_CURSOR_EFFECTS: CursorEffects = {
  smoothing: 0,
  size: 1,
  hide: false,
  clickRings: { enabled: true, color: '#FFB020', size: 0.04, durationUs: 500_000 },
  highlight: { enabled: false, color: '#FFE45C59', radius: 0.035 },
};

/** Height of the system cursor in screen pixels at 1080 lines (scaled with the screen). */
const CURSOR_HEIGHT_AT_1080 = 24;
const CURSOR_HEIGHT_MIN = 16;

/** The cursor track recorded with `screenMediaId`, if any. */
export function cursorMediaFor(doc: Project, screenMediaId: string): Media | undefined {
  return doc.media.find((m) => m.kind === 'cursor' && m.cursor?.screenMediaId === screenMediaId);
}

/** Cursor track media of a project. */
export function cursorMedia(doc: Project): Media[] {
  return doc.media.filter((m) => m.kind === 'cursor');
}

export interface CursorEffectsAvailability {
  /** Rings, highlight and auto-zoom: some screen media has a usable cursor track. */
  available: boolean;
  /** Smoothing, size and hide: some usable track's video does not show the system cursor. */
  drawn: boolean;
  /** Why `available` is false (null when it is true). */
  reason: string | null;
  /** Why `drawn` is false (null when it is true). */
  drawnReason: string | null;
}

/** Which cursor effects the project can use, with the reasons for the editor (spec §2.5). */
export function cursorEffectsAvailability(doc: Project): CursorEffectsAvailability {
  const usable = cursorMedia(doc).filter((m) => m.status === 'ok' || m.status === 'recovered');
  if (usable.length === 0) {
    const reason =
      cursorMedia(doc).length > 0
        ? 'The cursor track of this recording is missing or damaged.'
        : doc.recording?.platform.session === 'wayland'
          ? 'Cursor positions are not available on Wayland, so this recording has no cursor track. Manual zoom still works.'
          : 'This project has no cursor track (recordings made with cursor tracking have one). Manual zoom still works.';
    return { available: false, drawn: false, reason, drawnReason: reason };
  }
  const drawn = usable.some((m) => m.cursor?.inVideo === false);
  return {
    available: true,
    drawn,
    reason: null,
    drawnReason: drawn
      ? null
      : 'The system cursor is part of this recording’s picture, so it cannot be smoothed, resized or hidden. Click rings and the highlight still work.',
  };
}

/**
 * The effects in force: the timeline's, or, without any, just the drawn cursor where a video
 * lacks the system cursor (so the cursor never disappears from such a recording).
 */
export function effectiveCursorEffects(doc: Project): CursorEffects | null {
  if (doc.timeline.cursorEffects) return doc.timeline.cursorEffects;
  if (!cursorMedia(doc).some((m) => m.cursor?.inVideo === false)) return null;
  return {
    ...DEFAULT_CURSOR_EFFECTS,
    clickRings: { ...DEFAULT_CURSOR_EFFECTS.clickRings, enabled: false },
  };
}

/** Whether the effects change any frame (the export then renders frames, D4). */
export function cursorEffectsActive(doc: Project): boolean {
  const effects = effectiveCursorEffects(doc);
  if (!effects || cursorMedia(doc).length === 0) return false;
  if (effects.clickRings.enabled || effects.highlight.enabled) return true;
  // The drawn cursor replaces the system cursor whenever the video lacks it.
  return cursorMedia(doc).some((m) => m.cursor?.inVideo === false);
}

// ---------------------------------------------------------------------------------------------
// Draw plans

/** What one cursor-effect picture shows; sizes in output pixels. */
export type CursorPicture =
  | { kind: 'highlight'; radiusPx: number; color: string }
  | { kind: 'ring'; radiusPx: number; lineWidthPx: number; color: string }
  | { kind: 'cursor'; heightPx: number };

/**
 * One picture to draw: the rasteriser draws `picture` into a canvas of `size` with its anchor
 * (centre, or the cursor's tip) at `anchor`, and the compositor places it at `rect` (whole
 * pixels, so it is drawn 1:1). `key` changes whenever the picture does.
 */
export interface CursorDrawPlan {
  key: string;
  rect: PxRect;
  size: { width: number; height: number };
  anchor: Point;
  picture: CursorPicture;
  opacity: number;
}

/** The arrow's outline, tip at (0, 0), in units of its height (our own shape). */
export const CURSOR_ARROW: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 0.86],
  [0.21, 0.67],
  [0.35, 1],
  [0.5, 0.94],
  [0.36, 0.62],
  [0.62, 0.62],
];

/** Picture size and anchor for a picture at output position `at`. */
function placed(picture: CursorPicture, at: Point, opacity: number): CursorDrawPlan {
  let half: { left: number; top: number; right: number; bottom: number };
  if (picture.kind === 'cursor') {
    // Room for the outline around the arrow.
    const pad = Math.max(1, picture.heightPx * 0.08);
    half = {
      left: pad,
      top: pad,
      right: picture.heightPx * 0.62 + pad,
      bottom: picture.heightPx + pad,
    };
  } else {
    const r =
      picture.kind === 'ring' ? picture.radiusPx + picture.lineWidthPx : picture.radiusPx + 1;
    half = { left: r, top: r, right: r, bottom: r };
  }
  const x = Math.floor(at.x - half.left);
  const y = Math.floor(at.y - half.top);
  const size = {
    width: Math.max(1, Math.ceil(at.x + half.right) - x),
    height: Math.max(1, Math.ceil(at.y + half.bottom) - y),
  };
  const anchor = { x: at.x - x, y: at.y - y };
  const r = (v: number) => Math.round(v * 100) / 100;
  const key = [JSON.stringify(picture), size.width, size.height, r(anchor.x), r(anchor.y)].join(
    '|',
  );
  return { key, rect: { x, y, ...size }, size, anchor, picture, opacity };
}

function insideRect(p: Point, rect: PxRect): boolean {
  return p.x >= rect.x && p.y >= rect.y && p.x < rect.x + rect.width && p.y < rect.y + rect.height;
}

/** Ring growth over its life: fast at first, slowing down (ease-out). */
function ringProgress(ageUs: number, durationUs: number): number {
  const t = Math.min(1, Math.max(0, ageUs / durationUs));
  return 1 - (1 - t) ** 3;
}

/**
 * The cursor effects' draw plans for a scene, bottom to top. Tracks that are not loaded (yet)
 * draw nothing.
 */
export function sceneCursorPlans(
  doc: Project,
  tracks: CursorTracks,
  scene: Pick<Scene, 'tUs' | 'canvas' | 'camera' | 'layers'>,
): CursorDrawPlan[] {
  const effects = effectiveCursorEffects(doc);
  if (!effects || tracks.size === 0) return [];
  const media = new Map(doc.media.map((m) => [m.id, m]));
  const unitPx = Math.min(scene.canvas.width, scene.canvas.height) / scene.camera.width;
  const below: CursorDrawPlan[] = [];
  const above: CursorDrawPlan[] = [];
  for (const layer of scene.layers) {
    if (layer.kind !== 'screen' || layer.decoder !== undefined || layer.offline) continue;
    if (layer.opacity <= 0) continue;
    const screen = media.get(layer.mediaId);
    const cursorInfo = screen && cursorMediaFor(doc, screen.id);
    const track = cursorInfo && tracks.get(cursorInfo.id);
    if (!screen?.video || !cursorInfo?.cursor || !track) continue;
    const fileUs = refToFileUsExact(cursorInfo, layer.refTimeUs);
    if (fileUs < 0 || fileUs > cursorInfo.durationUs) continue;
    const drawn = !cursorInfo.cursor.inVideo;
    const smoothing = drawn ? effects.smoothing : 0;
    const pos = positionAt(track, fileUs, smoothing);
    if (!pos) continue;
    // Track pixels → media pixels → output pixels through the layer's rects.
    const { sourceRect: src, destRect: dst } = layer;
    const kx = screen.video.width / track.header.width;
    const ky = screen.video.height / track.header.height;
    const sx = dst.width / src.width;
    const sy = dst.height / src.height;
    const toOutput = (p: Point): Point => ({
      x: dst.x + (p.x * kx - src.x) * sx,
      y: dst.y + (p.y * ky - src.y) * sy,
    });
    const at = toOutput(pos);
    if (!insideRect(at, dst)) continue;
    const { opacity } = layer;
    if (effects.highlight.enabled) {
      const radiusPx = effects.highlight.radius * unitPx;
      below.push(
        placed({ kind: 'highlight', radiusPx, color: effects.highlight.color }, at, opacity),
      );
    }
    if (effects.clickRings.enabled) {
      const { durationUs, size, color } = effects.clickRings;
      for (const click of clicksShowingAt(track, fileUs, durationUs)) {
        const progress = ringProgress(fileUs - click.tUs, durationUs);
        const maxPx = size * unitPx;
        const radiusPx = Math.round(maxPx * (0.3 + 0.7 * progress) * 10) / 10;
        const lineWidthPx = Math.max(1.5, Math.round(maxPx * 0.12 * 10) / 10);
        // Rings sit where the click happened, also when the drawn cursor is smoothed.
        const ringAt = toOutput(click);
        const fade = Math.round((1 - progress) * 100) / 100;
        below.push(placed({ kind: 'ring', radiusPx, lineWidthPx, color }, ringAt, opacity * fade));
      }
    }
    if (drawn && !effects.hide) {
      const systemPx = Math.max(
        CURSOR_HEIGHT_MIN,
        (CURSOR_HEIGHT_AT_1080 * screen.video.height) / 1080,
      );
      const heightPx = Math.round(systemPx * sy * effects.size * 10) / 10;
      above.push(placed({ kind: 'cursor', heightPx }, at, opacity));
    }
  }
  return [...below, ...above];
}
