/**
 * The video pause gate (§1.5, §4.3.3, R1.14). Pauses are pressed in session time; a frame whose
 * stamped session time falls inside a pause is not encoded (it is closed and counted as paused,
 * not dropped). Audio uses `AudioContinuity.pause/resume`, which replaces paused samples with
 * silence instead.
 *
 * The schedule also gives the active (unpaused) recording time used for dropped-frame accounting.
 */
import type { Us } from '../../../shared/time';

export interface PauseSpan {
  startUs: Us;
  /** null while the pause is open. */
  endUs: Us | null;
}

export class PauseSchedule {
  private readonly spans: PauseSpan[] = [];

  get paused(): boolean {
    return this.spans[this.spans.length - 1]?.endUs === null;
  }

  /** Opens a pause; ignored while already paused. Returns whether a pause was opened. */
  pause(atUs: Us): boolean {
    if (this.paused) return false;
    this.spans.push({ startUs: atUs, endUs: null });
    return true;
  }

  /** Closes the open pause; ignored while not paused. Returns whether a pause was closed. */
  resume(atUs: Us): boolean {
    const last = this.spans[this.spans.length - 1];
    if (last?.endUs !== null) return false;
    last.endUs = Math.max(atUs, last.startUs);
    return true;
  }

  /** True when `sessionUs` lies in `[start, end)` of a pause (an open pause has no end). */
  isPaused(sessionUs: Us): boolean {
    return this.spans.some(
      (s) => sessionUs >= s.startUs && (s.endUs === null || sessionUs < s.endUs),
    );
  }

  /** Time in `[fromUs, toUs)` outside every pause. */
  activeUs(fromUs: Us, toUs: Us): Us {
    if (toUs <= fromUs) return 0;
    let paused = 0;
    for (const s of this.spans) {
      const a = Math.max(fromUs, s.startUs);
      const b = Math.min(toUs, s.endUs ?? toUs);
      if (b > a) paused += b - a;
    }
    return toUs - fromUs - paused;
  }

  /** Closed spans, plus the open one ended at `nowUs`. */
  spansUntil(nowUs: Us): { startUs: Us; endUs: Us }[] {
    return this.spans.map((s) => ({
      startUs: s.startUs,
      endUs: s.endUs ?? Math.max(nowUs, s.startUs),
    }));
  }
}
