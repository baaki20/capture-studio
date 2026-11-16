/**
 * Starts a recording's cursor track (P3 step 4, R3.7–R3.9): the session manager's
 * `startCursorTrack`. It records only where `capture.cursor.track` is not unavailable (never on
 * Wayland), from the native helper when it starts, else by polling Electron's cursor position.
 *
 * The captured monitor is the display whose id the screen source names (or the only or primary
 * display). Its rect is turned into the source's coordinate space: DIPs as Electron reports them,
 * or device pixels (Windows: `screen.dipToScreenRect`; elsewhere bounds × scale factor).
 */
import type { Logger } from '../../shared/logger';
import type { NativeHelper } from '../native/cs-native';
import { CursorRecorder, monitorMapping } from './cursor-recorder';
import { nativeCursorSource, pollingCursorSource, type CursorSource } from './cursor-source';
import type { SessionManagerDeps } from './session-manager';

/** Cursor samples per second (spec: 120 Hz). */
export const CURSOR_RATE_HZ = 120;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  bounds: Rect;
  scaleFactor: number;
}

export interface CursorTrackStarterDeps {
  helper: NativeHelper | null;
  /** `capture.cursor.track` is not unavailable. */
  available: () => boolean;
  displays: () => DisplayLike[];
  primaryDisplay: () => DisplayLike;
  /** `screen.getCursorScreenPoint()`. */
  cursorPoint: () => { x: number; y: number };
  /** Windows only: `screen.dipToScreenRect(null, rect)`. */
  dipToScreenRect?: (rect: Rect) => Rect;
  platform: NodeJS.Platform;
  mainNowUs: () => number;
  logger: Logger;
}

/** The display's rect in a source's coordinate space. */
export function displayRect(
  display: DisplayLike,
  space: CursorSource['coordinateSpace'],
  platform: NodeJS.Platform,
  dipToScreenRect?: (rect: Rect) => Rect,
): Rect {
  if (space === 'dip') return display.bounds;
  if (platform === 'win32' && dipToScreenRect) return dipToScreenRect(display.bounds);
  const k = display.scaleFactor;
  const { x, y, width, height } = display.bounds;
  return { x: x * k, y: y * k, width: width * k, height: height * k };
}

export function createCursorTrackStarter(
  deps: CursorTrackStarterDeps,
): NonNullable<SessionManagerDeps['startCursorTrack']> {
  return ({ file, source, crop, t0Us }) => {
    if (!deps.available()) return null;
    const displays = deps.displays();
    const display =
      displays.find((d) => String(d.id) === source.displayId) ??
      (displays.length === 1 ? displays[0] : undefined) ??
      deps.primaryDisplay();
    const frame = { width: source.widthPx, height: source.heightPx };
    const record = (cursorSource: CursorSource) => {
      const rect = displayRect(
        display,
        cursorSource.coordinateSpace,
        deps.platform,
        deps.dipToScreenRect,
      );
      const recorder = new CursorRecorder({
        source: cursorSource,
        file,
        mapping: monitorMapping({ display: rect, frame, crop }),
        t0Us,
        mainNowUs: deps.mainNowUs,
        sampleRateHz: CURSOR_RATE_HZ,
        logger: deps.logger,
      });
      const started = recorder.start();
      deps.logger.info(
        `recording: cursor track from ${cursorSource.kind}${started.clicks ? ' with clicks' : ', no clicks'}`,
      );
      return recorder;
    };
    if (deps.helper) {
      try {
        return record(nativeCursorSource(deps.helper, CURSOR_RATE_HZ));
      } catch (error) {
        deps.logger.warn('recording: the native cursor helper did not start; polling', error);
      }
    }
    return record(
      pollingCursorSource({ point: deps.cursorPoint, nowUs: deps.mainNowUs }, CURSOR_RATE_HZ),
    );
  };
}
