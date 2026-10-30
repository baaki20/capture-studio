/**
 * Low disk space during a recording (R1.17) in the real app, without a tmpfs: the test-only
 * control channel (`CS_HARNESS_SOCKET`, `src/main/diagnostics/harness-channel.ts`) overrides the
 * free space the disk monitor sees. The thresholds come from settings (3 GB warn, 1 GB stop
 * instead of the 2 GB / 500 MB defaults), so this also shows they are configurable.
 *
 * Like the other recorder tests: fake devices, the X11 screen capturer, `CS_TEST=1` (the GNOME
 * portal is never opened). The same channel also checks the per-minute metrics file (R1.23).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createDefaultSettings } from '../../src/shared/settings/schema';
import { ChannelClient } from '../wayland/lib/channel-client';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
const GB = 1_000_000_000;

interface Notice {
  level: string;
  message: string;
}
interface StatePayload {
  state: string;
  root: string | null;
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('warns below the warn threshold and stops and finalizes below the stop threshold (R1.17)', async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-disk-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-disk-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  settings.recorder = {
    ...settings.recorder,
    systemAudio: false,
    minimizeControlsOnStart: 'off',
    countdownSec: 0,
    afterRecording: 'show-in-library',
  };
  settings.disk = { warnBytes: 3 * GB, stopBytes: 1 * GB };
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const socket = path.join(userData, 'control.sock');

  let app: ElectronApplication | null = null;
  let channel: ChannelClient | null = null;
  try {
    app = await electron.launch({
      args: [
        '--ozone-platform=x11',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--disable-features=WebRTCPipeWireCapturer',
        MAIN,
      ],
      cwd: ROOT,
      env: {
        ...process.env,
        CS_TEST: '1',
        CS_USER_DATA_DIR: userData,
        CS_FFMPEG_DIR: FFMPEG_DIR,
        CS_HARNESS_SOCKET: socket,
        XDG_SESSION_TYPE: 'x11',
        WAYLAND_DISPLAY: '',
      },
    });
    const shell = await app.firstWindow();
    // Let the setup panel finish opening its device previews before recording starts.
    await expect(shell.getByTestId('camera-select').locator('option')).not.toHaveCount(1);
    channel = await ChannelClient.connect(socket);
    const notices: Notice[] = [];
    channel.onEvent((e) => {
      if (e.event === 'notice') notices.push(e.payload as Notice);
    });

    const recording = channel.waitFor<{ root: string }>('session', undefined, 30_000);
    await channel.call('action', { type: 'toggle-recording' });
    const started = await recording.catch(() => null);
    const status = await channel.call<{ state: string }>('status');
    test.skip(
      !started && status.state === 'acquiring',
      'desktopCapturer gave no screen (X display without capture)',
    );
    expect(started?.root).toBeTruthy();

    // Plenty of space: nothing happens.
    await channel.call('free-bytes', { bytes: 50 * GB });
    // Below the warning threshold: one warning within one check interval (10 s).
    await channel.call('free-bytes', { bytes: 2.5 * GB });
    await expect
      .poll(() => notices.filter((n) => n.message.startsWith('Low disk space')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    expect((await channel.call<{ state: string }>('status')).state).toBe('recording');

    // Below the stop threshold: stops and finalizes on its own.
    const injectedAt = Date.now();
    const finalizing = channel.waitFor<StatePayload>(
      'state',
      (p) => p.state === 'finalizing',
      15_000,
    );
    const ready = channel.waitFor<{ root: string }>('project-ready', undefined, 60_000);
    await channel.call('free-bytes', { bytes: 0.9 * GB });
    await finalizing;
    expect(Date.now() - injectedAt).toBeLessThanOrEqual(11_000);
    const project = await ready;
    expect(project.root).toBe(started?.root);
    expect(notices.some((n) => n.level === 'error' && n.message.startsWith('Disk space'))).toBe(
      true,
    );
    expect(notices.filter((n) => n.message.startsWith('Low disk space'))).toHaveLength(1);

    const doc = JSON.parse(readFileSync(path.join(project.root, 'project.json'), 'utf8')) as {
      recording: { state: string };
    };
    expect(doc.recording.state).toBe('complete');
    expect(readdirSync(path.join(project.root, 'media'))).toContain('screen.mp4');

    // The metrics file has the start and stop samples with per-type working sets (R1.23).
    const metrics = JSON.parse(
      readFileSync(path.join(project.root, 'logs', 'metrics.json'), 'utf8'),
    ) as { samples: { reason: string; totalWorkingSetKb: number; byType: object }[] };
    expect(metrics.samples.map((s) => s.reason)).toEqual(['start', 'stop']);
    expect(metrics.samples[1]?.totalWorkingSetKb).toBeGreaterThan(10_000);
    expect(Object.keys(metrics.samples[1]?.byType ?? {})).toContain('Browser');
  } finally {
    channel?.close();
    await app?.close().catch(() => undefined);
    await test
      .info()
      .attach('main.log', { path: path.join(userData, 'logs', 'main.log') })
      .catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
