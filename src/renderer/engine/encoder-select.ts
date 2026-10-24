/**
 * Encoder selection (§4.3.4, with §8 and §9.3–9.4).
 *
 * Video candidates are tried in a fixed order. The first one whose `isConfigSupported` probe
 * succeeds and that survives a 1 s warm-up encode is used:
 *   1. H.264 High, prefer-hardware
 *   2. VP9 profile 0, prefer-hardware
 *   3. AV1, prefer-hardware
 *   4. H.264, software
 *   5. VP9, software, `latencyMode: 'realtime'`
 *   6. VP8, software
 * On the dev machine only the software paths exist (spike S3), so selection lands on 4.
 *
 * Phase 1 records at most 1440p (§8): larger sources are encoded scaled to fit 2560 × 1440 with the
 * aspect preserved; the pipeline must scale frames to the selected size.
 *
 * Bitrate: `clamp(width × height × fps × 0.07, 4 Mbps, 40 Mbps)` for Standard, × 1.6 for High.
 * Camera: 4 Mbps (Standard) or 6 Mbps (High). Audio: Opus 48 kHz; mic 128 kbps at the device's
 * channel count; system 192 kbps stereo.
 *
 * The WebCodecs calls are injected, so this module has no DOM dependency and is unit-tested in
 * Node. The config types are structural subsets of `VideoEncoderConfig`/`AudioEncoderConfig`.
 */
import { dropLevelFor, type DropLevel } from '../../shared/recording/drop-level';
import { err, ok, type Result } from '../../shared/result';
import type { Us } from '../../shared/time';

export type Quality = 'standard' | 'high';
export type VideoStreamRole = 'screen' | 'camera';
export type HardwarePreference = 'prefer-hardware' | 'prefer-software';

export interface VideoEncoderConfigLike {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  hardwareAcceleration: HardwarePreference;
  latencyMode?: 'quality' | 'realtime';
  bitrateMode?: 'constant' | 'variable';
  avc?: { format: 'avc' | 'annexb' };
}

export interface AudioEncoderConfigLike {
  codec: 'opus';
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

export interface SupportLike {
  supported?: boolean;
}

/** Injected WebCodecs access: `VideoEncoder.isConfigSupported` and a warm-up encode. */
export interface EncoderProbe {
  isConfigSupported(config: VideoEncoderConfigLike): Promise<SupportLike>;
  /** Encodes about 1 s of frames with the config; resolves false or rejects on failure. */
  warmUp(config: VideoEncoderConfigLike): Promise<boolean>;
}

export type CodecFamily = 'h264' | 'vp9' | 'av1' | 'vp8';

export interface VideoCandidate {
  family: CodecFamily;
  hardwareAcceleration: HardwarePreference;
  latencyMode?: 'realtime';
  /** Display name, recorded as `Media.encoder.name`. */
  name: string;
}

/** §4.3.4, in order. */
export const VIDEO_CANDIDATES: readonly VideoCandidate[] = [
  { family: 'h264', hardwareAcceleration: 'prefer-hardware', name: 'H.264 (hardware)' },
  { family: 'vp9', hardwareAcceleration: 'prefer-hardware', name: 'VP9 (hardware)' },
  { family: 'av1', hardwareAcceleration: 'prefer-hardware', name: 'AV1 (hardware)' },
  { family: 'h264', hardwareAcceleration: 'prefer-software', name: 'H.264 (software)' },
  {
    family: 'vp9',
    hardwareAcceleration: 'prefer-software',
    latencyMode: 'realtime',
    name: 'VP9 (software)',
  },
  { family: 'vp8', hardwareAcceleration: 'prefer-software', name: 'VP8 (software)' },
];

/** §8: Phase 1 records up to 1440p. */
export const MAX_RECORD_SIZE = { width: 2560, height: 1440 } as const;

const MBPS = 1_000_000;
const BITS_PER_PIXEL = 0.07;
const MIN_SCREEN_BITRATE = 4 * MBPS;
const MAX_SCREEN_BITRATE = 40 * MBPS;
const HIGH_MULTIPLIER = 1.6;
const CAMERA_BITRATE: Record<Quality, number> = { standard: 4 * MBPS, high: 6 * MBPS };

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Even size within `max` (the box turns for portrait sources), aspect preserved, never upscaled. */
export function fitRecordSize(
  width: number,
  height: number,
  max: { width: number; height: number } = MAX_RECORD_SIZE,
): { width: number; height: number } {
  const portrait = height > width;
  const maxW = portrait ? Math.min(max.width, max.height) : Math.max(max.width, max.height);
  const maxH = portrait ? Math.max(max.width, max.height) : Math.min(max.width, max.height);
  const scale = Math.min(1, maxW / width, maxH / height);
  return { width: even(width * scale), height: even(height * scale) };
}

/** §4.3.4 video bitrate in bits per second. */
export function videoBitrate(
  role: VideoStreamRole,
  quality: Quality,
  width: number,
  height: number,
  fps: number,
): number {
  if (role === 'camera') return CAMERA_BITRATE[quality];
  const base = Math.min(
    MAX_SCREEN_BITRATE,
    Math.max(MIN_SCREEN_BITRATE, width * height * fps * BITS_PER_PIXEL),
  );
  return Math.round(quality === 'high' ? base * HIGH_MULTIPLIER : base);
}

/** [level_idc, MaxFS (macroblocks), MaxMBPS] for H.264 (ITU-T H.264 Table A-1). */
const H264_LEVELS: readonly (readonly [number, number, number])[] = [
  [30, 1620, 40_500],
  [31, 3600, 108_000],
  [32, 5120, 216_000],
  [40, 8192, 245_760],
  [41, 8192, 245_760],
  [42, 8704, 522_240],
  [50, 22_080, 589_824],
  [51, 36_864, 983_040],
  [52, 36_864, 2_073_600],
];

/** [level as "XY", max picture size (samples), max sample rate] for VP9. */
const VP9_LEVELS: readonly (readonly [string, number, number])[] = [
  ['31', 983_040, 36_864_000],
  ['40', 2_228_224, 83_558_400],
  ['41', 2_228_224, 160_432_128],
  ['50', 8_912_896, 311_951_360],
  ['51', 8_912_896, 588_251_136],
  ['52', 8_912_896, 1_176_502_272],
];

/** [seq_level_idx, max picture size, max display sample rate] for AV1. */
const AV1_LEVELS: readonly (readonly [number, number, number])[] = [
  [5, 665_856, 39_938_400],
  [8, 2_359_296, 77_856_768],
  [9, 2_359_296, 155_713_536],
  [12, 8_912_896, 273_715_200],
  [13, 8_912_896, 547_430_400],
  [14, 8_912_896, 1_094_860_800],
];

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

/** The RFC 6381 / WebCodecs codec string for a family at a size and rate. */
export function codecString(
  family: CodecFamily,
  width: number,
  height: number,
  fps: number,
): string {
  const samples = width * height;
  switch (family) {
    case 'h264': {
      const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
      const level = H264_LEVELS.find(([, fs, mbps]) => mbs <= fs && mbs * fps <= mbps)?.[0] ?? 52;
      return `avc1.6400${hex2(level)}`;
    }
    case 'vp9': {
      const level =
        VP9_LEVELS.find(([, size, rate]) => samples <= size && samples * fps <= rate)?.[0] ?? '52';
      return `vp09.00.${level}.08`;
    }
    case 'av1': {
      const idx =
        AV1_LEVELS.find(([, size, rate]) => samples <= size && samples * fps <= rate)?.[0] ?? 14;
      return `av01.0.${String(idx).padStart(2, '0')}M.08`;
    }
    case 'vp8':
      return 'vp8';
  }
}

export interface VideoEncoderRequest {
  role: VideoStreamRole;
  quality: Quality;
  /** The real stream size, from the first `VideoFrame` (spike S1), never from `getSettings()`. */
  sourceWidth: number;
  sourceHeight: number;
  /** Requested rate (30 or 60). */
  fps: number;
}

export function buildVideoConfig(
  candidate: VideoCandidate,
  request: VideoEncoderRequest,
): VideoEncoderConfigLike {
  const { width, height } = fitRecordSize(request.sourceWidth, request.sourceHeight);
  const config: VideoEncoderConfigLike = {
    codec: codecString(candidate.family, width, height, request.fps),
    width,
    height,
    bitrate: videoBitrate(request.role, request.quality, width, height, request.fps),
    framerate: request.fps,
    hardwareAcceleration: candidate.hardwareAcceleration,
    bitrateMode: 'variable',
  };
  if (candidate.latencyMode) config.latencyMode = candidate.latencyMode;
  if (candidate.family === 'h264') config.avc = { format: 'avc' };
  return config;
}

export interface EncoderAttempt {
  candidate: string;
  codec: string;
  outcome: 'unsupported' | 'probe-error' | 'warm-up-failed' | 'selected';
  detail?: string;
}

export interface SelectedVideoEncoder {
  candidate: VideoCandidate;
  config: VideoEncoderConfigLike;
  /** For `Media.encoder` (R1.19). */
  encoder: { name: string; hardware: boolean };
  /** Every candidate tried, for `logs/recording.json` and Diagnostics. */
  attempts: EncoderAttempt[];
}

export interface NoEncoderError {
  code: 'no-encoder';
  attempts: EncoderAttempt[];
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Tries the candidates in order and returns the first that probes and warms up. */
export async function selectVideoEncoder(
  request: VideoEncoderRequest,
  probe: EncoderProbe,
  candidates: readonly VideoCandidate[] = VIDEO_CANDIDATES,
): Promise<Result<SelectedVideoEncoder, NoEncoderError>> {
  const attempts: EncoderAttempt[] = [];
  for (const candidate of candidates) {
    const config = buildVideoConfig(candidate, request);
    const attempt = { candidate: candidate.name, codec: config.codec };
    try {
      const support = await probe.isConfigSupported(config);
      if (support.supported !== true) {
        attempts.push({ ...attempt, outcome: 'unsupported' });
        continue;
      }
    } catch (e) {
      attempts.push({ ...attempt, outcome: 'probe-error', detail: describe(e) });
      continue;
    }
    try {
      if (!(await probe.warmUp(config))) {
        attempts.push({ ...attempt, outcome: 'warm-up-failed' });
        continue;
      }
    } catch (e) {
      attempts.push({ ...attempt, outcome: 'warm-up-failed', detail: describe(e) });
      continue;
    }
    attempts.push({ ...attempt, outcome: 'selected' });
    return ok({
      candidate,
      config,
      encoder: {
        name: candidate.name,
        hardware: candidate.hardwareAcceleration === 'prefer-hardware',
      },
      attempts,
    });
  }
  return err({ code: 'no-encoder', attempts });
}

export type AudioStreamRole = 'microphone' | 'system-audio';

/** §4.3.4 audio: Opus 48 kHz; mic 128 kbps at its channel count; system 192 kbps stereo. */
export function audioEncoderConfig(
  role: AudioStreamRole,
  deviceChannels = 1,
): AudioEncoderConfigLike {
  return role === 'microphone'
    ? {
        codec: 'opus',
        sampleRate: 48_000,
        numberOfChannels: Math.max(1, Math.round(deviceChannels)),
        bitrate: 128_000,
      }
    : { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, bitrate: 192_000 };
}

/**
 * Delivered frame rate of a track (§9.3: cameras may deliver well below the requested rate, e.g.
 * 16.7 of 30). The estimate is 1 s over the median frame interval of the last `windowSize`
 * frames, which ignores single stalls and bursts.
 */
export class FrameRateMeter {
  private readonly intervals: number[] = [];
  private lastUs: Us | null = null;

  constructor(private readonly windowSize = 60) {}

  onFrame(timestampUs: Us): void {
    if (this.lastUs !== null) {
      const interval = timestampUs - this.lastUs;
      if (interval > 0) {
        this.intervals.push(interval);
        if (this.intervals.length > this.windowSize) this.intervals.shift();
      }
    }
    this.lastUs = timestampUs;
  }

  /** Frames per second, or null until two frames have been seen. */
  get fps(): number | null {
    if (this.intervals.length === 0) return null;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? (sorted[mid] ?? 0)
        : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    return median > 0 ? 1_000_000 / median : null;
  }
}

export type { DropLevel } from '../../shared/recording/drop-level';

export interface DropAccountingInput {
  /** Frames dropped by the pipeline (backpressure or encoder errors). */
  framesDropped: number;
  /** Frames that reached the pipeline (encoded + dropped). */
  framesIn: number;
  /** Recording time the track was active (pauses excluded). */
  activeUs: Us;
  requestedFps: number;
  /** From `FrameRateMeter`; null falls back to the requested rate. */
  deliveredFps: number | null;
}

export interface DropAccounting {
  /** Frames expected at the delivered rate over the active time. */
  expectedFrames: number;
  droppedRatio: number;
  /** R1.12: amber above 1 %, red above 5 %. */
  level: DropLevel;
  /** The rate used for expectations. */
  rateFps: number;
  /** True when the device delivers noticeably (over 10 %) below the requested rate. */
  belowRequested: boolean;
}

/**
 * Dropped-frame accounting against the **delivered** rate (§9.3). Measuring against the requested
 * rate would report a 16.7 fps camera as 44 % dropped.
 */
export function dropAccounting(input: DropAccountingInput): DropAccounting {
  const rateFps =
    input.deliveredFps !== null && input.deliveredFps > 0 ? input.deliveredFps : input.requestedFps;
  const expectedFrames = Math.round((rateFps * Math.max(0, input.activeUs)) / 1_000_000);
  const denominator = Math.max(expectedFrames, input.framesIn, 1);
  const droppedRatio = Math.max(0, input.framesDropped) / denominator;
  const level: DropLevel = dropLevelFor(droppedRatio);
  return {
    expectedFrames,
    droppedRatio,
    level,
    rateFps,
    belowRequested: rateFps < input.requestedFps * 0.9,
  };
}
