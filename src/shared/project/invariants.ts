/**
 * Cross-field invariants of project schema v1 (§4.4.1). Checked on load (as part of
 * `ProjectSchema`) and after every timeline operation (`timeline-ops.ts`).
 *
 * Invariant 2 (media bounds) ignores `syncAdjustUs`: clips must lie within the media's
 * un-nudged reference bounds (`mediaEditBounds`), so a sync nudge never makes a project invalid.
 * Where a nudge moves the file away from part of a clip, the render plan shows a gap there.
 *
 * Beyond the six numbered invariants of the spec, IDs of tracks, clips and media must be unique:
 * every edit operation addresses clips and tracks by ID.
 *
 * Format 2 adds (all checked only when the fields are present):
 * - a clip with `speed` or `freeze` has `durationUs`, and with `speed` its source length is
 *   `durationUs × speed` to within 2 µs (the schema keeps the speed in 0.25–4);
 * - a transition is no longer than its clip;
 * - linked clips also share their source length and freeze flag, so they stay in sync;
 * - keyframe lists (face layout, volume, camera, object boxes) and markers are sorted by time
 *   with no duplicate times; layout keyframes only on overlay tracks;
 * - objects end after they start, last at least one frame, and keep their keyframes inside
 *   `[inUs, outUs]`; object, marker and object-track IDs are unique;
 * - a camera rect lies inside the canvas; ducking names another audio track.
 */
import { frameDurationUs } from '../time';
import { SPEED_SLACK_US, clipSourceDurationUs, clipTimelineDurationUs } from './clip-time';
import { mediaEditBounds } from './media-time';
import type { Media, Project } from './schema';

export type InvariantCode =
  | 'clip-order'
  | 'clip-overlap'
  | 'clip-source-range'
  | 'clip-media-bounds'
  | 'clip-min-duration'
  | 'link-mismatch'
  | 'link-same-track'
  | 'canvas-size'
  | 'missing-media'
  | 'duplicate-id'
  | 'clip-speed'
  | 'transition-length'
  | 'keyframe-order'
  | 'layout-keyframes-track'
  | 'object-range'
  | 'object-keyframe-range'
  | 'camera-rect'
  | 'duck-track';

export interface InvariantViolation {
  code: InvariantCode;
  message: string;
  path: (string | number)[];
}

const CANVAS_MIN = 64;
const CANVAS_MAX = 7680;

function isValidCanvasSide(n: number): boolean {
  return Number.isInteger(n) && n % 2 === 0 && n >= CANVAS_MIN && n <= CANVAS_MAX;
}

export function checkProjectInvariants(project: Project): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const mediaById = new Map<string, Media>(project.media.map((m) => [m.id, m]));
  const minDurationUs = frameDurationUs(project.timeline.frameRate);
  const links = new Map<
    string,
    {
      trackIndex: number;
      clipIndex: number;
      startUs: number;
      durationUs: number;
      sourceUs: number;
      freeze: boolean;
      speed: number;
    }[]
  >();

  // 5. Canvas dimensions are even, each side in 64–7680.
  const { width, height } = project.timeline.canvas;
  if (!isValidCanvasSide(width) || !isValidCanvasSide(height)) {
    violations.push({
      code: 'canvas-size',
      message: `canvas ${String(width)}×${String(height)} must have even sides in ${String(CANVAS_MIN)}–${String(CANVAS_MAX)}`,
      path: ['timeline', 'canvas'],
    });
  }

  // IDs are unique per kind (tracks, clips, media).
  const seen = new Set<string>();
  const unique = (id: string, path: (string | number)[]) => {
    if (seen.has(id)) {
      violations.push({ code: 'duplicate-id', message: `ID ${id} is used more than once`, path });
    }
    seen.add(id);
  };
  project.media.forEach((m, i) => {
    unique(m.id, ['media', i, 'id']);
  });
  project.timeline.tracks.forEach((track, trackIndex) => {
    unique(track.id, ['timeline', 'tracks', trackIndex, 'id']);
    track.clips.forEach((clip, clipIndex) => {
      unique(clip.id, ['timeline', 'tracks', trackIndex, 'clips', clipIndex, 'id']);
    });
  });
  (project.timeline.objectTracks ?? []).forEach((track, trackIndex) => {
    unique(track.id, ['timeline', 'objectTracks', trackIndex, 'id']);
    track.items.forEach((item, itemIndex) => {
      unique(item.id, ['timeline', 'objectTracks', trackIndex, 'items', itemIndex, 'id']);
    });
  });
  (project.timeline.markers ?? []).forEach((marker, i) => {
    unique(marker.id, ['timeline', 'markers', i, 'id']);
  });

  project.timeline.tracks.forEach((track, trackIndex) => {
    let previousEndUs = -Infinity;
    let previousStartUs = -Infinity;

    track.clips.forEach((clip, clipIndex) => {
      const path = ['timeline', 'tracks', trackIndex, 'clips', clipIndex];
      const sourceUs = clipSourceDurationUs(clip);
      const durationUs = clipTimelineDurationUs(clip);

      // 1. Sorted by timelineStartUs, no overlap.
      if (clip.timelineStartUs < previousStartUs) {
        violations.push({
          code: 'clip-order',
          message: `clip ${clip.id} starts before the previous clip on track ${track.id}`,
          path,
        });
      } else if (clip.timelineStartUs < previousEndUs) {
        violations.push({
          code: 'clip-overlap',
          message: `clip ${clip.id} overlaps the previous clip on track ${track.id}`,
          path,
        });
      }
      previousStartUs = clip.timelineStartUs;
      previousEndUs = Math.max(previousEndUs, clip.timelineStartUs + Math.max(durationUs, 0));

      // 2a. sourceEndUs > sourceStartUs.
      if (sourceUs <= 0) {
        violations.push({
          code: 'clip-source-range',
          message: `clip ${clip.id} has sourceEndUs ≤ sourceStartUs`,
          path,
        });
      } else if (durationUs < minDurationUs) {
        // 3. At least one frame at the timeline frame rate.
        violations.push({
          code: 'clip-min-duration',
          message: `clip ${clip.id} is shorter than one frame (${String(minDurationUs)} µs)`,
          path,
        });
      }

      // 6. Referenced media exists; 2b. the clip lies within the media's un-nudged bounds.
      const media = mediaById.get(clip.mediaId);
      if (!media) {
        violations.push({
          code: 'missing-media',
          message: `clip ${clip.id} references unknown media ${clip.mediaId}`,
          path: [...path, 'mediaId'],
        });
      } else {
        const bounds = mediaEditBounds(media);
        if (clip.sourceStartUs < bounds.startUs || clip.sourceEndUs > bounds.endUs) {
          violations.push({
            code: 'clip-media-bounds',
            message: `clip ${clip.id} [${String(clip.sourceStartUs)}, ${String(clip.sourceEndUs)}) lies outside media ${media.id} [${String(bounds.startUs)}, ${String(bounds.endUs)}]`,
            path,
          });
        }
      }

      // v2: a sped-up or frozen clip stores its timeline length; a sped-up clip's source length
      // matches it to within the rounding of edits.
      if ((clip.freeze || clip.speed !== undefined) && clip.durationUs === undefined) {
        violations.push({
          code: 'clip-speed',
          message: `clip ${clip.id} has speed or freeze but no durationUs`,
          path,
        });
      } else if (!clip.freeze && clip.speed !== undefined && clip.durationUs !== undefined) {
        const expected = clip.durationUs * clip.speed;
        if (Math.abs(sourceUs - expected) > SPEED_SLACK_US) {
          violations.push({
            code: 'clip-speed',
            message: `clip ${clip.id} plays ${String(sourceUs)} µs of source in ${String(clip.durationUs)} µs, not at speed ${String(clip.speed)}`,
            path,
          });
        }
      }
      if (clip.transitionIn && clip.transitionIn.durationUs > durationUs) {
        violations.push({
          code: 'transition-length',
          message: `transition of clip ${clip.id} is longer than the clip`,
          path: [...path, 'transitionIn'],
        });
      }

      if (clip.linkId !== null) {
        const group = links.get(clip.linkId) ?? [];
        group.push({
          trackIndex,
          clipIndex,
          startUs: clip.timelineStartUs,
          durationUs,
          sourceUs,
          freeze: clip.freeze ?? false,
          speed: clip.speed ?? 1,
        });
        links.set(clip.linkId, group);
      }
    });
  });

  // 4. Linked clips share timelineStartUs and duration, and lie on different tracks.
  for (const [linkId, group] of links) {
    const first = group[0];
    if (!first) continue;
    const tracksSeen = new Set<number>();
    for (const member of group) {
      const path = ['timeline', 'tracks', member.trackIndex, 'clips', member.clipIndex];
      if (member.startUs !== first.startUs || member.durationUs !== first.durationUs) {
        violations.push({
          code: 'link-mismatch',
          message: `linked clips in ${linkId} differ in start or duration`,
          path,
        });
      } else if (
        member.sourceUs !== first.sourceUs ||
        member.freeze !== first.freeze ||
        member.speed !== first.speed
      ) {
        violations.push({
          code: 'link-mismatch',
          message: `linked clips in ${linkId} differ in speed or freeze`,
          path,
        });
      }
      if (tracksSeen.has(member.trackIndex)) {
        violations.push({
          code: 'link-same-track',
          message: `link ${linkId} has more than one clip on the same track`,
          path,
        });
      }
      tracksSeen.add(member.trackIndex);
    }
  }

  checkV2Timeline(project, minDurationUs, violations);
  return violations;
}

/** Times must increase strictly. */
function checkSorted(
  times: readonly number[],
  what: string,
  path: (string | number)[],
  violations: InvariantViolation[],
): void {
  for (let i = 1; i < times.length; i++) {
    if ((times[i] ?? 0) <= (times[i - 1] ?? 0)) {
      violations.push({
        code: 'keyframe-order',
        message: `${what} must be sorted by time with no duplicates`,
        path: [...path, i],
      });
      return;
    }
  }
}

function checkV2Timeline(
  project: Project,
  minDurationUs: number,
  violations: InvariantViolation[],
): void {
  const timeline = project.timeline;
  const tracks = timeline.tracks;

  tracks.forEach((track, trackIndex) => {
    const path = ['timeline', 'tracks', trackIndex];
    if (track.type === 'video' && track.layoutKeyframes) {
      if (track.layout.kind !== 'overlay') {
        violations.push({
          code: 'layout-keyframes-track',
          message: `track ${track.id} has layout keyframes but is not an overlay track`,
          path: [...path, 'layoutKeyframes'],
        });
      }
      checkSorted(
        track.layoutKeyframes.map((k) => k.tUs),
        'layout keyframes',
        [...path, 'layoutKeyframes'],
        violations,
      );
    }
    if (track.type === 'audio') {
      if (track.volumeKeyframes) {
        checkSorted(
          track.volumeKeyframes.map((k) => k.tUs),
          'volume keyframes',
          [...path, 'volumeKeyframes'],
          violations,
        );
      }
      const duck = track.cleanup?.duck;
      if (duck) {
        const by = tracks.find((t) => t.id === duck.byTrackId);
        if (by?.type !== 'audio' || by.id === track.id) {
          violations.push({
            code: 'duck-track',
            message: `track ${track.id} ducks under ${duck.byTrackId}, which is not another audio track`,
            path: [...path, 'cleanup', 'duck'],
          });
        }
      }
    }
  });

  (timeline.objectTracks ?? []).forEach((track, trackIndex) => {
    track.items.forEach((item, itemIndex) => {
      const path = ['timeline', 'objectTracks', trackIndex, 'items', itemIndex];
      if (item.outUs - item.inUs < minDurationUs) {
        violations.push({
          code: 'object-range',
          message: `object ${item.id} must last at least one frame`,
          path,
        });
      }
      if (item.keyframes) {
        checkSorted(
          item.keyframes.map((k) => k.tUs),
          'object keyframes',
          [...path, 'keyframes'],
          violations,
        );
        if (item.keyframes.some((k) => k.tUs < item.inUs || k.tUs > item.outUs)) {
          violations.push({
            code: 'object-keyframe-range',
            message: `object ${item.id} has keyframes outside its in and out times`,
            path: [...path, 'keyframes'],
          });
        }
      }
    });
  });

  if (timeline.camera) {
    checkSorted(
      timeline.camera.map((k) => k.tUs),
      'camera keyframes',
      ['timeline', 'camera'],
      violations,
    );
    timeline.camera.forEach((k, i) => {
      const r = k.rect;
      const eps = 1e-9;
      if (r.width <= 0 || r.height <= 0 || r.x + r.width > 1 + eps || r.y + r.height > 1 + eps) {
        violations.push({
          code: 'camera-rect',
          message: 'a camera rect must have a positive size and lie inside the canvas',
          path: ['timeline', 'camera', i, 'rect'],
        });
      }
    });
  }

  if (timeline.markers) {
    checkSorted(
      timeline.markers.map((m) => m.tUs),
      'markers',
      ['timeline', 'markers'],
      violations,
    );
  }
}
