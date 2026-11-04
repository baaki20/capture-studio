/**
 * Zod schema for `TimelineOp`, for edits that arrive from outside the editor (the automation
 * socket that the MCP server talks to). Values are checked for shape only: ranges are left to the
 * operations, which clamp or reject them exactly as they do for the UI.
 *
 * `replaceDocument` is deliberately absent, so automation can never swap in a whole document and
 * every edit passes the same per-operation checks as a user's.
 */
import { z } from 'zod';
import {
  BeautifySchema,
  BorderSchema,
  EASINGS,
  FACE_MODES,
  NRectSchema,
  ShadowSchema,
  prefixedId,
} from './schema';
import type { TimelineOp } from './timeline-ops';

/** A `TimelineOp` that automation may send. */
export type ExternalOp = Exclude<TimelineOp, { type: 'replaceDocument' }>;

const Us = z.int();
const NonNegativeUs = z.int().nonnegative();
const ClipId = prefixedId('clp');
const ClipIds = z.array(ClipId).min(1);
const TrackId = prefixedId('trk');

const LayoutPatchSchema = z.strictObject({
  centerX: z.number().optional(),
  centerY: z.number().optional(),
  width: z.number().optional(),
  shape: z.enum(['rectangle', 'rounded', 'circle']).optional(),
  cornerRadius: z.number().optional(),
  mirror: z.boolean().optional(),
  crop: NRectSchema.nullable().optional(),
  zoom: z.number().optional(),
  border: BorderSchema.nullable().optional().describe('null removes the border'),
  shadow: ShadowSchema.nullable().optional().describe('null removes the shadow'),
});
const FaceMode = z.enum(FACE_MODES);
/** A camera rect in canvas fractions; the operations clamp it inside the canvas. */
const CameraRect = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
const Easing = z.enum(EASINGS);

const NudgeTargetSchema = z.union([
  z.strictObject({ componentId: prefixedId('cmp') }),
  z.strictObject({ mediaIds: z.array(prefixedId('med')).min(1) }),
]);

export const TimelineOpSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('split'),
    atUs: NonNegativeUs,
    clipIds: ClipIds.optional(),
    includeLinked: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('trim'),
    clipId: ClipId,
    edge: z.enum(['start', 'end']),
    toUs: Us,
    includeLinked: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('move'),
    clipId: ClipId,
    toStartUs: Us,
    includeLinked: z.boolean().optional(),
    onOverlap: z.enum(['nearest-free', 'refuse']).optional(),
  }),
  z.strictObject({
    type: z.literal('delete'),
    clipIds: ClipIds,
    includeLinked: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('rippleDelete'),
    clipIds: ClipIds,
    includeLinked: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('cutRange'), inUs: NonNegativeUs, outUs: NonNegativeUs }),
  z.strictObject({ type: z.literal('setGain'), trackId: TrackId, gainDb: z.number() }),
  z.strictObject({ type: z.literal('setMuted'), trackId: TrackId, muted: z.boolean() }),
  z.strictObject({ type: z.literal('setSolo'), trackId: TrackId, solo: z.boolean() }),
  z.strictObject({ type: z.literal('setHidden'), trackId: TrackId, hidden: z.boolean() }),
  z.strictObject({ type: z.literal('setLocked'), trackId: TrackId, locked: z.boolean() }),
  z.strictObject({ type: z.literal('setLayout'), trackId: TrackId, layout: LayoutPatchSchema }),
  z.strictObject({
    type: z.literal('setLayoutKeyframe'),
    trackId: TrackId,
    tUs: NonNegativeUs,
    mode: FaceMode.optional(),
    layout: LayoutPatchSchema.optional(),
    easing: Easing.optional(),
  }),
  z.strictObject({ type: z.literal('removeLayoutKeyframe'), trackId: TrackId, tUs: NonNegativeUs }),
  z.strictObject({
    type: z.literal('moveLayoutKeyframe'),
    trackId: TrackId,
    fromUs: NonNegativeUs,
    toUs: NonNegativeUs,
  }),
  z.strictObject({
    type: z.literal('setFaceMode'),
    trackId: TrackId,
    startUs: NonNegativeUs,
    endUs: NonNegativeUs,
    mode: FaceMode,
    easeUs: NonNegativeUs.optional(),
  }),
  z.strictObject({ type: z.literal('setBeautify'), beautify: BeautifySchema.nullable() }),
  z.strictObject({
    type: z.literal('setCameraKeyframe'),
    tUs: NonNegativeUs,
    rect: CameraRect.optional(),
    easing: Easing.optional(),
  }),
  z.strictObject({ type: z.literal('removeCameraKeyframe'), tUs: NonNegativeUs }),
  z.strictObject({
    type: z.literal('moveCameraKeyframe'),
    fromUs: NonNegativeUs,
    toUs: NonNegativeUs,
  }),
  z.strictObject({
    type: z.literal('setCameraZoom'),
    startUs: NonNegativeUs,
    endUs: NonNegativeUs,
    rect: CameraRect,
    easeUs: NonNegativeUs.optional(),
  }),
  z.strictObject({ type: z.literal('nudge'), target: NudgeTargetSchema, syncAdjustUs: Us }),
  z.strictObject({ type: z.literal('unlink'), clipIds: ClipIds }),
  z.strictObject({ type: z.literal('relink'), clipIds: ClipIds }),
  z.strictObject({
    type: z.literal('setMarks'),
    inUs: NonNegativeUs.nullable(),
    outUs: NonNegativeUs.nullable(),
  }),
]);
