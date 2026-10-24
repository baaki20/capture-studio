import { defineConfig } from '@playwright/test';

/**
 * E2E tests drive the built app with Playwright's `_electron` (spec §4.6.3). CI runs them under
 * Xvfb on an X11 Electron. Run `npm run test:e2e` (it builds first).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
