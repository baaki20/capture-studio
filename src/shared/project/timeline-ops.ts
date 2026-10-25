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
 *   placed: `refUs = sourceStartUs + (tUs − timelineStartUs)`.
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
import { mediaEditBounds } from './media-time';
import type {
  AudioTrack,
  Clip,
  Media,
  NRect,
  OverlayLayout,
  ProjectV1,
  Track,
  VideoTrack,
} from './schema';

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

export type OpResult = Result<ProjectV1, OpError>;

export interface OpOptions {
  /** ULID source for new clip and link IDs (inject for deterministic tests). */
  generateId?: () => string;
}

/** Fields of an overlay or screen layout that `setLayout` may change. */
export type LayoutPatch = Partial<Omit<OverlayLayout, 'kind'>>;

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
  | { type: 'nudge'; target: NudgeTarget; syncAdjustUs: Us }
  | { type: 'unlink'; clipIds: string[] }
  | { type: 'relink'; clipIds: string[] }
  | { type: 'setMarks'; inUs: Us | null; outUs: Us | null }
  | { type: 'replaceDocument'; doc: ProjectV1 };

export type TimelineOpType = TimelineOp['type'];
type OpOf<T extends TimelineOpType> = Extract<TimelineOp, { type: T }>;
type OpArgs<T extends TimelineOpType> = Omit<OpOf<T>, 'type'>;

export interface PatchedResult {
  doc: ProjectV1;
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

export function clipDurationUs(clip: Pick<Clip, 'sourceStartUs' | 'sourceEndUs'>): Us {
  return clip.sourceEndUs - clip.sourceStartUs;
}

export function clipEndUs(clip: Clip): Us {
  return clip.timelineStartUs + clipDurationUs(clip);
}

/** The timeline's length: the latest clip end on any track (0 when empty). */
export function timelineDurationUs(doc: ProjectV1): Us {
  let end = 0;
  for (const track of doc.timeline.tracks)
    for (const c of track.clips) end = Math.max(end, clipEndUs(c));
  return end;
}

export function findTrack(doc: ProjectV1, trackId: string): Track | null {
  return doc.timeline.tracks.find((t) => t.id === trackId) ?? null;
}

export function findClip(doc: ProjectV1, clipId: string): ClipLocation | null {
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
export function linkedClips(doc: ProjectV1, clipId: string): ClipLocation[] {
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
export function clipsAt(doc: ProjectV1, tUs: Us): ClipLocation[] {
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
  return clip ? clip.sourceStartUs + (tUs - clip.timelineStartUs) : null;
}

/**
 * Snap targets for dragging (R1.39): 0, the playhead, the marks and every clip edge except those
 * of `excludeClipIds` (the clips being dragged). Sorted and deduplicated.
 */
export function snapPoints(
  doc: ProjectV1,
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
export function trackFrameSize(doc: ProjectV1, track: VideoTrack): Size {
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
export function applyOpWithPatches(
  doc: ProjectV1,
  op: TimelineOp,
  options: OpOptions = {},
): Result<PatchedResult, OpError> {
  const generate = options.generateId ?? ulid;
  const ctx: Ctx = {
    id: (kind) => newId(kind, generate),
    minUs: frameDurationUs(doc.timeline.frameRate),
  };
  try {
    const [next, patches, inversePatches] = produceWithPatches(doc, (draft) => {
      if (op.type === 'replaceDocument') return op.doc;
      runOp(draft, op, ctx);
      return undefined;
    });
    if (patches.length === 0) return ok({ doc, patches: [], inversePatches: [] });
    const violations = checkProjectInvariants(next);
    if (violations.length > 0) {
      return err({
        code: 'invariant',
        message: `${op.type} would break an invariant: ${violations.map((v) => v.message).join('; ')}`,
      });
    }
    return ok({ doc: next, patches, inversePatches });
  } catch (error) {
    if (error instanceof OpFailure) return err(error.opError);
    throw error;
  }
}

/** Applies an operation and returns the new document. */
export function applyOp(doc: ProjectV1, op: TimelineOp, options: OpOptions = {}): OpResult {
  const result = applyOpWithPatches(doc, op, options);
  return result.ok ? ok(result.value.doc) : result;
}

function opFn<T extends TimelineOpType>(type: T) {
  return (doc: ProjectV1, args: OpArgs<T>, options?: OpOptions): OpResult =>
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
/** Changes a video track's layout (face overlay geometry, or the screen crop); clamped. */
export const setLayout = opFn('setLayout');
/** Sets `syncAdjustUs` of a component's (or explicit) media; clip positions do not change. */
export const nudge = opFn('nudge');
export const unlink = opFn('unlink');
export const relink = opFn('relink');
export const setMarks = opFn('setMarks');

function runOp(draft: ProjectV1, op: TimelineOp, ctx: Ctx): void {
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

function requireTrack(draft: ProjectV1, trackId: string): Track {
  return findTrack(draft, trackId) ?? fail('unknown-track', `unknown track ${trackId}`);
}

function audioTrack(draft: ProjectV1, trackId: string): AudioTrack {
  const track = requireTrack(draft, trackId);
  if (track.type !== 'audio') fail('wrong-track-type', `track ${trackId} is not an audio track`);
  return track;
}

function videoTrack(draft: ProjectV1, trackId: string): VideoTrack {
  const track = requireTrack(draft, trackId);
  if (track.type !== 'video') fail('wrong-track-type', `track ${trackId} is not a video track`);
  return track;
}

function requireClip(draft: ProjectV1, clipId: string): ClipLocation {
  return findClip(draft, clipId) ?? fail('unknown-clip', `unknown clip ${clipId}`);
}

function requireMedia(draft: ProjectV1, mediaId: string): Media {
  return (
    draft.media.find((m) => m.id === mediaId) ?? fail('unknown-media', `unknown media ${mediaId}`)
  );
}

/** Plain (non-draft) copy of a value read from a draft. */
function plain<T extends object>(value: T): T {
  return isDraft(value) ? current<T>(value as Draft<T>) : value;
}

function dissolveLink(draft: ProjectV1, linkId: string): void {
  for (const track of draft.timeline.tracks) {
    for (const clip of track.clips) if (clip.linkId === linkId) clip.linkId = null;
  }
}

/** Clears link IDs that only one clip still carries. */
function normalizeLinks(draft: ProjectV1): void {
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
function editGroup(draft: ProjectV1, clipId: string, includeLinked: boolean): ClipLocation[] {
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
  draft: ProjectV1,
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

function splitDraft(draft: ProjectV1, op: OpOf<'split'>, ctx: Ctx): void {
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
      const right: Clip = {
        id: ctx.id('clip'),
        mediaId: clip.mediaId,
        timelineStartUs: at,
        sourceStartUs: clip.sourceStartUs + offset,
        sourceEndUs: clip.sourceEndUs,
        linkId: rightLink,
      };
      clip.sourceEndUs = clip.sourceStartUs + offset;
      const index = track.clips.findIndex((c) => c.id === clip.id);
      track.clips.splice(index + 1, 0, right);
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

function trimDraft(draft: ProjectV1, op: OpOf<'trim'>, ctx: Ctx): void {
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
      hi = Math.min(hi, start + (bounds.endUs - clip.sourceStartUs));
      const { next } = neighbours(track, clip.id);
      if (next) hi = Math.min(hi, next.timelineStartUs);
    }
    const lo = start + ctx.minUs;
    const newEnd = Math.min(Math.max(op.toUs, lo), Math.max(lo, hi));
    if (newEnd === end) return;
    for (const { clip } of group) clip.sourceEndUs = clip.sourceStartUs + (newEnd - start);
    return;
  }

  let lo = 0;
  for (const { track, clip } of group) {
    const bounds = mediaEditBounds(requireMedia(draft, clip.mediaId));
    lo = Math.max(lo, start - (clip.sourceStartUs - bounds.startUs));
    const { prev } = neighbours(track, clip.id);
    if (prev) lo = Math.max(lo, clipEndUs(prev));
  }
  const hi = end - ctx.minUs;
  const newStart = Math.max(Math.min(op.toUs, hi), Math.min(lo, hi));
  const delta = newStart - start;
  if (delta === 0) return;
  for (const { clip } of group) {
    clip.timelineStartUs = newStart;
    clip.sourceStartUs += delta;
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

function moveDraft(draft: ProjectV1, op: OpOf<'move'>): void {
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

function removeClips(draft: ProjectV1, ids: ReadonlySet<string>): void {
  for (const track of draft.timeline.tracks) {
    if (track.clips.some((c) => ids.has(c.id))) {
      track.clips = track.clips.filter((c) => !ids.has(c.id));
    }
  }
}

function deleteDraft(draft: ProjectV1, op: OpOf<'delete'>): void {
  const groups = editGroups(draft, op.clipIds, op.includeLinked ?? true);
  if (groups.length === 0) fail('nothing-to-do', 'no clips selected');
  for (const group of groups) assertUnlocked(group);
  removeClips(draft, new Set(groups.flat().map((m) => m.clip.id)));
  normalizeLinks(draft);
}

function rippleDeleteDraft(draft: ProjectV1, op: OpOf<'rippleDelete'>, ctx: Ctx): void {
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

function cutDraft(draft: ProjectV1, a: Us, b: Us, ctx: Ctx): void {
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
          const left = { ...clip, sourceEndUs: clip.sourceStartUs + (a - s) };
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
            ...clip,
            id: s < a ? ctx.id('clip') : clip.id,
            timelineStartUs: a,
            sourceStartUs: clip.sourceStartUs + (b - s),
            linkId,
          };
          if (clipDurationUs(right) >= ctx.minUs) out.push(right);
        }
      }
    }
    track.clips = out;
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

function layoutDraft(draft: ProjectV1, trackId: string, patch: LayoutPatch): void {
  const track = videoTrack(draft, trackId);
  const frame = trackFrameSize(draft, track);
  const layout = plain(track.layout);
  if (patch.crop !== undefined && patch.crop !== null) {
    const { x, y, width, height } = patch.crop;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      fail('invalid-value', 'crop must be a rectangle with a positive size');
    }
  }
  const crop: NRect | null | undefined =
    patch.crop === undefined || patch.crop === null
      ? patch.crop
      : clampRectToFrame(patch.crop, frame);

  if (layout.kind === 'screen') {
    if (OVERLAY_ONLY_KEYS.some((k) => patch[k] !== undefined)) {
      fail('wrong-track-type', `track ${trackId} has a screen layout; only crop can change`);
    }
    if (crop !== undefined) track.layout = { ...layout, crop };
    return;
  }
  for (const k of ['centerX', 'centerY', 'width', 'cornerRadius'] as const) {
    const v = patch[k];
    if (v !== undefined && !Number.isFinite(v)) fail('invalid-value', `${k} must be a number`);
  }
  const merged: OverlayLayout = {
    ...layout,
    ...patch,
    kind: 'overlay',
    crop: crop === undefined ? layout.crop : crop,
  };
  track.layout = clampOverlayLayout(merged, draft.timeline.canvas, frame);
}

function nudgeDraft(draft: ProjectV1, op: OpOf<'nudge'>): void {
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

function relinkDraft(draft: ProjectV1, clipIds: readonly string[], ctx: Ctx): void {
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
  }
  const linkId = ctx.id('link');
  for (const { clip } of locs) clip.linkId = linkId;
  normalizeLinks(draft);
}
