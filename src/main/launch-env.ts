/**
 * Environment variables main reads at launch (§1.3, §4.6.3; security finding S-1).
 *
 * Development and test switches are honoured only in an unpackaged build: a packaged app must not
 * let an environment variable load its windows from another origin (`ELECTRON_RENDERER_URL`
 * gives that origin the preload API and project media), move its profile, enter test mode, run
 * the harness control channel or change FFmpeg's folder (`CS_FFMPEG_DIR`, in `ffmpeg/locate.ts`).
 *
 * `CS_FORCE_X11=1` is the user's escape hatch to XWayland when native Wayland misbehaves (§4.7
 * risk 13), so it works in packaged builds too. See `applyForceX11`.
 */

/** Variables that only an unpackaged (development or test) build honours. */
export const DEV_ONLY_ENV = [
  'ELECTRON_RENDERER_URL',
  'CS_TEST',
  'CS_USER_DATA_DIR',
  'CS_METRICS_INTERVAL_MS',
  'CS_FFMPEG_DIR',
] as const;

export interface LaunchEnv {
  /** The Vite dev server (electron-vite dev), or null. */
  rendererUrl: string | null;
  /** End-to-end test mode: X11 Electron, fake devices, no portal (§4.6.3). */
  testMode: boolean;
  /** Separate profile folder for tests and development. */
  userDataDir: string | null;
  /** Shorter metrics sampling for harness dry runs. */
  metricsIntervalMs: number | null;
  /** The harness control channel's socket path (`harnessSocketEnv`). */
  harnessSocket: string | null;
  /** Run on XWayland instead of native Wayland. */
  forceX11: boolean;
}

/** Only a loopback http(s) dev server is accepted, even in development. */
export function devServerUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (url.protocol === 'http:' || url.protocol === 'https:') && loopback
      ? value.replace(/\/+$/, '')
      : null;
  } catch {
    return null;
  }
}

const nonEmpty = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

export function readLaunchEnv(
  env: Partial<Record<string, string>>,
  isPackaged: boolean,
  harnessSocketEnv: string,
): LaunchEnv {
  const forceX11 = env.CS_FORCE_X11 === '1';
  if (isPackaged) {
    return {
      rendererUrl: null,
      testMode: false,
      userDataDir: null,
      metricsIntervalMs: null,
      harnessSocket: null,
      forceX11,
    };
  }
  const interval = Number(env.CS_METRICS_INTERVAL_MS);
  return {
    rendererUrl: devServerUrl(env.ELECTRON_RENDERER_URL),
    testMode: env.CS_TEST === '1',
    userDataDir: nonEmpty(env.CS_USER_DATA_DIR),
    metricsIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : null,
    harnessSocket: nonEmpty(env[harnessSocketEnv]),
    forceX11,
  };
}

export interface CommandLineLike {
  appendSwitch(name: string, value?: string): void;
}

/**
 * `CS_FORCE_X11=1` under a Wayland session. Switches appended from JavaScript come too late for
 * Chromium's platform selection: the window still opens natively (or not at all) and the GPU
 * process, started for X11 without the switch, crashes in a loop (measured on GNOME with
 * Electron 45). So the app relaunches itself once with `--ozone-platform=x11` on the real command
 * line. Returns how to relaunch, or null when the switch is already there or there is no X
 * display. In an AppImage the relaunch goes through `$APPIMAGE`, because the mounted image
 * disappears when this process exits.
 */
export function x11Relaunch(
  argv: readonly string[],
  execPath: string,
  env: Partial<Record<string, string>>,
): { execPath: string; args: string[] } | null {
  if (!env.DISPLAY) return null;
  if (argv.some((a) => a === '--ozone-platform=x11')) return null;
  const args = argv.slice(1).filter((a) => !a.startsWith('--ozone-platform'));
  return { execPath: env.APPIMAGE ?? execPath, args: [...args, '--ozone-platform=x11'] };
}

/**
 * In the relaunched process: keep child processes (GPU, utility) off Wayland too. Must run before
 * `ready`. Returns false when there is no X server to use.
 */
export function applyForceX11(
  commandLine: CommandLineLike,
  env: Partial<Record<string, string>>,
): boolean {
  if (!env.DISPLAY) return false;
  commandLine.appendSwitch('ozone-platform', 'x11');
  commandLine.appendSwitch('ozone-platform-hint', 'x11');
  delete env.WAYLAND_DISPLAY;
  return true;
}
