import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const ROOT = path.join(import.meta.dirname, '../..');

test('the shell window opens sandboxed, with its preload and worker working', async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-'));
  const app = await electron.launch({
    args: [path.join(ROOT, 'out/main/index.js')],
    cwd: ROOT,
    env: { ...process.env, CS_USER_DATA_DIR: userData },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await expect(page).toHaveTitle('Capture Studio');
    await expect(page.getByRole('heading', { name: 'Capture Studio' })).toBeVisible();
    // The setup panel is the default view (step 11); the worker check lives under About.
    await expect(page.getByTestId('setup-panel')).toBeVisible();
    await page.getByRole('button', { name: 'About' }).click();
    await expect(page.getByTestId('worker-state')).toHaveText('ok');

    // No Node in the page; the preload bridge is present.
    const pageGlobals = await page.evaluate(() => ({
      hasRequire: typeof (globalThis as { require?: unknown }).require !== 'undefined',
      hasProcess: typeof (globalThis as { process?: unknown }).process !== 'undefined',
      electron: window.captureStudio.versions.electron,
    }));
    expect(pageGlobals).toEqual({
      hasRequire: false,
      hasProcess: false,
      electron: expect.any(String),
    });

    const csp = await page.evaluate(
      () =>
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content') ?? null,
    );
    expect(csp).toContain("default-src 'none'");

    // Navigation away from the app is blocked.
    await page.evaluate(() => {
      window.location.href = 'https://example.invalid/';
    });
    await page.waitForTimeout(500);
    expect(page.url()).toContain('/shell/index.html');

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
