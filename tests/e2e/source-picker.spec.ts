/**
 * The in-app screen picker on X11 (R1.53, D-6): the real app, its picker window, IPC and saved
 * choice, with no auto-select switch (unlike CI's other specs), so the picker opens.
 *
 * The picker opens only when X11 lists several monitors, and Xvfb cannot make a second one
 * (it refuses `xrandr --setmonitor`). So the test wraps `desktopCapturer.getSources` in the
 * main process to list a stand-in screen before the real one. Everything after the list is
 * real: thumbnails, Esc to cancel, choosing and recording the real screen, and the choice
 * highlighted the next time.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createDefaultSettings } from '../../src/shared/settings/schema';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
const STAND_IN_ID = 'screen:9999:0';

/**
 * Presses a key that closes the picker. The window closes before the key-up, which Playwright
 * reports as a closed target.
 */
async function pressClosing(page: Page, key: string): Promise<void> {
  try {
    await page.keyboard.press(key);
  } catch (error) {
    if (!String(error).includes('closed')) throw error;
  }
}

async function recState(shell: Page): Promise<string> {
  return shell.evaluate(async () => (await window.captureStudio.rec.status()).state);
}

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('X11 with several screens: the picker offers each, Esc cancels, the chosen one is recorded and remembered (R1.53)', async () => {
  test.setTimeout(150_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-picker-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  settings.recorder = {
    ...settings.recorder,
    // Screen only: no camera, mic or pw-record, and no countdown.
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
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  const pickerPage = async (): Promise<Page> => {
    await expect
      .poll(() => app.windows().some((w) => w.url().includes('source-picker/index.html')), {
        timeout: 20_000,
      })
      .toBe(true);
    const page = app.windows().find((w) => w.url().includes('source-picker/index.html'));
    if (!page) throw new Error('no picker window');
    await page.waitForTimeout(600); // keys are ignored for 500 ms after opening
    return page;
  };

  // A stand-in second screen listed first, with the real screen's thumbnail.
  await app.evaluate(({ desktopCapturer }, standInId) => {
    const real = desktopCapturer.getSources.bind(desktopCapturer);
    desktopCapturer.getSources = async (options) => {
      const sources = await real(options);
      const first = sources[0];
      return first ? [{ ...first, id: standInId, name: 'Stand-in screen' }, ...sources] : sources;
    };
  }, STAND_IN_ID);

  try {
    const shell = await app.firstWindow();
    await expect(shell.getByTestId('setup-panel')).toBeVisible();

    // First recording: both screens offered, each with a thumbnail. Esc cancels.
    await shell.getByTestId('record-button').click();
    let picker = await pickerPage();
    const cards = picker.getByRole('option');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toHaveAttribute('aria-selected', 'true');
    for (const card of await cards.all()) {
      await expect
        .poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
    }
    await expect(cards.first()).toHaveAttribute('data-source-id', STAND_IN_ID);
    const realId = await cards.nth(1).getAttribute('data-source-id');
    await pressClosing(picker, 'Escape');
    await expect.poll(() => recState(shell), { timeout: 15_000 }).toBe('configuring');
    expect(readdirSync(projects).filter((n) => n.endsWith('.cstudio'))).toHaveLength(0);

    // Second recording: choose the real screen and record it.
    await shell.getByTestId('record-button').click();
    picker = await pickerPage();
    await picker.keyboard.press('ArrowRight');
    await expect(picker.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await pressClosing(picker, 'Enter');
    await expect.poll(() => recState(shell), { timeout: 20_000 }).toBe('recording');
    await shell.waitForTimeout(2_000);
    await shell.evaluate(() => window.captureStudio.rec.stop());
    await expect(shell.getByTestId('completion-notice')).toBeVisible({ timeout: 60_000 });

    expect(readdirSync(projects).filter((n) => n.endsWith('.cstudio'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(userData, 'source-picker.json'), 'utf8'))).toEqual({
      lastSourceId: realId,
    });

    // Third: the last choice starts highlighted. Cancel again.
    await shell.getByTestId('record-button').click();
    picker = await pickerPage();
    await expect(picker.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await pressClosing(picker, 'Escape');
    await expect.poll(() => recState(shell), { timeout: 15_000 }).toBe('configuring');
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
