/**
 * Clip drags on the timeline (R1.36, R1.39): a pointer drag becomes `move` or `trim` operations
 * with absolute targets (the clip's position at drag start plus the pointer delta), snapped to
 * the playhead, clip edges and marks when snapping is on. The document store groups the whole
 * drag into one undo step (`beginGesture`/`endGesture`, R1.43).
 *
 * Alt held excludes linked partners (`includeLinked: false`). Overlaps are resolved by the
 * operation itself (`onOverlap: 'nearest-free'`: nearest free position, or the clip stays).
 */
import type { ProjectV1 } from '../../../shared/project/schema';
import {
  clipDurationUs,
  clipEndUs,
  findClip,
  linkedClips,
  snapPoints,
  snapTo,
  type TimelineOp,
} from '../../../shared/project/timeline-ops';

export type DragKind = 'move' | 'trim-start' | 'trim-end';

export interface ClipDrag {
  kind: DragKind;
  clipId: string;
  /** For a move, the clip start at drag start; for a trim, the dragged edge's time. */
  originUs: number;
  /** Timeline time under the pointer when the drag started. */
  grabUs: number;
}

export interface DragOptions {
  includeLinked: boolean;
  snapping: boolean;
  thresholdUs: number;
  playheadUs: number;
}

export interface DragResult {
  op: TimelineOp;
  /** The snap point used, for the snap guide line, or null. */
  snappedUs: number | null;
}

/** Starts a drag from a hit on a clip (body → move, edge → trim). */
export function beginClipDrag(
  doc: ProjectV1,
  clipId: string,
  zone: 'body' | 'start' | 'end',
  pointerUs: number,
): ClipDrag | null {
  const loc = findClip(doc, clipId);
  if (!loc) return null;
  const { clip } = loc;
  if (zone === 'start') {
    return { kind: 'trim-start', clipId, originUs: clip.timelineStartUs, grabUs: pointerUs };
  }
  if (zone === 'end')
    return { kind: 'trim-end', clipId, originUs: clipEndUs(clip), grabUs: pointerUs };
  return { kind: 'move', clipId, originUs: clip.timelineStartUs, grabUs: pointerUs };
}

function dragged(doc: ProjectV1, clipId: string, includeLinked: boolean): string[] {
  return includeLinked ? linkedClips(doc, clipId).map((l) => l.clip.id) : [clipId];
}

/** The operation for the pointer at `pointerUs`, or null when the clip no longer exists. */
export function dragOp(
  doc: ProjectV1,
  drag: ClipDrag,
  pointerUs: number,
  options: DragOptions,
): DragResult | null {
  const loc = findClip(doc, drag.clipId);
  if (!loc) return null;
  const delta = pointerUs - drag.grabUs;
  const points = options.snapping
    ? snapPoints(doc, {
        playheadUs: options.playheadUs,
        excludeClipIds: dragged(doc, drag.clipId, options.includeLinked),
      })
    : [];
  const snap = (t: number) =>
    options.snapping ? snapTo(t, points, options.thresholdUs) : { us: t, snapped: false };

  if (drag.kind === 'move') {
    const duration = clipDurationUs(loc.clip);
    let start = Math.max(0, drag.originUs + delta);
    let snappedUs: number | null = null;
    const head = snap(start);
    const tail = snap(start + duration);
    const headDist = head.snapped ? Math.abs(head.us - start) : Infinity;
    const tailDist = tail.snapped ? Math.abs(tail.us - (start + duration)) : Infinity;
    if (headDist <= tailDist && head.snapped) {
      start = head.us;
      snappedUs = head.us;
    } else if (tail.snapped) {
      start = Math.max(0, tail.us - duration);
      snappedUs = tail.us;
    }
    return {
      op: {
        type: 'move',
        clipId: drag.clipId,
        toStartUs: start,
        includeLinked: options.includeLinked,
        onOverlap: 'nearest-free',
      },
      snappedUs,
    };
  }

  const edge = snap(Math.max(0, drag.originUs + delta));
  return {
    op: {
      type: 'trim',
      clipId: drag.clipId,
      edge: drag.kind === 'trim-start' ? 'start' : 'end',
      toUs: edge.us,
      includeLinked: options.includeLinked,
    },
    snappedUs: edge.snapped ? edge.us : null,
  };
}
