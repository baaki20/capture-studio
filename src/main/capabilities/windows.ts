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
 * - Features that need later Phase 3 steps (on-screen overlay, whole desktop) stay unavailable
 *   until those steps land.
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

export function detectWindowsCapabilities(input: WindowsDetectInput): CapabilityMap {
  const build = windowsBuild(input.osRelease);
  const hidesFromCapture = build !== null && build >= WINDOWS_EXCLUDE_FROM_CAPTURE_BUILD;

  return {
    'capture.screen.source': available('desktopCapturer', 'In-app source picker.'),
    'capture.screen.restoreToken': available(
      'not-needed',
      'Windows asks no permission to capture.',
    ),
    'capture.screen.allMonitors': unavailable(
      'Recording all monitors at once is not supported yet; one monitor is captured.',
      'one-monitor',
    ),
    'capture.window.enumerate': available('desktopCapturer'),
    'capture.region.onScreenOverlay': unavailable(
      'The on-screen region overlay is not available yet; the in-app frozen-frame picker is used.',
      'in-app-picker',
    ),
    'capture.cursor.hide': unavailable(
      'Hiding the cursor is not verified on Windows yet.',
      'cursor-visible',
    ),
    'capture.cursor.track': cursorTrackCapability(input.nativeHelper ?? null, 'win32'),
    'capture.screenshot.silent': available('desktopCapturer'),
    'audio.system': available(
      'desktop-loopback',
      'Recorded with the screen capture (Windows loopback); audio-only recordings go without it.',
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
      ? available('setContentProtection')
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
