/**
 * Windows capability detection (§1.4, Phase 3). A pure function of what main already knows, so
 * tests can describe any Windows version without running anything.
 *
 * - Screen, window and camera capture go through Chromium (`desktopCapturer`, `getUserMedia`)
 *   with the in-app source picker, as on X11.
 * - `ui.excludeFromCapture`: `setContentProtection` uses `WDA_EXCLUDEFROMCAPTURE` from Windows 10
 *   2004 (build 19041). Older builds only black the window out in captures, which still shows a
 *   box, so the controls minimize there instead.
 * - `audio.system`: Chromium's desktop audio, the system mix as the screen capture's audio track
 *   (P3 step 2); the engine records it. Not yet checked on a real Windows machine.
 * - `capture.screen.allMonitors`: Chromium's whole-desktop source (P3 step 7), checked on X11;
 *   not yet on a real Windows machine (spike S9).
 */
import {
  available,
  degraded,
  unavailable,
  type CapabilityMap,
  type FfmpegEncoderReport,
} from '../../shared/capabilities/types';
import {
  cursorTrackCapability,
  ffmpegHardwareCapability,
  secretsCapability,
  webcodecsPending,
  type NativeHelperStatus,
  type SecretsStatusLike,
} from './common';

/** First build whose `SetWindowDisplayAffinity` hides a window from captures. */
export const WINDOWS_EXCLUDE_FROM_CAPTURE_BUILD = 19041;

export interface WindowsDetectInput {
  /** `os.release()`, for example `10.0.22631`. */
  osRelease: string;
  secrets: SecretsStatusLike | null;
  encoders: FfmpegEncoderReport | null;
  nativeHelper?: NativeHelperStatus | null;
}

/** The build number from `os.release()`, or null when it cannot be read. */
export function windowsBuild(osRelease: string): number | null {
  const build = Number(osRelease.split('.')[2]);
  return Number.isInteger(build) && build > 0 ? build : null;
}

/**
 * Said of what is built for Windows but not yet checked on a real Windows machine (Phase 3 was
 * built on Linux; `docs/platform-test-backlog.md`). Such capabilities are `degraded`, not
 * `available`, until the per-OS checklist passes.
 */
const UNVERIFIED = 'Not yet checked on a real Windows machine.';

export function detectWindowsCapabilities(input: WindowsDetectInput): CapabilityMap {
  const build = windowsBuild(input.osRelease);
  const hidesFromCapture = build !== null && build >= WINDOWS_EXCLUDE_FROM_CAPTURE_BUILD;

  return {
    'capture.screen.source': available('desktopCapturer', 'In-app source picker.'),
    'capture.screen.restoreToken': available(
      'not-needed',
      'Windows asks no permission to capture.',
    ),
    'capture.screen.allMonitors': degraded(
      'full-desktop-source',
      `With several monitors, the source picker offers "All screens". ${UNVERIFIED}`,
    ),
    'capture.window.enumerate': available('desktopCapturer'),
    'capture.region.onScreenOverlay': degraded(
      'overlay-window',
      `The region is drawn over the live desktop. ${UNVERIFIED}`,
    ),
    'capture.cursor.hide': unavailable(
      'Hiding the cursor is not verified on Windows yet.',
      'cursor-visible',
    ),
    'capture.cursor.track': cursorTrackCapability(input.nativeHelper ?? null, 'win32'),
    'capture.screenshot.silent': available('desktopCapturer'),
    'audio.system': degraded(
      'desktop-loopback',
      `Recorded with the screen capture (Windows loopback); audio-only recordings go without it. ${UNVERIFIED}`,
    ),
    'audio.mic': available('getUserMedia', 'Devices are listed in the setup panel.'),
    'video.camera': available('getUserMedia', 'Devices are listed in the setup panel.'),
    'encode.webcodecs.hw': webcodecsPending,
    'encode.ffmpeg.hw': ffmpegHardwareCapability(input.encoders),
    'hotkeys.global': available('globalShortcut'),
    'ui.tray': available('tray'),
    'ui.alwaysOnTop': available('setAlwaysOnTop'),
    'ui.windowPositioning': available('setBounds'),
    'ui.excludeFromCapture': hidesFromCapture
      ? degraded(
          'minimize-controls',
          'Windows 10 2004 and later can hide windows from captures, but this is not yet checked on a real machine; the controls minimize when recording starts.',
        )
      : degraded(
          'minimize-controls',
          'This Windows version shows protected windows as a black box in captures; the controls minimize when recording starts.',
        ),
    'ui.customToast': available('toast-window'),
    'input.synthetic': unavailable(
      'Needs the native helper (later phase); manual-scroll stitching is used.',
      'manual-scroll',
    ),
    'window.foregroundInfo': unavailable(
      'Needs the native helper (not available yet); %t and %pn resolve to empty.',
    ),
    'window.manipulate': unavailable('Needs the native helper; the tool is hidden.'),
    'colorPicker.screen': available('overlay'),
    'clipboard.writeImageUnfocused': available('clipboard'),
    'secrets.persistent': secretsCapability(input.secrets),
    'startup.login': available('setLoginItemSettings'),
    'shell.contextMenu': unavailable(
      'Explorer integration comes with the installer later; drag and drop works.',
      'drag-drop',
    ),
    'ocr.native': unavailable('Windows OCR is not used yet; tesseract.js is used.', 'tesseract.js'),
  };
}
