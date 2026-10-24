/**
 * Time helpers. Every time value in Capture Studio is an integer number of microseconds (§1.7).
 * Floating-point seconds appear only at the edges (FFmpeg arguments, media element APIs).
 */

/** Integer microseconds. */
export type Us = number;

export const US_PER_MS = 1_000;
export const US_PER_SECOND = 1_000_000;

export function isUs(value: unknown): value is Us {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Throws if `value` is not a safe integer. Use at trust boundaries, not in hot loops. */
export function assertUs(value: number, label = 'time'): Us {
  if (!isUs(value)) {
    throw new RangeError(
      `${label} must be an integer number of microseconds, got ${String(value)}`,
    );
  }
  return value;
}

export function msToUs(ms: number): Us {
  return Math.round(ms * US_PER_MS);
}

export function usToMs(us: Us): number {
  return us / US_PER_MS;
}

export function secondsToUs(seconds: number): Us {
  return Math.round(seconds * US_PER_SECOND);
}

export function usToSeconds(us: Us): number {
  return us / US_PER_SECOND;
}

export function clampUs(value: Us, min: Us, max: Us): Us {
  return Math.min(Math.max(value, min), max);
}

/** Frame rates are positive integers in Phase 1 (24, 25, 30, 50, 60). */
function assertFps(fps: number): void {
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new RangeError(`frame rate must be a positive integer, got ${String(fps)}`);
  }
}

/**
 * Start time of frame `index` at `fps`. Frame boundaries are rounded to the nearest microsecond,
 * so they never accumulate error: frame 30 at 30 fps is exactly 1 s.
 */
export function frameToUs(index: number, fps: number): Us {
  assertFps(fps);
  return Math.round((index * US_PER_SECOND) / fps);
}

/** Index of the frame that contains `us` (frames are half-open intervals [start, nextStart)). */
export function usToFrame(us: Us, fps: number): number {
  assertFps(fps);
  let index = Math.floor((us * fps) / US_PER_SECOND);
  // Correct for rounding in frameToUs so that usToFrame(frameToUs(i)) === i.
  if (frameToUs(index + 1, fps) <= us) index += 1;
  else if (frameToUs(index, fps) > us) index -= 1;
  return index;
}

/** Duration of one frame, rounded down to whole microseconds. */
export function frameDurationUs(fps: number): Us {
  assertFps(fps);
  return Math.floor(US_PER_SECOND / fps);
}

export type SnapMode = 'floor' | 'nearest' | 'ceil';

/** Snaps a time to a frame boundary. */
export function snapToFrame(us: Us, fps: number, mode: SnapMode = 'nearest'): Us {
  const index = usToFrame(us, fps);
  const start = frameToUs(index, fps);
  if (start === us || mode === 'floor') return start;
  const next = frameToUs(index + 1, fps);
  if (mode === 'ceil') return next;
  return us - start < next - us ? start : next;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Formats a time as `hh:mm:ss:ff` (R1.34). Negative times get a leading `-`.
 * Hours are not wrapped, so long timelines show `100:00:00:00`.
 */
export function formatTimecode(us: Us, fps: number): string {
  assertFps(fps);
  const sign = us < 0 ? '-' : '';
  const totalFrames = usToFrame(Math.abs(us), fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${sign}${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
}

const TIMECODE_RE = /^(-)?(\d+):([0-5]\d):([0-5]\d)[:;](\d+)$/;

/** Parses `hh:mm:ss:ff` back to the start time of that frame. Returns null if malformed. */
export function parseTimecode(text: string, fps: number): Us | null {
  assertFps(fps);
  const match = TIMECODE_RE.exec(text.trim());
  if (!match) return null;
  const [, sign, h, m, s, f] = match;
  const frames = Number(f);
  if (frames >= fps) return null;
  const totalFrames = (Number(h) * 3600 + Number(m) * 60 + Number(s)) * fps + frames;
  const us = frameToUs(totalFrames, fps);
  return sign ? -us : us;
}
