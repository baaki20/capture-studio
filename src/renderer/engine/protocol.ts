/**
 * Messages between the engine page and its per-stream pipeline workers (§4.3.3).
 *
 * The engine creates a `MediaStreamTrackProcessor` per track, transfers its `ReadableStream` and
 * the stream's MessagePort (to the media utility) in `init`, then forwards pause, resume, the
 * calibrated offset and stop. A worker reports stats at 2 Hz, its calibration warm-up samples once
 * the 2 s window is complete, failures, and finally its `result` (after `stop`, or on its own
 * when the track ends or the encoder fails).
 */
import type { EngineStreamStats, StreamKind } from '../../shared/ipc/contract';
import type { CalibrationSample } from '../../shared/recording/sync-calibrator';
import type { Us } from '../../shared/time';
import type {
  AudioEncoderConfigLike,
  AudioStreamRole,
  CodecFamily,
  VideoEncoderConfigLike,
} from './encoder-select';
import type { WorkerResult } from './pipeline/results';

export type { WorkerResult } from './pipeline/results';

interface InitBase {
  type: 'init';
  streamId: string;
  kind: StreamKind;
  port: MessagePort;
  /** Session clock t0 (absolute µs). */
  t0Us: Us;
}

export interface VideoInit extends InitBase {
  media: 'video';
  readable: ReadableStream<VideoFrame>;
  /** Requested rate (30 or 60; the camera's ideal 30). */
  fps: number;
  family: CodecFamily;
  config: VideoEncoderConfigLike;
  encoder: { name: string; hardware: boolean };
  sourceWidth: number;
  sourceHeight: number;
}

export interface AudioInit extends InitBase {
  media: 'audio';
  readable: ReadableStream<AudioData>;
  role: AudioStreamRole;
  /** From acquisition; the encoder is configured from the first chunk if it differs. */
  config: AudioEncoderConfigLike;
}

export type WorkerInit = VideoInit | AudioInit;

export type EngineToWorker =
  | WorkerInit
  | { type: 'calibration'; offsetUs: Us }
  | { type: 'pause'; atUs: Us }
  | { type: 'resume'; atUs: Us }
  /** Stop taking input, flush, finalize and answer with `result`. */
  | { type: 'stop'; atUs: Us };

export type WorkerToEngine =
  | { type: 'stats'; stats: EngineStreamStats }
  /** Audio: linear peak since the previous `level`, at about 15 Hz (live meters, R1.12). */
  | { type: 'level'; streamId: string; peak: number }
  | { type: 'calibration-samples'; streamId: string; samples: CalibrationSample[] }
  /** The encoder or muxer failed; the worker finalizes what it has and sends `result`. */
  | { type: 'failed'; streamId: string; message: string; atUs: Us }
  /** The track's readable ended without `stop` (device gone, stop-sharing). */
  | { type: 'input-ended'; streamId: string; atUs: Us }
  | { type: 'result'; result: WorkerResult }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
