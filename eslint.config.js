// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** `fs`, `node:fs`, `fs/promises`, … */
const NODE_BUILTINS = builtinModules.flatMap((m) => [m, `${m}/*`, `node:${m}`, `node:${m}/*`]);

const nodeImports = {
  group: NODE_BUILTINS,
  message: 'Node built-ins are not available here (process boundary, spec §1.2).',
};
const electronImports = {
  group: ['electron', 'electron/*'],
  message: 'Electron APIs are not available here (process boundary, spec §1.2).',
};

/** Matches relative or aliased imports that reach into another process's source folder. */
function processFolder(names, message) {
  return { regex: `(^|/)(${names.join('|')})(/|$)`, message };
}

/**
 * Process-boundary zones (spec §1.2): renderers cannot reach Node, main or utility code; the
 * shared core cannot reach Node, Electron or any process folder; main does not import renderer
 * or utility code (it starts the utility by path via `?modulePath`).
 */
const boundaryZones = [
  {
    files: ['src/renderer/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            nodeImports,
            electronImports,
            processFolder(
              ['main', 'utility', 'preload'],
              'Renderers talk to main only through preload APIs.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            nodeImports,
            electronImports,
            processFolder(
              ['main', 'utility', 'preload', 'renderer'],
              'The shared core is pure TypeScript and must not depend on a process.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            processFolder(
              ['renderer', 'preload'],
              'Main must not import renderer or preload code.',
            ),
            {
              regex: '(^|/)utility/.*(?<!\\?modulePath)$',
              message:
                'Main starts the utility process by path (`?modulePath`), it does not import its code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/utility/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            processFolder(
              ['main', 'renderer', 'preload'],
              'Utility processes share code only through src/shared.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/preload/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            processFolder(
              ['main', 'renderer', 'utility'],
              'Preloads share code only through src/shared.',
            ),
          ],
        },
      ],
    },
  },
];

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'resources/**',
      'coverage/**',
      '.cache/**',
      'docs/schemas/**',
      'spikes/**',
      'tests/sync/pattern/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    files: [
      'src/main/**',
      'src/preload/**',
      'src/utility/**',
      'scripts/**',
      'tests/**',
      '*.config.{js,ts}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/renderer/**'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  ...boundaryZones,
  prettier,
);
