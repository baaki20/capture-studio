/**
 * Recorder UI end to end (step 11; R1.5–R1.12, R1.18, R1.27 thumbnails): the real app with the
 * setup panel, the controls window, the region picker and the whole recording pipeline.
 *
 * Like `engine-smoke.spec.ts`, camera and mic are Chromium's fake devices and the screen comes
 * from the X11 capturer (`--ozone-platform=x11`, PipeWire capturer off, `CS_TEST=1` so main does
 * not turn it back on). The GNOME portal is never opened; the portal path is covered by the
 * Wayland manual checklist. Projects go to a temporary folder through a pre-written settings file.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createDefaultSettings, type Settings } from '../../src/shared/settings/schema';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);

interface Launched {
  app: ElectronApplication;
  shell: Page;
  userData: string;
  projects: string;
  cleanup(): Promise<void>;
}

async function launch(recorder: Partial<Settings['recorder']> = {}): Promise<Launched> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-rec-'));
  const projects = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-projects-'));
  const settings = createDefaultSettings({
    projectsDir: projects,
    exportsDir: path.join(projects, 'Exports'),
  });
  settings.recorder = {
    ...settings.recorder,
    // Deterministic: no pw-record, and the controls window stays visible for the test.
    systemAudio: false,
    minimizeControlsOnStart: 'off',
    ...recorder,
  };
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));

  const app = await electron.launch({
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
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  const shell = await app.firstWindow();
  return {
    app,
    shell,
    userData,
    projects,
    async cleanup() {
      await app.close().catch(() => undefined);
      // The main log explains most failures (portal, engine, finalize).
      await test
        .info()
        .attach('main.log', { path: path.join(userData, 'logs', 'main.log') })
        .catch(() => undefined);
      rmSync(userData, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    },
  };
}

/** The app window whose URL contains `fragment` (controls, picker), once it exists. */
async function windowFor(app: ElectronApplication, fragment: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const page = app.windows().find((w) => w.url().includes(fragment));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${fragment} window within ${String(timeout)} ms`);
}

async function recState(shell: Page): Promise<string> {
  return shell.evaluate(async () => (await window.captureStudio.rec.status()).state);
}

/**
 * Waits until the recorder leaves `acquiring`. Under XWayland `desktopCapturer.getSources` can
 * hang (see engine-smoke.spec.ts); that is an environment limit, so the test is skipped.
 */
async function waitPastAcquiring(shell: Page): Promise<string> {
  const end = Date.now() + 25_000;
  let state = await recState(shell);
  while (['configuring', 'acquiring'].includes(state) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    state = await recState(shell);
  }
  test.skip(state === 'acquiring', 'desktopCapturer gave no screen (X display without capture)');
  return state;
}

async function windowVisible(app: ElectronApplication, fragment: string): Promise<boolean> {
  return app.evaluate(
    ({ BrowserWindow }, f) =>
      BrowserWindow.getAllWindows().some(
        (w) => w.webContents.getURL().includes(f) && w.isVisible(),
      ),
    fragment,
  );
}

async function chooseFakeDevices(shell: Page): Promise<void> {
  const camera = shell.getByTestId('camera-select');
  await expect(camera.locator('option')).not.toHaveCount(1);
  await camera.selectOption({ index: 1 });
  const mic = shell.getByTestId('mic-select');
  await expect(mic.locator('option')).not.toHaveCount(1);
  await mic.selectOption({ index: 1 });
}

const meterPeak = (page: Page, testId: string) =>
  page.getByTestId(testId).getByRole('meter').getAttribute('data-peak');

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'needs Linux with an X display');

test('the setup panel shows devices, a live preview with its real fps, meters and persists choices (R1.5, R1.6)', async () => {
  const run = await launch();
  try {
    const { shell } = run;
    const errors: string[] = [];
    shell.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // The setup panel is the default view.
    await expect(shell.getByTestId('setup-panel')).toBeVisible();
    await expect(shell.getByRole('heading', { name: 'New recording' })).toBeVisible();
    await expect(shell.getByTestId('name-preview')).toHaveText(
      /^Lesson \d{4}-\d{2}-\d{2} \d{2}-\d{2}$/,
    );

    await chooseFakeDevices(shell);
    await expect(shell.getByTestId('camera-preview')).toBeVisible();
    // The delivered rate of the preview, measured, not the requested 30.
    await expect(shell.getByTestId('camera-fps')).toHaveText(/^\d+(\.\d)? fps$/, {
      timeout: 10_000,
    });
    // The mic meter is live (a level, not "off"). Whether the fake mic is audible at a given
    // moment depends on Chromium's fake-device beeps, so only the controls test asserts sound.
    await expect
      .poll(() => meterPeak(shell, 'mic-meter'), { timeout: 10_000 })
      .toMatch(/^\d+\.\d{3}$/);
    await expect(shell.getByTestId('linked-hint')).toContainText('linked Face + Voice');

    // System audio: either a live meter or disabled with the reason.
    const toggle = shell.getByTestId('system-audio-toggle');
    if (await toggle.isDisabled()) {
      await expect(shell.getByTestId('system-audio-reason')).toContainText('Unavailable');
    } else {
      await expect(shell.getByTestId('system-meter')).toBeVisible();
    }

    // Choices persist (R1.6).
    await shell.getByLabel('Region').check();
    await shell.getByTestId('countdown-select').selectOption('5');
    await shell.getByTestId('fps-select').selectOption('60');
    await shell.getByLabel('Noise suppression').check();
    await expect
      .poll(() => shell.evaluate(async () => (await window.captureStudio.settings.get()).recorder))
      .toMatchObject({
        captureMode: 'region',
        countdownSec: 5,
        fps: 60,
        micProcessing: { ec: false, ns: true, agc: false },
        cameraId: expect.any(String),
        micId: expect.any(String),
      });

    // A device that went away falls back to none, with a notice (R1.6).
    await shell.evaluate(() =>
      window.captureStudio.rec.configure({
        captureMode: 'fullscreen',
        cameraId: 'unplugged-camera',
        micId: null,
        systemAudio: false,
        micProcessing: { ec: false, ns: false, agc: false },
        fps: 30,
        quality: 'standard',
        countdownSec: 3,
      }),
    );
    await shell.reload();
    await expect(shell.getByTestId('setup-notices')).toContainText('camera is set to None');
    await expect(shell.getByTestId('camera-select')).toHaveValue('');
    expect(errors).toEqual([]);
  } finally {
    await run.cleanup();
  }
});

test('record → countdown → controls (meters, pause, restart) → stop → saved notice and library thumbnail (R1.10–R1.12, R1.18, R1.27)', async () => {
  test.setTimeout(150_000);
  const run = await launch({ countdownSec: 3 });
  try {
    const { app, shell } = run;
    await chooseFakeDevices(shell);
    await shell.getByTestId('record-button').click();
    await waitPastAcquiring(shell);

    const controls = await windowFor(app, 'controls/index.html');
    // The countdown, unless the run was too slow to see it.
    const state = await recState(shell);
    if (state === 'countdown') await expect(controls.getByTestId('countdown')).toBeVisible();
    await expect(controls.getByTestId('controls')).toBeVisible({ timeout: 15_000 });
    await expect(controls.getByTestId('rec-status')).toHaveText('Recording');
    expect(await windowVisible(app, 'controls/index.html')).toBe(true);

    // The timer runs.
    await expect(controls.getByTestId('elapsed')).not.toHaveText('00:00', { timeout: 5_000 });
    // Meters at ≥10 Hz (R1.12): count the mic levels reaching this window in one second. (The
    // fake mic is not always audible, so the values themselves may be zero.)
    const levelsPerSecond = await controls.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let count = 0;
          const off = window.csControls.rec.onLevels((levels) => {
            if (levels.mic !== undefined) count += 1;
          });
          setTimeout(() => {
            off();
            resolve(count);
          }, 1_000);
        }),
    );
    expect(levelsPerSecond).toBeGreaterThanOrEqual(10);
    await expect(controls.getByTestId('controls-mic-meter').getByRole('meter')).toHaveAttribute(
      'data-peak',
      /^\d+\.\d{3}$/,
    );
    await expect(controls.getByTestId('controls-system-meter').getByRole('meter')).toHaveAttribute(
      'data-peak',
      'off',
    );
    await expect(controls.getByTestId('drop-indicator')).toHaveAttribute(
      'data-level',
      /^(ok|amber|red)$/,
    );

    // Pause freezes the timer.
    await controls.getByRole('button', { name: 'Pause' }).click();
    await expect(controls.getByTestId('rec-status')).toHaveText('Paused');
    const frozen = await controls.getByTestId('elapsed').textContent();
    await controls.waitForTimeout(1_500);
    await expect(controls.getByTestId('elapsed')).toHaveText(frozen ?? '');
    await controls.getByRole('button', { name: 'Resume' }).click();
    await expect(controls.getByTestId('rec-status')).toHaveText('Recording');

    // Restart asks first, then counts down again with the same setup (R1.18).
    await controls.getByRole('button', { name: 'Restart' }).click();
    await controls.getByRole('button', { name: 'Keep recording' }).click();
    await expect(controls.getByTestId('rec-status')).toHaveText('Recording');
    await controls.getByRole('button', { name: 'Restart' }).click();
    await controls.getByRole('alertdialog').getByRole('button', { name: 'Restart' }).click();
    await expect(controls.getByTestId('controls')).toBeVisible({ timeout: 20_000 });
    await expect(controls.getByTestId('elapsed')).not.toHaveText('00:00', { timeout: 5_000 });
    await controls.waitForTimeout(1_500);

    await controls.getByRole('button', { name: 'Stop' }).click();
    // Finalizing, then the completion notice; the controls window goes away.
    await expect(shell.getByTestId('completion-notice')).toBeVisible({ timeout: 60_000 });
    await expect(shell.getByTestId('completion-notice')).toContainText('Recording saved');
    await expect.poll(() => windowVisible(app, 'controls/index.html')).toBe(false);

    expect(readdirSync(run.projects).filter((n) => n.endsWith('.cstudio'))).toHaveLength(1);

    // The library shows the project with its thumbnail (CSP img-src cs-media:, CORP).
    await shell.getByRole('button', { name: 'Show in library' }).click();
    const thumb = shell.getByTestId('library-thumb');
    await expect
      .poll(
        async () => {
          if ((await thumb.count()) === 0) {
            await shell.getByRole('button', { name: 'Library' }).click();
            return 0;
          }
          return thumb.first().evaluate((img: HTMLImageElement) => img.naturalWidth);
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await run.cleanup();
  }
});

test('region mode: the picker shows the frozen frame, selects in stream pixels, then abort leaves no project (R1.9, R1.12, R1.18)', async () => {
  test.setTimeout(120_000);
  const run = await launch({ captureMode: 'region', countdownSec: 0 });
  try {
    const { app, shell } = run;
    await shell.getByTestId('record-button').click();
    await waitPastAcquiring(shell);

    const picker = await windowFor(app, 'picker/index.html');
    const frame = picker.getByRole('img', { name: /frozen frame/ });
    await expect
      .poll(() => frame.evaluate((img: HTMLImageElement) => img.naturalWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await expect(picker.getByRole('button', { name: 'Last region' })).toBeDisabled();

    const view =
      picker.viewportSize() ??
      (await picker.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })));
    const x0 = Math.round(view.width * 0.3);
    const y0 = Math.round(view.height * 0.3);
    await picker.mouse.move(x0, y0);
    await picker.mouse.down();
    await picker.mouse.move(x0 + 200, y0 + 120, { steps: 6 });
    await picker.mouse.up();
    await expect(picker.getByTestId('region-size')).toHaveText(/^\d*[02468] × \d*[02468]$/);
    const [w, h] = ((await picker.getByTestId('region-size').textContent()) ?? '')
      .split(' × ')
      .map(Number);
    expect(w).toBeGreaterThanOrEqual(64);
    expect(h).toBeGreaterThanOrEqual(64);

    await picker.waitForTimeout(600); // keys are ignored for 500 ms after opening
    // Enter confirms and the picker closes before the key-up, which Playwright reports as a
    // closed target.
    await picker.keyboard.press('Enter').catch((error: unknown) => {
      if (!String(error).includes('closed')) throw error;
    });

    const controls = await windowFor(app, 'controls/index.html');
    await expect(controls.getByTestId('controls')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => windowVisible(app, 'picker/index.html')).toBe(false);

    const saved = await shell.evaluate(
      async () => (await window.captureStudio.settings.get()).recorder.lastRegion,
    );
    expect(saved?.rect).toMatchObject({ width: w, height: h });
    expect(saved?.sourceWidth).toBeGreaterThan(0);

    await controls.getByRole('button', { name: 'Abort' }).click();
    await controls.getByRole('alertdialog').getByRole('button', { name: 'Abort' }).click();
    await expect.poll(() => recState(shell), { timeout: 20_000 }).toBe('aborted');
    await expect.poll(() => windowVisible(app, 'controls/index.html')).toBe(false);
    // The state flips first; the engine stops and then the folder goes (R1.18).
    await expect
      .poll(() => readdirSync(run.projects).filter((n) => n.endsWith('.cstudio')), {
        timeout: 30_000,
      })
      .toEqual([]);
    const log = readFileSync(path.join(run.userData, 'logs', 'main.log'), 'utf8');
    expect(log).toContain('picking-region → countdown');
  } finally {
    await run.cleanup();
  }
});
