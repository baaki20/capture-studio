/**
 * Times at the MCP edge. Tools take seconds (`12.5`) or clock strings (`"1:02.5"`,
 * `"0:01:02.5"`, or `"00:01:02:15"` with frames) and report seconds plus `hh:mm:ss:ff`
 * timecode; the app works in integer microseconds.
 */
import { z } from 'zod';
import { parseTimecode, secondsToUs, type Us } from '../shared/time';

export const TimeInput = z
  .union([z.number().nonnegative(), z.string().min(1).max(32)])
  .describe(
    'Timeline time: seconds as a number (12.5), or "m:ss.s", "h:mm:ss.s", or timecode "hh:mm:ss:ff"',
  );
export type TimeInput = z.infer<typeof TimeInput>;

const CLOCK_RE = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;
const SECONDS_RE = /^(\d+(?:\.\d+)?)\s*s?$/;

/** Microseconds for a time input, or throws a readable error. */
export function toUs(input: TimeInput, frameRate: number): Us {
  if (typeof input === 'number') return secondsToUs(input);
  const text = input.trim();
  const seconds = SECONDS_RE.exec(text);
  if (seconds) return secondsToUs(Number(seconds[1]));
  if (text.split(/[:;]/).length === 4) {
    const us = parseTimecode(text, frameRate);
    if (us !== null && us >= 0) return us;
  }
  const clock = CLOCK_RE.exec(text);
  if (clock) {
    const [, h, m, s] = clock;
    if (Number(s) < 60 && (h === undefined || Number(m) < 60)) {
      return secondsToUs(Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s));
    }
  }
  throw new Error(
    `"${input}" is not a time: use seconds (12.5), "m:ss.s", "h:mm:ss.s" or "hh:mm:ss:ff"`,
  );
}

/** Seconds rounded to the millisecond, for messages. */
export function secondsText(us: Us): string {
  return `${String(Math.round(us / 1000) / 1000)} s`;
}
