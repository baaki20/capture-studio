/**
 * The scene at one timeline time (v2, §1.7): everything the compositor draws, resolved from the
 * project. It extends the render plan's `layersAt` with the teaching-editor features:
 *
 * - **Face layout keyframes** (`layoutKeyframes` on an overlay track): each keyframe resolves to
 *   a box, corner radius and opacity (overlay = the P1 box; full = the whole canvas;
 *   side-by-side = the right half; hidden = the overlay box at opacity 0), and the scene eases
 *   between them. Away from overlay mode the face picture is cropped to fill its box ("cover").
 * - **Face style**: zoom inside the shape, border and shadow (from the layout in effect).
 * - **Screen area**: the whole canvas, or the left half while the face is side by side; then
 *   inset by the beautify padding, with its corner radius and shadow.
 * - **Camera** (zoom and pan): `camera` keyframes give the part of the canvas that fills the
 *   frame. It applies to screen layers and objects, not to face overlays or the background.
 * - **Objects** on object tracks, with their keyframed box and fades.
 *
 * Every rect here is in canvas pixels. Layer rects are integers; with a camera zoom they may
 * extend past the canvas (the compositor clips). Without any v2 field the layers are exactly
 * `layersAt`'s, so Phase 1 projects render as before.
 *
 * - **Transitions** (`transitionIn` on a clip): dissolve, fade through a colour and slide, drawn
 *   from the incoming layer and the previous clip's layer continued past its end.
 *
 * Speed and freeze frames are resolved by the render plan's time mapping.
 */
import type { Us } from '../time';
import { cameraAt } from './camera-keyframes';
import { ease, interpolate, keyframeSpan, lerp, lerpRect } from './easing';
import {
  overlayDestRect,
  overlayRadiusPx,
  overlaySourceRect,
  roundEven,
  type PixelRect,
  type Size,
} from './face-layout';
import {
  OUTGOING_DECODER_SUFFIX,
  clipLayerAt,
  containRect,
  layersAt,
  type LayerMask,
  type VideoLayer,
} from './render-plan';
import { clipTimelineDurationUs } from './clip-time';
import type {
  Beautify,
  Clip,
  FaceMode,
  FRect,
  LayoutKeyframe,
  NRect,
  OverlayLayout,
  Project,
  TimelineObject,
  VideoTrack,
} from './schema';

/** A rectangle in canvas pixels that may be fractional. */
export interface RectF {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneShadow {
  blurPx: number;
  offsetXPx: number;
  offsetYPx: number;
  color: string;
}

export interface SceneLayer extends VideoLayer {
  /** 0–1. */
  opacity: number;
  /** Mixes the picture toward a colour (fade-to-colour transitions); null when none. */
  tint: { color: string; amount: number } | null;
  border: { widthPx: number; color: string } | null;
  shadow: SceneShadow | null;
}

export interface SceneObject {
  trackId: string;
  item: TimelineObject;
  /** The box after keyframes, in canvas fractions, before the camera. */
  box: FRect;
  /** The box on the output frame, camera applied. */
  rectPx: RectF;
  /** 0–1, fades applied. */
  opacity: number;
}

export interface Scene {
  tUs: Us;
  canvas: Size;
  background: Beautify['background'];
  camera: FRect;
  layers: SceneLayer[];
  objects: SceneObject[];
}

export const FULL_FRAME: FRect = { x: 0, y: 0, width: 1, height: 1 };

// ---------------------------------------------------------------------------------------------
// Camera

/** The camera rect at `tUs` (canvas fractions); the full frame without camera keyframes. */
export function cameraRectAt(doc: Project, tUs: Us): FRect {
  return cameraAt(doc.timeline.camera, tUs);
}

/** Where a canvas rect lands on the output frame under camera rect `camera`. */
export function applyCamera(rect: RectF, camera: FRect, canvas: Size): RectF {
  const sx = 1 / camera.width;
  const sy = 1 / camera.height;
  return {
    x: (rect.x - camera.x * canvas.width) * sx,
    y: (rect.y - camera.y * canvas.height) * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
}

function isFullFrame(camera: FRect): boolean {
  return camera.x === 0 && camera.y === 0 && camera.width === 1 && camera.height === 1;
}

function roundRect(rect: RectF): PixelRect {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    x,
    y,
    width: Math.max(1, Math.round(rect.x + rect.width) - x),
    height: Math.max(1, Math.round(rect.y + rect.height) - y),
  };
}

// ---------------------------------------------------------------------------------------------
// Face layout

/** Box, corner radius and opacity of the face for one keyframe. */
export interface FaceState {
  rect: RectF;
  radiusPx: number;
  opacity: number;
}

export function faceStateFor(
  mode: FaceMode,
  layout: OverlayLayout,
  canvas: Size,
  frame: Size,
): FaceState {
  switch (mode) {
    case 'overlay':
    case 'hidden': {
      const rect = overlayDestRect(layout, canvas, frame);
      return { rect, radiusPx: overlayRadiusPx(layout, rect), opacity: mode === 'hidden' ? 0 : 1 };
    }
    case 'full':
      return {
        rect: { x: 0, y: 0, width: canvas.width, height: canvas.height },
        radiusPx: 0,
        opacity: 1,
      };
    case 'side-by-side': {
      const half = Math.floor(canvas.width / 2);
      return {
        rect: { x: half, y: 0, width: canvas.width - half, height: canvas.height },
        radiusPx: 0,
        opacity: 1,
      };
    }
  }
}

/** The face layout keyframes of a track, or one implied by its static layout. */
function faceKeys(track: VideoTrack): LayoutKeyframe[] | null {
  if (track.layout.kind !== 'overlay') return null;
  if (track.layoutKeyframes && track.layoutKeyframes.length > 0) return track.layoutKeyframes;
  return null;
}

/** Centred crop of `rect` with the aspect of `target` ("cover"). */
export function coverCrop(rect: NRect, target: Size): NRect {
  const aspect = target.width / target.height;
  let width = rect.width;
  let height = Math.round(width / aspect);
  if (height > rect.height) {
    height = rect.height;
    width = Math.round(height * aspect);
  }
  width = Math.max(1, Math.min(rect.width, width));
  height = Math.max(1, Math.min(rect.height, height));
  return {
    x: rect.x + Math.floor((rect.width - width) / 2),
    y: rect.y + Math.floor((rect.height - height) / 2),
    width,
    height,
  };
}

/** The centre `1 / zoom` of a source rect. */
export function zoomCrop(rect: NRect, zoom: number): NRect {
  if (zoom <= 1) return rect;
  const width = Math.max(1, Math.round(rect.width / zoom));
  const height = Math.max(1, Math.round(rect.height / zoom));
  return {
    x: rect.x + Math.floor((rect.width - width) / 2),
    y: rect.y + Math.floor((rect.height - height) / 2),
    width,
    height,
  };
}

function shortSide(canvas: Size): number {
  return Math.min(canvas.width, canvas.height);
}

function faceStyle(layout: OverlayLayout, canvas: Size): Pick<SceneLayer, 'border' | 'shadow'> {
  const s = shortSide(canvas);
  return {
    border: layout.border ? { widthPx: layout.border.width * s, color: layout.border.color } : null,
    shadow: layout.shadow
      ? {
          blurPx: layout.shadow.blur * s,
          offsetXPx: layout.shadow.offsetX * s,
          offsetYPx: layout.shadow.offsetY * s,
          color: layout.shadow.color,
        }
      : null,
  };
}

/**
 * Geometry of a face layer at `tUs`. With a static layout (no keyframes) it is P1's geometry
 * plus zoom and style; with keyframes it eases between the keyframes' states.
 */
function faceLayer(
  layer: VideoLayer,
  track: VideoTrack,
  frame: Size,
  canvas: Size,
  tUs: Us,
): SceneLayer {
  const keys = faceKeys(track);
  if (!keys) {
    const layout = track.layout as OverlayLayout;
    return {
      ...layer,
      sourceRect: zoomCrop(layer.sourceRect, layout.zoom ?? 1),
      opacity: 1,
      tint: null,
      ...faceStyle(layout, canvas),
    };
  }
  const span = keyframeSpan(keys, tUs);
  if (!span) throw new Error('unreachable: keyframes are not empty');
  const a = faceStateFor(span.from.mode, span.from.layout, canvas, frame);
  const settled = span.from === span.to || span.progress === 0 || span.progress === 1;
  const key = span.progress === 1 ? span.to : span.from;
  let state: FaceState;
  if (settled) {
    state = span.progress === 1 ? faceStateFor(key.mode, key.layout, canvas, frame) : a;
  } else {
    const b = faceStateFor(span.to.mode, span.to.layout, canvas, frame);
    state = {
      rect: lerpRect(a.rect, b.rect, span.progress),
      radiusPx: lerp(a.radiusPx, b.radiusPx, span.progress),
      opacity: lerp(a.opacity, b.opacity, span.progress),
    };
  }
  const destRect = roundRect(state.rect);
  const inOverlayBox = settled && (key.mode === 'overlay' || key.mode === 'hidden');
  const base = inOverlayBox
    ? overlaySourceRect(key.layout, frame)
    : coverCrop(
        key.layout.crop ?? { x: 0, y: 0, width: frame.width, height: frame.height },
        destRect,
      );
  const zoom = settled
    ? (key.layout.zoom ?? 1)
    : lerp(span.from.layout.zoom ?? 1, span.to.layout.zoom ?? 1, span.progress);
  const mask: LayerMask = inOverlayBox
    ? { shape: key.layout.shape, radiusPx: state.radiusPx }
    : { shape: state.radiusPx > 0 ? 'rounded' : 'rectangle', radiusPx: state.radiusPx };
  return {
    ...layer,
    sourceRect: zoomCrop(base, zoom),
    destRect,
    mask,
    tint: null,
    mirror: key.layout.mirror,
    opacity: state.opacity,
    ...faceStyle(key.layout, canvas),
  };
}

// ---------------------------------------------------------------------------------------------
// Screen area and beautify

/** The face mode's screen area for one keyframe: the left half when side by side. */
function screenAreaFor(mode: FaceMode, canvas: Size): RectF {
  if (mode === 'side-by-side') {
    return { x: 0, y: 0, width: Math.floor(canvas.width / 2), height: canvas.height };
  }
  return { x: 0, y: 0, width: canvas.width, height: canvas.height };
}

/** The canvas area the screen fits into at `tUs`, before beautify padding. */
export function screenAreaAt(doc: Project, tUs: Us): RectF {
  const canvas = doc.timeline.canvas;
  for (const track of doc.timeline.tracks) {
    if (track.type !== 'video' || track.hidden) continue;
    const keys = faceKeys(track);
    if (!keys) continue;
    return (
      interpolate(keys, tUs, (k) => screenAreaFor(k.mode, canvas), lerpRect) ??
      screenAreaFor('overlay', canvas)
    );
  }
  return { x: 0, y: 0, width: canvas.width, height: canvas.height };
}

/** "Contain" fit of a source size into an area of the canvas, centred, even-sized. */
export function containIn(source: Size, area: RectF): PixelRect {
  const scale = Math.min(area.width / source.width, area.height / source.height);
  const width = Math.min(Math.floor(area.width), roundEven(source.width * scale));
  const height = Math.min(Math.floor(area.height), roundEven(source.height * scale));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function screenLayer(layer: VideoLayer, doc: Project, tUs: Us): SceneLayer {
  const canvas = doc.timeline.canvas;
  const beautify = doc.timeline.beautify;
  const area = screenAreaAt(doc, tUs);
  const full =
    area.x === 0 && area.y === 0 && area.width === canvas.width && area.height === canvas.height;
  if (full && !beautify) return { ...layer, opacity: 1, tint: null, border: null, shadow: null };
  const s = shortSide(canvas);
  const pad = (beautify?.padding ?? 0) * s;
  const inner = {
    x: area.x + pad,
    y: area.y + pad,
    width: Math.max(2, area.width - 2 * pad),
    height: Math.max(2, area.height - 2 * pad),
  };
  const destRect =
    full && pad === 0 ? containRect(layer.sourceRect, canvas) : containIn(layer.sourceRect, inner);
  const radiusPx = Math.min(
    (beautify?.cornerRadius ?? 0) * s,
    Math.min(destRect.width, destRect.height) / 2,
  );
  const shadow = beautify?.shadow;
  return {
    ...layer,
    destRect,
    mask: { shape: radiusPx > 0 ? 'rounded' : 'rectangle', radiusPx },
    opacity: 1,
    tint: null,
    border: null,
    shadow: shadow
      ? {
          blurPx: shadow.blur * s,
          offsetXPx: shadow.offsetX * s,
          offsetYPx: shadow.offsetY * s,
          color: shadow.color,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Objects

/** Fade factor of an object at `tUs` (1 outside its fades). */
export function objectFade(item: TimelineObject, tUs: Us): number {
  let f = 1;
  if (item.fadeInUs && item.fadeInUs > 0) f = Math.min(f, (tUs - item.inUs) / item.fadeInUs);
  if (item.fadeOutUs && item.fadeOutUs > 0) f = Math.min(f, (item.outUs - tUs) / item.fadeOutUs);
  return Math.min(1, Math.max(0, f));
}

/** The object's box at `tUs` (keyframes applied), in canvas fractions. */
export function objectBoxAt(item: TimelineObject, tUs: Us): FRect {
  if (!item.keyframes || item.keyframes.length === 0) return item.box;
  return interpolate(item.keyframes, tUs, (k) => k.box, lerpRect) ?? item.box;
}

/** Objects visible at `tUs`, bottom to top. */
export function objectsAt(
  doc: Project,
  tUs: Us,
  camera: FRect = cameraRectAt(doc, tUs),
): SceneObject[] {
  const canvas = doc.timeline.canvas;
  const out: SceneObject[] = [];
  for (const track of doc.timeline.objectTracks ?? []) {
    if (track.hidden) continue;
    for (const item of track.items) {
      if (tUs < item.inUs || tUs >= item.outUs) continue;
      const box = objectBoxAt(item, tUs);
      const px = {
        x: box.x * canvas.width,
        y: box.y * canvas.height,
        width: box.width * canvas.width,
        height: box.height * canvas.height,
      };
      out.push({
        trackId: track.id,
        item,
        box,
        rectPx: isFullFrame(camera) ? px : applyCamera(px, camera, canvas),
        opacity: (item.opacity ?? 1) * objectFade(item, tUs),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Transitions

/** A clip's transition in progress at `tUs`, or null. */
export interface TransitionState {
  kind: 'fade-color' | 'dissolve' | 'slide';
  /** 0 at the clip's start, 1 when the transition is over. */
  progress: number;
  color: string;
  direction: 'left' | 'right' | 'up' | 'down';
}

export function transitionAt(clip: Clip, tUs: Us): TransitionState | null {
  const t = clip.transitionIn;
  if (!t) return null;
  const into = tUs - clip.timelineStartUs;
  if (into < 0 || into >= t.durationUs) return null;
  return {
    kind: t.kind,
    progress: into / t.durationUs,
    color: t.color ?? '#000000',
    direction: t.direction ?? 'left',
  };
}

/**
 * The layers a transition draws, bottom to top, from the incoming clip's layer and the
 * outgoing one (null after a gap or at the start: the transition comes from the background).
 * - dissolve: the incoming picture fades in over the outgoing one;
 * - fade-color: the outgoing picture fades to the colour over the first half, the incoming one
 *   from it over the second (without an outgoing picture, from the colour throughout);
 * - slide: the incoming picture slides in over the outgoing one from the side it moves away
 *   from (`left`: it enters from the right and moves left), eased in and out.
 */
export function transitionLayers(
  state: TransitionState,
  incoming: SceneLayer,
  outgoing: SceneLayer | null,
  canvas: Size,
): SceneLayer[] {
  const p = state.progress;
  switch (state.kind) {
    case 'dissolve':
      return [...(outgoing ? [outgoing] : []), { ...incoming, opacity: incoming.opacity * p }];
    case 'fade-color': {
      if (!outgoing) return [{ ...incoming, tint: { color: state.color, amount: 1 - p } }];
      return p < 0.5
        ? [{ ...outgoing, tint: { color: state.color, amount: p * 2 } }]
        : [{ ...incoming, tint: { color: state.color, amount: (1 - p) * 2 } }];
    }
    case 'slide': {
      const left = 1 - ease('ease-in-out', p);
      const dx =
        state.direction === 'left'
          ? canvas.width * left
          : state.direction === 'right'
            ? -canvas.width * left
            : 0;
      const dy =
        state.direction === 'up'
          ? canvas.height * left
          : state.direction === 'down'
            ? -canvas.height * left
            : 0;
      const moved = {
        ...incoming,
        destRect: {
          ...incoming.destRect,
          x: incoming.destRect.x + Math.round(dx),
          y: incoming.destRect.y + Math.round(dy),
        },
      };
      return [...(outgoing ? [outgoing] : []), moved];
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scene

/** Everything drawn at timeline time `tUs`. */
export function sceneAt(doc: Project, tUs: Us): Scene {
  const canvas = { width: doc.timeline.canvas.width, height: doc.timeline.canvas.height };
  const camera = cameraRectAt(doc, tUs);
  const media = new Map(doc.media.map((m) => [m.id, m]));
  const layers: SceneLayer[] = [];
  /** A video layer placed on the canvas: face layout, or screen area, beautify and camera. */
  const place = (layer: VideoLayer): SceneLayer | null => {
    const track = doc.timeline.tracks[layer.trackIndex];
    const m = media.get(layer.mediaId);
    if (track?.type !== 'video' || !m?.video) return null;
    if (layer.kind === 'overlay') {
      const frame = { width: m.video.width, height: m.video.height };
      return faceLayer(layer, track, frame, canvas, tUs);
    }
    const screen = screenLayer(layer, doc, tUs);
    if (isFullFrame(camera)) return screen;
    const scale = 1 / camera.width;
    return {
      ...screen,
      destRect: roundRect(applyCamera(screen.destRect, camera, canvas)),
      mask: { ...screen.mask, radiusPx: screen.mask.radiusPx * scale },
      shadow: screen.shadow && {
        ...screen.shadow,
        blurPx: screen.shadow.blurPx * scale,
        offsetXPx: screen.shadow.offsetXPx * scale,
        offsetYPx: screen.shadow.offsetYPx * scale,
      },
    };
  };
  for (const layer of layersAt(doc, tUs)) {
    const placed = place(layer);
    if (!placed) continue;
    const track = doc.timeline.tracks[layer.trackIndex];
    const clip = track?.clips.find((c) => c.id === layer.clipId);
    const transition = clip ? transitionAt(clip, tUs) : null;
    if (!track || !clip || !transition) {
      layers.push(placed);
      continue;
    }
    // The clip before, if it ends where this one starts, keeps playing under the transition.
    const prev = track.clips.find(
      (c) => c.timelineStartUs + clipTimelineDurationUs(c) === clip.timelineStartUs,
    );
    const continued = prev ? clipLayerAt(doc, layer.trackIndex, prev, tUs) : null;
    // A second decoder: the incoming clip may show the same media at another time.
    const outgoingLayer = continued && {
      ...continued,
      decoder: continued.mediaId + OUTGOING_DECODER_SUFFIX,
    };
    const outgoing = outgoingLayer ? place(outgoingLayer) : null;
    layers.push(...transitionLayers(transition, placed, outgoing, canvas));
  }
  return {
    tUs,
    canvas,
    background: doc.timeline.beautify?.background ?? doc.timeline.canvas.background,
    camera,
    layers,
    objects: objectsAt(doc, tUs, camera),
  };
}
