/** Launch environment (security finding S-1): development switches only when unpackaged. */
import { describe, expect, it } from 'vitest';
import {
  applyForceX11,
  DEV_ONLY_ENV,
  devServerUrl,
  readLaunchEnv,
  x11Relaunch,
} from '../../src/main/launch-env';

const SOCKET = 'CS_HARNESS_SOCKET';
const DEV_ENV = {
  ELECTRON_RENDERER_URL: 'http://localhost:5173',
  CS_TEST: '1',
  CS_USER_DATA_DIR: '/tmp/profile',
  CS_METRICS_INTERVAL_MS: '500',
  [SOCKET]: '/tmp/harness.sock',
  CS_FORCE_X11: '1',
};

describe('readLaunchEnv (S-1)', () => {
  it('ignores every development variable in a packaged app', () => {
    expect(readLaunchEnv(DEV_ENV, true, SOCKET)).toEqual({
      rendererUrl: null,
      testMode: false,
      userDataDir: null,
      metricsIntervalMs: null,
      harnessSocket: null,
      // The XWayland escape hatch is for users, so it stays.
      forceX11: true,
    });
  });

  it('honours them in an unpackaged build', () => {
    expect(readLaunchEnv(DEV_ENV, false, SOCKET)).toEqual({
      rendererUrl: 'http://localhost:5173',
      testMode: true,
      userDataDir: '/tmp/profile',
      metricsIntervalMs: 500,
      harnessSocket: '/tmp/harness.sock',
      forceX11: true,
    });
    expect(readLaunchEnv({}, false, SOCKET)).toMatchObject({
      rendererUrl: null,
      testMode: false,
      forceX11: false,
    });
  });

  it('accepts only a loopback http(s) dev server', () => {
    expect(devServerUrl('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(devServerUrl('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(devServerUrl('https://evil.example.com')).toBeNull();
    expect(devServerUrl('file:///etc/passwd')).toBeNull();
    expect(devServerUrl('not a url')).toBeNull();
    expect(
      readLaunchEnv({ ELECTRON_RENDERER_URL: 'https://evil.example' }, false, SOCKET),
    ).toMatchObject({ rendererUrl: null });
  });

  it('lists the renderer URL among the development-only variables', () => {
    expect(DEV_ONLY_ENV).toContain('ELECTRON_RENDERER_URL');
  });
});

describe('applyForceX11', () => {
  it('sets the platform and hint and hides the Wayland display from child processes', () => {
    const switches: [string, string | undefined][] = [];
    const env: Record<string, string> = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' };
    expect(applyForceX11({ appendSwitch: (n, v) => switches.push([n, v]) }, env)).toBe(true);
    expect(switches).toEqual([
      ['ozone-platform', 'x11'],
      ['ozone-platform-hint', 'x11'],
    ]);
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
  });

  it('does nothing without an X display', () => {
    const switches: string[] = [];
    const env: Record<string, string> = { WAYLAND_DISPLAY: 'wayland-0' };
    expect(applyForceX11({ appendSwitch: (n) => switches.push(n) }, env)).toBe(false);
    expect(switches).toEqual([]);
    expect(env.WAYLAND_DISPLAY).toBe('wayland-0');
  });
});

describe('x11Relaunch', () => {
  it('relaunches once with the switch on the real command line', () => {
    const argv = ['/opt/cs/capture-studio', '--action', 'new-recording'];
    expect(x11Relaunch(argv, '/opt/cs/capture-studio', { DISPLAY: ':0' })).toEqual({
      execPath: '/opt/cs/capture-studio',
      args: ['--action', 'new-recording', '--ozone-platform=x11'],
    });
    // The relaunched process has it: no loop.
    expect(x11Relaunch([...argv, '--ozone-platform=x11'], argv[0]!, { DISPLAY: ':0' })).toBeNull();
    expect(x11Relaunch(argv, argv[0]!, {})).toBeNull();
  });

  it('replaces another platform switch and relaunches an AppImage through $APPIMAGE', () => {
    expect(
      x11Relaunch(['/tmp/.mount_x/cs', '--ozone-platform=wayland'], '/tmp/.mount_x/cs', {
        DISPLAY: ':0',
        APPIMAGE: '/home/u/Capture-Studio.AppImage',
      }),
    ).toEqual({ execPath: '/home/u/Capture-Studio.AppImage', args: ['--ozone-platform=x11'] });
  });
});
