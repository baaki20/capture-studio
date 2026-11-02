import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/reap-children.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/reap-children.ts'],
          // Real FFmpeg encodes run in parallel files; CI runners are slower than a dev machine.
          testTimeout: process.env.CI ? 180_000 : 60_000,
          hookTimeout: process.env.CI ? 180_000 : 60_000,
        },
      },
    ],
  },
});
