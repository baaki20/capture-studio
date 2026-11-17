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
  private forced = false;
  private readonly thresholdUs: Us;

  /**
   * @param frameDurationUs nominal frame duration; a keyframe is forced one frame early so the
   *   fragment it closes stays within `intervalUs`.
   */
  constructor(
    frameDurationUs: Us,
    readonly intervalUs: Us = KEYFRAME_INTERVAL_US,
  ) {
    this.thresholdUs = Math.max(
      0,
      Math.min(intervalUs, MAX_KEYFRAME_INTERVAL_US) - frameDurationUs,
    );
  }

  /** Whether the frame at file time `timeUs` must be encoded as a keyframe. Records it if so. */
  next(timeUs: Us): boolean {
    if (this.forced || this.lastKeyUs === null || timeUs - this.lastKeyUs >= this.thresholdUs) {
      this.lastKeyUs = timeUs;
      this.forced = false;
      return true;
    }
    return false;
  }

  /** File time from which the next frame must be a keyframe (null before the first one). */
  dueAtUs(): Us | null {
    return this.lastKeyUs === null ? null : this.lastKeyUs + this.thresholdUs;
  }

  /**
   * Makes the next frame a keyframe whatever its time. For sources that send frames unevenly
   * (Windows and Wayland send one only when the screen changes): waiting for the first frame
   * after `dueAtUs` would let a fragment run past `intervalUs` (R1.13).
   */
  forceNext(): void {
    this.forced = true;
  }

  /** Records a keyframe the encoder produced on its own (scene cut), which restarts the interval. */
  observedKey(timeUs: Us): void {
    if (this.lastKeyUs === null || timeUs > this.lastKeyUs) this.lastKeyUs = timeUs;
  }
}
