/**
 * Stream statistics (§4.3.3: frames in, encoded, dropped; bytes; discontinuities; queue depth,
 * posted at 2 Hz). Each worker keeps a `StreamCounters`; the engine merges the workers' reports
 * with a `StatsAggregator` and sends `engine.stats` on its own 2 Hz timer.
 *
 * Dropped frames are judged against the **delivered** rate (§9.3) with `dropAccounting`. Audio
 * reports carry the peak level and the drift checkpoints produced since the previous report, so
 * the session manager can append them to `<kind>.sync.json` while recording (crash safety).
 */
import type { EngineStreamStats, StreamKind } from '../../../shared/ipc/contract';
import type { Checkpoint } from '../../../shared/recording/drift';
import type { Us } from '../../../shared/time';
import { dropAccounting } from '../encoder-select';

export const STATS_INTERVAL_MS = 500;

export type StreamState = NonNullable<EngineStreamStats['state']>;

export interface CountersInit {
  kind: StreamKind;
  streamId: string;
  /** Video only: the requested rate, the fallback until a delivered rate is measured. */
  requestedFps?: number;
}

export interface SnapshotInput {
  state: StreamState;
  queueDepth: number;
  /** Video: from `FrameRateMeter`. */
  deliveredFps?: number | null;
  /** Video: recording time with pauses removed, for the expected frame count. */
  activeUs?: Us;
}

export class StreamCounters {
  framesIn = 0;
  framesEncoded = 0;
  framesDropped = 0;
  framesPaused = 0;
  bytes = 0;
  discontinuities = 0;
  samplesWritten = 0;
  silenceSamples = 0;
  private peak = 0;
  private readonly pending: Checkpoint[] = [];
  private readonly all: Checkpoint[] = [];

  constructor(private readonly init: CountersInit) {}

  get isVideo(): boolean {
    return this.init.kind === 'screen' || this.init.kind === 'camera';
  }

  notePeak(level: number): void {
    if (level > this.peak) this.peak = level;
  }

  addCheckpoint(checkpoint: Checkpoint): void {
    this.pending.push(checkpoint);
    this.all.push(checkpoint);
  }

  get checkpoints(): readonly Checkpoint[] {
    return this.all;
  }

  /** The report for one stats tick; resets the peak and the pending checkpoints. */
  snapshot(input: SnapshotInput): EngineStreamStats {
    const stats: EngineStreamStats = {
      kind: this.init.kind,
      streamId: this.init.streamId,
      framesIn: this.framesIn,
      framesEncoded: this.framesEncoded,
      framesDropped: this.framesDropped,
      framesPaused: this.framesPaused,
      bytes: this.bytes,
      discontinuities: this.discontinuities,
      queueDepth: Math.max(0, Math.round(input.queueDepth)),
      state: input.state,
    };
    if (this.isVideo) {
      const deliveredFps = input.deliveredFps ?? null;
      const accounting = dropAccounting({
        framesDropped: this.framesDropped,
        framesIn: this.framesIn - this.framesPaused,
        activeUs: input.activeUs ?? 0,
        requestedFps: this.init.requestedFps ?? 30,
        deliveredFps,
      });
      stats.deliveredFps = deliveredFps;
      stats.droppedRatio = accounting.droppedRatio;
      stats.dropLevel = accounting.level;
    } else {
      stats.samplesWritten = this.samplesWritten;
      stats.level = this.peak;
      stats.checkpoints = this.pending.map(([a, b]) => [a, b]);
      this.pending.length = 0;
      this.peak = 0;
    }
    return stats;
  }
}

/**
 * Keeps the latest report per stream. Audio peaks and checkpoints from reports that arrive
 * between two `drain` calls are merged, so none are lost when workers report faster than the
 * engine sends.
 */
export class StatsAggregator {
  private readonly latest = new Map<string, EngineStreamStats>();

  update(stats: EngineStreamStats): void {
    const key = stats.streamId ?? stats.kind;
    const previous = this.latest.get(key);
    const merged: EngineStreamStats = { ...stats };
    if (previous?.checkpoints?.length) {
      merged.checkpoints = [...previous.checkpoints, ...(stats.checkpoints ?? [])];
    }
    if (previous?.level !== undefined && stats.level !== undefined) {
      merged.level = Math.max(previous.level, stats.level);
    }
    this.latest.set(key, merged);
  }

  remove(streamId: string): void {
    this.latest.delete(streamId);
  }

  get size(): number {
    return this.latest.size;
  }

  /** The `engine.stats` payload; clears the merged peaks and checkpoints. */
  drain(atUs: Us): { atUs: Us; streams: EngineStreamStats[] } {
    const streams = [...this.latest.values()].map((s) => ({ ...s }));
    for (const [key, s] of this.latest) {
      if (s.checkpoints !== undefined || s.level !== undefined) {
        this.latest.set(key, {
          ...s,
          ...(s.checkpoints !== undefined ? { checkpoints: [] } : {}),
          ...(s.level !== undefined ? { level: 0 } : {}),
        });
      }
    }
    return { atUs, streams };
  }

  clear(): void {
    this.latest.clear();
  }
}
