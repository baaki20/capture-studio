/**
 * Preview instrumentation (§4.6.4): late video frames while playing. A playing render request is
 * late when it never reached the screen (a newer request replaced it while the worker was busy)
 * or was drawn with a stand-in because its exact frame was not decoded yet. The performance test
 * asserts late frames stay under 1 % over 5 minutes of 1080p30 playback.
 */
export interface PreviewCounterValues {
  /** Render requests made while playing. */
  requested: number;
  /** Playing requests replaced by a newer one before the worker drew them. */
  superseded: number;
  /** Playing requests the worker drew. */
  drawn: number;
  /** Drawn playing requests that showed a stand-in frame. */
  inexact: number;
  /** `superseded + inexact`. */
  late: number;
}

export class PlaybackCounters {
  private values: Omit<PreviewCounterValues, 'late'> = {
    requested: 0,
    superseded: 0,
    drawn: 0,
    inexact: 0,
  };

  /** A render request; `replacedPlaying` when it replaced a waiting playing request. */
  request(playing: boolean, replacedPlaying: boolean): void {
    if (playing) this.values.requested += 1;
    if (replacedPlaying) this.values.superseded += 1;
  }

  /** The worker drew a request. */
  drawn(playing: boolean, exact: boolean): void {
    if (!playing) return;
    this.values.drawn += 1;
    if (!exact) this.values.inexact += 1;
  }

  snapshot(): PreviewCounterValues {
    return { ...this.values, late: this.values.superseded + this.values.inexact };
  }

  reset(): void {
    this.values = { requested: 0, superseded: 0, drawn: 0, inexact: 0 };
  }
}
