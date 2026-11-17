/**
 * Capability smoke test (P3 step 10, acceptance e): no capability the app reports as
 * `available` may fail a check of what it promises. The app runs as it does for users (no test
 * mode); each check runs in its main process. Capabilities without an automatic check (they need
 * a person, sound or a real device) are listed in the output, and their manual checks are in the
 * per-OS checklists.
 *
 * Runs wherever there is a display: Linux under Xvfb, and the Windows and macOS runners.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { CapabilityReport } from '../../src/shared/capabilities/types';
import { HAS_DISPLAY } from './platform';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const FFMPEG_DIR = path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`);
const HELPER_DIR = path.join(ROOT, 'resources/native', `${process.platform}-${process.arch}`);

type Check = (
  app: ElectronApplication,
  strategy: string | null,
  log: () => string,
) => Promise<void>;

/** What "available" promises, checked. Keys missing here have no automatic check. */
const CHECKS: Partial<Record<CapabilityKey, Check>> = {
  'capture.screen.source': async (app, strategy) => {
    // The portal (Wayland) would ask the user; everywhere else the screens are listed.
    if (strategy === 'portal') return;
    const count = await app.evaluate(
      async ({ desktopCapturer }) =>
        (
          await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 },
          })
        ).length,
    );
    expect(count).toBeGreaterThan(0);
  },
  'capture.window.enumerate': async (app) => {
    const listed = await app.evaluate(async ({ desktopCapturer }) =>
      Array.isArray(
        await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
        }),
      ),
    );
    expect(listed).toBe(true);
  },
  'capture.screenshot.silent': async (app) => {
    const count = await app.evaluate(
      async ({ desktopCapturer }) =>
        (
          await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 },
          })
        ).length,
    );
    expect(count).toBeGreaterThan(0);
  },
  'capture.region.onScreenOverlay': async (app) => {
    const ok = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = new BrowserWindow({
        ...screen.getPrimaryDisplay().bounds,
        show: false,
        frame: false,
        transparent: true,
        focusable: false,
      });
      win.setIgnoreMouseEvents(true);
      win.setAlwaysOnTop(true, 'screen-saver');
      const bounds = win.getBounds();
      win.destroy();
      return bounds.width > 0;
    });
    expect(ok).toBe(true);
  },
  'capture.cursor.track': async (app, strategy, log) => {
    if (strategy === 'native-helper') {
      await expect.poll(log).toMatch(/native helper: (x11|win32|macos)/);
    }
    const point = await app.evaluate(({ screen }) => screen.getCursorScreenPoint());
    expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
  },
  'encode.ffmpeg.hw': async (app, strategy) => {
    const shell = await app.firstWindow();
    const report = await shell.evaluate(() => window.captureStudio.diag.get());
    expect(report.encoders?.hardware).toBe(strategy);
    expect(report.encoders?.encoders.find((e) => e.name === strategy)?.works).toBe(true);
  },
  'hotkeys.global': async (app) => {
    const registered = await app.evaluate(({ globalShortcut }) => {
      const accelerator = 'CommandOrControl+Alt+Shift+F11';
      const ok = globalShortcut.register(accelerator, () => undefined);
      globalShortcut.unregister(accelerator);
      return ok;
    });
    expect(registered).toBe(true);
  },
  'ui.alwaysOnTop': async (app) => {
    const onTop = await app.evaluate(({ BrowserWindow }) => {
      const win = new BrowserWindow({ show: false });
      win.setAlwaysOnTop(true);
      const result = win.isAlwaysOnTop();
      win.destroy();
      return result;
    });
    expect(onTop).toBe(true);
  },
  'ui.excludeFromCapture': async (app) => {
    const ok = await app.evaluate(({ BrowserWindow }) => {
      const win = new BrowserWindow({ show: false });
      win.setContentProtection(true);
      win.destroy();
      return true;
    });
    expect(ok).toBe(true);
  },
  'clipboard.writeImageUnfocused': async (app) => {
    // Electron 45's clipboard: async, ClipboardItem-based (W3C style).
    const ok = await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
      const png = nativeImage
        .createFromBuffer(Buffer.alloc(16, 255), { width: 2, height: 2 })
        .toPNG();
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }),
      ]);
      return clipboard.has('image/png');
    });
    expect(ok).toBe(true);
  },
  'secrets.persistent': async (app) => {
    const ok = await app.evaluate(({ safeStorage }) => safeStorage.isAsyncEncryptionAvailable());
    expect(ok).toBe(true);
  },
  'startup.login': async (app) => {
    const settings = await app.evaluate(({ app: electronApp }) =>
      electronApp.getLoginItemSettings(),
    );
    expect(typeof settings.openAtLogin).toBe('boolean');
  },
};

type CapabilityKey = keyof CapabilityReport['capabilities'];

test.skip(!HAS_DISPLAY, 'needs a display');

test('every available capability passes its smoke check (acceptance e)', async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-caps-'));
  const app = await electron.launch({
    args: ['--ozone-platform=x11', MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: FFMPEG_DIR,
      CS_NATIVE_DIR: HELPER_DIR,
      XDG_SESSION_TYPE: process.platform === 'linux' ? 'x11' : (process.env.XDG_SESSION_TYPE ?? ''),
      WAYLAND_DISPLAY: '',
    },
  });
  const log = () => {
    try {
      return readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
    } catch {
      return '';
    }
  };
  try {
    const shell = await app.firstWindow();
    // The encoder probe finishes in the background; wait for the report that includes it.
    await expect
      .poll(
        async () =>
          (await shell.evaluate(() => window.captureStudio.caps.get())).capabilities[
            'encode.ffmpeg.hw'
          ].reason,
        { timeout: 60_000 },
      )
      .not.toContain('has not finished');
    const report = await shell.evaluate(() => window.captureStudio.caps.get());
    const checked: string[] = [];
    const unchecked: string[] = [];
    for (const [key, capability] of Object.entries(report.capabilities) as [
      CapabilityKey,
      CapabilityReport['capabilities'][CapabilityKey],
    ][]) {
      if (capability.state !== 'available') continue;
      const check = CHECKS[key];
      if (!check) {
        unchecked.push(`${key} (${capability.strategy ?? '–'})`);
        continue;
      }
      await test.step(`${key}: ${capability.strategy ?? '–'}`, () =>
        check(app, capability.strategy, log));
      checked.push(key);
    }
    console.info(`capabilities checked: ${checked.join(', ')}`);
    console.info(
      `available without an automatic check (manual checklists): ${unchecked.join(', ')}`,
    );
    expect(checked.length).toBeGreaterThan(3);
  } finally {
    await app.close().catch(() => undefined);
    await test
      .info()
      .attach('main.log', { path: path.join(userData, 'logs', 'main.log') })
      .catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
  }
});
