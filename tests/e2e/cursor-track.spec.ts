/**
 * The cursor track end to end (P3 step 4, R3.7–R3.9): the real app records the screen of an X
 * server of its own (CI's Xvfb) while the native helper's XTest moves and clicks the pointer; the
 * finished project has a `cursor` media whose `cursor.jsonl` holds 120 Hz positions in video
 * pixels and the click, inside the recording's time.
 *
 * Needs `npm run build:native` and `CS_NATIVE_INPUT_TEST=1` (it moves the pointer, so never on a
 * desktop someone is using). Like `recorder-ui.spec.ts`, the screen comes from the X11 capturer.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { nativeHelperPath, type NativeHelper } from '../../src/main/native/cs-native';
import { parseCursorTrack } from '../../src/shared/project/cursor-track';
import type { Project } from '../../src/shared/project/schema';
import { createDefaultSettings } from '../../src/shared/settings/schema';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
const HELPER = nativeHelperPath({ isPackaged: false, resourcesPath: '', appPath: ROOT });

const recState = (shell: Page) =>
  shell.evaluate(async () => (await window.captureStudio.rec.status()).state);

test.skip(
  process.platform !== 'linux' ||
    !process.env.DISPLAY ||
    process.env.CS_NATIVE_INPUT_TEST !== '1' ||
    !existsSync(HELPER),
  'needs an X server of its own, the built helper and CS_NATIVE_INPUT_TEST=1',
);

test('a recording gets a cursor track with positions and clicks (R3.7–R3.9)', async () => {
  test.setTimeout(120_000);
  const helper = createRequire(import.meta.url)(HELPER) as NativeHelper;
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-cursor-rec-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-cursor-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  settings.recorder = {
    ...settings.recorder,
    systemAudio: false,
    minimizeControlsOnStart: 'off',
    countdownSec: 0,
  };
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const app = await electron.launch({
    args: ['--ozone-platform=x11', '--disable-features=WebRTCPipeWireCapturer', MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_TEST: '1',
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: FFMPEG_DIR,
      CS_NATIVE_DIR: path.dirname(HELPER),
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  try {
    const shell = await app.firstWindow();
    helper.injectPointer('move', 50, 50);
    await shell.getByTestId('record-button').click();
    await expect.poll(() => recState(shell), { timeout: 30_000 }).toBe('recording');
    await shell.waitForTimeout(500);
    helper.injectPointer('move', 300, 200);
    await shell.waitForTimeout(300);
    helper.injectPointer('move', 900, 600);
    await shell.waitForTimeout(300);
    helper.injectPointer('press', 0, 0, 1);
    await shell.waitForTimeout(80);
    helper.injectPointer('release', 0, 0, 1);
    await shell.waitForTimeout(500);
    await shell.evaluate(() => window.captureStudio.rec.stop());
    await expect.poll(() => recState(shell), { timeout: 60_000 }).not.toBe('finalizing');

    const folder = readdirSync(projects).find((n) => n.endsWith('.cstudio'));
    expect(folder).toBeDefined();
    const root = path.join(projects, folder!);
    const doc = JSON.parse(readFileSync(path.join(root, 'project.json'), 'utf8')) as Project;
    const screen = doc.media.find((m) => m.role === 'screen');
    const cursor = doc.media.find((m) => m.kind === 'cursor');
    expect(cursor).toMatchObject({
      role: 'cursor',
      path: 'media/cursor.jsonl',
      status: 'ok',
      cursor: { screenMediaId: screen?.id, inVideo: true, sampleRateHz: 120, clicks: 1 },
    });
    const track = parseCursorTrack(readFileSync(path.join(root, 'media', 'cursor.jsonl'), 'utf8'));
    expect(track.header).toMatchObject({
      width: screen?.video?.width,
      height: screen?.video?.height,
    });
    // Xvfb's screen is the captured frame (1920×1080), so positions are root pixels.
    const scale = (screen?.video?.width ?? 1920) / 1920;
    const at = (x: number, y: number) =>
      Array.from(track.x).some(
        (v, i) => Math.abs(v - x * scale) < 1 && Math.abs((track.y[i] ?? 0) - y * scale) < 1,
      );
    expect(at(300, 200)).toBe(true);
    expect(at(900, 600)).toBe(true);
    expect(track.clicks).toHaveLength(1);
    const [click] = track.clicks;
    expect(click).toMatchObject({ button: 'left' });
    expect(click!.x).toBeCloseTo(900 * scale, 0);
    expect(click!.upUs! - click!.tUs).toBeGreaterThan(40_000);
    expect(click!.tUs).toBeGreaterThan(0);
    expect(click!.tUs).toBeLessThan(doc.recording!.durationUs);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
