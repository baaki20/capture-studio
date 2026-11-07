/**
 * Timeline edit operations (§1.7, §2.5, R1.35–R1.42). Every operation is a pure function from a
 * project document to a new document or an `OpError`; the input is never modified.
 *
 * Operations are written as Immer recipes, so the editor store gets exact patches for undo and
 * redo (`applyOpWithPatches`) and everyone else gets a plain new document (`applyOp` or the
 * per-operation functions). Untouched parts of the document are shared with the input. Every
 * successful result satisfies `checkProjectInvariants`; an operation that would break one
 * returns `{ code: 'invariant' }` instead (a bug guard: the operations are built not to).
 *
 * Semantics shared by all clip operations:
 * - **Linked clips** (same `linkId`: camera + mic pieces) are split, trimmed, moved and deleted
 *   together. With `includeLinked: false` (Alt held in the UI) the clip's link group is first
 *   dissolved, because invariant 4 does not allow linked clips to differ.
 * - **Locked tracks** are never changed by clip operations. Selecting a clip on a locked track
 *   (or one whose linked partner is on a locked track) gives `track-locked`. Range operations
 *   (`cutRange`, `rippleDelete`) skip locked tracks; a link group that spans a locked and an
 *   unlocked track is unlinked before the cut so the unlocked part can change alone.
 * - Clips shorter than one frame are never produced; slivers that a cut would leave are dropped.
 * - Clip bounds are the media's **un-nudged** reference bounds (`mediaEditBounds`). A sync nudge
 *   only changes `syncAdjustUs` and never touches clips (non-destructive); where the nudged file
 *   no longer covers part of a clip, the render plan draws a gap and plays silence there.
 * - Timeline time equals the reference clock of the clip's media, offset by where the clip was
 *   placed: `refUs = sourceStartUs + (tUs − timelineStartUs)` (times the v2 speed, see
 *   `clip-time.ts`, which every edit that cuts or trims a clip goes through).
 *
 * Results:
 * - `ok(sameDoc)` (reference-equal) when the operation changes nothing, e.g. a trim dragged
 *   against its limit. The store records no undo step for it.
 * - `err({ code: 'nothing-to-do' })` when a command found nothing to act on (split with no clip
 *   under the playhead), so the UI can say so.
 *
 * API for the timeline and inspector builders: `applyOp(doc, op)` with a `TimelineOp`, or the
 * named functions (`split`, `trim`, `move`, `deleteClips`, `rippleDelete`, `cutRange`,
 * `setGain`, `setMuted`, `setSolo`, `setHidden`, `setLocked`, `setLayout`, `nudge`, `unlink`,
 * `relink`, `setMarks`), plus the queries `findClip`, `linkedClips`, `clipsAt`, `clipAt`,
 * `timelineDurationUs`, `refTimeAt`, `snapPoints`, `snapTo`.
 */
import { current, enablePatches, isDraft, produceWithPatches, type Draft, type Patch } from 'immer';
import { newId, ulid, type IdKind } from '../ids';
import { err, ok, type Result } from '../result';
import { frameDurationUs, type Us } from '../time';
import { clampOverlayLayout, clampRectToFrame, type Size } from './face-layout';
import { checkProjectInvariants } from './invariants';
import {
  SPEED_MAX,
  SPEED_MIN,
  clipHead,
  clipMaxEndUs,
  clipMinStartUs,
  clipRefAt,
  clipSourceDurationUs,
  clipTail,
  clipTimelineDurationUs,
  clipWithEnd,
  clipWithStart,
  fitTransition,
} from './clip-time';
import { mediaEditBounds } from './media-time';
import type { ObjectPatch } from './object-patch';
import { upsertBoxKeyframe } from './objects';
import { upsertVolumeKeyframe, type VolumeKeyframe } from './volume-keyframes';
import {
  CAMERA_EASE_MAX_US,
  cameraZoomRange,
  clampCameraRect,
  upsertCameraKeyframe,
} from './camera-keyframes';
import {
  FACE_EASE_MAX_US,
  faceModeSegment,
  faceStateAt,
  keyframesThroughCut,
  moveKeyframe,
  removeKeyframe,
  upsertKeyframe,
} from './layout-keyframes';
import {
  ArrowObjectSchema,
  BlurObjectSchema,
  HighlightObjectSchema,
  PixelateObjectSchema,
  ShapeObjectSchema,
  SpotlightObjectSchema,
  StepObjectSchema,
  TextObjectSchema,
} from './schema';
import type {
  AudioTrack,
  Beautify,
  Border,
  CameraKeyframe,
  Clip,
  Easing,
  FaceMode,
  FRect,
  LayoutKeyframe,
  Marker,
  Media,
  ObjectTrack,
  OverlayLayout,
  Project,
  Shadow,
  TimelineObject,
  Track,
  VideoTrack,
} from './schema';

export type { ObjectPatch } from './object-patch';

enablePatches();

/** Gain slider range and step (R1.40). */
export const GAIN_MIN_DB = -60;
export const GAIN_MAX_DB = 12;
export const GAIN_STEP_DB = 0.5;
/** Sync nudge range (R1.42). */
export const NUDGE_MAX_US = 2_000_000;

export type OpErrorCode =
  | 'unknown-track'
  | 'unknown-clip'
  | 'unknown-media'
  | 'track-locked'
  | 'wrong-track-type'
  | 'invalid-value'
  | 'overlap'
  | 'cannot-link'
  | 'nothing-to-do'
  | 'invariant';

export interface OpError {
  code: OpErrorCode;
  message: string;
}

export type OpResult = Result<Project, OpError>;

export interface OpOptions {
  /** ULID source for new clip and link IDs (inject for deterministic tests). */
  generateId?: () => string;
}

/**
 * Fields of an overlay or screen layout that `setLayout` may change. `border` and `shadow`
 * take null to remove them.
 */
export type LayoutPatch = Flatten<
  Partial<Omit<OverlayLayout, 'kind' | 'border' | 'shadow'>> & {
    border?: Border | null;
    shadow?: Shadow | null;
  }
>;

/** One object type instead of an intersection (so it equals the op schema's inferred type). */
type Flatten<T> = { [K in keyof T]: T[K] };

/** An audio track's cleanup settings (R2.14–R2.16). */
export type Cleanup = NonNullable<AudioTrack['cleanup']>;
/** What `setCleanup` changes; `duck: null` stops ducking. */
export interface CleanupPatch {
  noise?: Cleanup['noise'];
  normalize?: boolean;
  duck?: NonNullable<Cleanup['duck']> | null;
}

/** A clip's transition from the previous clip on its track (v2, R2.10). */
export type Transition = NonNullable<Clip['transitionIn']>;

export type NudgeTarget = { componentId: string } | { mediaIds: string[] };

/** A serializable edit command; `applyOp` dispatches on `type`. */
export type TimelineOp =
  | { type: 'split'; atUs: Us; clipIds?: string[]; includeLinked?: boolean }
  | { type: 'trim'; clipId: string; edge: 'start' | 'end'; toUs: Us; includeLinked?: boolean }
  | {
      type: 'move';
      clipId: string;
      toStartUs: Us;
      includeLinked?: boolean;
      onOverlap?: 'nearest-free' | 'refuse';
    }
  | { type: 'delete'; clipIds: string[]; includeLinked?: boolean }
  | { type: 'rippleDelete'; clipIds: string[]; includeLinked?: boolean }
  | { type: 'cutRange'; inUs: Us; outUs: Us }
  | { type: 'setGain'; trackId: string; gainDb: number }
  | { type: 'setMuted'; trackId: string; muted: boolean }
  | { type: 'setSolo'; trackId: string; solo: boolean }
  | { type: 'setHidden'; trackId: string; hidden: boolean }
  | { type: 'setLocked'; trackId: string; locked: boolean }
  | { type: 'setLayout'; trackId: string; layout: LayoutPatch }
  | {
      type: 'setLayoutKeyframe';
      trackId: string;
      tUs: Us;
      mode?: FaceMode;
      layout?: LayoutPatch;
      easing?: Easing;
    }
  | { type: 'removeLayoutKeyframe'; trackId: string; tUs: Us }
  | { type: 'moveLayoutKeyframe'; trackId: string; fromUs: Us; toUs: Us }
  | {
      type: 'setFaceMode';
      trackId: string;
      startUs: Us;
      endUs: Us;
      mode: FaceMode;
      easeUs?: Us;
    }
  | { type: 'setBeautify'; beautify: Beautify | null }
  | { type: 'setCameraKeyframe'; tUs: Us; rect?: FRect; easing?: Easing }
  | { type: 'removeCameraKeyframe'; tUs: Us }
  | { type: 'moveCameraKeyframe'; fromUs: Us; toUs: Us }
  | { type: 'setCameraZoom'; startUs: Us; endUs: Us; rect: FRect; easeUs?: Us }
  | { type: 'addObject'; item: TimelineObject; trackId?: string }
  | { type: 'updateObject'; objectId: string; patch: ObjectPatch }
  | { type: 'removeObjects'; objectIds: string[] }
  | { type: 'moveObject'; objectId: string; toInUs: Us }
  | { type: 'setObjectKeyframe'; objectId: string; tUs: Us; box?: FRect; easing?: Easing }
  | { type: 'removeObjectKeyframe'; objectId: string; tUs: Us }
  | { type: 'setObjectTrack'; trackId: string; hidden?: boolean; locked?: boolean }
  | { type: 'setSpeed'; inUs: Us; outUs: Us; speed: number }
  | { type: 'freezeFrame'; atUs: Us; durationUs: Us }
  | { type: 'setTransition'; clipId: string; transition: Transition | null }
  | { type: 'addMarker'; marker: Marker }
  | { type: 'updateMarker'; markerId: string; tUs?: Us; label?: string; chapter?: boolean }
  | { type: 'removeMarker'; markerId: string }
  | {
      type: 'setClipAudio';
      clipIds: string[];
      gainDb?: number | null;
      fadeInUs?: Us | null;
      fadeOutUs?: Us | null;
    }
  | { type: 'setVolumeKeyframe'; trackId: string; tUs: Us; gainDb?: number; easing?: Easing }
  | { type: 'removeVolumeKeyframe'; trackId: string; tUs: Us }
  | { type: 'moveVolumeKeyframe'; trackId: string; fromUs: Us; toUs: Us }
  | { type: 'setCleanup'; trackId: string; cleanup: CleanupPatch }
  | { type: 'addMedia'; media: Media[]; tracks: Track[]; atUs: Us }
  | { type: 'nudge'; target: NudgeTarget; syncAdjustUs: Us }
  | { type: 'unlink'; clipIds: string[] }
  | { type: 'relink'; clipIds: string[] }
  | { type: 'setMarks'; inUs: Us | null; outUs: Us | null }
  | { type: 'replaceDocument'; doc: Project };

export type TimelineOpType = TimelineOp['type'];
type OpOf<T extends TimelineOpType> = Extract<TimelineOp, { type: T }>;
type OpArgs<T extends TimelineOpType> = Omit<OpOf<T>, 'type'>;

export interface PatchedResult {
  doc: Project;
  patches: Patch[];
  inversePatches: Patch[];
}

// ---------------------------------------------------------------------------------------------
// Queries (work on any document, draft or not)

export interface ClipLocation {
  trackIndex: number;
  clipIndex: number;
  track: Track;
  clip: Clip;
}

/** Length of a clip on the timeline (`clip-time.ts`: the source length unless v2 speed is set). */
export function clipDurationUs(
  clip: Pick<Clip, 'sourceStartUs' | 'sourceEndUs' | 'durationUs' | 'freeze'>,
): Us {
  return clipTimelineDurationUs(clip);
}

export function clipEndUs(clip: Clip): Us {
  return clip.timelineStartUs + clipDurationUs(clip);
}

/** The timeline's length: the latest clip end on any track (0 when empty). */
export function timelineDurationUs(doc: Project): Us {
  let end = 0;
  for (const track of doc.timeline.tracks)
    for (const c of track.clips) end = Math.max(end, clipEndUs(c));
  return end;
}

export function findTrack(doc: Project, trackId: string): Track | null {
  return doc.timeline.tracks.find((t) => t.id === trackId) ?? null;
}

export function findClip(doc: Project, clipId: string): ClipLocation | null {
  const tracks = doc.timeline.tracks;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    if (!track) continue;
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    const clip = track.clips[clipIndex];
    if (clip) return { trackIndex, clipIndex, track, clip };
  }
  return null;
}

/** The clip and every clip sharing its `linkId` (just the clip when unlinked). */
export function linkedClips(doc: Project, clipId: string): ClipLocation[] {
  const loc = findClip(doc, clipId);
  if (!loc) return [];
  const linkId = loc.clip.linkId;
  if (linkId === null) return [loc];
  const result: ClipLocation[] = [];
  doc.timeline.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      if (clip.linkId === linkId) result.push({ trackIndex, clipIndex, track, clip });
    });
  });
  return result;
}

/** The clip on `track` covering `tUs` (half-open `[start, end)`), or null. */
export function clipAt(track: Track, tUs: Us): Clip | null {
  for (const clip of track.clips) {
    if (clip.timelineStartUs > tUs) break;
    if (tUs < clipEndUs(clip)) return clip;
  }
  return null;
}

/** Every clip under the playhead (one per track at most). */
export function clipsAt(doc: Project, tUs: Us): ClipLocation[] {
  const result: ClipLocation[] = [];
  doc.timeline.tracks.forEach((track, trackIndex) => {
    const clip = clipAt(track, tUs);
    if (clip) result.push({ trackIndex, clipIndex: track.clips.indexOf(clip), track, clip });
  });
  return result;
}

/** Reference-clock time shown at timeline time `tUs` on a track, or null in a gap. */
export function refTimeAt(track: Track, tUs: Us): Us | null {
  const clip = clipAt(track, tUs);
  return clip ? clipRefAt(clip, tUs) : null;
}

/**
 * Snap targets for dragging (R1.39): 0, the playhead, the marks and every clip edge except those
 * of `excludeClipIds` (the clips being dragged). Sorted and deduplicated.
 */
export function snapPoints(
  doc: Project,
  options: { playheadUs?: Us | null; excludeClipIds?: readonly string[] } = {},
): Us[] {
  const exclude = new Set(options.excludeClipIds ?? []);
  const points = new Set<Us>([0]);
  if (options.playheadUs !== undefined && options.playheadUs !== null) {
    points.add(options.playheadUs);
  }
  const { inUs, outUs } = doc.timeline.marks;
  if (inUs !== null) points.add(inUs);
  if (outUs !== null) points.add(outUs);
  for (const track of doc.timeline.tracks) {
    for (const clip of track.clips) {
      if (exclude.has(clip.id)) continue;
      points.add(clip.timelineStartUs);
      points.add(clipEndUs(clip));
    }
  }
  return [...points].sort((a, b) => a - b);
}

/** The nearest snap point within `thresholdUs` of `tUs`, else `tUs` itself. */
export function snapTo(
  tUs: Us,
  points: readonly Us[],
  thresholdUs: Us,
): { us: Us; snapped: boolean } {
  let best: Us | null = null;
  for (const p of points) {
    const d = Math.abs(p - tUs);
    if (d <= thresholdUs && (best === null || d < Math.abs(best - tUs))) best = p;
  }
  return best === null ? { us: tUs, snapped: false } : { us: best, snapped: true };
}

/** Picture size of the media shown on a video track (for layout clamping). */
export function trackFrameSize(doc: Project, track: VideoTrack): Size {
  const byId = new Map(doc.media.map((m) => [m.id, m]));
  for (const clip of track.clips) {
    const video = byId.get(clip.mediaId)?.video;
    if (video) return { width: video.width, height: video.height };
  }
  const component = doc.components.find((c) => c.id === track.componentId);
  for (const id of component?.mediaIds ?? []) {
    const video = byId.get(id)?.video;
    if (video) return { width: video.width, height: video.height };
  }
  return { width: doc.timeline.canvas.width, height: doc.timeline.canvas.height };
}

// ---------------------------------------------------------------------------------------------
// Running operations

class OpFailure extends Error {
  constructor(readonly opError: OpError) {
    super(opError.message);
  }
}

function fail(code: OpErrorCode, message: string): never {
  throw new OpFailure({ code, message });
}

interface Ctx {
  id: (kind: IdKind) => string;
  minUs: Us;
}

/**
 * Applies an operation and returns the new document with Immer patches (for undo/redo).
 * No change gives the input document and empty patch lists.
 */
/**
 * IDs drawn by an operation that was then refused, per generator, handed out again first: a
 * refused edit uses up no IDs, so a batch draws the same IDs as the same edits made one by one.
 */
const returnedIds = new WeakMap<() => string, string[]>();

export function applyOpWithPatches(
  doc: Project,
  op: TimelineOp,
  options: OpOptions = {},
): Result<PatchedResult, OpError> {
  const generate = options.generateId ?? ulid;
  const drawn: string[] = [];
  const draw = (): string => {
    const id = returnedIds.get(generate)?.shift() ?? generate();
    drawn.push(id);
    return id;
  };
  const giveBack = () => {
    if (drawn.length > 0)
      returnedIds.set(generate, [...drawn, ...(returnedIds.get(generate) ?? [])]);
  };
  const ctx: Ctx = {
    id: (kind) => newId(kind, draw),
    minUs: frameDurationUs(doc.timeline.frameRate),
  };
  try {
    const [next, patches, inversePatches] = produceWithPatches(doc, (draft) => {
      if (op.type === 'replaceDocument') return op.doc;
      runOp(draft, op, ctx);
      return undefined;
    });
    if (patches.length === 0) {
      giveBack();
      return ok({ doc, patches: [], inversePatches: [] });
    }
    const violations = checkProjectInvariants(next);
    if (violations.length > 0) {
      giveBack();
      return err({
        code: 'invariant',
        message: `${op.type} would break an invariant: ${violations.map((v) => v.message).join('; ')}`,
      });
    }
    return ok({ doc: next, patches, inversePatches });
  } catch (error) {
    if (error instanceof OpFailure) {
      giveBack();
      return err(error.opError);
    }
    throw error;
  }
}

/** Applies an operation and returns the new document. */
export function applyOp(doc: Project, op: TimelineOp, options: OpOptions = {}): OpResult {
  const result = applyOpWithPatches(doc, op, options);
  return result.ok ? ok(result.value.doc) : result;
}

/** A batch failure: the error of the operation at `index`. */
export interface BatchOpError extends OpError {
  index: number;
}

/**
 * Applies operations in order as one change: all succeed or none takes effect, and the joined
 * patches let a single undo step revert the whole batch. Operations that change nothing are
 * allowed; a batch that changes nothing gives the input document and empty patch lists.
 */
export function applyOpsWithPatches(
  doc: Project,
  ops: readonly TimelineOp[],
  options: OpOptions = {},
): Result<PatchedResult, BatchOpError> {
  let next = doc;
  const patches: Patch[] = [];
  let inversePatches: Patch[] = [];
  for (const [index, op] of ops.entries()) {
    const result = applyOpWithPatches(next, op, options);
    if (!result.ok) {
      const prefix = ops.length > 1 ? `operation ${String(index + 1)} (${op.type}): ` : '';
      return err({ ...result.error, message: prefix + result.error.message, index });
    }
    next = result.value.doc;
    patches.push(...result.value.patches);
    inversePatches = [...result.value.inversePatches, ...inversePatches];
  }
  return ok({ doc: next, patches, inversePatches });
}

function opFn<T extends TimelineOpType>(type: T) {
  return (doc: Project, args: OpArgs<T>, options?: OpOptions): OpResult =>
    applyOp(doc, { ...args, type } as unknown as TimelineOp, options);
}

/** Splits the given clips (or every clip under the playhead on unlocked tracks) at `atUs`. */
export const split = opFn('split');
/** Moves a clip edge to `toUs`, clamped to the media bounds, neighbours and one frame. */
export const trim = opFn('trim');
/** Moves a clip (and its linked partners) to start at `toStartUs`. */
export const move = opFn('move');
/** Removes clips and leaves gaps. */
export const deleteClips = opFn('delete');
/** Removes the time spans of the clips from all unlocked tracks and closes the gaps. */
export const rippleDelete = opFn('rippleDelete');
/** Removes `[inUs, outUs)` from all unlocked tracks and closes the gap (sync preserved). */
export const cutRange = opFn('cutRange');
export const setGain = opFn('setGain');
export const setMuted = opFn('setMuted');
export const setSolo = opFn('setSolo');
export const setHidden = opFn('setHidden');
export const setLocked = opFn('setLocked');
/**
 * Changes a video track's layout (face overlay geometry and style, or the screen crop); clamped.
 * On a face track with layout keyframes the change applies to every keyframe too (the whole
 * track); `setLayoutKeyframe` changes one.
 */
export const setLayout = opFn('setLayout');
/**
 * Sets the face layout keyframe at a time (R2.1): its mode, layout fields and easing. A new
 * keyframe starts from the state in effect there; see `layout-keyframes.ts`.
 */
export const setLayoutKeyframe = opFn('setLayoutKeyframe');
export const removeLayoutKeyframe = opFn('removeLayoutKeyframe');
/** Moves a face layout keyframe to another time (not onto another keyframe). */
export const moveLayoutKeyframe = opFn('moveLayoutKeyframe');
/** The face in one mode on a time range, eased in and out (per-segment layout, R2.2). */
export const setFaceMode = opFn('setFaceMode');
/**
 * Sets the screen's background, padding, rounded corners and shadow (R2.11), or removes them
 * (null: the plain canvas colour again). Sizes are clamped to the schema's ranges.
 */
export const setBeautify = opFn('setBeautify');
/**
 * Sets the camera keyframe at a time (R2.9): its rect (clamped inside the canvas) and easing. A
 * new keyframe starts from the rect shown there; see `camera-keyframes.ts`.
 */
export const setCameraKeyframe = opFn('setCameraKeyframe');
export const removeCameraKeyframe = opFn('removeCameraKeyframe');
/** Moves a camera keyframe to another time (not onto another keyframe). */
export const moveCameraKeyframe = opFn('moveCameraKeyframe');
/** The camera on one rect over a time range, eased in and out (a zoomed range). */
export const setCameraZoom = opFn('setCameraZoom');
/**
 * Adds a text, callout or privacy object (R2.5–R2.7) with the ID it carries, to `trackId` or to
 * the first object track (an "Annotations" track is made when there is none).
 */
export const addObject = opFn('addObject');
/** Changes an object's times, box, look or style; checked against the project schema. */
export const updateObject = opFn('updateObject');
export const removeObjects = opFn('removeObjects');
/** Moves an object in time (its box keyframes move with it). */
export const moveObject = opFn('moveObject');
/** Sets a box keyframe of an object (a moving region, R2.7); see `objects.ts`. */
export const setObjectKeyframe = opFn('setObjectKeyframe');
export const removeObjectKeyframe = opFn('removeObjectKeyframe');
/** Hides or locks an object track. */
export const setObjectTrack = opFn('setObjectTrack');
/**
 * Plays `[inUs, outUs)` at `speed` (0.25–4×, R2.18) on every unlocked track: clips are split at
 * the range's edges, the range gets `(outUs − inUs) × old speed / speed` long, and what follows
 * moves with it (keyframes, annotations, markers). Audio keeps its pitch. Linked clips stay in
 * sync. Refused when the range mixes clips at different speeds.
 */
export const setSpeed = opFn('setSpeed');
/**
 * Holds the picture at `atUs` for `durationUs` (R2.19): every unlocked track opens a gap there,
 * which video tracks fill with a freeze frame of what they showed; audio is silent meanwhile.
 */
export const freezeFrame = opFn('freezeFrame');
/** Sets or removes a clip's transition from the previous clip (R2.10). */
export const setTransition = opFn('setTransition');
/** Adds a marker; `chapter` markers become MP4 chapters (R2.20). */
export const addMarker = opFn('addMarker');
export const updateMarker = opFn('updateMarker');
export const removeMarker = opFn('removeMarker');
/**
 * Sets audio clips' own gain (on top of the track's) and fade in/out (R2.12); null removes one.
 * Fades are kept within the clip.
 */
export const setClipAudio = opFn('setClipAudio');
/** Sets an audio track's volume keyframe (R2.13); see `volume-keyframes.ts`. */
export const setVolumeKeyframe = opFn('setVolumeKeyframe');
export const removeVolumeKeyframe = opFn('removeVolumeKeyframe');
export const moveVolumeKeyframe = opFn('moveVolumeKeyframe');
/**
 * Sets an audio track's cleanup (R2.14–R2.16): noise reduction, loudness normalization of the
 * export, and ducking under another (voice) track.
 */
export const setCleanup = opFn('setCleanup');
/**
 * Adds media and the tracks that show them at `atUs` (imported files, extra takes, R2.21,
 * R2.22); see `media-import.ts`. Clip times in `tracks` count from 0.
 */
export const addMedia = opFn('addMedia');
/** Sets `syncAdjustUs` of a component's (or explicit) media; clip positions do not change. */
export const nudge = opFn('nudge');
export const unlink = opFn('unlink');
export const relink = opFn('relink');
export const setMarks = opFn('setMarks');

function runOp(draft: Project, op: TimelineOp, ctx: Ctx): void {
  switch (op.type) {
    case 'split':
      splitDraft(draft, op, ctx);
      return;
    case 'trim':
      trimDraft(draft, op, ctx);
      return;
    case 'move':
      moveDraft(draft, op);
      return;
    case 'delete':
      deleteDraft(draft, op);
      return;
    case 'rippleDelete':
      rippleDeleteDraft(draft, op, ctx);
      return;
    case 'cutRange':
      if (!isTime(op.inUs) || !isTime(op.outUs) || op.outUs <= op.inUs) {
        fail('invalid-value', 'cut range needs 0 ≤ in < out');
      }
      cutDraft(draft, op.inUs, op.outUs, ctx);
      return;
    case 'setGain': {
      if (!Number.isFinite(op.gainDb)) fail('invalid-value', 'gain must be a number');
      const track = audioTrack(draft, op.trackId);
      const stepped = Math.round(op.gainDb / GAIN_STEP_DB) * GAIN_STEP_DB;
      track.gainDb = Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, stepped));
      return;
    }
    case 'setMuted':
      audioTrack(draft, op.trackId).muted = op.muted;
      return;
    case 'setSolo':
      audioTrack(draft, op.trackId).solo = op.solo;
      return;
    case 'setHidden':
      videoTrack(draft, op.trackId).hidden = op.hidden;
      return;
    case 'setLocked':
      requireTrack(draft, op.trackId).locked = op.locked;
      return;
    case 'setLayout':
      layoutDraft(draft, op.trackId, op.layout);
      return;
    case 'setLayoutKeyframe':
    case 'removeLayoutKeyframe':
    case 'moveLayoutKeyframe':
    case 'setFaceMode':
      layoutKeyframeDraft(draft, op);
      return;
    case 'setBeautify':
      beautifyDraft(draft, op.beautify);
      return;
    case 'setCameraKeyframe':
    case 'removeCameraKeyframe':
    case 'moveCameraKeyframe':
    case 'setCameraZoom':
      cameraDraft(draft, op);
      return;
    case 'addObject':
    case 'updateObject':
    case 'removeObjects':
    case 'moveObject':
    case 'setObjectKeyframe':
    case 'removeObjectKeyframe':
    case 'setObjectTrack':
      objectDraft(draft, op, ctx);
      return;
    case 'setSpeed':
      speedDraft(draft, op, ctx);
      return;
    case 'freezeFrame':
      freezeDraft(draft, op, ctx);
      return;
    case 'setTransition':
      transitionDraft(draft, op);
      return;
    case 'addMarker':
    case 'updateMarker':
    case 'removeMarker':
      markerDraft(draft, op);
      return;
    case 'setClipAudio':
      clipAudioDraft(draft, op);
      return;
    case 'setVolumeKeyframe':
    case 'removeVolumeKeyframe':
    case 'moveVolumeKeyframe':
      volumeDraft(draft, op);
      return;
    case 'setCleanup':
      cleanupDraft(draft, op);
      return;
    case 'addMedia':
      addMediaDraft(draft, op, ctx);
      return;
    case 'nudge':
      nudgeDraft(draft, op);
      return;
    case 'unlink':
      for (const id of op.clipIds) {
        const linkId = requireClip(draft, id).clip.linkId;
        if (linkId !== null) dissolveLink(draft, linkId);
      }
      return;
    case 'relink':
      relinkDraft(draft, op.clipIds, ctx);
      return;
    case 'setMarks':
      for (const t of [op.inUs, op.outUs]) {
        if (t !== null && !isTime(t)) fail('invalid-value', 'marks must be times ≥ 0');
      }
      if (op.inUs !== null && op.outUs !== null && op.outUs <= op.inUs) {
        fail('invalid-value', 'the out mark must be after the in mark');
      }
      draft.timeline.marks.inUs = op.inUs;
      draft.timeline.marks.outUs = op.outUs;
      return;
    case 'replaceDocument':
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Draft helpers

function isTime(t: number): boolean {
  return Number.isSafeInteger(t) && t >= 0;
}

function requireTrack(draft: Project, trackId: string): Track {
  return findTrack(draft, trackId) ?? fail('unknown-track', `unknown track ${trackId}`);
}

function audioTrack(draft: Project, trackId: string): AudioTrack {
  const track = requireTrack(draft, trackId);
  if (track.type !== 'audio') fail('wrong-track-type', `track ${trackId} is not an audio track`);
  return track;
}

function videoTrack(draft: Project, trackId: string): VideoTrack {
  const track = requireTrack(draft, trackId);
  if (track.type !== 'video') fail('wrong-track-type', `track ${trackId} is not a video track`);
  return track;
}

function requireClip(draft: Project, clipId: string): ClipLocation {
  return findClip(draft, clipId) ?? fail('unknown-clip', `unknown clip ${clipId}`);
}

function requireMedia(draft: Project, mediaId: string): Media {
  return (
    draft.media.find((m) => m.id === mediaId) ?? fail('unknown-media', `unknown media ${mediaId}`)
  );
}

/** Plain (non-draft) copy of a value read from a draft. */
function plain<T extends object>(value: T): T {
  return isDraft(value) ? current<T>(value as Draft<T>) : value;
}

function dissolveLink(draft: Project, linkId: string): void {
  for (const track of draft.timeline.tracks) {
    for (const clip of track.clips) if (clip.linkId === linkId) clip.linkId = null;
  }
}

/** Clears link IDs that only one clip still carries. */
function normalizeLinks(draft: Project): void {
  const counts = new Map<string, number>();
  for (const track of draft.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.linkId !== null) counts.set(clip.linkId, (counts.get(clip.linkId) ?? 0) + 1);
    }
  }
  for (const track of draft.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.linkId !== null && counts.get(clip.linkId) === 1) clip.linkId = null;
    }
  }
}

function sortClips(track: Track): void {
  track.clips.sort((a, b) => a.timelineStartUs - b.timelineStartUs);
}

/** A clip's edit group as clip IDs: the clip, plus its linked partners unless excluded. */
function editGroup(draft: Project, clipId: string, includeLinked: boolean): ClipLocation[] {
  const loc = requireClip(draft, clipId);
  if (!includeLinked && loc.clip.linkId !== null) dissolveLink(draft, loc.clip.linkId);
  return linkedClips(draft, clipId);
}

function assertUnlocked(group: readonly ClipLocation[]): void {
  for (const { track, clip } of group) {
    if (track.locked) fail('track-locked', `clip ${clip.id} is on locked track ${track.id}`);
  }
}

/** Distinct edit groups for a selection, keyed by their first clip ID. */
function editGroups(
  draft: Project,
  clipIds: readonly string[],
  includeLinked: boolean,
): ClipLocation[][] {
  const seen = new Set<string>();
  const groups: ClipLocation[][] = [];
  for (const id of clipIds) {
    if (seen.has(id)) continue;
    const group = editGroup(draft, id, includeLinked);
    for (const member of group) seen.add(member.clip.id);
    groups.push(group);
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Split

function splitDraft(draft: Project, op: OpOf<'split'>, ctx: Ctx): void {
  const at = op.atUs;
  if (!isTime(at)) fail('invalid-value', 'split time must be ≥ 0');
  let groups: ClipLocation[][];
  if (op.clipIds && op.clipIds.length > 0) {
    groups = editGroups(draft, op.clipIds, op.includeLinked ?? true);
    for (const group of groups) assertUnlocked(group);
  } else {
    // Nothing selected: every clip under the playhead on unlocked tracks (R1.35).
    const ids = clipsAt(draft, at).map((l) => l.clip.id);
    groups = editGroups(draft, ids, true).filter((g) => g.every((m) => !m.track.locked));
  }

  let count = 0;
  for (const group of groups) {
    const first = group[0]?.clip;
    if (!first) continue;
    const offset = at - first.timelineStartUs;
    if (offset < ctx.minUs || clipDurationUs(first) - offset < ctx.minUs) continue;
    const rightLink = first.linkId === null ? null : ctx.id('link');
    for (const { track, clip } of group) {
      const whole = plain(clip);
      const right: Clip = { ...clipTail(whole, at), id: ctx.id('clip'), linkId: rightLink };
      const index = track.clips.findIndex((c) => c.id === clip.id);
      track.clips.splice(index, 1, clipHead(whole, at), right);
    }
    count++;
  }
  if (count === 0) fail('nothing-to-do', 'no clip to split at the playhead');
}

// ---------------------------------------------------------------------------------------------
// Trim

function neighbours(track: Track, clipId: string): { prev: Clip | null; next: Clip | null } {
  const index = track.clips.findIndex((c) => c.id === clipId);
  return { prev: track.clips[index - 1] ?? null, next: track.clips[index + 1] ?? null };
}

function trimDraft(draft: Project, op: OpOf<'trim'>, ctx: Ctx): void {
  if (!Number.isSafeInteger(op.toUs)) fail('invalid-value', 'trim time must be an integer');
  const group = editGroup(draft, op.clipId, op.includeLinked ?? true);
  assertUnlocked(group);
  const first = group[0]?.clip ?? fail('unknown-clip', `unknown clip ${op.clipId}`);
  const start = first.timelineStartUs;
  const end = clipEndUs(first);

  if (op.edge === 'end') {
    let hi = Number.POSITIVE_INFINITY;
    for (const { track, clip } of group) {
      const bounds = mediaEditBounds(requireMedia(draft, clip.mediaId));
      hi = Math.min(hi, clipMaxEndUs(clip, bounds.endUs));
      const { next } = neighbours(track, clip.id);
      if (next) hi = Math.min(hi, next.timelineStartUs);
    }
    const lo = start + ctx.minUs;
    const newEnd = Math.min(Math.max(op.toUs, lo), Math.max(lo, hi));
    if (newEnd === end) return;
    for (const { clip } of group) replaceClip(draft, clip.id, clipWithEnd(plain(clip), newEnd));
    return;
  }

  let lo = 0;
  for (const { track, clip } of group) {
    const bounds = mediaEditBounds(requireMedia(draft, clip.mediaId));
    lo = Math.max(lo, clipMinStartUs(clip, bounds.startUs));
    const { prev } = neighbours(track, clip.id);
    if (prev) lo = Math.max(lo, clipEndUs(prev));
  }
  const hi = end - ctx.minUs;
  const newStart = Math.max(Math.min(op.toUs, hi), Math.min(lo, hi));
  if (newStart === start) return;
  for (const { clip } of group) replaceClip(draft, clip.id, clipWithStart(plain(clip), newStart));
}

/** Replaces a clip (found by ID) with a new value in place. */
function replaceClip(draft: Project, clipId: string, next: Clip): void {
  for (const track of draft.timeline.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) {
      track.clips[index] = next;
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Move

interface Span {
  startUs: Us;
  endUs: Us;
}

/** Free intervals of a track, ignoring `exclude`; the last one is open-ended. */
function freeSpans(track: Track, exclude: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const clip of track.clips) {
    if (exclude.has(clip.id)) continue;
    if (clip.timelineStartUs > cursor) spans.push({ startUs: cursor, endUs: clip.timelineStartUs });
    cursor = Math.max(cursor, clipEndUs(clip));
  }
  spans.push({ startUs: cursor, endUs: Number.POSITIVE_INFINITY });
  return spans;
}

function moveDraft(draft: Project, op: OpOf<'move'>): void {
  if (!Number.isSafeInteger(op.toStartUs)) fail('invalid-value', 'move time must be an integer');
  const group = editGroup(draft, op.clipId, op.includeLinked ?? true);
  assertUnlocked(group);
  const first = group[0]?.clip ?? fail('unknown-clip', `unknown clip ${op.clipId}`);
  const duration = clipDurationUs(first);
  const exclude = new Set(group.map((m) => m.clip.id));
  const free = group.map((m) => freeSpans(m.track, exclude));
  const fits = (p: Us) =>
    p >= 0 && free.every((spans) => spans.some((s) => s.startUs <= p && p + duration <= s.endUs));

  const target = Math.max(0, op.toStartUs);
  let position = target;
  if (!fits(target)) {
    if (op.onOverlap === 'refuse') fail('overlap', 'the clip would overlap another clip');
    // Nearest free position (R1.39): a gap edge on one of the tracks that fits on all of them.
    const candidates = free.flatMap((spans) =>
      spans.flatMap((s) => [s.startUs, s.endUs - duration]).filter(Number.isFinite),
    );
    let best: Us | null = null;
    for (const c of candidates) {
      if (!fits(c)) continue;
      const better =
        best === null ||
        Math.abs(c - target) < Math.abs(best - target) ||
        (Math.abs(c - target) === Math.abs(best - target) && c < best);
      if (better) best = c;
    }
    position = best ?? fail('overlap', 'no free position for the clip');
  }
  if (position === first.timelineStartUs) return;
  for (const { track, clip } of group) {
    clip.timelineStartUs = position;
    sortClips(track);
  }
}

// ---------------------------------------------------------------------------------------------
// Delete, ripple delete, cut range

function removeClips(draft: Project, ids: ReadonlySet<string>): void {
  for (const track of draft.timeline.tracks) {
    if (track.clips.some((c) => ids.has(c.id))) {
      track.clips = track.clips.filter((c) => !ids.has(c.id));
    }
  }
}

function deleteDraft(draft: Project, op: OpOf<'delete'>): void {
  const groups = editGroups(draft, op.clipIds, op.includeLinked ?? true);
  if (groups.length === 0) fail('nothing-to-do', 'no clips selected');
  for (const group of groups) assertUnlocked(group);
  removeClips(draft, new Set(groups.flat().map((m) => m.clip.id)));
  normalizeLinks(draft);
}

function rippleDeleteDraft(draft: Project, op: OpOf<'rippleDelete'>, ctx: Ctx): void {
  const groups = editGroups(draft, op.clipIds, op.includeLinked ?? true);
  if (groups.length === 0) fail('nothing-to-do', 'no clips selected');
  for (const group of groups) assertUnlocked(group);
  // The union of the selected clips' spans, removed last-first so earlier spans stay put.
  const spans = groups
    .flat()
    .map((m) => ({ startUs: m.clip.timelineStartUs, endUs: clipEndUs(m.clip) }))
    .sort((a, b) => a.startUs - b.startUs);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.startUs <= last.endUs) last.endUs = Math.max(last.endUs, s.endUs);
    else merged.push({ ...s });
  }
  for (const s of merged.reverse()) cutDraft(draft, s.startUs, s.endUs, ctx);
}

/** Where timeline time `t` lands after removing `[a, b)`. */
export function mapTimeThroughCut(t: Us, a: Us, b: Us): Us {
  if (t < a) return t;
  if (t >= b) return t - (b - a);
  return a;
}

function cutDraft(draft: Project, a: Us, b: Us, ctx: Ctx): void {
  const removed = b - a;
  const tracks = draft.timeline.tracks;

  // A link group with members on locked and unlocked tracks cannot stay linked through the cut.
  const lockedLinks = new Set<string>();
  const unlockedLinks = new Set<string>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.linkId === null || clipEndUs(clip) <= a) continue;
      (track.locked ? lockedLinks : unlockedLinks).add(clip.linkId);
    }
  }
  for (const linkId of lockedLinks) if (unlockedLinks.has(linkId)) dissolveLink(draft, linkId);

  const rightLinks = new Map<string, string>();
  for (const track of tracks) {
    if (track.locked) continue;
    const out: Clip[] = [];
    for (const original of track.clips) {
      const clip = plain(original);
      const s = clip.timelineStartUs;
      const e = clipEndUs(clip);
      if (e <= a) {
        out.push(clip);
      } else if (s >= b) {
        out.push({ ...clip, timelineStartUs: s - removed });
      } else {
        if (s < a) {
          const left = clipHead(clip, a);
          if (clipDurationUs(left) >= ctx.minUs) out.push(left);
        }
        if (e > b) {
          let linkId = clip.linkId;
          if (s < a && linkId !== null) {
            const known = rightLinks.get(linkId) ?? ctx.id('link');
            rightLinks.set(linkId, known);
            linkId = known;
          }
          const right: Clip = {
            ...clipTail(clip, b),
            id: s < a ? ctx.id('clip') : clip.id,
            timelineStartUs: a,
            linkId,
          };
          if (clipDurationUs(right) >= ctx.minUs) out.push(right);
        }
      }
    }
    track.clips = out;
    if (track.type === 'video' && track.layoutKeyframes) {
      setKeyframes(track, keyframesThroughCut(plain(track.layoutKeyframes), a, b));
    }
    if (track.type === 'audio' && track.volumeKeyframes) {
      setVolumeKeys(track, keyframesThroughCut(plain(track.volumeKeyframes), a, b));
    }
  }
  for (const track of draft.timeline.objectTracks ?? []) {
    if (track.locked) continue;
    track.items = plain(track.items).flatMap((item) => objectThroughCut(item, a, b, ctx.minUs));
  }
  // The camera follows the screen, so it moves with the content unless every video track is
  // locked (then the picture under it does not move either).
  const screenMoves = tracks.some((t) => t.type === 'video' && !t.locked);
  if (draft.timeline.camera && screenMoves) {
    setCamera(draft, keyframesThroughCut(plain(draft.timeline.camera), a, b));
  }

  if (draft.timeline.markers) {
    setMarkers(
      draft,
      // Markers on removed content go with it.
      plain(draft.timeline.markers)
        .filter((m) => m.tUs <= a || m.tUs >= b)
        .map((m) => ({ ...m, tUs: mapTimeThroughCut(m.tUs, a, b) })),
    );
  }

  const marks = draft.timeline.marks;
  const inUs = marks.inUs === null ? null : mapTimeThroughCut(marks.inUs, a, b);
  const outUs = marks.outUs === null ? null : mapTimeThroughCut(marks.outUs, a, b);
  const empty = inUs !== null && outUs !== null && outUs <= inUs;
  marks.inUs = empty ? null : inUs;
  marks.outUs = empty ? null : outUs;
  normalizeLinks(draft);
}

// ---------------------------------------------------------------------------------------------
// Layout, nudge, links

const OVERLAY_ONLY_KEYS = [
  'centerX',
  'centerY',
  'width',
  'shape',
  'cornerRadius',
  'mirror',
] as const;

/** `patch` applied to an overlay layout, validated and clamped. */
function mergeOverlayPatch(
  layout: OverlayLayout,
  patch: LayoutPatch,
  canvas: Size,
  frame: Size,
): OverlayLayout {
  for (const k of ['centerX', 'centerY', 'width', 'cornerRadius', 'zoom'] as const) {
    const v = patch[k];
    if (v !== undefined && !Number.isFinite(v)) fail('invalid-value', `${k} must be a number`);
  }
  const { border, shadow, crop, ...rest } = patch;
  const merged: OverlayLayout = { ...layout, ...rest, kind: 'overlay' };
  if (crop !== undefined) merged.crop = crop === null ? null : clampRectToFrame(crop, frame);
  if (border === null) delete merged.border;
  else if (border !== undefined) merged.border = border;
  if (shadow === null) delete merged.shadow;
  else if (shadow !== undefined) merged.shadow = shadow;
  return clampOverlayLayout(merged, canvas, frame);
}

function checkCrop(patch: LayoutPatch): void {
  if (patch.crop !== undefined && patch.crop !== null) {
    const { x, y, width, height } = patch.crop;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      fail('invalid-value', 'crop must be a rectangle with a positive size');
    }
  }
}

function layoutDraft(draft: Project, trackId: string, patch: LayoutPatch): void {
  const track = videoTrack(draft, trackId);
  const frame = trackFrameSize(draft, track);
  const layout = plain(track.layout);
  checkCrop(patch);

  if (layout.kind === 'screen') {
    if (
      OVERLAY_ONLY_KEYS.some((k) => patch[k] !== undefined) ||
      patch.border !== undefined ||
      patch.shadow !== undefined
    ) {
      fail('wrong-track-type', `track ${trackId} has a screen layout; only crop can change`);
    }
    if (patch.crop !== undefined) {
      track.layout = {
        ...layout,
        crop: patch.crop === null ? null : clampRectToFrame(patch.crop, frame),
      };
    }
    return;
  }
  const canvas = draft.timeline.canvas;
  track.layout = mergeOverlayPatch(layout, patch, canvas, frame);
  if (track.layoutKeyframes) {
    setKeyframes(
      track,
      plain(track.layoutKeyframes).map((k) => ({
        ...k,
        layout: mergeOverlayPatch(k.layout, patch, canvas, frame),
      })),
    );
  }
}

/** Stores keyframes, dropping the field when there are none. */
function setKeyframes(track: VideoTrack, keys: LayoutKeyframe[] | undefined): void {
  if (keys && keys.length > 0) track.layoutKeyframes = keys;
  else delete track.layoutKeyframes;
}

function overlayTrack(draft: Project, trackId: string): VideoTrack & { layout: OverlayLayout } {
  const track = videoTrack(draft, trackId);
  if (track.layout.kind !== 'overlay') {
    fail('wrong-track-type', `track ${trackId} is not a face overlay track`);
  }
  return track as VideoTrack & { layout: OverlayLayout };
}

function requireTime(t: Us, name: string): void {
  if (!isTime(t)) fail('invalid-value', `${name} must be a time ≥ 0`);
}

function layoutKeyframeDraft(
  draft: Project,
  op: OpOf<'setLayoutKeyframe' | 'removeLayoutKeyframe' | 'moveLayoutKeyframe' | 'setFaceMode'>,
): void {
  const track = overlayTrack(draft, op.trackId);
  if (track.locked) fail('track-locked', `track ${track.name} is locked`);
  const keys = track.layoutKeyframes ? plain(track.layoutKeyframes) : undefined;
  const layout = plain(track.layout);
  switch (op.type) {
    case 'setLayoutKeyframe': {
      requireTime(op.tUs, 'the keyframe time');
      let next: OverlayLayout | undefined;
      if (op.layout) {
        checkCrop(op.layout);
        const base =
          keys?.find((k) => k.tUs === op.tUs)?.layout ?? faceStateAt(keys, layout, op.tUs).layout;
        next = mergeOverlayPatch(
          base,
          op.layout,
          draft.timeline.canvas,
          trackFrameSize(draft, track),
        );
      }
      setKeyframes(
        track,
        upsertKeyframe(keys, layout, op.tUs, {
          ...(op.mode ? { mode: op.mode } : {}),
          ...(next ? { layout: next } : {}),
          ...(op.easing ? { easing: op.easing } : {}),
        }),
      );
      return;
    }
    case 'removeLayoutKeyframe': {
      const next = removeKeyframe(keys, op.tUs);
      if (next === null) fail('nothing-to-do', `no layout keyframe at ${String(op.tUs)} µs`);
      setKeyframes(track, next);
      return;
    }
    case 'moveLayoutKeyframe': {
      requireTime(op.toUs, 'the keyframe time');
      const next = moveKeyframe(keys, op.fromUs, op.toUs);
      if (next === null) {
        fail(
          keys?.some((k) => k.tUs === op.fromUs) ? 'overlap' : 'nothing-to-do',
          keys?.some((k) => k.tUs === op.fromUs)
            ? `another layout keyframe is at ${String(op.toUs)} µs`
            : `no layout keyframe at ${String(op.fromUs)} µs`,
        );
      }
      setKeyframes(track, next);
      return;
    }
    case 'setFaceMode': {
      requireTime(op.startUs, 'the start');
      requireTime(op.endUs, 'the end');
      if (op.endUs <= op.startUs) fail('invalid-value', 'the face mode range needs start < end');
      const easeUs = op.easeUs ?? 0;
      if (!isTime(easeUs) || easeUs > FACE_EASE_MAX_US) {
        fail('invalid-value', `the change takes 0–${String(FACE_EASE_MAX_US / 1e6)} s`);
      }
      const ease = Math.min(easeUs, Math.floor((op.endUs - op.startUs) / 2));
      setKeyframes(track, faceModeSegment(keys, layout, op.startUs, op.endUs, op.mode, ease));
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Beautify and camera

const clampTo = (v: number, lo: number, hi: number, name: string) => {
  if (!Number.isFinite(v)) fail('invalid-value', `${name} must be a number`);
  return Math.min(hi, Math.max(lo, v));
};

function beautifyDraft(draft: Project, beautify: Beautify | null): void {
  if (beautify === null) {
    if (!draft.timeline.beautify) fail('nothing-to-do', 'the background is already plain');
    delete draft.timeline.beautify;
    return;
  }
  const background =
    beautify.background.type === 'gradient'
      ? {
          ...beautify.background,
          angleDeg: clampTo(beautify.background.angleDeg, 0, 360, 'the gradient angle'),
        }
      : beautify.background;
  const next: Beautify = {
    background,
    padding: clampTo(beautify.padding, 0, 0.3, 'padding'),
    cornerRadius: clampTo(beautify.cornerRadius, 0, 0.2, 'the corner radius'),
  };
  if (beautify.shadow) {
    const s = beautify.shadow;
    next.shadow = {
      blur: clampTo(s.blur, 0, 0.1, 'the shadow blur'),
      offsetX: clampTo(s.offsetX, -0.1, 0.1, 'the shadow offset'),
      offsetY: clampTo(s.offsetY, -0.1, 0.1, 'the shadow offset'),
      color: s.color,
    };
  }
  draft.timeline.beautify = next;
}

/** Stores camera keyframes, dropping the field when there are none. */
function setCamera(draft: Project, keys: CameraKeyframe[] | undefined): void {
  if (keys && keys.length > 0) draft.timeline.camera = keys;
  else delete draft.timeline.camera;
}

function cameraRectOf(rect: FRect): FRect {
  return clampCameraRect(rect) ?? fail('invalid-value', 'the camera rect must be a rectangle');
}

function cameraDraft(
  draft: Project,
  op: OpOf<'setCameraKeyframe' | 'removeCameraKeyframe' | 'moveCameraKeyframe' | 'setCameraZoom'>,
): void {
  const keys = draft.timeline.camera ? plain(draft.timeline.camera) : undefined;
  switch (op.type) {
    case 'setCameraKeyframe': {
      requireTime(op.tUs, 'the keyframe time');
      setCamera(
        draft,
        upsertCameraKeyframe(keys, op.tUs, {
          ...(op.rect ? { rect: cameraRectOf(op.rect) } : {}),
          ...(op.easing ? { easing: op.easing } : {}),
        }),
      );
      return;
    }
    case 'removeCameraKeyframe': {
      const next = removeKeyframe(keys, op.tUs);
      if (next === null) fail('nothing-to-do', `no camera keyframe at ${String(op.tUs)} µs`);
      setCamera(draft, next);
      return;
    }
    case 'moveCameraKeyframe': {
      requireTime(op.toUs, 'the keyframe time');
      const next = moveKeyframe(keys, op.fromUs, op.toUs);
      if (next === null) {
        const there = keys?.some((k) => k.tUs === op.fromUs);
        fail(
          there ? 'overlap' : 'nothing-to-do',
          there
            ? `another camera keyframe is at ${String(op.toUs)} µs`
            : `no camera keyframe at ${String(op.fromUs)} µs`,
        );
      }
      setCamera(draft, next);
      return;
    }
    case 'setCameraZoom': {
      requireTime(op.startUs, 'the start');
      requireTime(op.endUs, 'the end');
      if (op.endUs <= op.startUs) fail('invalid-value', 'the zoom range needs start < end');
      const easeUs = op.easeUs ?? 0;
      if (!isTime(easeUs) || easeUs > CAMERA_EASE_MAX_US) {
        fail('invalid-value', `the change takes 0–${String(CAMERA_EASE_MAX_US / 1e6)} s`);
      }
      const ease = Math.min(easeUs, Math.floor((op.endUs - op.startUs) / 2));
      setCamera(draft, cameraZoomRange(keys, op.startUs, op.endUs, cameraRectOf(op.rect), ease));
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Objects

const OBJECT_SCHEMAS = {
  text: TextObjectSchema,
  rectangle: ShapeObjectSchema,
  ellipse: ShapeObjectSchema,
  arrow: ArrowObjectSchema,
  step: StepObjectSchema,
  highlight: HighlightObjectSchema,
  spotlight: SpotlightObjectSchema,
  blur: BlurObjectSchema,
  pixelate: PixelateObjectSchema,
} as const;

/** Patch fields each kind has (besides the common times, box, opacity and fades). */
const KIND_FIELDS: Record<TimelineObject['kind'], readonly string[]> = {
  text: ['text', 'preset', 'style'],
  rectangle: ['stroke', 'fill'],
  ellipse: ['stroke', 'fill'],
  arrow: ['tail', 'stroke', 'head'],
  step: ['value', 'format', 'fill', 'textColor'],
  highlight: ['color'],
  spotlight: ['shape', 'dim'],
  blur: ['radius'],
  pixelate: ['blockSize'],
};
const COMMON_FIELDS = ['inUs', 'outUs', 'box', 'opacity', 'fadeInUs', 'fadeOutUs'];

/** The object checked against its kind's schema (sizes, colours, ranges). */
function checkedObject(item: TimelineObject, minUs: Us): TimelineObject {
  const parsed = OBJECT_SCHEMAS[item.kind].safeParse(item);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    fail(
      'invalid-value',
      `${item.kind} ${where ? `${where} ` : ''}${issue?.message ?? 'is invalid'}`,
    );
  }
  if (item.outUs - item.inUs < minUs) {
    fail('invalid-value', 'an object must last at least one frame');
  }
  return parsed.data;
}

/** Keyframes kept inside the object's times; undefined when none are left. */
function keyframesInside(item: TimelineObject): TimelineObject['keyframes'] {
  const keys = item.keyframes?.filter((k) => k.tUs >= item.inUs && k.tUs <= item.outUs);
  return keys && keys.length > 0 ? keys : undefined;
}

function withKeyframes(item: TimelineObject, keys: TimelineObject['keyframes']): TimelineObject {
  const { keyframes: _old, ...rest } = item;
  return keys && keys.length > 0 ? { ...rest, keyframes: keys } : rest;
}

/** `patch` applied to `item` (null removes a field; nested text style merges). */
function patchedObject(item: TimelineObject, patch: ObjectPatch): TimelineObject {
  const allowed = new Set([...COMMON_FIELDS, ...KIND_FIELDS[item.kind]]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) fail('invalid-value', `${key} does not apply to a ${item.kind}`);
  }
  // Undefined leaves a field as it is; null removes it (after the patch is merged over it).
  const merge = (base: object, change: object) =>
    Object.fromEntries(
      Object.entries({
        ...base,
        ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
      }).filter(([, v]) => v !== null),
    );
  const next = merge(item, {
    ...patch,
    ...(item.kind === 'text' && patch.style ? { style: merge(item.style, patch.style) } : {}),
  });
  const merged = next as TimelineObject;
  return withKeyframes(merged, keyframesInside(merged));
}

function findObject(
  draft: Project,
  objectId: string,
): { track: ObjectTrack; index: number; item: TimelineObject } {
  for (const track of draft.timeline.objectTracks ?? []) {
    const index = track.items.findIndex((i) => i.id === objectId);
    const item = track.items[index];
    if (item) {
      if (track.locked) fail('track-locked', `track ${track.name} is locked`);
      return { track, index, item: plain(item) };
    }
  }
  return fail('unknown-clip', `unknown object ${objectId}`);
}

/** An object after removing `[a, b)` from the timeline; none when it was inside. */
function objectThroughCut(item: TimelineObject, a: Us, b: Us, minUs: Us): TimelineObject[] {
  const inUs = mapTimeThroughCut(item.inUs, a, b);
  const outUs = mapTimeThroughCut(item.outUs, a, b);
  if (outUs - inUs < minUs) return [];
  const moved = { ...item, inUs, outUs };
  const keys = keyframesThroughCut(item.keyframes, a, b)?.filter(
    (k) => k.tUs >= inUs && k.tUs <= outUs,
  );
  return [withKeyframes(moved, keys)];
}

function objectDraft(
  draft: Project,
  op: OpOf<
    | 'addObject'
    | 'updateObject'
    | 'removeObjects'
    | 'moveObject'
    | 'setObjectKeyframe'
    | 'removeObjectKeyframe'
    | 'setObjectTrack'
  >,
  ctx: Ctx,
): void {
  switch (op.type) {
    case 'addObject': {
      // Check everything before making a track, so a refused add changes and uses up nothing.
      requireTime(op.item.inUs, 'the start');
      const item = checkedObject(plain(op.item), ctx.minUs);
      const existing = draft.timeline.objectTracks ?? [];
      if (existing.some((t) => t.items.some((i) => i.id === item.id))) {
        fail('invalid-value', `object ${item.id} already exists`);
      }
      let track = op.trackId ? existing.find((t) => t.id === op.trackId) : existing[0];
      if (op.trackId && !track) fail('unknown-track', `unknown object track ${op.trackId}`);
      if (track?.locked) fail('track-locked', `track ${track.name} is locked`);
      if (!track) {
        track = {
          id: ctx.id('track'),
          name: 'Annotations',
          locked: false,
          hidden: false,
          items: [],
        };
        (draft.timeline.objectTracks ??= []).push(track);
      }
      track.items.push(withKeyframes(item, keyframesInside(item)));
      return;
    }
    case 'updateObject': {
      const { track, index, item } = findObject(draft, op.objectId);
      track.items[index] = checkedObject(patchedObject(item, op.patch), ctx.minUs);
      return;
    }
    case 'removeObjects': {
      if (op.objectIds.length === 0) fail('nothing-to-do', 'no objects to remove');
      for (const id of new Set(op.objectIds)) {
        const { track, index } = findObject(draft, id);
        track.items.splice(index, 1);
      }
      return;
    }
    case 'moveObject': {
      requireTime(op.toInUs, 'the start');
      const { track, index, item } = findObject(draft, op.objectId);
      const delta = op.toInUs - item.inUs;
      if (delta === 0) return;
      track.items[index] = {
        ...item,
        inUs: item.inUs + delta,
        outUs: item.outUs + delta,
        ...(item.keyframes
          ? { keyframes: item.keyframes.map((k) => ({ ...k, tUs: k.tUs + delta })) }
          : {}),
      };
      return;
    }
    case 'setObjectKeyframe': {
      const { track, index, item } = findObject(draft, op.objectId);
      if (!isTime(op.tUs) || op.tUs < item.inUs || op.tUs > item.outUs) {
        fail('invalid-value', 'a box keyframe must be inside the object’s times');
      }
      const keys = upsertBoxKeyframe(item, op.tUs, {
        ...(op.box ? { box: op.box } : {}),
        ...(op.easing ? { easing: op.easing } : {}),
      });
      track.items[index] = checkedObject(withKeyframes(item, keys), ctx.minUs);
      return;
    }
    case 'removeObjectKeyframe': {
      const { track, index, item } = findObject(draft, op.objectId);
      const next = removeKeyframe(item.keyframes, op.tUs);
      if (next === null) fail('nothing-to-do', `no box keyframe at ${String(op.tUs)} µs`);
      track.items[index] = withKeyframes(item, next);
      return;
    }
    case 'setObjectTrack': {
      const track =
        draft.timeline.objectTracks?.find((t) => t.id === op.trackId) ??
        fail('unknown-track', `unknown object track ${op.trackId}`);
      if (op.hidden !== undefined) track.hidden = op.hidden;
      if (op.locked !== undefined) track.locked = op.locked;
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Speed, freeze frames, transitions, markers

/** Splits every clip group under `at` on unlocked tracks (none there is fine). */
function splitAllAt(draft: Project, at: Us, ctx: Ctx): void {
  const ids = clipsAt(draft, at).map((l) => l.clip.id);
  const groups = editGroups(draft, ids, true).filter((g) => g.every((m) => !m.track.locked));
  for (const group of groups) {
    const first = group[0]?.clip;
    if (!first) continue;
    const offset = at - first.timelineStartUs;
    if (offset < ctx.minUs || clipDurationUs(first) - offset < ctx.minUs) continue;
    const rightLink = first.linkId === null ? null : ctx.id('link');
    for (const { track, clip } of group) {
      const whole = plain(clip);
      const right: Clip = { ...clipTail(whole, at), id: ctx.id('clip'), linkId: rightLink };
      const index = track.clips.findIndex((c) => c.id === clip.id);
      track.clips.splice(index, 1, clipHead(whole, at), right);
    }
  }
}

/**
 * Moves every time on the timeline that follows the content through `map` (layout keyframes and
 * clips of unlocked tracks are the caller's): camera keyframes, objects on unlocked object
 * tracks, markers and the In/Out marks. `map` must keep the order of times.
 */
function remapTimes(draft: Project, map: (t: Us) => Us, minUs: Us): void {
  for (const track of draft.timeline.tracks) {
    if (track.locked || track.type !== 'audio' || !track.volumeKeyframes) continue;
    setVolumeKeys(
      track,
      dedupeTimes(plain(track.volumeKeyframes).map((k) => ({ ...k, tUs: map(k.tUs) }))),
    );
  }
  for (const track of draft.timeline.tracks) {
    if (track.locked || track.type !== 'video' || !track.layoutKeyframes) continue;
    setKeyframes(
      track,
      dedupeTimes(plain(track.layoutKeyframes).map((k) => ({ ...k, tUs: map(k.tUs) }))),
    );
  }
  if (draft.timeline.camera) {
    setCamera(
      draft,
      dedupeTimes(plain(draft.timeline.camera).map((k) => ({ ...k, tUs: map(k.tUs) }))),
    );
  }
  for (const track of draft.timeline.objectTracks ?? []) {
    if (track.locked) continue;
    track.items = plain(track.items).flatMap((item) => {
      const inUs = map(item.inUs);
      const outUs = map(item.outUs);
      if (outUs - inUs < minUs) return [];
      const keys = item.keyframes
        ? dedupeTimes(item.keyframes.map((k) => ({ ...k, tUs: map(k.tUs) })))
        : undefined;
      return [withKeyframes({ ...item, inUs, outUs }, keys)];
    });
  }
  if (draft.timeline.markers) {
    setMarkers(
      draft,
      plain(draft.timeline.markers).map((m) => ({ ...m, tUs: map(m.tUs) })),
    );
  }
  const marks = draft.timeline.marks;
  if (marks.inUs !== null) marks.inUs = map(marks.inUs);
  if (marks.outUs !== null) marks.outUs = map(marks.outUs);
}

/** Keyframes with distinct times (a squeezed range can bring two onto one; the later wins). */
function dedupeTimes<K extends { tUs: Us }>(keys: K[]): K[] {
  const out: K[] = [];
  for (const key of keys) {
    if (out.length > 0 && out[out.length - 1]?.tUs === key.tUs) out[out.length - 1] = key;
    else out.push(key);
  }
  return out;
}

function speedDraft(draft: Project, op: OpOf<'setSpeed'>, ctx: Ctx): void {
  const { inUs: a, outUs: b, speed } = op;
  if (!isTime(a) || !isTime(b) || b <= a) fail('invalid-value', 'the range needs 0 ≤ in < out');
  if (!Number.isFinite(speed) || speed < SPEED_MIN || speed > SPEED_MAX) {
    fail('invalid-value', `speed must be ${String(SPEED_MIN)}–${String(SPEED_MAX)}×`);
  }
  splitAllAt(draft, a, ctx);
  splitAllAt(draft, b, ctx);
  const tracks = draft.timeline.tracks.filter((t) => !t.locked);
  let old: number | null = null;
  for (const track of tracks) {
    for (const clip of track.clips) {
      const end = clipEndUs(clip);
      if (end <= a || clip.timelineStartUs >= b) continue;
      if (clip.timelineStartUs < a || end > b) {
        fail(
          'invalid-value',
          'a clip edge is less than a frame from the range edge; widen the range',
        );
      }
      if (clip.freeze) continue;
      const s = clip.speed ?? 1;
      if (old !== null && Math.abs(s - old) > 1e-9) {
        fail('invalid-value', 'the range has clips at different speeds; change them one at a time');
      }
      old = s;
    }
  }
  if (old === null) fail('nothing-to-do', 'no clip in the range');
  if (Math.abs(old - speed) < 1e-9)
    fail('nothing-to-do', `the range already plays at ${String(speed)}×`);
  const k = old / speed;
  const newLength = Math.round((b - a) * k);
  const map = (t: Us): Us =>
    t <= a ? t : t >= b ? t + newLength - (b - a) : a + Math.round((t - a) * k);
  for (const track of tracks) {
    track.clips = plain(track.clips).map((clip) => {
      const start = clip.timelineStartUs;
      const end = clipEndUs(clip);
      if (end <= a) return clip;
      if (start >= b) return { ...clip, timelineStartUs: map(start) };
      const newStart = map(start);
      let duration = map(end) - newStart;
      if (clip.freeze) return { ...clip, timelineStartUs: newStart, durationUs: duration };
      const available = clip.sourceEndUs - clip.sourceStartUs;
      let source = Math.round(duration * speed);
      if (source > available) {
        // Rounding asked for a few µs more than the clip has: end it that much earlier.
        source = available;
        duration = Math.max(1, Math.round(source / speed));
      }
      const { speed: _s, durationUs: _d, ...rest } = clip;
      const next: Clip = {
        ...rest,
        timelineStartUs: newStart,
        sourceEndUs: clip.sourceStartUs + source,
      };
      return fitTransition(
        speed === 1
          ? { ...next, sourceEndUs: clip.sourceStartUs + duration }
          : { ...next, speed, durationUs: duration },
        duration,
      );
    });
  }
  for (const track of tracks) {
    if (track.clips.some((c) => clipEndUs(c) - c.timelineStartUs < ctx.minUs)) {
      fail('invalid-value', `at ${String(speed)}× a clip would be shorter than one frame`);
    }
  }
  remapTimes(draft, map, ctx.minUs);
  normalizeLinks(draft);
}

function freezeDraft(draft: Project, op: OpOf<'freezeFrame'>, ctx: Ctx): void {
  const { durationUs: d } = op;
  if (!isTime(op.atUs)) fail('invalid-value', 'the freeze time must be ≥ 0');
  if (!isTime(d) || d < ctx.minUs) fail('invalid-value', 'a freeze frame lasts at least one frame');
  // Less than a frame from a clip edge (where clips are not split): freeze at that edge.
  let at = op.atUs;
  for (const track of draft.timeline.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips) {
      const start = clip.timelineStartUs;
      const end = clipEndUs(clip);
      if (at <= start || at >= end) continue;
      if (at - start < ctx.minUs) at = start;
      else if (end - at < ctx.minUs) at = end;
    }
  }
  for (const track of draft.timeline.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips) {
      const start = clip.timelineStartUs;
      const end = clipEndUs(clip);
      if (at > start && at < end && (at - start < ctx.minUs || end - at < ctx.minUs)) {
        fail('invalid-value', 'clip edges on different tracks are too close to freeze here');
      }
    }
  }
  // What each unlocked video track shows at `at`, before anything moves.
  const stills = new Map<string, Clip>();
  for (const track of draft.timeline.tracks) {
    if (track.locked || track.type !== 'video') continue;
    // The clip under `at`, or the one ending there (freezing at a clip's end holds its last frame).
    const clip =
      track.clips.find((c) => c.timelineStartUs <= at && at < clipEndUs(c)) ??
      track.clips.find((c) => clipEndUs(c) === at);
    if (!clip) continue;
    const ref = clip.freeze
      ? clip.sourceStartUs
      : Math.min(clipRefAt(clip, at), clip.sourceEndUs - ctx.minUs);
    stills.set(track.id, {
      id: ctx.id('clip'),
      mediaId: clip.mediaId,
      timelineStartUs: at,
      sourceStartUs: ref,
      sourceEndUs: ref + ctx.minUs,
      linkId: null,
      freeze: true,
      durationUs: d,
    });
  }
  if (stills.size === 0) fail('nothing-to-do', 'no picture to freeze at this time');
  splitAllAt(draft, at, ctx);
  // A linked group with a member on a locked track is not split: it cannot open a gap.
  for (const track of draft.timeline.tracks) {
    if (track.locked) continue;
    if (track.clips.some((c) => c.timelineStartUs < at && clipEndUs(c) > at)) {
      fail('track-locked', 'a clip here is linked to a clip on a locked track');
    }
  }
  for (const track of draft.timeline.tracks) {
    if (track.locked) continue;
    const moved = plain(track.clips).map((c) =>
      c.timelineStartUs >= at ? { ...c, timelineStartUs: c.timelineStartUs + d } : c,
    );
    const still = stills.get(track.id);
    if (still) moved.push(still);
    track.clips = moved.sort((x, y) => x.timelineStartUs - y.timelineStartUs);
  }
  // Later times move by the freeze's length; an object showing at `at` (its end moves, its start
  // does not) stays through it.
  remapTimes(draft, (t) => (t < at ? t : t + d), ctx.minUs);
  normalizeLinks(draft);
}

function transitionDraft(draft: Project, op: OpOf<'setTransition'>): void {
  const { track, clip } = requireClip(draft, op.clipId);
  if (track.locked) fail('track-locked', `track ${track.name} is locked`);
  if (track.type !== 'video') fail('wrong-track-type', 'transitions are for video clips');
  const index = track.clips.findIndex((c) => c.id === clip.id);
  const target = track.clips[index] ?? fail('unknown-clip', `unknown clip ${op.clipId}`);
  if (op.transition === null) {
    if (!target.transitionIn) fail('nothing-to-do', 'the clip has no transition');
    delete target.transitionIn;
    return;
  }
  const t = op.transition;
  if (!isTime(t.durationUs) || t.durationUs <= 0) {
    fail('invalid-value', 'a transition lasts a positive time');
  }
  if (t.durationUs > clipDurationUs(target)) {
    fail('invalid-value', 'a transition cannot be longer than its clip');
  }
  if (t.color !== undefined && !/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(t.color)) {
    fail('invalid-value', 'the colour must be #RRGGBB');
  }
  target.transitionIn = plain(t);
}

/**
 * Stores markers sorted by time, dropping the field when there are none. Markers an edit brought
 * onto one time (a cut, a squeezed range) keep the first.
 */
function setMarkers(draft: Project, markers: Marker[]): void {
  const sorted = [...markers].sort((a, b) => a.tUs - b.tUs);
  const unique = sorted.filter((m, i) => i === 0 || sorted[i - 1]?.tUs !== m.tUs);
  if (unique.length > 0) draft.timeline.markers = unique;
  else delete draft.timeline.markers;
}

function markerDraft(
  draft: Project,
  op: OpOf<'addMarker' | 'updateMarker' | 'removeMarker'>,
): void {
  // A copy: `plain` may return the previous document's frozen array.
  const markers = [...(draft.timeline.markers ? plain(draft.timeline.markers) : [])];
  const checkLabel = (label: string) => {
    if (label.length > 200) fail('invalid-value', 'a marker label has at most 200 characters');
  };
  switch (op.type) {
    case 'addMarker': {
      requireTime(op.marker.tUs, 'the marker time');
      checkLabel(op.marker.label);
      if (markers.some((m) => m.id === op.marker.id)) {
        fail('invalid-value', `marker ${op.marker.id} already exists`);
      }
      if (markers.some((m) => m.tUs === op.marker.tUs)) {
        fail('overlap', 'another marker is at this time');
      }
      setMarkers(draft, [...markers, plain(op.marker)]);
      return;
    }
    case 'updateMarker': {
      const index = markers.findIndex((m) => m.id === op.markerId);
      const marker = markers[index] ?? fail('unknown-clip', `unknown marker ${op.markerId}`);
      if (op.tUs !== undefined) {
        requireTime(op.tUs, 'the marker time');
        if (markers.some((m) => m.tUs === op.tUs && m.id !== op.markerId)) {
          fail('overlap', 'another marker is at this time');
        }
      }
      if (op.label !== undefined) checkLabel(op.label);
      markers[index] = {
        ...marker,
        ...(op.tUs !== undefined ? { tUs: op.tUs } : {}),
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...(op.chapter !== undefined ? { chapter: op.chapter } : {}),
      };
      setMarkers(draft, markers);
      return;
    }
    case 'removeMarker': {
      if (!markers.some((m) => m.id === op.markerId)) {
        fail('unknown-clip', `unknown marker ${op.markerId}`);
      }
      setMarkers(
        draft,
        markers.filter((m) => m.id !== op.markerId),
      );
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Audio: clip gain and fades, volume keyframes, cleanup

/** Stores volume keyframes, dropping the field when there are none. */
function setVolumeKeys(track: AudioTrack, keys: VolumeKeyframe[] | undefined): void {
  if (keys && keys.length > 0) track.volumeKeyframes = keys;
  else delete track.volumeKeyframes;
}

function checkGainDb(gainDb: number): number {
  if (!Number.isFinite(gainDb)) fail('invalid-value', 'gain must be a number');
  return Math.min(
    GAIN_MAX_DB,
    Math.max(GAIN_MIN_DB, Math.round(gainDb / GAIN_STEP_DB) * GAIN_STEP_DB),
  );
}

function clipAudioDraft(draft: Project, op: OpOf<'setClipAudio'>): void {
  if (op.clipIds.length === 0) fail('nothing-to-do', 'no clips');
  for (const id of new Set(op.clipIds)) {
    const { track, clip } = requireClip(draft, id);
    if (track.locked) fail('track-locked', `track ${track.name} is locked`);
    if (track.type !== 'audio') fail('wrong-track-type', 'gain and fades are for audio clips');
    const length = clipDurationUs(clip);
    if (op.gainDb === null || op.gainDb === 0) delete clip.gainDb;
    else if (op.gainDb !== undefined) clip.gainDb = checkGainDb(op.gainDb);
    const fade = (value: Us | null | undefined): Us | null | undefined => {
      if (value === undefined || value === null || value === 0) return value === 0 ? null : value;
      if (!isTime(value)) fail('invalid-value', 'a fade lasts a time ≥ 0');
      return Math.min(value, length);
    };
    const fadeIn = fade(op.fadeInUs);
    if (fadeIn === null) delete clip.fadeInUs;
    else if (fadeIn !== undefined) clip.fadeInUs = fadeIn;
    const fadeOut = fade(op.fadeOutUs);
    if (fadeOut === null) delete clip.fadeOutUs;
    else if (fadeOut !== undefined) clip.fadeOutUs = fadeOut;
  }
}

function volumeDraft(
  draft: Project,
  op: OpOf<'setVolumeKeyframe' | 'removeVolumeKeyframe' | 'moveVolumeKeyframe'>,
): void {
  const track = audioTrack(draft, op.trackId);
  if (track.locked) fail('track-locked', `track ${track.name} is locked`);
  const keys = track.volumeKeyframes ? plain(track.volumeKeyframes) : undefined;
  switch (op.type) {
    case 'setVolumeKeyframe':
      requireTime(op.tUs, 'the keyframe time');
      setVolumeKeys(
        track,
        upsertVolumeKeyframe(keys, op.tUs, {
          ...(op.gainDb !== undefined ? { gainDb: checkGainDb(op.gainDb) } : {}),
          ...(op.easing ? { easing: op.easing } : {}),
        }),
      );
      return;
    case 'removeVolumeKeyframe': {
      const next = removeKeyframe(keys, op.tUs);
      if (next === null) fail('nothing-to-do', `no volume keyframe at ${String(op.tUs)} µs`);
      setVolumeKeys(track, next);
      return;
    }
    case 'moveVolumeKeyframe': {
      requireTime(op.toUs, 'the keyframe time');
      const next = moveKeyframe(keys, op.fromUs, op.toUs);
      if (next === null) {
        const there = keys?.some((k) => k.tUs === op.fromUs);
        fail(
          there ? 'overlap' : 'nothing-to-do',
          there
            ? `another volume keyframe is at ${String(op.toUs)} µs`
            : `no volume keyframe at ${String(op.fromUs)} µs`,
        );
      }
      setVolumeKeys(track, next);
      return;
    }
  }
}

function cleanupDraft(draft: Project, op: OpOf<'setCleanup'>): void {
  const track = audioTrack(draft, op.trackId);
  if (track.locked) fail('track-locked', `track ${track.name} is locked`);
  const current: Cleanup = track.cleanup
    ? plain(track.cleanup)
    : { noise: 'off', normalize: false };
  const next: Cleanup = { ...current };
  if (op.cleanup.noise !== undefined) next.noise = op.cleanup.noise;
  if (op.cleanup.normalize !== undefined) next.normalize = op.cleanup.normalize;
  if (op.cleanup.duck === null) delete next.duck;
  else if (op.cleanup.duck !== undefined) {
    const d = op.cleanup.duck;
    const by = audioTrack(draft, d.byTrackId);
    if (by.id === track.id) fail('invalid-value', 'a track cannot duck under itself');
    next.duck = {
      byTrackId: d.byTrackId,
      amountDb: clampTo(d.amountDb, -40, 0, 'the ducking amount'),
      attackMs: Math.round(clampTo(d.attackMs, 1, 2000, 'the attack')),
      releaseMs: Math.round(clampTo(d.releaseMs, 1, 5000, 'the release')),
    };
  }
  if (next.noise === 'off' && !next.normalize && !next.duck) delete track.cleanup;
  else track.cleanup = next;
}

// ---------------------------------------------------------------------------------------------
// Adding media

function addMediaDraft(draft: Project, op: OpOf<'addMedia'>, ctx: Ctx): void {
  requireTime(op.atUs, 'the start');
  if (op.tracks.length === 0) fail('nothing-to-do', 'nothing to add');
  const known = new Set(draft.media.map((m) => m.id));
  for (const m of op.media) {
    if (known.has(m.id)) fail('invalid-value', `media ${m.id} already exists`);
    known.add(m.id);
  }
  for (const track of op.tracks) {
    for (const clip of track.clips) {
      if (!known.has(clip.mediaId)) fail('unknown-media', `unknown media ${clip.mediaId}`);
      if (clipDurationUs(clip) < ctx.minUs) {
        fail('invalid-value', 'that media is shorter than one frame of the timeline');
      }
    }
  }
  draft.media.push(...op.media.map((m) => plain(m)));
  // New IDs: the same link in the given tracks stays one link.
  const links = new Map<string, string>();
  const linkFor = (id: string | null): string | null => {
    if (id === null) return null;
    const known = links.get(id) ?? ctx.id('link');
    links.set(id, known);
    return known;
  };
  const placed = op.tracks.map((track): Track => {
    const clips = track.clips.map((clip) => ({
      ...plain(clip),
      id: ctx.id('clip'),
      timelineStartUs: clip.timelineStartUs + op.atUs,
      linkId: linkFor(clip.linkId),
    }));
    return { ...plain(track), id: ctx.id('track'), componentId: null, clips };
  });
  const tracks = draft.timeline.tracks;
  const screenIndex = tracks.findIndex((t) => t.type === 'video' && t.layout.kind === 'screen');
  const video = placed.filter((t) => t.type === 'video');
  const audio = placed.filter((t) => t.type === 'audio');
  tracks.splice(screenIndex + 1, 0, ...video);
  tracks.push(...audio);
  normalizeLinks(draft);
}

function nudgeDraft(draft: Project, op: OpOf<'nudge'>): void {
  if (!Number.isFinite(op.syncAdjustUs)) fail('invalid-value', 'nudge must be a number');
  let mediaIds: string[];
  if ('componentId' in op.target) {
    const id = op.target.componentId;
    const component =
      draft.components.find((c) => c.id === id) ?? fail('unknown-media', `unknown component ${id}`);
    mediaIds = [...component.mediaIds];
  } else {
    mediaIds = [...op.target.mediaIds];
  }
  const value = Math.min(NUDGE_MAX_US, Math.max(-NUDGE_MAX_US, Math.round(op.syncAdjustUs)));
  // Non-destructive (R1.42): clips keep their positions and source ranges.
  for (const id of mediaIds) requireMedia(draft, id).syncAdjustUs = value;
}

function relinkDraft(draft: Project, clipIds: readonly string[], ctx: Ctx): void {
  const locs = [...new Set(clipIds)].map((id) => requireClip(draft, id));
  if (locs.length < 2) fail('cannot-link', 'select at least two clips to link');
  assertUnlocked(locs);
  const first = locs[0]?.clip ?? fail('cannot-link', 'select at least two clips to link');
  const tracks = new Set<number>();
  for (const { trackIndex, clip } of locs) {
    if (tracks.has(trackIndex)) fail('cannot-link', 'linked clips must be on different tracks');
    tracks.add(trackIndex);
    if (
      clip.timelineStartUs !== first.timelineStartUs ||
      clipDurationUs(clip) !== clipDurationUs(first)
    ) {
      fail('cannot-link', 'linked clips must start together and have the same length');
    }
    if (
      clipSourceDurationUs(clip) !== clipSourceDurationUs(first) ||
      (clip.freeze ?? false) !== (first.freeze ?? false) ||
      (clip.speed ?? 1) !== (first.speed ?? 1)
    ) {
      fail('cannot-link', 'linked clips must play at the same speed');
    }
  }
  const linkId = ctx.id('link');
  for (const { clip } of locs) clip.linkId = linkId;
  normalizeLinks(draft);
}
