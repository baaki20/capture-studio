import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { ConfigEnv, Plugin } from 'vite';
import { buildCsp } from './src/shared/security/csp';

/** Injects the CSP meta tag into every renderer HTML entry (strict in production builds). */
function cspPlugin(env: ConfigEnv): Plugin {
  return {
    name: 'capture-studio:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        const devServerOrigin =
          env.command === 'serve' && ctx.server
            ? `http://localhost:${String(ctx.server.config.server.port)}`
            : undefined;
        return [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: buildCsp(devServerOrigin ? { devServerOrigin } : {}),
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

/** Every window has a preload entry (§4.2), even before its page exists. */
const PRELOADS = ['shell', 'controls', 'picker', 'editor', 'engine', 'source-picker'] as const;

/**
 * Renderer pages are added as their `index.html` appears, so later steps (controls, picker,
 * editor, engine) only need to create the page.
 */
function rendererInputs(): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const name of PRELOADS) {
    const page = resolve('src/renderer', name, 'index.html');
    if (existsSync(page)) inputs[name] = page;
  }
  return inputs;
}

export default defineConfig((env) => ({
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads must be a single CommonJS file with no runtime requires.
      externalizeDeps: false,
      isolatedEntries: true,
      rolldownOptions: {
        input: Object.fromEntries(
          PRELOADS.map((name) => [name, resolve(`src/preload/${name}.ts`)]),
        ),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), cspPlugin(env)],
    server: {
      port: 5173,
      strictPort: true,
    },
    worker: {
      format: 'es',
    },
    build: {
      rolldownOptions: {
        input: rendererInputs(),
      },
    },
  },
}));
