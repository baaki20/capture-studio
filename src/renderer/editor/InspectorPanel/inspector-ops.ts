/**
 * Inspector intents → timeline operations (R1.40–R1.42). Pure, so the mapping is unit-tested;
 * the panels only render controls and call these. Values are clamped by the operations too
 * (`setGain` steps and limits, `setLayout` keeps the overlay inside the canvas, `nudge` clamps
 * to ±2000 ms).
 */
import {
  applyCornerPreset,
  applySizePreset,
  layoutFromDestRect,
  type Corner,
  type FaceSizePreset,
  type PixelRect,
} from '../../../shared/project/face-layout';
import type {
  Component,
  Media,
  NRect,
  OverlayLayout,
  ProjectV1,
  Track,
  VideoTrack,
} from '../../../shared/project/schema';
import {
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  NUDGE_MAX_US,
  trackFrameSize,
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
export function faceTrack(doc: ProjectV1): (VideoTrack & { layout: OverlayLayout }) | null {
  for (const track of doc.timeline.tracks) {
    if (track.type === 'video' && track.layout.kind === 'overlay') {
      return track as VideoTrack & { layout: OverlayLayout };
    }
  }
  return null;
}

/** The screen track (the video track with a screen layout), if any. */
export function screenTrack(doc: ProjectV1): VideoTrack | null {
  for (const track of doc.timeline.tracks) {
    if (track.type === 'video' && track.layout.kind === 'screen') return track;
  }
  return null;
}

function overlayOf(
  doc: ProjectV1,
  trackId: string,
): { track: VideoTrack; layout: OverlayLayout } | null {
  const track = doc.timeline.tracks.find((t) => t.id === trackId);
  if (track?.type !== 'video' || track.layout.kind !== 'overlay') return null;
  return { track, layout: track.layout };
}

/** Corner preset (R1.41): moves the overlay into a corner with the standard margin. */
export function cornerOp(doc: ProjectV1, trackId: string, corner: Corner): TimelineOp | null {
  const face = overlayOf(doc, trackId);
  if (!face) return null;
  const next = applyCornerPreset(
    face.layout,
    corner,
    doc.timeline.canvas,
    trackFrameSize(doc, face.track),
  );
  return { type: 'setLayout', trackId, layout: { centerX: next.centerX, centerY: next.centerY } };
}

/** Size slider (5–50 % of the canvas width) keeping the centre (then clamped inside). */
export function sizeOp(trackId: string, widthFraction: number): TimelineOp {
  return { type: 'setLayout', trackId, layout: { width: widthFraction } };
}

export function sizePresetOp(
  doc: ProjectV1,
  trackId: string,
  preset: FaceSizePreset,
): TimelineOp | null {
  const face = overlayOf(doc, trackId);
  if (!face) return null;
  const next = applySizePreset(
    face.layout,
    preset,
    doc.timeline.canvas,
    trackFrameSize(doc, face.track),
  );
  return {
    type: 'setLayout',
    trackId,
    layout: { width: next.width, centerX: next.centerX, centerY: next.centerY },
  };
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
export function overlayRectOp(doc: ProjectV1, trackId: string, rect: PixelRect): TimelineOp | null {
  const face = overlayOf(doc, trackId);
  if (!face) return null;
  const next = layoutFromDestRect(
    face.layout,
    rect,
    doc.timeline.canvas,
    trackFrameSize(doc, face.track),
  );
  return {
    type: 'setLayout',
    trackId,
    layout: { centerX: next.centerX, centerY: next.centerY, width: next.width },
  };
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
export function syncComponents(doc: ProjectV1): ComponentSync[] {
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
