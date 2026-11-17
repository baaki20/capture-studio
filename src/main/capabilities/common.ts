/**
 * Capability helpers shared by the Linux, Windows and macOS detectors (§1.4).
 */
import {
  available,
  degraded,
  unavailable,
  type Capability,
  type FfmpegEncoderReport,
} from '../../shared/capabilities/types';

export interface SecretsStatusLike {
  persistent: boolean;
  backend: string;
  reason: string | null;
}

export function ffmpegHardwareCapability(report: FfmpegEncoderReport | null): Capability {
  if (!report) return unavailable('Encoder probe has not finished; libx264 is used.', 'libx264');
  if (report.hardware) return available(report.hardware, 'Verified with a 1 s test encode.');
  const failed = report.encoders
    .filter((e) => e.kind !== 'software')
    .map((e) => `${e.name}: ${e.listed ? (e.error ?? 'failed') : 'not in this build'}`);
  return unavailable(
    `No working hardware encoder${failed.length ? ` (${failed.join('; ')})` : ''}. libx264 is used.`,
    'libx264',
  );
}

export function secretsCapability(status: SecretsStatusLike | null): Capability {
  if (!status) return unavailable('Secret storage has not been checked yet.');
  return status.persistent
    ? available(`safeStorage:${status.backend}`)
    : unavailable(
        status.reason ?? `Backend ${status.backend} does not encrypt; secrets stay in memory.`,
        `memory (backend ${status.backend})`,
      );
}

/** Whether the native helper loaded (P3 step 4), and its backend or why not. */
export interface NativeHelperStatus {
  /** `x11`, `win32`, `macos` or `unsupported`; null when the helper did not load. */
  backend: string | null;
  reason: string | null;
}

/**
 * `capture.cursor.track` where cursor positions can be read (X11, Windows, macOS): the helper
 * gives 120 Hz positions and clicks; without it Electron's cursor position is polled (no clicks).
 * `clicksBlocked` is the reason clicks cannot be read even with the helper (macOS permission).
 */
export function cursorTrackCapability(
  helper: NativeHelperStatus | null,
  backend: 'x11' | 'win32' | 'macos',
  clicksBlocked: string | null = null,
): Capability {
  if (helper?.backend === backend) {
    return clicksBlocked
      ? degraded('native-helper', `${clicksBlocked} Positions are recorded; clicks are not.`)
      : available('native-helper', 'Cursor positions at 120 Hz and clicks.');
  }
  const why = helper?.reason ?? 'The native helper is not available.';
  return degraded(
    'electron-poll',
    `${why} Cursor positions are polled, without clicks, so click rings and auto-zoom have nothing to show.`,
  );
}

/** The engine measures WebCodecs hardware encoding when recording starts (an override). */
export const webcodecsPending: Capability = unavailable(
  'Probed by the capture engine when recording starts; software H.264 (WebCodecs) is used meanwhile.',
  'webcodecs-software',
);

/**
 * P3 step 2: on Windows and macOS the system audio is Chromium's desktop audio (loopback), an
 * audio track of the screen capture the engine records; on Linux it is `pw-record` in the media
 * utility. With the screen, it needs a screen or window recording and has no idle meter.
 */
export function systemAudioWithScreen(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}
