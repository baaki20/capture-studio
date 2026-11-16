/**
 * Cursor tracks (v3, plan decision D8, R3.7–R3.12): the `cursor.jsonl` file the native helper
 * writes next to the screen video, and the positions the editor's cursor effects read from it.
 *
 * File format (JSON Lines, UTF-8):
 * - Line 1, the header: `{"format":"capture-studio.cursor","version":1,"sampleRateHz":120,
 *   "width":W,"height":H}`. `width` × `height` is the screen video's frame size; positions are in
 *   its pixels (they may lie outside it when the cursor leaves the captured area).
 * - Then one event per line, times in file-local µs from the media's start, never decreasing:
 *   `[tUs, x, y]` a position, or `[tUs, x, y, "down" | "up", "left" | "right" | "middle"]` a
 *   button press or release (also a position).
 *
 * A recording that ended abruptly may leave a partial last line without a newline; it is ignored.
 * Any other malformed line makes the file invalid.
 *
 * Sampling: the position at a time is interpolated linearly between events (held before the
 * first and after the last). Smoothing averages the path with a Gaussian over time, centred on
 * the time (the editor can look ahead), and fades out near clicks so the cursor sits exactly on
 * each click. Everything here is pure arithmetic, so the preview and the export compute the same
 * positions.
 */

export const CURSOR_FILE_FORMAT = 'capture-studio.cursor';
export const CURSOR_FILE_VERSION = 1;
/** Conventional file name inside the project's media folder. */
export const CURSOR_FILE_NAME = 'cursor.jsonl';

export type CursorButton = 'left' | 'right' | 'middle';

export interface CursorTrackHeader {
  sampleRateHz: number;
  width: number;
  height: number;
}

export interface CursorClick {
  /** File-local µs of the press. */
  tUs: number;
  x: number;
  y: number;
  button: CursorButton;
  /** File-local µs of the release, or null if none was recorded. */
  upUs: number | null;
}

export interface CursorTrack {
  header: CursorTrackHeader;
  /** Event times (µs), positions in video pixels; one entry per event, sorted by time. */
  t: Float64Array;
  x: Float32Array;
  y: Float32Array;
  /** Presses, in time order. */
  clicks: CursorClick[];
}

export type CursorEvent =
  | { tUs: number; x: number; y: number }
  | { tUs: number; x: number; y: number; action: 'down' | 'up'; button: CursorButton };

export class CursorTrackError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`cursor track line ${String(line)}: ${message}`);
    this.name = 'CursorTrackError';
  }
}

const BUTTONS = new Set<string>(['left', 'right', 'middle']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseHeader(line: string): CursorTrackHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CursorTrackError('the header is not JSON', 1);
  }
  const h = raw as Record<string, unknown> | null;
  if (typeof h !== 'object' || h?.format !== CURSOR_FILE_FORMAT) {
    throw new CursorTrackError(`not a ${CURSOR_FILE_FORMAT} file`, 1);
  }
  if (h.version !== CURSOR_FILE_VERSION) {
    throw new CursorTrackError(`unsupported version ${String(h.version)}`, 1);
  }
  const { sampleRateHz, width, height } = h;
  if (!isFiniteNumber(sampleRateHz) || sampleRateHz <= 0) {
    throw new CursorTrackError('sampleRateHz must be a positive number', 1);
  }
  const positive = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
  if (!positive(width) || !positive(height)) {
    throw new CursorTrackError('width and height must be positive integers', 1);
  }
  return { sampleRateHz, width, height };
}

function parseEvent(line: string, lineNo: number): CursorEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CursorTrackError('not JSON', lineNo);
  }
  if (!Array.isArray(raw) || (raw.length !== 3 && raw.length !== 5)) {
    throw new CursorTrackError('expected [t, x, y] or [t, x, y, action, button]', lineNo);
  }
  const [tUs, x, y, action, button] = raw as unknown[];
  if (!Number.isInteger(tUs) || (tUs as number) < 0) {
    throw new CursorTrackError('the time must be a non-negative integer', lineNo);
  }
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    throw new CursorTrackError('the position must be numbers', lineNo);
  }
  if (raw.length === 3) return { tUs: tUs as number, x, y };
  if (
    (action !== 'down' && action !== 'up') ||
    typeof button !== 'string' ||
    !BUTTONS.has(button)
  ) {
    throw new CursorTrackError('unknown action or button', lineNo);
  }
  return { tUs: tUs as number, x, y, action, button: button as CursorButton };
}

/** Parses a `cursor.jsonl` file. Throws `CursorTrackError` when it is malformed. */
export function parseCursorTrack(text: string): CursorTrack {
  const lines = text.split('\n');
  const terminated = text.endsWith('\n');
  // A partial last line (no newline) from an abrupt end is dropped if it does not parse.
  if (terminated || lines[lines.length - 1] === '') lines.pop();
  const header = parseHeader(lines[0] ?? '');
  const events: CursorEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const last = i === lines.length - 1 && !terminated;
    let event: CursorEvent;
    try {
      event = parseEvent(line, i + 1);
    } catch (e) {
      if (last) break;
      throw e;
    }
    const prev = events[events.length - 1];
    if (prev && event.tUs < prev.tUs) {
      throw new CursorTrackError('times must not decrease', i + 1);
    }
    events.push(event);
  }
  return cursorTrackFromEvents(header, events);
}

/** Builds a track from events in time order (the parser, tests and synthetic fixtures). */
export function cursorTrackFromEvents(
  header: CursorTrackHeader,
  events: readonly CursorEvent[],
): CursorTrack {
  const n = events.length;
  const t = new Float64Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const clicks: CursorClick[] = [];
  const open = new Map<CursorButton, CursorClick>();
  events.forEach((event, i) => {
    t[i] = event.tUs;
    x[i] = event.x;
    y[i] = event.y;
    if (!('action' in event)) return;
    if (event.action === 'down') {
      const click: CursorClick = {
        tUs: event.tUs,
        x: event.x,
        y: event.y,
        button: event.button,
        upUs: null,
      };
      clicks.push(click);
      open.set(event.button, click);
    } else {
      const click = open.get(event.button);
      if (click) click.upUs = event.tUs;
      open.delete(event.button);
    }
  });
  return { header, t, x, y, clicks };
}

/** The header line of a `cursor.jsonl` file (without the newline). */
export function cursorHeaderLine(header: CursorTrackHeader): string {
  return JSON.stringify({
    format: CURSOR_FILE_FORMAT,
    version: CURSOR_FILE_VERSION,
    sampleRateHz: header.sampleRateHz,
    width: header.width,
    height: header.height,
  });
}

/** One event line of a `cursor.jsonl` file (without the newline). */
export function cursorEventLine(e: CursorEvent): string {
  return JSON.stringify('action' in e ? [e.tUs, e.x, e.y, e.action, e.button] : [e.tUs, e.x, e.y]);
}

/** Serializes events as a `cursor.jsonl` file (the recorder writes the same lines, streamed). */
export function serializeCursorTrack(
  header: CursorTrackHeader,
  events: readonly CursorEvent[],
): string {
  return [cursorHeaderLine(header), ...events.map(cursorEventLine)].join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Sampling

export interface Point {
  x: number;
  y: number;
}

/** Index of the last event at or before `tUs`, or −1 when `tUs` is before the first. */
function eventIndexAt(track: CursorTrack, tUs: number): number {
  const { t } = track;
  let lo = 0;
  let hi = t.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((t[mid] ?? 0) <= tUs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The recorded position at file time `tUs`, interpolated; null for an empty track. */
export function rawPositionAt(track: CursorTrack, tUs: number): Point | null {
  const n = track.t.length;
  if (n === 0) return null;
  const i = eventIndexAt(track, tUs);
  if (i < 0) return { x: track.x[0] ?? 0, y: track.y[0] ?? 0 };
  if (i >= n - 1) return { x: track.x[n - 1] ?? 0, y: track.y[n - 1] ?? 0 };
  const t0 = track.t[i] ?? 0;
  const t1 = track.t[i + 1] ?? 0;
  const x0 = track.x[i] ?? 0;
  const y0 = track.y[i] ?? 0;
  if (t1 <= t0) return { x: track.x[i + 1] ?? x0, y: track.y[i + 1] ?? y0 };
  const f = (tUs - t0) / (t1 - t0);
  return { x: x0 + ((track.x[i + 1] ?? x0) - x0) * f, y: y0 + ((track.y[i + 1] ?? y0) - y0) * f };
}

/** Gaussian σ at full smoothing. */
export const SMOOTHING_SIGMA_MAX_US = 120_000;
/** Within this time of a click, smoothing fades out so the cursor rests on the click. */
export const CLICK_SETTLE_US = 150_000;
/** Step between the path samples the smoothing averages. */
const SMOOTHING_STEP_US = 4_000;

/** Time from `tUs` to the nearest press (∞ without clicks). */
export function nearestClickDistanceUs(track: CursorTrack, tUs: number): number {
  const { clicks } = track;
  let lo = 0;
  let hi = clicks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((clicks[mid]?.tUs ?? 0) < tUs) lo = mid + 1;
    else hi = mid - 1;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const j of [lo - 1, lo]) {
    const click = clicks[j];
    if (click) best = Math.min(best, Math.abs(click.tUs - tUs));
  }
  return best;
}

/**
 * The cursor position at file time `tUs` with `smoothing` in 0–1 (0 = the recorded path).
 * Null for an empty track.
 */
export function positionAt(track: CursorTrack, tUs: number, smoothing: number): Point | null {
  const raw = rawPositionAt(track, tUs);
  if (!raw || smoothing <= 0) return raw;
  const settle = Math.min(1, nearestClickDistanceUs(track, tUs) / CLICK_SETTLE_US);
  const sigma = Math.min(1, smoothing) * SMOOTHING_SIGMA_MAX_US * settle;
  if (sigma < SMOOTHING_STEP_US / 2) return raw;
  const steps = Math.ceil((3 * sigma) / SMOOTHING_STEP_US);
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let k = -steps; k <= steps; k++) {
    const dt = k * SMOOTHING_STEP_US;
    const w = Math.exp(-(dt * dt) / (2 * sigma * sigma));
    const p = rawPositionAt(track, tUs + dt) ?? raw;
    sx += p.x * w;
    sy += p.y * w;
    sw += w;
  }
  return { x: sx / sw, y: sy / sw };
}

/** Presses whose ring is showing at `tUs`: pressed in `(tUs − durationUs, tUs]`. */
export function clicksShowingAt(
  track: CursorTrack,
  tUs: number,
  durationUs: number,
): CursorClick[] {
  const out: CursorClick[] = [];
  for (const click of track.clicks) {
    if (click.tUs > tUs) break;
    if (tUs - click.tUs < durationUs) out.push(click);
  }
  return out;
}
