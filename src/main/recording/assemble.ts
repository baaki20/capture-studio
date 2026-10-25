/**
 * Pieces shared by finalize (session manager) and recovery: the project folder layout, the
 * session lock, the progressive session log `logs/recording.json` (which holds the recording
 * manifest so recovery can rebuild a project after a crash), the per-stream data the engine
 * reports, and turning finalized files into the manifest's recorded streams (§4.3.5, §4.3.6).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { StreamKind } from '../../shared/ipc/contract';
import { StreamKindSchema } from '../../shared/ipc/contract';
import type {
  FinalizedStream,
  JobKind,
  JobResult,
  JobSpec,
  SyncCheckpoints,
} from '../../shared/ipc/media-utility';
import type { Logger } from '../../shared/logger';
import {
  RecordingManifestSchema,
  type RecordedRole,
  type RecordedStream,
  type RecordingManifest,
  type StreamSync,
} from '../../shared/project/from-recording';
import type { Media } from '../../shared/project/schema';
import { fitSyncFile, type DriftFit } from '../../shared/recording/drift';
import { writeFileAtomic } from '../settings/atomic-file';

export const MEDIA_DIR = 'media';
export const CACHE_DIR = 'cache';
export const LOGS_DIR = 'logs';
export const LOCK_FILE = 'session.lock';
export const SESSION_LOG_FILE = 'recording.json';
/** The lock is refreshed this often (§1.5: at most every 5 s)… */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** …and is stale when older than this (§1.5). */
export const STALE_LOCK_MS = 15_000;

export const ROLE_BY_KIND: Record<StreamKind, RecordedRole> = {
  screen: 'screen',
  camera: 'camera',
  mic: 'microphone',
  system: 'system-audio',
};

export const KIND_BY_ROLE: Record<RecordedRole, StreamKind> = {
  screen: 'screen',
  camera: 'camera',
  microphone: 'mic',
  'system-audio': 'system',
};

export function isVideoKind(kind: StreamKind): boolean {
  return kind === 'screen' || kind === 'camera';
}

/** Stream counts the remuxed file must contain (§4.3.5 step 2). */
export function expectedStreams(kind: StreamKind): { video: number; audio: number } {
  return isVideoKind(kind) ? { video: 1, audio: 0 } : { video: 0, audio: 1 };
}

/** Names the media utility uses inside `media/` (kept in step with `utility/media`). */
export const recFileName = (kind: StreamKind): string => `${kind}.rec.mp4`;
export const finalFileName = (kind: StreamKind): string => `${kind}.mp4`;
export const syncFileName = (kind: StreamKind): string => `${kind}.sync.json`;

// ---------------------------------------------------------------------------------------------
// Session lock

export const SessionLockSchema = z.object({
  pid: z.int().positive(),
  hostname: z.string().optional(),
  sessionId: z.string().optional(),
  startedAt: z.string().optional(),
  heartbeatAt: z.iso.datetime(),
  appVersion: z.string(),
});
export type SessionLock = z.infer<typeof SessionLockSchema>;

export async function writeLock(root: string, lock: SessionLock): Promise<void> {
  await writeFileAtomic(path.join(root, LOCK_FILE), `${JSON.stringify(lock)}\n`, {
    backup: false,
  });
}

export async function readLock(root: string): Promise<SessionLock | null> {
  try {
    const text = await fs.readFile(path.join(root, LOCK_FILE), 'utf8');
    return SessionLockSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function removeLock(root: string): Promise<void> {
  await fs.rm(path.join(root, LOCK_FILE), { force: true });
}

/** True when `pid` is a live process on this machine. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface StaleLockOptions {
  now: Date;
  isAlive?: (pid: number) => boolean;
  hostname?: string;
  /** Pids of this app run (their locks are live by definition). */
  ownPid?: number;
  staleMs?: number;
}

/**
 * A lock is stale when it is missing or unreadable, when its process is dead (same host only:
 * a pid means nothing on another machine), or when its heartbeat is older than 15 s.
 */
export function isLockStale(lock: SessionLock | null, options: StaleLockOptions): boolean {
  if (!lock) return true;
  const sameHost = !lock.hostname || lock.hostname === (options.hostname ?? os.hostname());
  if (sameHost && lock.pid === options.ownPid) return false;
  if (sameHost && !(options.isAlive ?? isProcessAlive)(lock.pid)) return true;
  const age = options.now.getTime() - Date.parse(lock.heartbeatAt);
  return !(age <= (options.staleMs ?? STALE_LOCK_MS));
}

// ---------------------------------------------------------------------------------------------
// Engine stream reports
//
// `engine.stop` (and `engine.stats`) stream entries are loose objects. Besides the stats, the
// session manager reads these optional fields when the engine provides them.

export const CalibrationReportSchema = z.object({
  mode: z.enum(['shared', 'arrival-calibrated']),
  offsetUs: z.number(),
  clockHandshakeUs: z.number().nullable().optional(),
});

export const EngineStreamReportSchema = z.looseObject({
  kind: StreamKindSchema,
  framesIn: z.number().optional(),
  framesEncoded: z.number().optional(),
  framesDropped: z.number().optional(),
  discontinuities: z.number().optional(),
  bytes: z.number().optional(),
  /** Session time (µs since t0) of the stream's first sample. */
  startOffsetUs: z.number().optional(),
  calibration: CalibrationReportSchema.optional(),
  /** The calibrator's reason and warm-up stats (kept in `logs/recording.json` for diagnosis). */
  sync: z.looseObject({ reason: z.string() }).optional(),
  /** Drift checkpoints `[sessionUs, cumulativeSamples]` (audio). */
  checkpoints: z.array(z.tuple([z.number(), z.number()])).optional(),
  nominalRate: z.number().positive().optional(),
  video: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      frameRate: z.number().optional(),
    })
    .optional(),
  encoder: z.object({ name: z.string(), hardware: z.boolean() }).optional(),
  endedEarly: z.boolean().optional(),
  /** Linear peak level 0–1 (stats only). */
  level: z.number().optional(),
  /** Video: dropped fraction from the engine's accounting against the delivered rate (§9.3). */
  droppedRatio: z.number().optional(),
});
export type EngineStreamReport = z.infer<typeof EngineStreamReportSchema>;

/** Parses the entries it can; malformed ones are dropped. */
export function parseStreamReports(streams: readonly unknown[]): EngineStreamReport[] {
  return streams.flatMap((s) => {
    const parsed = EngineStreamReportSchema.safeParse(s);
    return parsed.success ? [parsed.data] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// Session log: logs/recording.json

export const StreamLogSchema = z.object({
  kind: StreamKindSchema,
  streamId: z.string(),
  mediaId: z.string(),
  label: z.string().nullable(),
  encoder: z.object({ name: z.string(), hardware: z.boolean() }).nullable(),
  sync: z.object({
    mode: z.enum(['shared', 'arrival-calibrated']),
    offsetUs: z.int(),
    clockHandshakeUs: z.int().nullable(),
    outputLatencyUs: z.int().optional(),
  }),
  /** Why the calibrator chose the mode, with its warm-up stats. */
  calibrationDetail: z.looseObject({ reason: z.string() }).optional(),
  startOffsetUs: z.int().nullable(),
  endedEarly: z.boolean(),
  endedAtUs: z.int().nullable(),
  stats: z
    .object({
      framesIn: z.number().optional(),
      framesEncoded: z.number().optional(),
      framesDropped: z.number().optional(),
      discontinuities: z.number().optional(),
      bytes: z.number().optional(),
    })
    .nullable(),
});
export type StreamLog = z.infer<typeof StreamLogSchema>;

export const SessionLogSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  /** Session clock t0 (engine clock, µs), or null before the engine started. */
  t0Us: z.number().nullable(),
  /** Utility clock minus engine clock (µs), from the clock handshake. */
  utilityClockOffsetUs: z.number().nullable(),
  systemCaptureId: z.string().nullable(),
  streams: z.array(StreamLogSchema),
  notices: z.array(z.object({ at: z.string(), level: z.string(), message: z.string() })),
  manifest: RecordingManifestSchema,
});
export type SessionLog = z.infer<typeof SessionLogSchema>;

export async function writeSessionLog(root: string, log: SessionLog): Promise<void> {
  await writeFileAtomic(
    path.join(root, LOGS_DIR, SESSION_LOG_FILE),
    `${JSON.stringify(log, null, 2)}\n`,
    { backup: false },
  );
}

export async function readSessionLog(root: string): Promise<SessionLog | null> {
  try {
    const text = await fs.readFile(path.join(root, LOGS_DIR, SESSION_LOG_FILE), 'utf8');
    return SessionLogSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Finalized files → recorded streams

/** Shift drift checkpoints into session time (the slope is unchanged; the log stays readable). */
export function shiftCheckpoints(sync: SyncCheckpoints, byUs: number): SyncCheckpoints {
  return { ...sync, checkpoints: sync.checkpoints.map(([t, n]) => [Math.round(t - byUs), n]) };
}

export function fitDrift(sync: SyncCheckpoints | null): DriftFit | null {
  if (!sync || sync.checkpoints.length === 0) return null;
  return fitSyncFile(sync);
}

/** What the session (or its log) knows about a stream besides the finalized file. */
export interface StreamMeta {
  kind: StreamKind;
  mediaId: string;
  label: string | null;
  encoder: { name: string; hardware: boolean } | null;
  sync: StreamSync;
  startOffsetUs: number | null;
  endedEarly: boolean;
  stats: { framesEncoded?: number; framesDropped?: number; discontinuities?: number } | null;
  /** Nominal frame rate for video (the requested fps for the screen). */
  frameRate: number | null;
}

export function streamMetaFromLog(entry: StreamLog, frameRate: number | null): StreamMeta {
  return {
    kind: entry.kind,
    mediaId: entry.mediaId,
    label: entry.label,
    encoder: entry.encoder,
    sync: entry.sync,
    startOffsetUs: entry.startOffsetUs,
    endedEarly: entry.endedEarly,
    stats: entry.stats,
    frameRate,
  };
}

const nonNegInt = (n: number | undefined): number | undefined =>
  n === undefined || !Number.isFinite(n) ? undefined : Math.max(0, Math.round(n));

/**
 * One manifest stream from a finalized file. A failed file becomes a `failed` media of zero
 * length (no clips); with `recovering`, good files are marked `recovered`.
 */
export function recordedStream(
  meta: StreamMeta,
  file: FinalizedStream | null,
  drift: DriftFit | null,
  recovering: boolean,
): RecordedStream {
  const ok = file?.ok === true && (file.durationUs ?? 0) > 0;
  const stream: RecordedStream = {
    mediaId: meta.mediaId,
    role: ROLE_BY_KIND[meta.kind],
    path: `${MEDIA_DIR}/${finalFileName(meta.kind)}`,
    status: ok ? (recovering ? 'recovered' : 'ok') : 'failed',
    durationUs: ok ? Math.round(file.durationUs ?? 0) : 0,
    startOffsetUs: Math.round(meta.startOffsetUs ?? 0),
    clockRatio: drift?.clockRatio ?? 1,
    endedEarly: meta.endedEarly,
    sync: meta.sync,
    video: undefined,
    audio: undefined,
    encoder: meta.encoder ?? undefined,
    stats: undefined,
    device: meta.label ? { label: meta.label } : undefined,
  };
  if (file?.video && file.video.width > 0 && file.video.height > 0) {
    stream.video = {
      codec: file.video.codec ?? 'unknown',
      width: file.video.width,
      height: file.video.height,
      frameRateNominal: meta.frameRate ?? file.video.frameRate ?? 30,
      variableFrameRate: true,
    };
  }
  if (file?.audio && file.audio.sampleRate > 0 && file.audio.channels > 0) {
    stream.audio = {
      codec: file.audio.codec ?? 'unknown',
      sampleRate: file.audio.sampleRate,
      channels: file.audio.channels,
      discontinuities: nonNegInt(meta.stats?.discontinuities) ?? 0,
      ...(file.sync ? { syncCheckpointsPath: `${MEDIA_DIR}/${syncFileName(meta.kind)}` } : {}),
    };
  }
  const framesEncoded = nonNegInt(meta.stats?.framesEncoded);
  const framesDropped = nonNegInt(meta.stats?.framesDropped);
  if (isVideoKind(meta.kind) && (framesEncoded !== undefined || framesDropped !== undefined)) {
    stream.stats = {
      ...(framesEncoded === undefined ? {} : { framesEncoded }),
      ...(framesDropped === undefined ? {} : { framesDropped }),
    };
  }
  return stream;
}

/** Session length: the longest stream extent, or `fallbackUs` when no stream has one. */
export function sessionDurationUs(streams: readonly RecordedStream[], fallbackUs: number): number {
  let end = 0;
  for (const s of streams) {
    if (s.durationUs > 0) end = Math.max(end, s.startOffsetUs + s.durationUs * s.clockRatio);
  }
  return Math.max(0, Math.round(end > 0 ? end : fallbackUs));
}

export function withState(
  manifest: RecordingManifest,
  state: RecordingManifest['recording']['state'],
  failureReason?: string,
): RecordingManifest {
  const recording = { ...manifest.recording, state };
  if (failureReason) recording.failureReason = failureReason;
  else delete recording.failureReason;
  return { ...manifest, recording };
}

// ---------------------------------------------------------------------------------------------
// Caches

export interface JobRunner {
  runJob<K extends JobKind>(job: Extract<JobSpec, { kind: K }>): Promise<JobResult<K>>;
}

/** Peaks for audio media and thumbnails for video media (§4.3.5). Failures are only logged. */
export async function generateCaches(
  utility: JobRunner,
  root: string,
  media: readonly Media[],
  logger: Logger,
): Promise<void> {
  const cacheDir = path.join(root, CACHE_DIR);
  await fs.mkdir(cacheDir, { recursive: true });
  for (const m of media) {
    if (m.status === 'failed' || m.status === 'missing' || m.durationUs <= 0) continue;
    const input = path.join(root, ...m.path.split('/'));
    try {
      if (m.kind === 'audio') {
        await utility.runJob({
          kind: 'peaks',
          input,
          output: path.join(cacheDir, `${m.id}.peaks`),
        });
      } else {
        await utility.runJob({ kind: 'thumbnails', input, outDir: cacheDir, mediaId: m.id });
      }
    } catch (error) {
      logger.warn(
        `recording: ${m.kind === 'audio' ? 'peaks' : 'thumbnails'} for ${m.id} failed`,
        error,
      );
    }
  }
}
