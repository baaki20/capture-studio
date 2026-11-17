/**
 * macOS capability detection (§1.4, Phase 3). A pure function of the macOS version and the
 * privacy (TCC) permission states main reads with `systemPreferences`, so tests can describe any
 * Mac without running anything.
 *
 * - Screen capture goes through Chromium (ScreenCaptureKit) and needs Screen Recording
 *   permission. Camera and microphone need their own permissions; macOS asks on first use.
 * - `ui.excludeFromCapture`: reports say ScreenCaptureKit on macOS 15 and later captures windows
 *   that set `NSWindowSharingNone`, so it is degraded there (the controls minimize) until spike
 *   S10 checks it.
 * - `audio.system`: ScreenCaptureKit's audio with the screen capture, macOS 13+ (P3 step 2),
 *   degraded until spike S10 checks it on a real Mac.
 * - Features that need later Phase 3 steps stay unavailable until then.
 */
import {
  available,
  degraded,
  unavailable,
  type Capability,
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

/** `systemPreferences.getMediaAccessStatus` results. */
export type MacAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface MacPermissions {
  screen: MacAccessStatus;
  camera: MacAccessStatus;
  microphone: MacAccessStatus;
  /** `systemPreferences.isTrustedAccessibilityClient(false)`. */
  accessibility: boolean;
}

export interface MacDetectInput {
  /** `os.release()`: the Darwin version, for example `24.1.0` on macOS 15. */
  osRelease: string;
  permissions: MacPermissions | null;
  secrets: SecretsStatusLike | null;
  encoders: FfmpegEncoderReport | null;
  nativeHelper?: NativeHelperStatus | null;
}

/** The macOS major version from the Darwin version (Darwin 25 is macOS 26), or null. */
export function macosMajor(osRelease: string): number | null {
  const darwin = Number(osRelease.split('.')[0]);
  if (!Number.isInteger(darwin) || darwin < 20) return null;
  return darwin >= 25 ? darwin + 1 : darwin - 9;
}

const SETTINGS_HINT = 'System Settings → Privacy & Security';

/** A capability that depends on one TCC permission. */
function permissionGated(
  status: MacAccessStatus | undefined,
  strategy: string,
  pane: string,
  firstUse: string,
): Capability {
  switch (status) {
    case 'granted':
      return available(strategy);
    case 'denied':
      return unavailable(
        `${pane} permission is off. Turn on Capture Studio in ${SETTINGS_HINT} → ${pane}.`,
        strategy,
      );
    case 'restricted':
      return unavailable(
        `${pane} is blocked on this Mac (for example by a device policy).`,
        strategy,
      );
    default:
      return degraded(strategy, firstUse);
  }
}

/** First macOS whose ScreenCaptureKit captures system audio. */
export const MACOS_SYSTEM_AUDIO_MAJOR = 13;

/**
 * System audio (P3 step 2): ScreenCaptureKit's audio as the screen capture's audio track, from
 * macOS 13. Degraded until spike S10 confirms the pinned Electron delivers it: a capture without
 * audio records on without it.
 */
function macSystemAudio(major: number | null, screen: Capability): Capability {
  if (major !== null && major < MACOS_SYSTEM_AUDIO_MAJOR) {
    return unavailable(
      'System audio needs macOS 13 or later. Recording continues without it.',
      'desktop-loopback',
    );
  }
  if (screen.state === 'unavailable') return screen;
  return degraded(
    'desktop-loopback',
    'Recorded with the screen capture (ScreenCaptureKit); not yet verified on this macOS, so a capture without audio records on without it. Audio-only recordings go without it.',
  );
}

export function detectMacCapabilities(input: MacDetectInput): CapabilityMap {
  const major = macosMajor(input.osRelease);
  const p = input.permissions;
  const screen = permissionGated(
    p?.screen,
    'screencapturekit',
    'Screen Recording',
    'macOS asks for Screen Recording permission on the first recording.',
  );
  const sharingNoneHonoured = major !== null && major < 15;

  return {
    'capture.screen.source': screen,
    'capture.screen.restoreToken': available('not-needed', 'Permission is kept once granted.'),
    'capture.screen.allMonitors': unavailable(
      'macOS captures one display per stream; one display is captured.',
      'one-display',
    ),
    'capture.window.enumerate':
      screen.state === 'available' ? available('desktopCapturer') : screen,
    'capture.region.onScreenOverlay': unavailable(
      'The on-screen region overlay is not available yet; the in-app frozen-frame picker is used.',
      'in-app-picker',
    ),
    'capture.cursor.hide': unavailable(
      'Hiding the cursor is not verified on macOS yet.',
      'cursor-visible',
    ),
    'capture.cursor.track': cursorTrackCapability(
      input.nativeHelper ?? null,
      'macos',
      p && !p.accessibility ? 'Clicks need Accessibility permission (System Settings).' : null,
    ),
    'capture.screenshot.silent': screen,
    'audio.system': macSystemAudio(major, screen),
    'audio.mic': permissionGated(
      p?.microphone,
      'getUserMedia',
      'Microphone',
      'macOS asks for microphone permission the first time a microphone is used.',
    ),
    'video.camera': permissionGated(
      p?.camera,
      'getUserMedia',
      'Camera',
      'macOS asks for camera permission the first time a camera is used.',
    ),
    'encode.webcodecs.hw': webcodecsPending,
    'encode.ffmpeg.hw': ffmpegHardwareCapability(input.encoders),
    'hotkeys.global': available('globalShortcut'),
    'ui.tray': available('tray'),
    'ui.alwaysOnTop': available('setAlwaysOnTop'),
    'ui.windowPositioning': available('setBounds'),
    'ui.excludeFromCapture': sharingNoneHonoured
      ? available('setContentProtection')
      : degraded(
          'minimize-controls',
          'Hiding windows from captures is not verified on this macOS version; the controls minimize when recording starts.',
        ),
    'ui.customToast': available('toast-window'),
    'input.synthetic': unavailable(
      'Needs the native helper and Accessibility permission (later phase); manual-scroll stitching is used.',
      'manual-scroll',
    ),
    'window.foregroundInfo': unavailable(
      'Needs the native helper (not available yet); %t and %pn resolve to empty.',
    ),
    'window.manipulate': unavailable(
      'macOS does not let apps change other apps’ windows; the tool is hidden.',
    ),
    'colorPicker.screen': screen.state === 'available' ? available('overlay') : screen,
    'clipboard.writeImageUnfocused': available('clipboard'),
    'secrets.persistent': secretsCapability(input.secrets),
    'startup.login': available('setLoginItemSettings'),
    'shell.contextMenu': unavailable(
      'A Finder share extension is in the backlog; drag and drop works.',
      'drag-drop',
    ),
    'ocr.native': unavailable(
      'macOS Vision OCR is not used yet; tesseract.js is used.',
      'tesseract.js',
    ),
  };
}
