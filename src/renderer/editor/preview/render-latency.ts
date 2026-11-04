/**
 * How far ahead of the heard time the preview must render while playing (R1.24 in the preview).
 *
 * A playing frame reaches the screen some time after `Playback` asks for it: the request goes to
 * the worker, which decodes and draws, and the canvas is shown at the next display refresh. The
 * e2e sync test measured 2–5 refreshes under software WebGL, which put the picture 55–110 ms
 * behind the sound. Rendering `heard + lead` cancels that delay.
 *
 * The lead is the median request → drawn time of recent playing frames, plus one refresh for
 * the canvas to be shown. The median ignores one-off stalls (a keyframe, a GC pause).
 */
export const DISPLAY_FRAME_MS = 1000 / 60;
/** A stalled preview must not push the picture far ahead of the sound. */
export const MAX_LEAD_MS = 250;
const WINDOW = 31;

export class RenderLatency {
  private samples: number[] = [];

  /** A playing frame was drawn `ms` after it was requested. */
  sample(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  /** The lead to add to the heard time, in µs (0 until a frame has been timed). */
  leadUs(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return Math.round(Math.min(median + DISPLAY_FRAME_MS, MAX_LEAD_MS) * 1000);
  }

  reset(): void {
    this.samples = [];
  }
}
