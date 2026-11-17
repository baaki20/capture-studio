/**
 * Window recording from the in-app window list on X11 (P3 step 7, R3.18): `desktopCapturer`
 * lists the windows, the CI switch `--auto-select-desktop-capture-source` picks the app's own
 * main window by name, and the project records a window source of that window's size. The same
 * code path serves Windows and macOS (no portal there); see docs/platform-test-backlog.md.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { createDefaultSettings } from '../../src/shared/settings/schema';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('records one window chosen from the window list (R3.18)', async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-window-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-window-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  settings.recorder = {
    ...settings.recorder,
    captureMode: 'window',
    systemAudio: false,
    minimizeControlsOnStart: 'off',
    countdownSec: 0,
    afterRecording: 'show-in-library',
  };
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));

  const app = await electron.launch({
    args: [
      '--ozone-platform=x11',
      '--disable-features=WebRTCPipeWireCapturer',
      '--auto-select-desktop-capture-source=Capture Studio',
      MAIN,
    ],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_TEST: '1',
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: FFMPEG_DIR,
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  try {
    const shell = await app.firstWindow();
    await expect(shell.getByTestId('setup-panel')).toBeVisible();
    const listed = await app.evaluate(async ({ desktopCapturer }) =>
      (
        await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
        })
      ).map((s) => s.name),
    );
    const hasWindows = listed.some((name) => name.includes('Capture Studio'));
    // CI runs this spec under a window manager and must not skip it there.
    if (process.env.CS_E2E_REQUIRE_WINDOWS === '1') expect(listed).toContain('Capture Studio');
    test.skip(!hasWindows, 'this X server lists no windows (no window manager)');
    const size = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => w.isVisible());
      return main ? main.getContentBounds() : null;
    });

    const result = await shell.evaluate(() => window.captureStudio.rec.record());
    expect(result).toMatchObject({ status: 'started' });
    await shell.waitForTimeout(1_500);
    await shell.evaluate(() => window.captureStudio.rec.stop());
    await expect
      .poll(() => readdirSync(projects).filter((n) => n.endsWith('.cstudio')), { timeout: 60_000 })
      .toHaveLength(1);
    const root = path.join(
      projects,
      readdirSync(projects).find((n) => n.endsWith('.cstudio'))!,
    );
    await expect
      .poll(
        () =>
          (
            JSON.parse(readFileSync(path.join(root, 'project.json'), 'utf8')) as {
              recording: { state: string } | null;
            }
          ).recording?.state,
        { timeout: 60_000 },
      )
      .toBe('complete');
    const project = JSON.parse(readFileSync(path.join(root, 'project.json'), 'utf8')) as {
      recording: { source: { kind: string; widthPx: number; heightPx: number } };
      media: { role: string; status: string }[];
    };
    expect(project.recording.source.kind).toBe('window');
    expect(project.media.find((m) => m.role === 'screen')?.status).toBe('ok');
    if (size) {
      // The window's pixels (no window manager decorations under Xvfb).
      expect(project.recording.source.widthPx).toBe(size.width);
      expect(project.recording.source.heightPx).toBe(size.height);
    }
  } finally {
    await app.close().catch(() => undefined);
    await test
      .info()
      .attach('main.log', { path: path.join(userData, 'logs', 'main.log') })
      .catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});
