/**
 * A compact, readable view of a project for automation clients (the MCP server shows it to a
 * language model). Times are seconds (exact: µs / 1e6) plus `hh:mm:ss:ff` timecode; everything a
 * client needs to address an edit (track, clip and component IDs) is included, media internals
 * are not.
 */
import { formatTimecode, usToSeconds, type Us } from '../time';
import { isTrackAudible } from './render-plan';
import type { Component, Media, ProjectV1, ScreenLayout, OverlayLayout } from './schema';
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
}

export function timeSummary(us: Us, frameRate: number): TimeSummary {
  return { seconds: usToSeconds(us), timecode: formatTimecode(us, frameRate) };
}

export function summarizeProject(doc: ProjectV1): ProjectSummary {
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
        })),
      };
      return track.type === 'video'
        ? {
            ...base,
            type: 'video',
            hidden: track.hidden,
            layout: track.layout,
            sourceSize: trackFrameSize(doc, track),
          }
        : {
            ...base,
            type: 'audio',
            gainDb: track.gainDb,
            muted: track.muted,
            solo: track.solo,
            audible: isTrackAudible(doc, track),
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
  };
}
