/**
 * Inspector intents → timeline operations (R1.40–R1.42, R2.1–R2.4). Pure, so the mapping is
 * unit-tested; the panels only render controls and call these. Values are clamped by the
 * operations too (`setGain` steps and limits, `setLayout` keeps the overlay inside the canvas,
 * `nudge` clamps to ±2000 ms).
 *
 * Face edits and layout keyframes: without keyframes every face edit changes the track's layout
 * (Phase 1). With keyframes, geometry edits (corner, size, dragging the face) change the keyframe
 * in effect at the playhead, and style edits (shape, radius, mirror, crop, zoom, border, shadow)
 * change the whole track, every keyframe included.
 */
import {
  applyCornerPreset,
  applySizePreset,
  layoutFromDestRect,
  type Corner,
  type FaceSizePreset,
  type PixelRect,
} from '../../../shared/project/face-layout';
import { faceKeyAt, faceStateAt } from '../../../shared/project/layout-keyframes';
import { sceneAt } from '../../../shared/project/scene';
import type {
  Border,
  Component,
  Easing,
  FaceMode,
  LayoutKeyframe,
  Media,
  NRect,
  OverlayLayout,
  Project,
  Shadow,
  Track,
  VideoTrack,
} from '../../../shared/project/schema';
import {
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  NUDGE_MAX_US,
  trackFrameSize,
  type LayoutPatch,
  type TimelineOp,
} from '../../../shared/project/timeline-ops';

export const NUDGE_MAX_MS = NUDGE_MAX_US / 1_000;

export function gainOp(trackId: string, gainDb: number): TimelineOp {
  return { type: 'setGain', trackId, gainDb: Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, gainDb)) };
}

/** Double-click on the gain slider (R1.40). */
export function resetGainOp(trackId: string): TimelineOp {
  return gainOp(trackId, 0);
}

/** Mute, solo (audio), hide (video) and lock (any) toggles. */
export function toggleOp(track: Track, what: 'mute' | 'solo' | 'hide' | 'lock'): TimelineOp | null {
  if (what === 'lock') return { type: 'setLocked', trackId: track.id, locked: !track.locked };
  if (track.type === 'audio') {
    if (what === 'mute') return { type: 'setMuted', trackId: track.id, muted: !track.muted };
    if (what === 'solo') return { type: 'setSolo', trackId: track.id, solo: !track.solo };
    return null;
  }
  return what === 'hide' ? { type: 'setHidden', trackId: track.id, hidden: !track.hidden } : null;
}

/** The face-overlay track (the video track with an overlay layout), if any. */
export function faceTrack(doc: Project): (VideoTrack & { layout: OverlayLayout }) | null {
  for (const track of doc.timeline.tracks) {
    if (track.type === 'video' && track.layout.kind === 'overlay') {
      return track as VideoTrack & { layout: OverlayLayout };
    }
  }
  return null;
}

/** The screen track (the video track with a screen layout), if any. */
export function screenTrack(doc: Project): VideoTrack | null {
  for (const track of doc.timeline.tracks) {
    if (track.type === 'video' && track.layout.kind === 'screen') return track;
  }
  return null;
}

/**
 * The face track and the layout its geometry edits start from at `atUs`: the keyframe in effect
 * there (`keyTime`), or the static layout (`keyTime` null).
 */
function overlayOf(
  doc: Project,
  trackId: string,
  atUs: number,
): { track: VideoTrack; layout: OverlayLayout; keyTime: number | null } | null {
  const track = doc.timeline.tracks.find((t) => t.id === trackId);
  if (track?.type !== 'video' || track.layout.kind !== 'overlay') return null;
  const key = faceKeyAt(track.layoutKeyframes, atUs);
  return { track, layout: key?.layout ?? track.layout, keyTime: key?.tUs ?? null };
}

/** A geometry change at `atUs`: to the keyframe in effect, or the track's layout. */
function geometryOp(
  face: { track: VideoTrack; keyTime: number | null },
  layout: LayoutPatch,
): TimelineOp {
  const trackId = face.track.id;
  return face.keyTime === null
    ? { type: 'setLayout', trackId, layout }
    : { type: 'setLayoutKeyframe', trackId, tUs: face.keyTime, layout };
}

/** The face layout the inspector shows at `atUs` (the keyframe in effect, or the static one). */
export function faceLayoutAt(
  doc: Project,
  trackId: string,
  atUs: number,
): { layout: OverlayLayout; mode: FaceMode; keyTime: number | null } | null {
  const face = overlayOf(doc, trackId, atUs);
  if (!face) return null;
  const state = faceStateAt(face.track.layoutKeyframes, face.track.layout as OverlayLayout, atUs);
  return { layout: face.layout, mode: state.mode, keyTime: face.keyTime };
}

/** Corner preset (R1.41): moves the overlay into a corner with the standard margin. */
export function cornerOp(
  doc: Project,
  trackId: string,
  corner: Corner,
  atUs: number,
): TimelineOp | null {
  const face = overlayOf(doc, trackId, atUs);
  if (!face) return null;
  const next = applyCornerPreset(
    face.layout,
    corner,
    doc.timeline.canvas,
    trackFrameSize(doc, face.track),
  );
  return geometryOp(face, { centerX: next.centerX, centerY: next.centerY });
}

/** Size slider (5–50 % of the canvas width) keeping the centre (then clamped inside). */
export function sizeOp(
  doc: Project,
  trackId: string,
  widthFraction: number,
  atUs: number,
): TimelineOp | null {
  const face = overlayOf(doc, trackId, atUs);
  return face ? geometryOp(face, { width: widthFraction }) : null;
}

export function sizePresetOp(
  doc: Project,
  trackId: string,
  preset: FaceSizePreset,
  atUs: number,
): TimelineOp | null {
  const face = overlayOf(doc, trackId, atUs);
  if (!face) return null;
  const next = applySizePreset(
    face.layout,
    preset,
    doc.timeline.canvas,
    trackFrameSize(doc, face.track),
  );
  return geometryOp(face, { width: next.width, centerX: next.centerX, centerY: next.centerY });
}

export function shapeOp(trackId: string, shape: OverlayLayout['shape']): TimelineOp {
  return { type: 'setLayout', trackId, layout: { shape } };
}

/** Rounded-rectangle radius as a fraction (0–0.5) of the overlay's short side. */
export function radiusOp(trackId: string, cornerRadius: number): TimelineOp {
  return { type: 'setLayout', trackId, layout: { cornerRadius } };
}

export function mirrorOp(trackId: string, mirror: boolean): TimelineOp {
  return { type: 'setLayout', trackId, layout: { mirror } };
}

/** Face or screen crop in the media's pixels; null removes it. */
export function cropOp(trackId: string, crop: NRect | null): TimelineOp {
  return { type: 'setLayout', trackId, layout: { crop } };
}

/** A box dragged or resized on the preview (canvas px) → overlay layout (aspect locked). */
export function overlayRectOp(
  doc: Project,
  trackId: string,
  rect: PixelRect,
  atUs: number,
): TimelineOp | null {
  const face = overlayOf(doc, trackId, atUs);
  if (!face) return null;
  const next = layoutFromDestRect(
    face.layout,
    rect,
    doc.timeline.canvas,
    trackFrameSize(doc, face.track),
  );
  return geometryOp(face, { centerX: next.centerX, centerY: next.centerY, width: next.width });
}

/**
 * The face's box on the canvas at `atUs` for the preview handles, or null when it cannot be
 * dragged there: hidden, no clip under the playhead, or not settled in overlay mode.
 */
export function faceBoxAt(doc: Project, atUs: number): PixelRect | null {
  const track = faceTrack(doc);
  if (!track || track.hidden) return null;
  const face = faceLayoutAt(doc, track.id, atUs);
  if (face?.mode !== 'overlay') return null;
  const layer = sceneAt(doc, atUs).layers.find((l) => l.trackId === track.id);
  if (!layer || layer.opacity < 1) return null;
  // Mid-change the box is moving; only a settled overlay box is draggable.
  const keys = track.layoutKeyframes ?? [];
  const next = keys.find((k) => k.tUs > atUs);
  const from = faceKeyAt(keys, atUs);
  if (from && next && from.easing !== 'hold' && atUs > from.tUs) return null;
  return layer.destRect;
}

// ---------------------------------------------------------------------------------------------
// Face style (whole track) and layout over time

export function zoomOp(trackId: string, zoom: number): TimelineOp {
  return { type: 'setLayout', trackId, layout: { zoom } };
}

/** Border as a fraction of the canvas's short side and a colour; null removes it. */
export function borderOp(trackId: string, border: Border | null): TimelineOp {
  return { type: 'setLayout', trackId, layout: { border } };
}

export function shadowOp(trackId: string, shadow: Shadow | null): TimelineOp {
  return { type: 'setLayout', trackId, layout: { shadow } };
}

/** `#RRGGBB` plus an opacity 0–1 as `#RRGGBBAA`. */
export function withAlpha(color: string, opacity: number): string {
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  return `${color.slice(0, 7)}${alpha.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** The opacity 0–1 of a `#RRGGBB[AA]` colour. */
export function alphaOf(color: string): number {
  return color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
}

export const DEFAULT_BORDER: Border = { width: 0.006, color: '#FFFFFF' };
export const DEFAULT_SHADOW: Shadow = {
  blur: 0.03,
  offsetX: 0,
  offsetY: 0.015,
  color: '#00000099',
};

export const FACE_MODE_LABELS: Record<FaceMode, string> = {
  overlay: 'Overlay',
  full: 'Full screen',
  'side-by-side': 'Side by side',
  hidden: 'Hidden',
};

export const EASING_LABELS: Record<Easing, string> = {
  'ease-in-out': 'Smooth',
  linear: 'Linear',
  'ease-in': 'Ease in',
  'ease-out': 'Ease out',
  hold: 'Hold, then cut',
};

/**
 * Face mode (R2.2): over the In–Out marks when both are set (a per-segment layout, eased over
 * `easeUs`), otherwise from the playhead on (a keyframe).
 */
export function faceModeOp(
  doc: Project,
  trackId: string,
  mode: FaceMode,
  atUs: number,
  easeUs: number,
): TimelineOp {
  const { inUs, outUs } = doc.timeline.marks;
  if (inUs !== null && outUs !== null && outUs > inUs) {
    return { type: 'setFaceMode', trackId, startUs: inUs, endUs: outUs, mode, easeUs };
  }
  return { type: 'setLayoutKeyframe', trackId, tUs: atUs, mode };
}

/** Adds a keyframe at the playhead holding what is shown there. */
export function addKeyframeOp(trackId: string, atUs: number): TimelineOp {
  return { type: 'setLayoutKeyframe', trackId, tUs: atUs };
}

export function keyframeEasingOp(trackId: string, tUs: number, easing: Easing): TimelineOp {
  return { type: 'setLayoutKeyframe', trackId, tUs, easing };
}

export function removeKeyframeOp(trackId: string, tUs: number): TimelineOp {
  return { type: 'removeLayoutKeyframe', trackId, tUs };
}

/** The face track's keyframes (empty without any). */
export function faceKeyframes(doc: Project): readonly LayoutKeyframe[] {
  return faceTrack(doc)?.layoutKeyframes ?? [];
}

/** Sync nudge in ms (R1.42), relative to the screen; clamped to ±2000 ms, 1 ms steps. */
export function nudgeOp(componentId: string, ms: number): TimelineOp {
  const clamped = Math.min(NUDGE_MAX_MS, Math.max(-NUDGE_MAX_MS, Math.round(ms)));
  return { type: 'nudge', target: { componentId }, syncAdjustUs: clamped * 1_000 };
}

export interface SyncMediaInfo {
  mediaId: string;
  role: Media['role'];
  label: string;
  mode: string | null;
  /** System audio: the sink output latency added at recording time, ms. */
  outputLatencyMs: number | null;
  /** Cross-process clock handshake applied, ms. */
  clockHandshakeMs: number | null;
  /** Drift correction: deviation of `clockRatio` from 1 in ppm. */
  driftPpm: number;
}

export interface ComponentSync {
  component: Component;
  label: string;
  /** The current nudge in ms (the component's media share it). */
  offsetMs: number;
  media: SyncMediaInfo[];
}

const ROLE_LABELS: Record<Media['role'], string> = {
  screen: 'Screen',
  camera: 'Camera',
  microphone: 'Microphone',
  'system-audio': 'System audio',
  imported: 'Imported',
};

/** The components that can be nudged (Face + Voice, System audio) with their recorded sync info. */
export function syncComponents(doc: Project): ComponentSync[] {
  const media = new Map(doc.media.map((m) => [m.id, m]));
  return doc.components
    .filter((c) => c.type !== 'screen')
    .map((component) => {
      const members = component.mediaIds.flatMap((id) => {
        const m = media.get(id);
        return m ? [m] : [];
      });
      return {
        component,
        label: component.type === 'face-voice' ? 'Face + Voice' : 'System audio',
        offsetMs: (members[0]?.syncAdjustUs ?? 0) / 1_000,
        media: members.map((m) => ({
          mediaId: m.id,
          role: m.role,
          label: m.device?.label ?? ROLE_LABELS[m.role],
          mode: m.sync?.mode ?? null,
          outputLatencyMs:
            m.sync?.outputLatencyUs === undefined ? null : m.sync.outputLatencyUs / 1_000,
          clockHandshakeMs:
            m.sync?.clockHandshakeUs === undefined ? null : m.sync.clockHandshakeUs / 1_000,
          driftPpm: Math.round((m.clockRatio - 1) * 1e6 * 10) / 10,
        })),
      };
    });
}
