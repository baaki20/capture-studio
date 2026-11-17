import { describe, expect, it, vi } from 'vitest';
import { CapabilityService, detectCapabilities } from '../../src/main/capabilities/detect';
import {
  findDefaultSink,
  inferOzonePlatform,
  isGnome,
  type ExecFn,
  type ExecResult,
} from '../../src/main/capabilities/linux';
import { cursorTrackCapability, systemAudioWithScreen } from '../../src/main/capabilities/common';
import { readMacPermissions } from '../../src/main/capabilities/mac-permissions';
import { macosMajor, type MacPermissions } from '../../src/main/capabilities/macos';
import { windowsBuild } from '../../src/main/capabilities/windows';
import {
  CAPABILITY_KEYS,
  CapabilityReportSchema,
  type FfmpegEncoderReport,
} from '../../src/shared/capabilities/types';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', error: null });
const missing: ExecResult = { code: null, stdout: '', stderr: '', error: 'ENOENT' };
const failed: ExecResult = { code: 1, stdout: '', stderr: 'nope', error: null };

const SINK_META = `Found "default" metadata 41
update: id:0 key:'default.audio.sink' value:'{"name":"alsa_output.pci-0000_00_1f.3.analog-stereo"}' type:'Spa:String:JSON'`;

/** The dev machine (spikes): GNOME Wayland, PipeWire with pw-record, AppIndicator extension. */
function machine(
  overrides: Partial<Record<string, ExecResult>> = {},
): ExecFn & { calls: string[] } {
  const table: Record<string, ExecResult> = {
    'pw-record': ok('pw-record\nCompiled with libpipewire 1.6.2'),
    'pw-metadata': ok(SINK_META),
    wpctl: ok('id 84, type PipeWire:Interface:Node\n    node.name = "alsa_output.x"'),
    gdbus: ok('(true,)\n'),
    ...overrides,
  };
  const calls: string[] = [];
  const exec = ((file: string, args: readonly string[]) => {
    calls.push([file, ...args].join(' '));
    return Promise.resolve(table[file] ?? missing);
  }) as ExecFn & { calls: string[] };
  exec.calls = calls;
  return exec;
}

const waylandEnv = {
  XDG_SESSION_TYPE: 'wayland',
  WAYLAND_DISPLAY: 'wayland-0',
  XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
};

const secrets = { persistent: true, backend: 'gnome_libsecret', reason: null };

const encoders: FfmpegEncoderReport = {
  probedAt: '2026-10-24T00:00:00.000Z',
  hardware: null,
  software: 'libx264',
  encoders: [
    { name: 'h264_vaapi', kind: 'vaapi', listed: true, works: false, error: 'No VA display found' },
    { name: 'h264_nvenc', kind: 'nvenc', listed: true, works: false, error: 'driver too old' },
    { name: 'libx264', kind: 'software', listed: true, works: true, error: null },
  ],
};

function detect(exec: ExecFn, extra: Partial<Parameters<typeof detectCapabilities>[0]> = {}) {
  return detectCapabilities({
    platform: 'linux',
    env: waylandEnv,
    ozonePlatform: 'wayland',
    secrets,
    encoders,
    exec,
    now: () => new Date('2026-10-24T08:00:00Z'),
    ...extra,
  });
}

describe('Linux capability detection (§1.4, §9)', () => {
  it('describes the GNOME Wayland dev machine', async () => {
    const report = await detect(machine());
    expect(CapabilityReportSchema.parse(report)).toEqual(report);
    expect(Object.keys(report.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
    const c = report.capabilities;

    expect(c['audio.system']).toMatchObject({ state: 'available', strategy: 'pw-record' });
    expect(c['audio.system'].reason).toContain('alsa_output.pci-0000_00_1f.3.analog-stereo');
    expect(c['hotkeys.global']).toMatchObject({ state: 'unavailable', strategy: 'cli-action' });
    expect(c['hotkeys.global'].reason).toContain('GNOME custom shortcuts');
    expect(c['ui.tray']).toMatchObject({ state: 'available', strategy: 'status-notifier' });
    expect(c['capture.screen.source']).toMatchObject({ state: 'available', strategy: 'portal' });
    expect(c['capture.region.onScreenOverlay']).toMatchObject({
      state: 'unavailable',
      strategy: 'in-app-picker',
    });
    expect(c['ui.alwaysOnTop'].state).toBe('unavailable');
    expect(c['audio.mic'].state).toBe('available');
    expect(c['video.camera'].state).toBe('available');
    expect(c['encode.ffmpeg.hw']).toMatchObject({ state: 'unavailable', strategy: 'libx264' });
    expect(c['encode.ffmpeg.hw'].reason).toContain('h264_vaapi: No VA display found');
    expect(c['secrets.persistent']).toMatchObject({ state: 'available' });
    expect(report.session).toEqual({
      type: 'wayland',
      desktop: 'ubuntu:GNOME',
      ozonePlatform: 'wayland',
    });
    // Every non-available entry explains itself.
    for (const key of CAPABILITY_KEYS) {
      if (c[key].state !== 'available') expect(c[key].reason, key).not.toBe('');
    }
  });

  it('marks system audio unavailable without pw-record', async () => {
    const report = await detect(machine({ 'pw-record': missing }));
    expect(report.capabilities['audio.system'].state).toBe('unavailable');
    expect(report.capabilities['audio.system'].reason).toContain('pw-record was not found');
  });

  it('marks system audio unavailable without a default sink', async () => {
    const report = await detect(
      machine({ 'pw-metadata': ok('Found "default" metadata 41\n'), wpctl: failed }),
    );
    expect(report.capabilities['audio.system']).toMatchObject({
      state: 'unavailable',
      strategy: 'pw-record',
    });
    expect(report.capabilities['audio.system'].reason).toContain('No PipeWire default output');
  });

  it('falls back to wpctl for the default sink', async () => {
    expect(await findDefaultSink(machine({ 'pw-metadata': missing }))).toBe('alsa_output.x');
    expect(await findDefaultSink(machine({ 'pw-metadata': missing, wpctl: missing }))).toBeNull();
  });

  it('reports the tray as unavailable without a StatusNotifier host, degraded without gdbus', async () => {
    const none = await detect(machine({ gdbus: ok('(false,)\n') }));
    expect(none.capabilities['ui.tray'].state).toBe('unavailable');
    expect(none.capabilities['ui.tray'].reason).toContain('AppIndicator');
    const unknown = await detect(machine({ gdbus: missing }));
    expect(unknown.capabilities['ui.tray'].state).toBe('degraded');
  });

  it('describes an X11 session', async () => {
    const report = await detect(machine(), {
      env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'GNOME' },
      ozonePlatform: 'x11',
    });
    const c = report.capabilities;
    expect(c['capture.screen.source'].strategy).toBe('desktopCapturer');
    expect(c['capture.window.enumerate'].state).toBe('available');
    expect(c['hotkeys.global']).toMatchObject({ state: 'available', strategy: 'globalShortcut' });
    expect(c['ui.alwaysOnTop'].state).toBe('available');
    // P3 step 7: every monitor in one picture (Chromium's whole-desktop source).
    expect(c['capture.screen.allMonitors']).toMatchObject({
      state: 'available',
      strategy: 'full-desktop-source',
    });
    // P3 step 6: the region is drawn over the live desktop.
    expect(c['capture.region.onScreenOverlay']).toMatchObject({
      state: 'available',
      strategy: 'overlay-window',
    });
  });

  it('uses a verified hardware encoder and reports session-only secrets', async () => {
    const report = await detect(machine(), {
      encoders: { ...encoders, hardware: 'h264_vaapi' },
      secrets: { persistent: false, backend: 'basic_text', reason: 'basic_text does not encrypt' },
    });
    expect(report.capabilities['encode.ffmpeg.hw']).toMatchObject({
      state: 'available',
      strategy: 'h264_vaapi',
    });
    expect(report.capabilities['secrets.persistent']).toMatchObject({
      state: 'unavailable',
      reason: 'basic_text does not encrypt',
    });
  });

  it('says the encoder probe is pending before it finishes', async () => {
    const report = await detect(machine(), { encoders: null });
    expect(report.capabilities['encode.ffmpeg.hw'].reason).toContain('has not finished');
  });

  it('runs no tools off Linux and leaves the Linux session fields empty', async () => {
    const exec = machine();
    const report = await detect(exec, {
      platform: 'win32',
      ozonePlatform: null,
      osRelease: '10.0.22631',
    });
    expect(exec.calls).toEqual([]);
    expect(report.session).toEqual({ type: null, desktop: null, ozonePlatform: null });
  });

  it('gives placeholders on platforms without a detector', async () => {
    const report = await detect(machine(), { platform: 'freebsd', ozonePlatform: null });
    expect(report.capabilities['audio.mic'].state).toBe('available');
    expect(report.capabilities['audio.system'].state).toBe('unavailable');
  });
});

describe('Windows capability detection (Phase 3)', () => {
  const win = (osRelease: string) =>
    detect(machine(), { platform: 'win32', ozonePlatform: null, osRelease });

  it('describes Windows 11', async () => {
    const report = await win('10.0.22631');
    expect(CapabilityReportSchema.safeParse(report).success).toBe(true);
    const c = report.capabilities;
    expect(Object.keys(c).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect(c['capture.screen.source']).toMatchObject({
      state: 'available',
      strategy: 'desktopCapturer',
    });
    expect(c['capture.window.enumerate'].state).toBe('available');
    expect(c['ui.excludeFromCapture']).toMatchObject({
      state: 'available',
      strategy: 'setContentProtection',
    });
    expect(c['hotkeys.global'].state).toBe('available');
    expect(c['secrets.persistent'].state).toBe('available');
    // System audio comes with the screen capture (P3 step 2).
    expect(c['audio.system']).toMatchObject({ state: 'available', strategy: 'desktop-loopback' });
    // Without the native helper the cursor is polled (no clicks).
    expect(c['capture.cursor.track']).toMatchObject({
      state: 'degraded',
      strategy: 'electron-poll',
    });
    expect(c['capture.region.onScreenOverlay'].strategy).toBe('overlay-window');
  });

  it('minimizes the controls on builds before 19041, which only black windows out', async () => {
    expect((await win('10.0.18363')).capabilities['ui.excludeFromCapture'].state).toBe('degraded');
    expect((await win('10.0.19041')).capabilities['ui.excludeFromCapture'].state).toBe('available');
    expect((await win('garbage')).capabilities['ui.excludeFromCapture'].state).toBe('degraded');
  });
});

describe('macOS capability detection (Phase 3)', () => {
  const granted = {
    screen: 'granted',
    camera: 'granted',
    microphone: 'granted',
    accessibility: false,
  } as const;
  const mac = (osRelease: string, macPermissions: MacPermissions | null = granted) =>
    detect(machine(), { platform: 'darwin', ozonePlatform: null, osRelease, macPermissions });

  it('describes macOS 14 with every permission granted', async () => {
    const report = await mac('23.6.0');
    expect(CapabilityReportSchema.safeParse(report).success).toBe(true);
    const c = report.capabilities;
    expect(c['capture.screen.source']).toMatchObject({
      state: 'available',
      strategy: 'screencapturekit',
    });
    expect(c['audio.mic'].state).toBe('available');
    expect(c['ui.excludeFromCapture'].state).toBe('available');
    expect(c['capture.screen.allMonitors'].state).toBe('unavailable');
    expect(c['window.manipulate'].state).toBe('unavailable');
  });

  it('does not trust content protection from macOS 15', async () => {
    expect((await mac('24.1.0')).capabilities['ui.excludeFromCapture'].state).toBe('degraded');
    expect((await mac('25.0.0')).capabilities['ui.excludeFromCapture'].state).toBe('degraded');
  });

  it('follows the privacy permissions', async () => {
    const report = await mac('24.1.0', {
      screen: 'denied',
      camera: 'not-determined',
      microphone: 'restricted',
      accessibility: false,
    });
    const c = report.capabilities;
    expect(c['capture.screen.source'].state).toBe('unavailable');
    expect(c['capture.screen.source'].reason).toContain('Screen Recording');
    expect(c['capture.window.enumerate'].state).toBe('unavailable');
    expect(c['capture.screenshot.silent'].state).toBe('unavailable');
    expect(c['video.camera'].state).toBe('degraded');
    expect(c['audio.mic'].reason).toContain('blocked');
  });

  it('offers system audio with the screen from macOS 13, degraded until checked (P3 step 2)', async () => {
    expect((await mac('23.6.0')).capabilities['audio.system']).toMatchObject({
      state: 'degraded',
      strategy: 'desktop-loopback',
    });
    expect((await mac('21.6.0')).capabilities['audio.system'].state).toBe('unavailable');
    const denied = await mac('23.6.0', { ...granted, screen: 'denied' });
    expect(denied.capabilities['audio.system'].state).toBe('unavailable');
    expect(systemAudioWithScreen('darwin')).toBe(true);
    expect(systemAudioWithScreen('win32')).toBe(true);
    expect(systemAudioWithScreen('linux')).toBe(false);
  });

  it('treats unread permissions as not asked yet', async () => {
    const c = (await mac('23.0.0', null)).capabilities;
    expect(c['capture.screen.source'].state).toBe('degraded');
    expect(c['capture.screen.source'].reason).toContain('first recording');
  });
});

describe('platform versions', () => {
  it('reads the Windows build and the macOS major version', () => {
    expect(windowsBuild('10.0.22631')).toBe(22631);
    expect(windowsBuild('10.0')).toBeNull();
    expect(macosMajor('22.6.0')).toBe(13);
    expect(macosMajor('24.1.0')).toBe(15);
    expect(macosMajor('25.0.0')).toBe(26);
    expect(macosMajor('19.6.0')).toBeNull();
  });

  it('reads macOS permissions without prompting', () => {
    const prompts: boolean[] = [];
    const permissions = readMacPermissions({
      getMediaAccessStatus: (t) =>
        ({ screen: 'granted', camera: 'denied', microphone: 'weird' })[t],
      isTrustedAccessibilityClient: (prompt) => (prompts.push(prompt), true),
    });
    expect(permissions).toEqual({
      screen: 'granted',
      camera: 'denied',
      microphone: 'unknown',
      accessibility: true,
    });
    expect(prompts).toEqual([false]);
  });
});

describe('session helpers', () => {
  it('infers the ozone platform', () => {
    expect(inferOzonePlatform(waylandEnv, null)).toBe('wayland');
    expect(inferOzonePlatform(waylandEnv, 'x11')).toBe('x11');
    expect(inferOzonePlatform({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, null)).toBe('x11');
    expect(inferOzonePlatform({ XDG_SESSION_TYPE: 'wayland' }, null)).toBe('x11');
  });

  it('recognizes GNOME in XDG_CURRENT_DESKTOP', () => {
    expect(isGnome({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe(true);
    expect(isGnome({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe(false);
    expect(isGnome({})).toBe(false);
  });
});

describe('CapabilityService', () => {
  it('refreshes, notifies, applies overrides and new inputs', async () => {
    const service = new CapabilityService({
      platform: 'linux',
      env: waylandEnv,
      ozonePlatform: 'wayland',
      secrets,
      encoders: null,
      exec: machine(),
    });
    expect(service.current()).toBeNull();
    expect(service.get('audio.system').state).toBe('unavailable');

    const listener = vi.fn();
    service.onChange(listener);
    const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
    expect(a).toBe(b); // concurrent refreshes coalesce
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.get('audio.system').state).toBe('available');

    await service.setEncoderReport({ ...encoders, hardware: 'h264_nvenc' });
    expect(service.get('encode.ffmpeg.hw').strategy).toBe('h264_nvenc');

    await service.setOverride('encode.webcodecs.hw', {
      state: 'available',
      strategy: 'webcodecs-hw',
      reason: '',
    });
    expect(service.get('encode.webcodecs.hw').state).toBe('available');
    await service.refresh();
    expect(service.get('encode.webcodecs.hw').state).toBe('available');
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe('cursor track capability (P3 step 4)', () => {
  const helper = (backend: string | null) => ({ backend, reason: backend ? null : 'Not built.' });

  it('uses the helper on its own platform, and polls otherwise', () => {
    expect(cursorTrackCapability(helper('x11'), 'x11')).toMatchObject({
      state: 'available',
      strategy: 'native-helper',
    });
    const polled = cursorTrackCapability(helper(null), 'x11');
    expect(polled).toMatchObject({ state: 'degraded', strategy: 'electron-poll' });
    expect(polled.reason).toMatch(/^Not built\. /);
    expect(cursorTrackCapability(helper('unsupported'), 'win32').strategy).toBe('electron-poll');
    expect(cursorTrackCapability(null, 'macos').strategy).toBe('electron-poll');
  });

  it('says when clicks are blocked by a permission', () => {
    const blocked = cursorTrackCapability(helper('macos'), 'macos', 'Clicks need Accessibility.');
    expect(blocked).toMatchObject({ state: 'degraded', strategy: 'native-helper' });
    expect(blocked.reason).toMatch(/clicks are not/);
  });

  it('is never offered on Wayland, helper or not', async () => {
    const report = await detectCapabilities({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
      ozonePlatform: 'wayland',
      secrets: null,
      encoders: null,
      nativeHelper: helper('x11'),
      exec: () => Promise.resolve({ code: 0, stdout: '', stderr: '', error: null }),
    });
    expect(report.capabilities['capture.cursor.track'].state).toBe('unavailable');
  });
});
