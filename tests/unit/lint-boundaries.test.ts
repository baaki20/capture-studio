/**
 * The ESLint import zones enforce process boundaries (spec §1.2). Lints small snippets as if they
 * lived in each folder.
 */
import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(import.meta.dirname, '../..');
// The snippets are not on disk, so type-aware rules (which need the TS project) are switched off.
const eslint = new ESLint({ cwd: ROOT, overrideConfig: [tseslint.configs.disableTypeChecked] });

async function boundaryErrors(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  const fatal = result?.messages.find((m) => m.fatal);
  if (fatal) throw new Error(fatal.message);
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

describe('process-boundary lint zones', () => {
  it.each([
    ['src/renderer/shell/x.ts', "import fs from 'node:fs';\nexport const a = fs;\n"],
    [
      'src/renderer/shell/x.ts',
      "import { readFile } from 'fs/promises';\nexport const a = readFile;\n",
    ],
    ['src/renderer/shell/x.ts', "import { app } from 'electron';\nexport const a = app;\n"],
    [
      'src/renderer/shell/x.ts',
      "import { log } from '../../main/logging';\nexport const a = log;\n",
    ],
    [
      'src/renderer/shell/x.ts',
      "import { runFfmpeg } from '../../utility/media/ffmpeg-runner';\nexport const a = runFfmpeg;\n",
    ],
    ['src/shared/x.ts', "import path from 'node:path';\nexport const a = path;\n"],
    ['src/shared/x.ts', "import { shell } from 'electron';\nexport const a = shell;\n"],
    ['src/shared/x.ts', "import { log } from '../main/logging';\nexport const a = log;\n"],
    ['src/main/x.ts', "import { App } from '../renderer/shell/App';\nexport const a = App;\n"],
    [
      'src/main/x.ts',
      "import { probeMedia } from '../utility/media/probe';\nexport const a = probeMedia;\n",
    ],
    [
      'src/utility/media/x.ts',
      "import { log } from '../../main/logging';\nexport const a = log;\n",
    ],
  ])('%s: rejects %j', async (file, code) => {
    expect(await boundaryErrors(file, code)).not.toEqual([]);
  });

  it.each([
    [
      'src/renderer/shell/x.ts',
      "import { ulid } from '../../shared/ids';\nexport const a = ulid;\n",
    ],
    ['src/main/x.ts', "import p from '../utility/media/index?modulePath';\nexport const a = p;\n"],
    ['src/main/x.ts', "import path from 'node:path';\nexport const a = path;\n"],
    ['src/utility/media/x.ts', "import { ok } from '../../shared/result';\nexport const a = ok;\n"],
  ])('%s: allows %j', async (file, code) => {
    expect(await boundaryErrors(file, code)).toEqual([]);
  });
});
