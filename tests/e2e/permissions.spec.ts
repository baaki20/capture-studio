/**
 * macOS permission guidance (P3 step 3, R3.6) on Linux: `CS_TEST_MAC_PERMISSIONS` describes a
 * Mac to the permission service (test mode only; capabilities stay Linux's). With Screen
 * Recording off, the setup panel explains it, Record is disabled except for audio only, and main
 * refuses `rec.record` with the same reason. macOS's prompts grant at once in this mode, and
 * System Settings is never opened (main logs what it would open).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { HAS_DISPLAY } from './platform';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');

test.skip(!HAS_DISPLAY, 'needs a display');

test('explains missing macOS permissions and blocks screen recording without Screen Recording (R3.6)', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-perms-'));
  const app = await electron.launch({
    args: ['--ozone-platform=x11', '--use-fake-device-for-media-stream', MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_TEST: '1',
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`),
      CS_TEST_MAC_PERMISSIONS: JSON.stringify({
        screen: 'denied',
        camera: 'not-determined',
        microphone: 'granted',
        inputMonitoring: 'denied',
      }),
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  try {
    const shell = await app.firstWindow();
    const card = shell.getByTestId('permissions');
    await expect(card).toBeVisible();
    await expect(shell.getByTestId('permission-screen-status')).toHaveText('Off');
    await expect(shell.getByTestId('permissions-blocked')).toContainText('Screen Recording');
    // Allowed permissions are not listed; Screen Recording has no prompt, only System Settings.
    await expect(shell.getByTestId('permission-microphone')).toHaveCount(0);
    await expect(shell.getByTestId('permission-screen-request')).toHaveCount(0);
    await expect(shell.getByTestId('record-button')).toBeDisabled();

    // Main refuses too (the tray, hotkeys and --action do not go through this button).
    const refused = await shell.evaluate(() => window.captureStudio.rec.record());
    expect(refused).toMatchObject({ status: 'failed' });
    expect((refused as { message: string }).message).toContain('Screen Recording');

    // Audio only needs no screen.
    await shell.getByLabel('Audio only').check();
    await expect(shell.getByTestId('record-button')).toBeEnabled();
    await shell.getByLabel('Full screen').check();
    await expect(shell.getByTestId('record-button')).toBeDisabled();

    // macOS's own prompts (granted at once in test mode) take the items off the list.
    await shell.getByTestId('permission-camera-request').click();
    await expect(shell.getByTestId('permission-camera')).toHaveCount(0);
    await shell.getByTestId('permission-inputMonitoring-request').click();
    await expect(shell.getByTestId('permission-inputMonitoring')).toHaveCount(0);

    // System Settings: the right pane, never opened for real here.
    await shell.getByTestId('permission-screen-settings').click();
    await expect
      .poll(() => readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8'))
      .toContain(
        'would open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
    await expect(card).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('shows nothing on a system without these permissions', async () => {
  test.skip(process.platform === 'darwin', 'macOS has these permissions');
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-perms-'));
  const app = await electron.launch({
    args: ['--ozone-platform=x11', MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      CS_TEST: '1',
      CS_USER_DATA_DIR: userData,
      CS_FFMPEG_DIR: path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`),
      XDG_SESSION_TYPE: 'x11',
      WAYLAND_DISPLAY: '',
    },
  });
  try {
    const shell = await app.firstWindow();
    await expect(shell.getByTestId('setup-panel')).toBeVisible();
    expect(await shell.evaluate(() => window.captureStudio.perms.get())).toMatchObject({
      applies: false,
    });
    await expect(shell.getByTestId('permissions')).toHaveCount(0);
    await expect(shell.getByTestId('record-button')).toBeEnabled();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
