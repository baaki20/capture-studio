import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const ROOT = path.join(import.meta.dirname, '../..');

/**
 * Closes the app, but does not wait forever: if it has not quit after `ms`, the app's log and
 * process tree are attached (to see which shutdown step hangs) and the process is killed.
 */
async function closeWithin(app: ElectronApplication, userData: string, ms: number) {
  const pid = app.process().pid;
  const closed = app.close().then(() => true);
  const quit = await Promise.race([
    closed,
    new Promise<false>((r) => setTimeout(() => r(false), ms)),
  ]);
  if (quit) return;
  const log = path.join(userData, 'logs', 'main.log');
  if (existsSync(log)) await test.info().attach('main.log', { path: log });
  // Every process with its parent and group: the main process may be gone while something it
  // started (a helper, or a program it launched) still holds the stdio pipes Playwright waits on.
  const tree = execFileSync('ps', ['-eo', 'pid,ppid,pgid,stat,etime,args'], { encoding: 'utf8' });
  await test.info().attach('processes.txt', { body: `main pid ${String(pid)}\n${tree}` });
  app.process().kill('SIGKILL');
  throw new Error(
    `the app did not quit within ${String(ms / 1000)} s (see main.log and processes.txt)`,
  );
}

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

    // Navigation away from the app is blocked and the URL is handed to the system browser.
    // The hand-off is recorded instead of performed: a real browser would inherit the app's
    // stdio and keep Playwright waiting for the app to close.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { openedExternal?: string[] }).openedExternal = opened;
      shell.openExternal = (url: string) => {
        opened.push(url);
        return Promise.resolve();
      };
    });
    await page.evaluate(() => {
      window.location.href = 'https://example.invalid/';
    });
    await expect
      .poll(() => app.evaluate(() => (globalThis as { openedExternal?: string[] }).openedExternal))
      .toEqual(['https://example.invalid/']);
    expect(page.url()).toContain('/shell/index.html');

    expect(errors).toEqual([]);
  } finally {
    try {
      await closeWithin(app, userData, 15_000);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  }
});
