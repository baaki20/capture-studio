import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const ROOT = path.join(import.meta.dirname, '../..');
const MAIN = path.join(ROOT, 'out/main/index.js');
const electronPath = createRequire(import.meta.url)('electron') as string;

test('Diagnostics lists capabilities and shortcut commands; --action is forwarded (R1.1, R1.2, R1.4)', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-'));
  // Launched as `electron out/main/index.js`, the app path is not the project root, so point
  // the dev FFmpeg lookup at the bundled binaries.
  const env = {
    ...process.env,
    CS_USER_DATA_DIR: userData,
    CS_FFMPEG_DIR: path.join(ROOT, 'resources/bin', `${process.platform}-${process.arch}`),
  };
  const app = await electron.launch({ args: [MAIN], cwd: ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Diagnostics' }).click();

    const table = page.getByTestId('capabilities');
    await expect(table.getByText('audio.system', { exact: true })).toBeVisible();
    await expect(table.getByText('hotkeys.global', { exact: true })).toBeVisible();
    await expect(page.getByTestId('ffmpeg-version')).toHaveText(/^n\d/, { timeout: 15_000 });
    await expect(page.getByTestId('log-path')).toContainText(path.join(userData, 'logs'));
    await expect(page.getByTestId('shortcut-toggle-recording')).toContainText(
      '--action toggle-recording',
    );

    const report = await page.evaluate(() => window.captureStudio.diag.copyReport());
    expect(report.text).toContain('Capture Studio diagnostics');
    expect(report.text).toContain('audio.system: ');

    // A second launch forwards its action to this instance and exits. `stop-recording` is a
    // no-op while idle, so the test never opens the ScreenCast portal.
    const second = spawn(electronPath, [MAIN, '--action', 'stop-recording'], {
      cwd: ROOT,
      env,
      stdio: 'ignore',
    });
    const exitCode = await new Promise<number | null>((resolve) => second.on('exit', resolve));
    expect(exitCode).toBe(0);
    await expect
      .poll(() => readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8'), {
        timeout: 5_000,
      })
      .toContain('action: stop-recording (from cli)');
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
