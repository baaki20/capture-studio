/**
 * Per-frame video policies (§4.3.3):
 * - **Backpressure:** when `encoder.encodeQueueSize` exceeds 2 × fps the frame is dropped and
 *   counted. Nothing is burst-filled later; the file is VFR, so a gap is fine.
 * - **Keyframe cadence:** a keyframe at least every 2 s is the spec's floor. mediabunny starts a
 *   fragment only on a keyframe, so fragments are as long as the keyframe interval; to keep every
 *   fragment ≤ 1 s (R1.13, §9.6) keyframes are forced so that the next one lands no later than
 *   1 s after the previous one.
 */
import type { Us } from '../../../shared/time';

/** R1.13: no fragment longer than 1 s. */
export const KEYFRAME_INTERVAL_US: Us = 1_000_000;

/** §4.3.4/§4.3.3 floor; the cadence above is stricter. */
export const MAX_KEYFRAME_INTERVAL_US: Us = 2_000_000;

export function backpressureLimit(fps: number): number {
  return 2 * fps;
}

export function shouldDropForBackpressure(encodeQueueSize: number, fps: number): boolean {
  return encodeQueueSize > backpressureLimit(fps);
}

export class KeyframeCadence {
  private lastKeyUs: Us | null = null;
  private readonly thresholdUs: Us;

  /**
   * @param frameDurationUs nominal frame duration; a keyframe is forced one frame early so the
   *   fragment it closes stays within `intervalUs`.
   * @param earlyUs how much earlier still a keyframe falls due. Sources that send frames only on
   *   change (Windows, Wayland) rely on a timer that repeats the last frame; this slack covers the
   *   timer period and its lateness, so the keyframe lands before `intervalUs` (R1.13,
   *   `stillRepeatAt`).
   */
  constructor(
    frameDurationUs: Us,
    readonly intervalUs: Us = KEYFRAME_INTERVAL_US,
    earlyUs: Us = 0,
  ) {
    this.thresholdUs = Math.max(
      0,
      Math.min(intervalUs, MAX_KEYFRAME_INTERVAL_US) - frameDurationUs - earlyUs,
    );
  }

  /** Whether the frame at file time `timeUs` must be encoded as a keyframe. Records it if so. */
  next(timeUs: Us): boolean {
    if (this.lastKeyUs === null || timeUs - this.lastKeyUs >= this.thresholdUs) {
      this.lastKeyUs = timeUs;
      return true;
    }
    return false;
  }

  /** File time from which a frame is a keyframe (null before the first one). */
  dueAtUs(): Us | null {
    return this.lastKeyUs === null ? null : this.lastKeyUs + this.thresholdUs;
  }

  /** Records a keyframe the encoder produced on its own (scene cut), which restarts the interval. */
  observedKey(timeUs: Us): void {
    if (this.lastKeyUs === null || timeUs > this.lastKeyUs) this.lastKeyUs = timeUs;
  }
}

/**
 * When the screen pipeline's timer should encode the last frame again, and at which file time;
 * null for not now. A repeat sits behind the clock so the next real frame still sorts after it:
 * `lagUs` for the repeat after `repeatAfterUs` of stillness (fragments keep closing, R1.21), and
 * the shorter `keyLagUs` for the repeat made as soon as it reaches the keyframe due time, so that
 * keyframe lands at most one timer period (plus its lateness) after `dueAtUs` (R1.13).
 */
export function stillRepeatAt(input: {
  /** File time of the last frame kept for repeats, and how long ago it arrived. */
  lastFileUs: Us;
  stillForUs: Us;
  /** The cadence's due time. */
  dueAtUs: Us | null;
  /** File time of the last frame encoded; a repeat must come after it. */
  lastEncodedUs: Us;
  lagUs: Us;
  keyLagUs: Us;
  repeatAfterUs: Us;
}): Us | null {
  const keyUs = input.lastFileUs + input.stillForUs - input.keyLagUs;
  if (input.dueAtUs !== null && keyUs >= input.dueAtUs && keyUs > input.lastEncodedUs) return keyUs;
  const fileUs = input.lastFileUs + input.stillForUs - input.lagUs;
  if (input.stillForUs < input.repeatAfterUs || fileUs <= input.lastEncodedUs) return null;
  return fileUs;
}
