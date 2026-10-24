/**
 * Audio continuity and the audio pause gate (§1.5, §4.3.3). Each audio file is written as one
 * continuous sample stream starting at the first chunk's mapped time, so file time is simply
 * `frames / sampleRate` and drift is measured by `drift.ts`.
 *
 * For every incoming chunk the planner compares the chunk's mapped time with the time the stream
 * has reached:
 * - a gap of more than 50 ms is filled with silence before the chunk;
 * - an overlap of more than 50 ms is dropped (the overlapping leading frames, or the whole chunk);
 * - smaller differences are absorbed (the chunk is written as is);
 * - each fill or drop counts as one discontinuity.
 *
 * Pause: frames whose session time falls inside a pause are replaced by the same number of
 * silent frames, so the stream stays linear and none of the paused content is stored.
 *
 * Pure: the planner returns instructions. The pipeline worker turns them into `AudioData`
 * (copying frame ranges of the incoming chunk, or creating silent buffers) and closes the
 * original exactly once.
 */
import type { Us } from '../time';

/** Copy frames `[fromFrame, toFrame)` of the incoming chunk to the encoder. */
export interface CopyOp {
  type: 'copy';
  fromFrame: number;
  toFrame: number;
}

/** Feed `frames` frames of digital silence to the encoder. */
export interface SilenceOp {
  type: 'silence';
  frames: number;
  /** Why the silence is written. */
  cause: 'gap' | 'pause';
}

export type AudioOp = CopyOp | SilenceOp;

export interface AudioChunkInfo {
  /**
   * Time of the chunk's first frame in the track's reference clock (its media timestamp mapped by
   * the sync calibrator). Gaps and overlaps are measured in this clock, which runs at the device's
   * sample rate, so slow clock drift never looks like a gap.
   */
  timeUs: Us;
  frames: number;
  /**
   * Session-clock time of the chunk's first frame, used only for the pause gate. Pauses are
   * pressed in session time; pass the best live estimate (for example the arrival time minus the
   * chunk duration). Defaults to `timeUs`.
   */
  sessionUs?: Us;
}

export interface Discontinuity {
  kind: 'gap' | 'overlap';
  /** Signed difference between the chunk's position and the stream's position. */
  frames: number;
  us: Us;
}

export interface ChunkPlan {
  ops: AudioOp[];
  discontinuity: Discontinuity | null;
  /** True when no frame of the chunk is used (a full overlap). */
  dropped: boolean;
  /** Frames this plan adds to the stream. */
  framesOut: number;
}

export interface AudioContinuityOptions {
  sampleRate: number;
  /** Gaps and overlaps up to this size are absorbed (§1.5: 50 ms). */
  thresholdUs?: Us;
  /** Silence ops are split into pieces of at most this many frames (default 1 s). */
  maxSilenceFrames?: number;
}

export const CONTINUITY_THRESHOLD_US = 50_000;

interface PauseInterval {
  startUs: Us;
  endUs: Us | null;
}

export class AudioContinuity {
  readonly sampleRate: number;
  private readonly thresholdFrames: number;
  private readonly maxSilenceFrames: number;
  private start: Us | null = null;
  private written = 0;
  private events = 0;
  private readonly pauses: PauseInterval[] = [];

  constructor(options: AudioContinuityOptions) {
    if (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0) {
      throw new RangeError(
        `sample rate must be a positive integer, got ${String(options.sampleRate)}`,
      );
    }
    this.sampleRate = options.sampleRate;
    this.thresholdFrames = this.usToFrames(options.thresholdUs ?? CONTINUITY_THRESHOLD_US);
    this.maxSilenceFrames = Math.max(1, options.maxSilenceFrames ?? options.sampleRate);
  }

  /** Reference time of the stream's first frame, or null before the first chunk. */
  get startUs(): Us | null {
    return this.start;
  }

  /** Frames written so far (including silence). Use for drift checkpoints. */
  get framesWritten(): number {
    return this.written;
  }

  /** Reference time the stream has reached. */
  get endUs(): Us | null {
    return this.start === null ? null : this.start + this.framesToUs(this.written);
  }

  get discontinuities(): number {
    return this.events;
  }

  get paused(): boolean {
    const last = this.pauses[this.pauses.length - 1];
    return last?.endUs === null;
  }

  /** Starts a pause at a session time. Ignored while already paused. */
  pause(atSessionUs: Us): void {
    if (!this.paused) this.pauses.push({ startUs: atSessionUs, endUs: null });
  }

  /** Ends the current pause at a session time. Ignored while not paused. */
  resume(atSessionUs: Us): void {
    const last = this.pauses[this.pauses.length - 1];
    if (last?.endUs === null) last.endUs = Math.max(atSessionUs, last.startUs);
  }

  /** Plans how to write one chunk and advances the stream. */
  plan(chunk: AudioChunkInfo): ChunkPlan {
    const frames = Math.max(0, Math.floor(chunk.frames));
    this.start ??= chunk.timeUs;

    const position = this.usToFrames(chunk.timeUs - this.start);
    const delta = position - this.written;
    const ops: AudioOp[] = [];
    let discontinuity: Discontinuity | null = null;
    let skip = 0;

    if (delta > this.thresholdFrames) {
      discontinuity = { kind: 'gap', frames: delta, us: this.framesToUs(delta) };
      this.pushSilence(ops, delta, 'gap');
    } else if (-delta > this.thresholdFrames) {
      discontinuity = { kind: 'overlap', frames: delta, us: this.framesToUs(delta) };
      skip = Math.min(-delta, frames);
    }
    if (discontinuity) this.events += 1;

    // The pause gate: silence every frame of the chunk that falls inside a pause.
    const sessionUs = chunk.sessionUs ?? chunk.timeUs;
    let cursor = skip;
    for (const [from, to] of this.pausedRanges(sessionUs, frames)) {
      const a = Math.max(from, cursor);
      if (to <= a) continue;
      if (a > cursor) ops.push({ type: 'copy', fromFrame: cursor, toFrame: a });
      this.pushSilence(ops, to - a, 'pause');
      cursor = to;
    }
    if (cursor < frames) ops.push({ type: 'copy', fromFrame: cursor, toFrame: frames });

    const framesOut = ops.reduce(
      (n, op) => n + (op.type === 'copy' ? op.toFrame - op.fromFrame : op.frames),
      0,
    );
    this.written += framesOut;
    return { ops, discontinuity, dropped: skip >= frames && frames > 0, framesOut };
  }

  /** Paused frame ranges `[from, to)` of a chunk, sorted and clamped to `[0, frames)`. */
  private pausedRanges(sessionUs: Us, frames: number): [number, number][] {
    const ranges: [number, number][] = [];
    for (const p of this.pauses) {
      const from = Math.max(0, this.usToFrames(p.startUs - sessionUs));
      const to = p.endUs === null ? frames : Math.min(frames, this.usToFrames(p.endUs - sessionUs));
      if (to > from && from < frames) ranges.push([from, to]);
    }
    return ranges.sort((a, b) => a[0] - b[0]);
  }

  private pushSilence(ops: AudioOp[], frames: number, cause: SilenceOp['cause']): void {
    let left = frames;
    while (left > 0) {
      const n = Math.min(left, this.maxSilenceFrames);
      ops.push({ type: 'silence', frames: n, cause });
      left -= n;
    }
  }

  private usToFrames(us: number): number {
    return Math.round((us * this.sampleRate) / 1_000_000);
  }

  private framesToUs(frames: number): Us {
    return Math.round((frames * 1_000_000) / this.sampleRate);
  }
}
