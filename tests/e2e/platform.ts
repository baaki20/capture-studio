import path from 'node:path';
import { test, type ElectronApplication } from '@playwright/test';

/**
 * Where the end-to-end tests can run (P3 step 10, acceptance a). Linux needs an X server (Xvfb in
 * CI); Windows and macOS always have a display.
 *
 * - `HAS_DISPLAY`: the app and its editor, export and preview (no screen capture).
 * - `CAN_CAPTURE`: recording the screen too. Linux X11 and Windows can; GitHub's macOS runners
 *   cannot grant Screen Recording, so recording on macOS is a manual check
 *   (`docs/macos-manual-checklist.md`).
 */
export const HAS_DISPLAY =
  process.platform === 'linux'
    ? Boolean(process.env.DISPLAY)
    : process.platform === 'win32' || process.platform === 'darwin';

export const CAN_CAPTURE =
  process.platform === 'linux' ? Boolean(process.env.DISPLAY) : process.platform === 'win32';

/**
 * The test-only control channel (`CS_HARNESS_SOCKET`): a Unix socket in the test's profile, or on
 * Windows a named pipe (a file path cannot be listened on there).
 */
export function controlSocketPath(userData: string): string {
  if (process.platform !== 'win32') return path.join(userData, 'control.sock');
  return `\\\\.\\pipe\\cs-harness-${path.basename(userData)}`;
}

/**
 * Collects the console output of every window of the app (editor, render window, engine), for
 * diagnosing failures on the Windows and macOS runners; `attach` adds it to the test's results.
 */
export function recordConsole(app: ElectronApplication): { attach: () => Promise<void> } {
  const lines: string[] = [];
  const watch = (page: {
    url(): string;
    on(event: 'console', fn: (m: { type(): string; text(): string }) => void): unknown;
  }) => {
    page.on('console', (m) => {
      lines.push(`[${page.url().split('/').slice(-2, -1)[0] ?? '?'}] ${m.type()}: ${m.text()}`);
    });
  };
  for (const page of app.windows()) watch(page);
  app.on('window', watch);
  return {
    attach: () =>
      test
        .info()
        .attach('console.txt', { body: lines.join('\n'), contentType: 'text/plain' })
        .catch(() => undefined),
  };
}
