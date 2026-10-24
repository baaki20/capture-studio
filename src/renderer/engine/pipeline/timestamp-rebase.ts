/**
 * Guards a track against jumps in its media timestamps. Chromium audio timestamps are in their own
 * domain (spike S2) and can restart: in the engine smoke test the first chunk of a fresh
 * `MediaStreamTrackProcessor` carried a timestamp 22 s away from every later chunk. Fed as is,
 * the continuity planner would see every later chunk as an overlap and drop it.
 *
 * Arrival time is the independent reference: `arrivalUs − (timestampUs + durationUs)` (the
 * latency) is stable within tens of ms. When it moves by more than `thresholdUs` from the
 * least-delayed latency seen so far, the timestamps jumped; a correction is added so later
 * timestamps continue in the original domain at the observed arrival time. Ordinary jitter and
 * slow drift never reach the threshold, so they still go to the continuity planner and the drift
 * fit untouched.
 */
import type { Us } from '../../../shared/time';

export const TIMESTAMP_JUMP_US: Us = 1_000_000;

export interface RebasedTimestamp {
  /** The timestamp in the track's original domain. */
  timestampUs: Us;
  /** True when this sample started a new correction. */
  jumped: boolean;
}

export class TimestampRebaser {
  private correctionUs: Us = 0;
  private baselineUs: Us | null = null;
  private count = 0;

  constructor(private readonly thresholdUs: Us = TIMESTAMP_JUMP_US) {}

  /** Number of jumps corrected so far. */
  get jumps(): number {
    return this.count;
  }

  map(arrivalUs: Us, timestampUs: Us, durationUs: Us): RebasedTimestamp {
    let adjusted = timestampUs + this.correctionUs;
    const latency = arrivalUs - (adjusted + durationUs);
    if (this.baselineUs === null) {
      this.baselineUs = latency;
      return { timestampUs: adjusted, jumped: false };
    }
    const deviation = latency - this.baselineUs;
    if (Math.abs(deviation) > this.thresholdUs) {
      this.correctionUs += deviation;
      adjusted += deviation;
      this.count += 1;
      return { timestampUs: adjusted, jumped: true };
    }
    if (latency < this.baselineUs) this.baselineUs = latency;
    return { timestampUs: adjusted, jumped: false };
  }
}
