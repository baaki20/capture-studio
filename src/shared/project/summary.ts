/**
 * A compact, readable view of a project for automation clients (the MCP server shows it to a
 * language model). Times are seconds (exact: µs / 1e6) plus `hh:mm:ss:ff` timecode; everything a
 * client needs to address an edit (track, clip and component IDs) is included, media internals
 * are not.
 */
import { formatTimecode, usToSeconds, type Us } from '../time';
import { isTrackAudible } from './render-plan';
import { cameraView } from './camera-keyframes';
import { objectLabel } from './objects';
import type {
  AudioTrack,
  Beautify,
  Component,
  Easing,
  FaceMode,
  FRect,
  Media,
  OverlayLayout,
  Project,
  ScreenLayout,
  TimelineObject,
} from './schema';
import { clipDurationUs, clipEndUs, timelineDurationUs, trackFrameSize } from './timeline-ops';

export interface TimeSummary {
  seconds: number;
  timecode: string;
}

export interface ClipSummary {
  id: string;
  start: TimeSummary;
  end: TimeSummary;
  durationSeconds: number;
  /** Clips sharing a link ID (camera + mic) are edited together. */
  linkId: string | null;
  source: Media['role'] | 'unknown';
  /** Playback speed when not 1 (audio keeps its pitch). */
  speed?: number;
  /** A freeze frame (one picture held, silent). */
  freeze?: true;
  /** The transition in from the previous clip. */
  transition?: { kind: string; seconds: number };
  /** Audio clips: own gain (dB) and fades (seconds). */
  gainDb?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
}

interface TrackSummaryBase {
  id: string;
  name: string;
  componentId: string | null;
  locked: boolean;
  clips: ClipSummary[];
}

export interface VideoTrackSummary extends TrackSummaryBase {
  type: 'video';
  hidden: boolean;
  layout: ScreenLayout | OverlayLayout;
  /** Face layout keyframes (time, mode, easing to the next); absent when the layout is fixed. */
  layoutKeyframes?: {
    at: TimeSummary;
    mode: FaceMode;
    easing: Easing;
    layout: OverlayLayout;
  }[];
  /** The picture size of the track's media, in the pixels `layout.crop` uses. */
  sourceSize: { width: number; height: number };
}

export interface AudioTrackSummary extends TrackSummaryBase {
  type: 'audio';
  gainDb: number;
  muted: boolean;
  solo: boolean;
  /** False when muted, or when another track is soloed. */
  audible: boolean;
  /** Noise reduction, normalization and ducking; absent when off. */
  cleanup?: NonNullable<AudioTrack['cleanup']>;
  /** Volume keyframes (dB on top of the track volume). */
  volumeKeyframes?: { at: TimeSummary; gainDb: number; easing: Easing }[];
}

export type TrackSummary = VideoTrackSummary | AudioTrackSummary;

export interface ComponentSummary {
  id: string;
  type: Component['type'];
  /** The sync nudge of each of the component's media, in milliseconds. */
  media: { id: string; role: Media['role']; status: Media['status']; syncAdjustMs: number }[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  frameRate: number;
  canvas: { width: number; height: number };
  duration: TimeSummary;
  marks: { in: TimeSummary | null; out: TimeSummary | null };
  /** Video tracks render bottom to top in this order. */
  tracks: TrackSummary[];
  components: ComponentSummary[];
  /** Markers, by time; chapter markers become MP4 chapters. */
  markers?: { id: string; at: TimeSummary; label: string; chapter: boolean }[];
  /** Text, callouts and privacy regions over the video, bottom to top. */
  annotations?: {
    id: string;
    kind: TimelineObject['kind'];
    label: string;
    track: string;
    start: TimeSummary;
    end: TimeSummary;
    box: FRect;
    moves: boolean;
  }[];
  /** Background, padding, corners and shadow around the screen; absent when plain. */
  background?: Beautify;
  /** Camera zoom keyframes (zoom 1 = the full frame, centre in canvas fractions). */
  zoomKeyframes?: {
    at: TimeSummary;
    zoom: number;
    centerX: number;
    centerY: number;
    easing: Easing;
  }[];
}

export function timeSummary(us: Us, frameRate: number): TimeSummary {
  return { seconds: usToSeconds(us), timecode: formatTimecode(us, frameRate) };
}

export function summarizeProject(doc: Project): ProjectSummary {
  const fps = doc.timeline.frameRate;
  const time = (us: Us) => timeSummary(us, fps);
  const media = new Map(doc.media.map((m) => [m.id, m]));
  const { inUs, outUs } = doc.timeline.marks;
  return {
    id: doc.id,
    name: doc.name,
    frameRate: fps,
    canvas: { width: doc.timeline.canvas.width, height: doc.timeline.canvas.height },
    duration: time(timelineDurationUs(doc)),
    marks: { in: inUs === null ? null : time(inUs), out: outUs === null ? null : time(outUs) },
    tracks: doc.timeline.tracks.map((track): TrackSummary => {
      const base = {
        id: track.id,
        name: track.name,
        componentId: track.componentId,
        locked: track.locked,
        clips: track.clips.map((clip): ClipSummary => ({
          id: clip.id,
          start: time(clip.timelineStartUs),
          end: time(clipEndUs(clip)),
          durationSeconds: usToSeconds(clipDurationUs(clip)),
          linkId: clip.linkId,
          source: media.get(clip.mediaId)?.role ?? 'unknown',
          ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
          ...(clip.freeze ? { freeze: true as const } : {}),
          ...(clip.gainDb !== undefined ? { gainDb: clip.gainDb } : {}),
          ...(clip.fadeInUs ? { fadeInSeconds: usToSeconds(clip.fadeInUs) } : {}),
          ...(clip.fadeOutUs ? { fadeOutSeconds: usToSeconds(clip.fadeOutUs) } : {}),
          ...(clip.transitionIn
            ? {
                transition: {
                  kind: clip.transitionIn.kind,
                  seconds: usToSeconds(clip.transitionIn.durationUs),
                },
              }
            : {}),
        })),
      };
      return track.type === 'video'
        ? {
            ...base,
            type: 'video',
            hidden: track.hidden,
            layout: track.layout,
            ...(track.layoutKeyframes
              ? {
                  layoutKeyframes: track.layoutKeyframes.map((k) => ({
                    at: time(k.tUs),
                    mode: k.mode,
                    easing: k.easing,
                    layout: k.layout,
                  })),
                }
              : {}),
            sourceSize: trackFrameSize(doc, track),
          }
        : {
            ...base,
            type: 'audio',
            gainDb: track.gainDb,
            muted: track.muted,
            solo: track.solo,
            audible: isTrackAudible(doc, track),
            ...(track.cleanup ? { cleanup: track.cleanup } : {}),
            ...(track.volumeKeyframes
              ? {
                  volumeKeyframes: track.volumeKeyframes.map((k) => ({
                    at: time(k.tUs),
                    gainDb: k.gainDb,
                    easing: k.easing,
                  })),
                }
              : {}),
          };
    }),
    components: doc.components.map((component) => ({
      id: component.id,
      type: component.type,
      media: component.mediaIds.flatMap((id) => {
        const m = media.get(id);
        return m
          ? [{ id, role: m.role, status: m.status, syncAdjustMs: m.syncAdjustUs / 1000 }]
          : [];
      }),
    })),
    ...(doc.timeline.markers
      ? {
          markers: doc.timeline.markers.map((m) => ({
            id: m.id,
            at: time(m.tUs),
            label: m.label,
            chapter: m.chapter,
          })),
        }
      : {}),
    ...(doc.timeline.objectTracks?.some((t) => t.items.length > 0)
      ? {
          annotations: doc.timeline.objectTracks.flatMap((track) =>
            track.items.map((item) => ({
              id: item.id,
              kind: item.kind,
              label: objectLabel(item),
              track: track.name,
              start: time(item.inUs),
              end: time(item.outUs),
              box: item.box,
              moves: (item.keyframes?.length ?? 0) > 0,
            })),
          ),
        }
      : {}),
    ...(doc.timeline.beautify ? { background: doc.timeline.beautify } : {}),
    ...(doc.timeline.camera
      ? {
          zoomKeyframes: doc.timeline.camera.map((k) => {
            const view = cameraView(k.rect);
            const round = (x: number) => Math.round(x * 1000) / 1000;
            return {
              at: time(k.tUs),
              zoom: round(view.zoom),
              centerX: round(view.centerX),
              centerY: round(view.centerY),
              easing: k.easing,
            };
          }),
        }
      : {}),
  };
}
