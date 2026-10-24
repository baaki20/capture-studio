/**
 * Linux capability detection (§1.4, with the binding spike outcomes in §9). Probes run external
 * tools through an injectable `exec`, so tests can describe any machine.
 *
 * - `audio.system`: `pw-record` on PATH and a PipeWire default sink (§9.5).
 * - `hotkeys.global`: never on GNOME Wayland (§9.8); the CLI `--action` fallback is offered.
 * - `ui.tray`: needs a StatusNotifier host (Ubuntu's AppIndicator extension provides one).
 * - `encode.ffmpeg.hw`: from the media utility's encoder probe.
 */
import {
  available,
  degraded,
  unavailable,
  type Capability,
  type CapabilityMap,
  type FfmpegEncoderReport,
} from '../../shared/capabilities/types';

export interface ExecResult {
  /** Exit code, or null when the program could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn error (for example `ENOENT` when the program is not on PATH). */
  error: string | null;
}

export type ExecFn = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<ExecResult>;

export interface SecretsStatusLike {
  persistent: boolean;
  backend: string;
  reason: string | null;
}

export interface LinuxDetectInput {
  env: Partial<Record<string, string>>;
  /** `wayland` or `x11`: what Electron actually runs on (see `inferOzonePlatform`). */
  ozonePlatform: 'wayland' | 'x11';
  secrets: SecretsStatusLike | null;
  encoders: FfmpegEncoderReport | null;
  exec: ExecFn;
}

const PROBE_TIMEOUT_MS = 3000;

/**
 * Electron 45 picks Wayland automatically in a Wayland session; `--ozone-platform=x11`
 * (`CS_FORCE_X11=1`) or a missing `WAYLAND_DISPLAY` means X11/XWayland.
 */
export function inferOzonePlatform(
  env: Partial<Record<string, string>>,
  ozoneSwitch: string | null,
): 'wayland' | 'x11' {
  if (ozoneSwitch === 'x11' || ozoneSwitch === 'wayland') return ozoneSwitch;
  return env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11' ? 'wayland' : 'x11';
}

export function isGnome(env: Partial<Record<string, string>>): boolean {
  return (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .some((part) => part.trim().toUpperCase() === 'GNOME');
}

async function commandExists(exec: ExecFn, file: string): Promise<boolean> {
  const result = await exec(file, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
  return result.error === null && result.code === 0;
}

/** The PipeWire default sink's node name, or null. */
export async function findDefaultSink(exec: ExecFn): Promise<string | null> {
  const meta = await exec('pw-metadata', ['0', 'default.audio.sink'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (meta.error === null && meta.code === 0) {
    const m = /key:'default\.audio\.sink'\s+value:'([^']*)'/.exec(meta.stdout);
    if (m?.[1]) {
      try {
        const value = JSON.parse(m[1]) as { name?: unknown };
        if (typeof value.name === 'string' && value.name) return value.name;
      } catch {
        return m[1];
      }
    }
  }
  // Fallback for systems without pw-metadata output: WirePlumber's alias.
  const inspect = await exec('wpctl', ['inspect', '@DEFAULT_AUDIO_SINK@'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (inspect.error === null && inspect.code === 0) {
    const name = /node\.name = "([^"]+)"/.exec(inspect.stdout)?.[1];
    return name ?? 'default';
  }
  return null;
}

export async function detectSystemAudio(exec: ExecFn): Promise<Capability> {
  if (!(await commandExists(exec, 'pw-record'))) {
    return unavailable(
      'pw-record was not found on PATH (install PipeWire’s pipewire-bin package). Recording continues without system audio.',
    );
  }
  const sink = await findDefaultSink(exec);
  if (!sink) {
    return unavailable(
      'No PipeWire default output (sink) was found. Recording continues without system audio.',
      'pw-record',
    );
  }
  return available('pw-record', `Monitor of the default output “${sink}”.`);
}

export async function detectTray(exec: ExecFn, gnome: boolean): Promise<Capability> {
  const result = await exec(
    'gdbus',
    [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.NameHasOwner',
      'org.kde.StatusNotifierWatcher',
    ],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (result.error === null && result.code === 0) {
    return result.stdout.includes('true')
      ? available('status-notifier')
      : unavailable(
          gnome
            ? 'No StatusNotifier host: enable the AppIndicator extension. The main window and notifications are used instead.'
            : 'No StatusNotifier host is running. The main window and notifications are used instead.',
        );
  }
  return degraded(
    'status-notifier',
    'Could not ask D-Bus for a StatusNotifier host (gdbus unavailable); a tray icon may not appear.',
  );
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

export async function detectLinuxCapabilities(input: LinuxDetectInput): Promise<CapabilityMap> {
  const wayland = input.ozonePlatform === 'wayland';
  const gnome = isGnome(input.env);
  const [systemAudio, tray] = await Promise.all([
    detectSystemAudio(input.exec),
    detectTray(input.exec, gnome),
  ]);

  const waylandOnly = (strategy: string, fallback: string): Capability =>
    wayland ? unavailable(fallback, null) : available(strategy);

  return {
    'capture.screen.source': wayland
      ? available('portal', 'The system picker appears on every recording (Phase 1).')
      : available('desktopCapturer', 'In-app source picker.'),
    'capture.screen.restoreToken': wayland
      ? unavailable('The portal asks again on every recording until Phase 3.', 'prompt-each-time')
      : available('not-needed', 'X11 capture needs no permission prompt.'),
    'capture.screen.allMonitors': waylandOnly(
      'entire-screen',
      'The portal gives one monitor per stream; one monitor is captured.',
    ),
    'capture.window.enumerate': waylandOnly(
      'desktopCapturer',
      'Windows cannot be listed on Wayland; the portal’s window tab arrives in Phase 2.',
    ),
    'capture.region.onScreenOverlay': unavailable(
      wayland
        ? 'Wayland does not let apps position overlay windows; the in-app frozen-frame picker is used.'
        : 'The on-screen overlay arrives in Phase 3; the in-app frozen-frame picker is used.',
      'in-app-picker',
    ),
    'capture.cursor.hide': unavailable(
      wayland ? 'The portal bakes the cursor into the stream.' : 'Not verified on X11 yet.',
      'cursor-visible',
    ),
    'capture.cursor.track': unavailable(
      wayland
        ? 'Cursor positions are not available on Wayland; cursor effects are disabled, manual zoom works.'
        : 'Needs the native XInput2 helper (Phase 3); cursor effects are disabled.',
    ),
    'capture.screenshot.silent': wayland
      ? degraded('screenshot-portal', 'The Screenshot portal may ask for permission each time.')
      : available('desktopCapturer'),
    'audio.system': systemAudio,
    'audio.mic': available('getUserMedia', 'Devices are listed in the setup panel.'),
    'video.camera': available('getUserMedia', 'Devices are listed in the setup panel.'),
    'encode.webcodecs.hw': unavailable(
      'Probed by the capture engine when recording starts; software H.264 (WebCodecs) is used meanwhile.',
      'webcodecs-software',
    ),
    'encode.ffmpeg.hw': ffmpegHardwareCapability(input.encoders),
    'hotkeys.global': wayland
      ? unavailable(
          gnome
            ? 'GNOME Wayland does not deliver portal global shortcuts to this app. Bind the commands in Diagnostics as GNOME custom shortcuts.'
            : 'Global shortcuts are not supported on this Wayland desktop. Bind the commands in Diagnostics as custom shortcuts.',
          'cli-action',
        )
      : available('globalShortcut'),
    'ui.tray': tray,
    'ui.alwaysOnTop': waylandOnly('setAlwaysOnTop', 'The compositor ignores always-on-top.'),
    'ui.windowPositioning': waylandOnly(
      'setBounds',
      'Wayland compositors place windows themselves.',
    ),
    'ui.excludeFromCapture': unavailable(
      'Linux cannot hide windows from capture; the controls minimize when recording starts.',
      'minimize-controls',
    ),
    'ui.customToast': wayland
      ? unavailable(
          'Toast windows cannot be positioned; system notifications are used.',
          'notification',
        )
      : available('toast-window'),
    'input.synthetic': unavailable(
      wayland
        ? 'Needs the RemoteDesktop portal (Phase 6); manual-scroll stitching is used.'
        : 'Needs the native XTest helper (Phase 3); manual-scroll stitching is used.',
      'manual-scroll',
    ),
    'window.foregroundInfo': unavailable(
      wayland
        ? 'Wayland does not reveal the active window; %t and %pn resolve to empty.'
        : 'Needs the native EWMH helper (Phase 3); %t and %pn resolve to empty.',
    ),
    'window.manipulate': unavailable(
      wayland
        ? 'Not possible on Wayland; the tool is hidden.'
        : 'Needs the native helper; the tool is hidden.',
    ),
    'colorPicker.screen': wayland
      ? degraded(
          'screenshot-portal',
          'Uses the Screenshot portal’s PickColor (asks for permission).',
        )
      : available('overlay'),
    'clipboard.writeImageUnfocused': wayland
      ? degraded(
          'copy-on-activate',
          'The Wayland clipboard needs focus; images are copied when the notification or window is activated.',
        )
      : available('clipboard'),
    'secrets.persistent': secretsCapability(input.secrets),
    'startup.login': available('xdg-autostart'),
    'shell.contextMenu': unavailable(
      'A Nautilus script integration is optional and arrives later; drag and drop works.',
      'drag-drop',
    ),
    'ocr.native': unavailable('No native OCR on Linux; tesseract.js is used.', 'tesseract.js'),
  };
}
