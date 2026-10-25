/**
 * A pipeline worker's final report, and how the engine turns it into an `engine.stop` stream
 * entry once the final calibration is known (`startOffsetUs` needs the track's offset).
 */
import type {
  EngineStreamResult,
  EngineStreamStats,
  StreamKind,
} from '../../../shared/ipc/contract';
import type { StreamStats } from '../../../shared/ipc/media-utility';
import { VIDEO_SYNC_RATE, type Checkpoint } from '../../../shared/recording/drift';
import type { CalibrationSample } from '../../../shared/recording/sync-calibrator';
import type { Us } from '../../../shared/time';
import type { StreamSync } from './calibration';
import { startOffsetUs } from './stamp';

export interface WorkerResult {
  streamId: string;
  kind: StreamKind;
  status: EngineStreamResult['status'];
  endedEarly: boolean;
  endedAtUs: Us | null;
  error: string | null;
  encoder: { name: string; hardware: boolean } | null;
  codec: string | null;
  firstTimestampUs: Us | null;
  video: NonNullable<EngineStreamResult['video']> | null;
  audio: NonNullable<EngineStreamResult['audio']> | null;
  checkpoints: Checkpoint[];
  writer: StreamStats | null;
  /** Final counters. */
  stats: EngineStreamStats;
  /** Warm-up samples not posted yet (the window never completed: a short recording). */
  samples: CalibrationSample[];
}

/** The entry for a worker that never reported (crashed or hung). */
export function missingResult(
  streamId: string,
  kind: StreamKind,
  encoder: { name: string; hardware: boolean } | null,
  atUs: Us,
): WorkerResult {
  return {
    streamId,
    kind,
    status: 'failed',
    endedEarly: false,
    endedAtUs: atUs,
    error: 'the pipeline did not finish in time',
    encoder,
    codec: null,
    firstTimestampUs: null,
    video: null,
    audio: null,
    checkpoints: [],
    writer: null,
    stats: {
      kind,
      streamId,
      framesIn: 0,
      framesEncoded: 0,
      framesDropped: 0,
      bytes: 0,
      discontinuities: 0,
      queueDepth: 0,
    },
    samples: [],
  };
}

/** The `engine.stop` entry: unknown fields are omitted (see `EngineStreamResultSchema`). */
export function streamResult(
  result: WorkerResult,
  sync: StreamSync | null,
  t0Us: Us,
): EngineStreamResult {
  const entry: EngineStreamResult = {
    ...result.stats,
    streamId: result.streamId,
    kind: result.kind,
    status: result.status,
    endedEarly: result.endedEarly,
    checkpoints: result.checkpoints.map(([a, b]) => [a, b]),
  };
  if (result.endedAtUs !== null) entry.endedAtUs = result.endedAtUs;
  if (result.error !== null) entry.error = result.error;
  if (result.encoder) entry.encoder = result.encoder;
  if (result.codec !== null) entry.codec = result.codec;
  if (result.firstTimestampUs !== null) entry.firstTimestampUs = result.firstTimestampUs;
  if (sync) {
    entry.sync = sync;
    entry.calibration = {
      mode: sync.mode,
      offsetUs: sync.offsetUs,
      clockHandshakeUs: sync.clockHandshakeUs,
    };
    if (result.firstTimestampUs !== null) {
      entry.startOffsetUs = startOffsetUs(result.firstTimestampUs, sync.offsetUs, t0Us);
    }
  }
  if (result.video) {
    entry.video = result.video;
    entry.nominalRate = VIDEO_SYNC_RATE;
  }
  if (result.audio) {
    entry.audio = result.audio;
    entry.nominalRate = result.audio.sampleRate;
  }
  if (result.writer) entry.writer = result.writer;
  return entry;
}
