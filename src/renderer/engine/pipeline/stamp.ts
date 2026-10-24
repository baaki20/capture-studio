/**
 * Stamping (§4.3.3): maps a track's media timestamps to the session clock with one additive
 * offset, `sessionUs = timestampUs + offsetUs`.
 *
 * The final offset comes from the sync calibrator once every track's 2 s warm-up window is in
 * (`calibrate()` in the engine). Until then the worker needs a live estimate for the pause gate,
 * so the stamper keeps a provisional offset: the smallest `arrivalUs − referenceUs` seen so far,
 * which is the least-delayed observation (the same idea as the calibrator's low percentile).
 *
 * `referenceUs` is what arrival is measured against: the frame timestamp for video, and the
 * **end** of the chunk (`timestampUs + durationUs`) for audio, because a chunk can only arrive
 * after its last sample was captured.
 */
import type { Us } from '../../../shared/time';

export class SessionStamper {
  private provisional: Us | null = null;
  private calibrated: Us | null = null;

  /** Feeds one arrival observation; ignored once the calibrated offset is set. */
  observe(arrivalUs: Us, referenceUs: Us): void {
    const offset = arrivalUs - referenceUs;
    if (this.provisional === null || offset < this.provisional) this.provisional = offset;
  }

  /** Switches to the calibrator's offset for the rest of the stream. */
  calibrate(offsetUs: Us): void {
    this.calibrated = offsetUs;
  }

  get isCalibrated(): boolean {
    return this.calibrated !== null;
  }

  /** The offset in use, or null before the first observation. */
  get offsetUs(): Us | null {
    return this.calibrated ?? this.provisional;
  }

  /** Session time of a media timestamp; falls back to `fallbackUs` before any observation. */
  toSession(timestampUs: Us, fallbackUs: Us): Us {
    const offset = this.offsetUs;
    return offset === null ? fallbackUs : timestampUs + offset;
  }
}

/**
 * `RecordedStream.startOffsetUs`: reference-clock time (µs since t0) of a file's first sample, from
 * its media timestamp and the track's calibrated offset.
 */
export function startOffsetUs(firstTimestampUs: Us, offsetUs: Us, t0Us: Us): Us {
  return Math.round(firstTimestampUs + offsetUs - t0Us);
}
