/**
 * Cross-field invariants of project schema v1 (§4.4.1). Checked on load (as part of
 * `ProjectV1Schema`) and, from step 14, after every timeline operation.
 */
import { frameDurationUs } from '../time';
import { mediaRefBounds } from './media-time';
import type { Media, ProjectV1 } from './schema';

export type InvariantCode =
  | 'clip-order'
  | 'clip-overlap'
  | 'clip-source-range'
  | 'clip-media-bounds'
  | 'clip-min-duration'
  | 'link-mismatch'
  | 'link-same-track'
  | 'canvas-size'
  | 'missing-media';

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

export function checkProjectInvariants(project: ProjectV1): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const mediaById = new Map<string, Media>(project.media.map((m) => [m.id, m]));
  const minDurationUs = frameDurationUs(project.timeline.frameRate);
  const links = new Map<
    string,
    { trackIndex: number; clipIndex: number; startUs: number; durationUs: number }[]
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

  project.timeline.tracks.forEach((track, trackIndex) => {
    let previousEndUs = -Infinity;
    let previousStartUs = -Infinity;

    track.clips.forEach((clip, clipIndex) => {
      const path = ['timeline', 'tracks', trackIndex, 'clips', clipIndex];
      const durationUs = clip.sourceEndUs - clip.sourceStartUs;

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
      if (durationUs <= 0) {
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

      // 6. Referenced media exists; 2b. the clip lies within the media's reference bounds.
      const media = mediaById.get(clip.mediaId);
      if (!media) {
        violations.push({
          code: 'missing-media',
          message: `clip ${clip.id} references unknown media ${clip.mediaId}`,
          path: [...path, 'mediaId'],
        });
      } else {
        const bounds = mediaRefBounds(media);
        if (clip.sourceStartUs < bounds.startUs || clip.sourceEndUs > bounds.endUs) {
          violations.push({
            code: 'clip-media-bounds',
            message: `clip ${clip.id} [${String(clip.sourceStartUs)}, ${String(clip.sourceEndUs)}) lies outside media ${media.id} [${String(bounds.startUs)}, ${String(bounds.endUs)}]`,
            path,
          });
        }
      }

      if (clip.linkId !== null) {
        const group = links.get(clip.linkId) ?? [];
        group.push({ trackIndex, clipIndex, startUs: clip.timelineStartUs, durationUs });
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

  return violations;
}
