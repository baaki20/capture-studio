/**
 * The frame port of the frame-render export (§1.7, D4): main wires a `MessageChannelMain` between
 * the hidden render window and the media utility, so frames never pass through main.
 *
 * - The utility sends `start` each time it starts FFmpeg (a hardware-encoder fallback starts a
 *   second attempt); the renderer then renders from frame 0, tagging frames with that attempt.
 * - The renderer sends `frame`s in order and keeps at most `FRAME_WINDOW` unacknowledged; the
 *   utility sends `ack` once a frame is written to FFmpeg's stdin, which is the backpressure.
 * - The renderer ends an attempt with `end` (all frames sent) or `error`. The utility sends
 *   `stop` when the export ends for any reason; the renderer then releases everything.
 * - The render window's start message (main → page, with the port) is `RenderStart`; the
 *   preload re-posts it (`render-window.ts`).
 */
import { z } from 'zod';
import { ProjectStructureSchema } from '../project/schema';

/** Frames in flight between the renderer and FFmpeg's stdin. */
export const FRAME_WINDOW = 3;

const Attempt = z.int().nonnegative();
const Index = z.int().nonnegative();

/**
 * Frame bytes: a `Uint8Array` (a Node `Buffer` is one too). Checked with `ArrayBuffer.isView`,
 * which also holds for arrays made in another realm, as deserialized port messages may be.
 */
const Bytes = z.custom<Uint8Array>(
  (value) =>
    ArrayBuffer.isView(value) && (value as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1,
  'expected bytes',
);

export const RendererToUtilitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('frame'), attempt: Attempt, index: Index, data: Bytes }),
  z.object({ type: z.literal('end'), attempt: Attempt, frames: Index }),
  z.object({ type: z.literal('error'), attempt: Attempt, message: z.string().max(2000) }),
]);
export type RendererToUtility = z.infer<typeof RendererToUtilitySchema>;

export const UtilityToRendererSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), attempt: Attempt }),
  z.object({ type: z.literal('ack'), attempt: Attempt, index: Index }),
  z.object({ type: z.literal('stop') }),
]);
export type UtilityToRenderer = z.infer<typeof UtilityToRendererSchema>;

export const FrameSpecSchema = z.object({
  width: z.int().positive().multipleOf(2),
  height: z.int().positive().multipleOf(2),
  fps: z.number().positive(),
  frames: z.int().nonnegative(),
});

/** Main → render window, with the frame port. */
export const RenderStartSchema = z.object({
  doc: ProjectStructureSchema,
  /** `cs-media://` URL per video media id. */
  mediaUrls: z.record(z.string(), z.string()),
  spec: FrameSpecSchema,
});
export type RenderStart = z.infer<typeof RenderStartSchema>;
