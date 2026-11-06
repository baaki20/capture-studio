/**
 * Annotation objects in the editor (R2.5–R2.8): intents → timeline operations. Pure, so the
 * mapping is unit-tested; `ObjectSections.tsx` and the preview's handles call these.
 *
 * - Adding puts the object at the playhead for `DEFAULT_OBJECT_US` (shorter at the end of the
 *   timeline), centred; a step takes the next number.
 * - Box edits (inspector or preview handles) change the box itself, or, when the object moves on
 *   keyframes, the box keyframe at the playhead (added there if needed).
 * - Preview boxes are in output-frame pixels, camera applied; `boxFromFrameRect` undoes the camera.
 */
import {
  DEFAULT_OBJECT_US,
  newObject,
  nextStepValue,
  TEXT_PRESETS,
  type ObjectKind,
  type TextPreset,
} from '../../../shared/project/objects';
import type { ObjectPatch } from '../../../shared/project/object-patch';
import { cameraRectAt, sceneAt, type RectF } from '../../../shared/project/scene';
import type { FRect, ObjectTrack, Project, TimelineObject } from '../../../shared/project/schema';
import { timelineDurationUs, type TimelineOp } from '../../../shared/project/timeline-ops';
import { frameDurationUs, frameToUs, usToFrame } from '../../../shared/time';

/** The object with `id` and its track, if any. */
export function findObject(
  doc: Project,
  id: string | null,
): { item: TimelineObject; track: ObjectTrack } | null {
  if (!id) return null;
  for (const track of doc.timeline.objectTracks ?? []) {
    const item = track.items.find((i) => i.id === id);
    if (item) return { item, track };
  }
  return null;
}

/** Every object on the timeline, in draw order. */
export function allObjects(doc: Project): TimelineObject[] {
  return (doc.timeline.objectTracks ?? []).flatMap((t) => t.items);
}

/**
 * Adds an object of `kind` at the playhead with the ID `id` (a text object takes `preset`).
 * Null when the timeline is empty.
 */
export function addObjectOp(
  doc: Project,
  kind: ObjectKind,
  atUs: number,
  id: string,
  preset: TextPreset = 'title',
): TimelineOp | null {
  const fps = doc.timeline.frameRate;
  const frame = frameDurationUs(fps);
  const end = timelineDurationUs(doc);
  if (end < frame) return null;
  const outUs = Math.min(end, frameToUs(usToFrame(atUs, fps), fps) + DEFAULT_OBJECT_US);
  const inUs = Math.max(0, Math.min(frameToUs(usToFrame(atUs, fps), fps), outUs - frame));
  let item: TimelineObject = newObject(kind, id, inUs, outUs);
  if (item.kind === 'text') {
    const text = {
      title: 'Title',
      subtitle: 'Subtitle',
      caption: 'Caption',
      label: 'Label',
      code: 'code',
    };
    item = { ...item, text: text[preset], preset, style: { ...TEXT_PRESETS[preset] } };
  }
  if (item.kind === 'step') item = { ...item, value: nextStepValue(allObjects(doc)) };
  return { type: 'addObject', item };
}

export function patchObjectOp(objectId: string, patch: ObjectPatch): TimelineOp {
  return { type: 'updateObject', objectId, patch };
}

/** The object's box shown at `atUs` changed to `box` (fractions): see the file comment. */
export function objectBoxOp(
  doc: Project,
  objectId: string,
  box: FRect,
  atUs: number,
): TimelineOp | null {
  const found = findObject(doc, objectId);
  if (!found) return null;
  const { item } = found;
  if (!item.keyframes || item.keyframes.length === 0) {
    return { type: 'updateObject', objectId, patch: { box } };
  }
  const tUs = Math.min(item.outUs, Math.max(item.inUs, atUs));
  return { type: 'setObjectKeyframe', objectId, tUs, box };
}

/** Starts motion: a box keyframe at the playhead (inside the object's times). */
export function addObjectKeyframeOp(
  doc: Project,
  objectId: string,
  atUs: number,
): TimelineOp | null {
  const found = findObject(doc, objectId);
  if (!found) return null;
  const tUs = Math.min(found.item.outUs, Math.max(found.item.inUs, atUs));
  return { type: 'setObjectKeyframe', objectId, tUs };
}

/**
 * A rect on the output frame (camera applied) as a box in canvas fractions at `atUs`, kept inside
 * the canvas with a side of at least 1 %.
 */
export function boxFromFrameRect(doc: Project, rect: RectF, atUs: number): FRect {
  const { width: W, height: H } = doc.timeline.canvas;
  const camera = cameraRectAt(doc, atUs);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const width = clamp((rect.width * camera.width) / W, 0.01, 1);
  const height = clamp((rect.height * camera.height) / H, 0.01, 1);
  return {
    x: clamp(camera.x + (rect.x * camera.width) / W, 0, 1 - width),
    y: clamp(camera.y + (rect.y * camera.height) / H, 0, 1 - height),
    width,
    height,
  };
}

/** Visible objects at `atUs` with their rect on the output frame, topmost first. */
export function objectsUnder(doc: Project, atUs: number): { id: string; rect: RectF }[] {
  return sceneAt(doc, atUs)
    .objects.map((o) => ({ id: o.item.id, rect: o.rectPx }))
    .reverse();
}

/** The topmost visible object whose box contains (x, y) on the output frame, or null. */
export function objectAt(doc: Project, atUs: number, x: number, y: number): string | null {
  for (const o of objectsUnder(doc, atUs)) {
    const r = o.rect;
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return o.id;
  }
  return null;
}
