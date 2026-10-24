import { describe, expect, it, vi } from 'vitest';
import { CapabilityService, detectCapabilities } from '../../src/main/capabilities/detect';
import {
  findDefaultSink,
  inferOzonePlatform,
  isGnome,
  type ExecFn,
  type ExecResult,
} from '../../src/main/capabilities/linux';
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

  it('gives placeholders off Linux without running tools', async () => {
    const exec = machine();
    const report = await detect(exec, { platform: 'win32', ozonePlatform: null });
    expect(exec.calls).toEqual([]);
    expect(report.capabilities['audio.mic'].state).toBe('available');
    expect(report.capabilities['audio.system'].reason).toContain('Phase 3');
    expect(report.session).toEqual({ type: null, desktop: null, ozonePlatform: null });
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
