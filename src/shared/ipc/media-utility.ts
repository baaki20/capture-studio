/**
 * Messages between main and the media utility process (§1.3), and between the capture engine
 * and the utility over the per-stream MessagePorts that main wires with `MessageChannelMain`.
 *
 * Main → utility requests carry MessagePorts for `stream.open` and `clock.attach` (one port each,
 * in the message's `ports`). Long jobs (`job`) answer with `job.progress`, then `job.done` or
 * `job.error` for the same `jobId`.
 */
import { z } from 'zod';
import { FfmpegEncoderReportSchema } from '../capabilities/types';
import { ProjectV1StructureSchema } from '../project/schema';
import { ExportOptionsSchema, StreamKindSchema } from './contract';

const Id = z.string().min(1).max(64);
const AbsPath = z.string().min(1);

// ---------------------------------------------------------------------------------------------
// Jobs

export const FinalizeStreamSchema = z.object({
  kind: StreamKindSchema,
  /** Streams the remuxed file must contain (§4.3.5 step 2). */
  expect: z.object({ video: z.int().nonnegative(), audio: z.int().nonnegative() }),
});

export const JobSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('finalize'),
    /** The project's `media/` folder holding `<kind>.rec.mp4`. */
    dir: AbsPath,
    streams: z.array(FinalizeStreamSchema).min(1),
    /** Recovery: a truncated last fragment is expected. */
    recovering: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('peaks'), input: AbsPath, output: AbsPath }),
  z.object({
    kind: z.literal('thumbnails'),
    input: AbsPath,
    outDir: AbsPath,
    mediaId: Id,
  }),
  z.object({ kind: z.literal('encoders.probe') }),
  /**
   * Export a project snapshot to MP4 (§4.3.9). Main validated `doc` against the full schema;
   * `hardwareEncoder` is the probe-verified encoder for `encoder: 'auto'` (null = libx264).
   */
  z.object({
    kind: z.literal('export'),
    root: AbsPath,
    doc: ProjectV1StructureSchema,
    options: ExportOptionsSchema,
    hardwareEncoder: z.string().nullable(),
    output: AbsPath,
    overwrite: z.boolean(),
  }),
]);
export type JobSpec = z.infer<typeof JobSpecSchema>;
export const JOB_KINDS = ['finalize', 'peaks', 'thumbnails', 'encoders.probe', 'export'] as const;
export type JobKind = JobSpec['kind'];

export const SyncCheckpointsSchema = z.object({
  version: z.literal(1),
  nominalRate: z.int().positive(),
  /** `[sessionUs, cumulativeSamples]`, about one per second (§4.4.3). */
  checkpoints: z.array(z.tuple([z.number(), z.int().nonnegative()])),
});
export type SyncCheckpoints = z.infer<typeof SyncCheckpointsSchema>;

export const FinalizedStreamSchema = z.object({
  kind: StreamKindSchema,
  path: AbsPath,
  ok: z.boolean(),
  error: z.string().nullable(),
  durationUs: z.number().nullable(),
  sizeBytes: z.int().nonnegative(),
  video: z
    .object({
      codec: z.string().nullable(),
      width: z.int(),
      height: z.int(),
      frameRate: z.number().nullable(),
    })
    .nullable(),
  audio: z
    .object({ codec: z.string().nullable(), sampleRate: z.int(), channels: z.int() })
    .nullable(),
  /** Parsed `<kind>.sync.json`, for the drift fit (§4.3.5 step 3); null when absent. */
  sync: SyncCheckpointsSchema.nullable(),
  /** Whether `<kind>.rec.mp4` was deleted (only after every check passed). */
  recDeleted: z.boolean(),
});
export type FinalizedStream = z.infer<typeof FinalizedStreamSchema>;

export const PeaksResultSchema = z.object({
  output: AbsPath,
  /** Number of [min, max] Int16 pairs; one per 10 ms. */
  pairs: z.int().nonnegative(),
  sampleRate: z.literal(8000),
  windowSamples: z.literal(80),
});

export const ThumbnailIndexSchema = z.object({
  version: z.literal(1),
  mediaId: Id,
  intervalUs: z.int().positive(),
  tileWidth: z.int().positive(),
  tileHeight: z.int().positive(),
  columns: z.int().positive(),
  rows: z.int().positive(),
  count: z.int().nonnegative(),
  /** File names next to the index, in order. */
  sheets: z.array(z.string()),
});
export type ThumbnailIndex = z.infer<typeof ThumbnailIndexSchema>;

export const JOB_RESULT_SCHEMAS = {
  finalize: z.object({ streams: z.array(FinalizedStreamSchema) }),
  peaks: PeaksResultSchema,
  thumbnails: z.object({ indexPath: AbsPath, index: ThumbnailIndexSchema }),
  'encoders.probe': FfmpegEncoderReportSchema,
  export: z.object({
    output: AbsPath,
    /** The video encoder that produced the file. */
    encoder: z.string(),
    /** Set when the hardware encoder failed and the export was redone with libx264. */
    fallback: z.object({ from: z.string(), reason: z.string() }).nullable(),
    durationUs: z.int().nonnegative(),
    sizeBytes: z.int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
  }),
} as const satisfies Record<JobKind, z.ZodType>;

export type JobResult<K extends JobKind> = z.infer<(typeof JOB_RESULT_SCHEMAS)[K]>;

// ---------------------------------------------------------------------------------------------
// Main → utility

export const MediaUtilityRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    ffmpegPath: z.string().min(1),
    ffprobePath: z.string().min(1),
  }),
  z.object({ type: z.literal('ping'), id: z.int() }),
  /** Main-side clock handshake (the engine uses `clock.attach` instead). */
  z.object({ type: z.literal('clock.ping'), id: z.int(), sentUs: z.number() }),

  /** Carries one MessagePort: the engine's muxer writes `<dir>/<kind>.rec.mp4` through it. */
  z.object({ type: z.literal('stream.open'), streamId: Id, kind: StreamKindSchema, dir: AbsPath }),
  /** Force-closes a stream (abort, engine crash); a normal close comes over the port. */
  z.object({ type: z.literal('stream.close'), streamId: Id }),
  /** Carries one MessagePort that answers `clock.ping` with the utility's clock. */
  z.object({ type: z.literal('clock.attach') }),

  /** System audio via `pw-record` (§9.5), written to `<dir>/system.rec.mp4`. */
  z.object({
    type: z.literal('system.start'),
    captureId: Id,
    dir: AbsPath,
    /** Development and tests only: replaces the `pw-record` command line. */
    command: z.object({ file: z.string().min(1), args: z.array(z.string()) }).optional(),
  }),
  z.object({ type: z.literal('system.pause'), captureId: Id, atUs: z.number().optional() }),
  z.object({ type: z.literal('system.resume'), captureId: Id, atUs: z.number().optional() }),
  z.object({ type: z.literal('system.stop'), captureId: Id }),
  /** The setup panel's system-audio meter: capture without writing (R1.5). */
  z.object({ type: z.literal('system.monitor'), enabled: z.boolean() }),

  z.object({ type: z.literal('job'), jobId: Id, job: JobSpecSchema }),
  z.object({ type: z.literal('job.cancel'), jobId: Id }),
]);

export const StreamStatsSchema = z.object({
  bytesWritten: z.int().nonnegative(),
  writes: z.int().nonnegative(),
  /** Writes that started before the previous write's end (seek-back of the muxer). */
  outOfOrder: z.int().nonnegative(),
  /** Highest byte written + 1. */
  size: z.int().nonnegative(),
  fsyncs: z.int().nonnegative(),
  /** `Date.now()` of the last fsync, or null. */
  lastFsyncAt: z.number().nullable(),
});
export type StreamStats = z.infer<typeof StreamStatsSchema>;

export const SystemAudioResultSchema = z.object({
  path: AbsPath,
  syncPath: AbsPath,
  /** Samples per channel written to the encoder, silence included. */
  samples: z.int().nonnegative(),
  /** Samples replaced by silence while paused. */
  silencedSamples: z.int().nonnegative(),
  /** Samples of silence inserted where captured audio never arrived (output device changes). */
  gapSamples: z.int().nonnegative(),
  /** Utility clock (µs) of the first chunk's first sample, or null if nothing arrived. */
  firstSampleUs: z.number().nullable(),
  checkpoints: z.int().nonnegative(),
  exitCode: z.int().nullable(),
});
export type SystemAudioResult = z.infer<typeof SystemAudioResultSchema>;

export const MediaUtilityEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    ffmpegVersion: z.string().nullable(),
    error: z.string().nullable(),
  }),
  z.object({ type: z.literal('pong'), id: z.int(), pid: z.int() }),
  z.object({
    type: z.literal('clock.pong'),
    id: z.int(),
    sentUs: z.number(),
    utilityUs: z.number(),
  }),

  z.object({ type: z.literal('stream.opened'), streamId: Id, path: AbsPath }),
  z.object({ type: z.literal('stream.stats'), streamId: Id, stats: StreamStatsSchema }),
  z.object({ type: z.literal('stream.closed'), streamId: Id, stats: StreamStatsSchema }),
  z.object({ type: z.literal('stream.error'), streamId: Id, message: z.string() }),

  z.object({
    type: z.literal('system.started'),
    captureId: Id,
    path: AbsPath,
  }),
  /** First PCM arrived; `firstSampleUs` is on the utility clock. */
  z.object({ type: z.literal('system.first-audio'), captureId: Id, firstSampleUs: z.number() }),
  z.object({ type: z.literal('system.stopped'), captureId: Id, result: SystemAudioResultSchema }),
  z.object({ type: z.literal('system.error'), captureId: Id, message: z.string() }),
  /** Linear peak 0–1 at about 15 Hz, from a capture (`captureId`) or the monitor (null). */
  z.object({
    type: z.literal('system.level'),
    captureId: Id.nullable(),
    peak: z.number().min(0),
  }),

  z.object({
    type: z.literal('job.progress'),
    jobId: Id,
    fraction: z.number().min(0).max(1).nullable(),
  }),
  z.object({
    type: z.literal('job.done'),
    jobId: Id,
    kind: z.enum(JOB_KINDS),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal('job.error'),
    jobId: Id,
    message: z.string(),
    cancelled: z.boolean(),
  }),
]);

export type MediaUtilityRequest = z.input<typeof MediaUtilityRequestSchema>;
export type MediaUtilityEvent = z.infer<typeof MediaUtilityEventSchema>;

// ---------------------------------------------------------------------------------------------
// Engine ⇄ utility over a stream or clock MessagePort

const Bytes = z.custom<Uint8Array | ArrayBuffer>(
  (value) => value instanceof Uint8Array || value instanceof ArrayBuffer,
  'expected bytes',
);

/** Engine → utility. */
export const StreamPortMessageSchema = z.discriminatedUnion('type', [
  /** Positional write: the muxer's `StreamTarget` chunk. */
  z.object({ type: z.literal('chunk'), position: z.int().nonnegative(), data: Bytes }),
  /** The muxer finalized; fsync, close and reply `closed`. */
  z.object({ type: z.literal('close') }),
  /** Clock handshake: `sentUs` is the engine's `performance.timeOrigin + performance.now()` in µs. */
  z.object({ type: z.literal('clock.ping'), id: z.int(), sentUs: z.number() }),
]);
export type StreamPortMessage = z.input<typeof StreamPortMessageSchema>;

/** Utility → engine. */
export type StreamPortReply =
  | { type: 'closed'; stats: StreamStats }
  | { type: 'error'; message: string }
  | { type: 'clock.pong'; id: number; sentUs: number; utilityUs: number };

// ---------------------------------------------------------------------------------------------
// Clock handshake (§9.5 risk): both sides use `performance.timeOrigin + performance.now()` in µs.

export interface ClockSample {
  /** Local clock when the ping was sent. */
  sentUs: number;
  /** Remote clock when it answered. */
  remoteUs: number;
  /** Local clock when the pong arrived. */
  receivedUs: number;
}

export interface ClockOffset {
  /** Remote clock minus local clock: `local ≈ remote − offsetUs`. */
  offsetUs: number;
  /** Round trip of the sample used. */
  rttUs: number;
  samples: number;
}

/**
 * NTP-style estimate from the sample with the shortest round trip:
 * `offset = remote − (sent + received) / 2`, so `local ≈ remote − offset`.
 */
export function estimateClockOffset(samples: readonly ClockSample[]): ClockOffset | null {
  let best: ClockSample | null = null;
  for (const sample of samples) {
    const rtt = sample.receivedUs - sample.sentUs;
    if (rtt < 0) continue;
    if (!best || rtt < best.receivedUs - best.sentUs) best = sample;
  }
  if (!best) return null;
  return {
    offsetUs: best.remoteUs - (best.sentUs + best.receivedUs) / 2,
    rttUs: best.receivedUs - best.sentUs,
    samples: samples.length,
  };
}
