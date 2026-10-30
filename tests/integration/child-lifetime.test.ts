/**
 * Media children die with their parent (FFmpeg orphans: an export once outlived its tests by 34
 * hours). A Node parent starts a never-ending export, or a system-audio capture with its Opus
 * encoder, through the real runner; the parent is then SIGKILLed (no JavaScript runs) or exits,
 * and every child pid must be gone within 2 s. Both parent-death mechanisms are exercised:
 * `setpriv --pdeathsig` and the `sh` watchdog fallback.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg } from '../../src/main/ffmpeg/locate';
import { deathSignalMode } from '../../src/utility/media/child-processes';

const ROOT = path.join(import.meta.dirname, '../..');
const PARENT = path.join(import.meta.dirname, 'helpers/orphan-parent.ts');
const linux = process.platform === 'linux';

let ffmpegPath: string;
let work: string;
const parents: ChildProcess[] = [];
const reported: number[] = [];

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpegPath = located.value.ffmpeg;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-orphans-'));
});

// Whatever happens in a test, nothing it started outlives it.
afterEach(() => {
  for (const parent of parents.splice(0)) parent.kill('SIGKILL');
  for (const pid of reported.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone, as expected.
    }
  }
});

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

/** True while `pid` is a live process (a zombie has already died). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

async function waitGone(pids: readonly number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    left = left.filter(alive);
  }
  return left;
}

interface Reported {
  pid: number;
  file: string;
}

async function startParent(
  kind: 'export' | 'pcm',
  mode: 'setpriv' | 'watchdog' | 'none',
  then: 'wait' | 'exit' = 'wait',
): Promise<{ parent: ChildProcess; children: Reported[] }> {
  const dir = await fs.mkdtemp(path.join(work, `${kind}-${mode}-`));
  const parent = spawn(
    process.execPath,
    ['--import', 'tsx', PARENT, ffmpegPath, dir, kind, mode, then],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  parents.push(parent);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('parent did not report its children')), 20_000);
    parent.stdout.setEncoding('utf8');
    parent.stdout.on('data', (chunk: string) => {
      out += chunk;
      const newline = out.indexOf('\n');
      if (newline !== -1) {
        clearTimeout(timer);
        resolve(out.slice(0, newline));
      }
    });
    parent.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`parent exited early (${String(code)})`));
    });
  });
  const children = JSON.parse(line) as Reported[];
  reported.push(...children.map((c) => c.pid));
  return { parent, children };
}

describe.skipIf(!linux)('media children die with their parent', () => {
  it('uses setpriv --pdeathsig on this machine', () => {
    expect(deathSignalMode()).toBe('setpriv');
  });

  for (const mode of ['setpriv', 'watchdog'] as const) {
    for (const kind of ['export', 'pcm'] as const) {
      it(`${kind}: SIGKILL of the parent kills every child within 2 s (${mode})`, async () => {
        const { parent, children } = await startParent(kind, mode);
        // export: FFmpeg; pcm: the capture and the encoder; watchdog mode adds one sh each.
        expect(children.length).toBe((kind === 'export' ? 1 : 2) * (mode === 'watchdog' ? 2 : 1));
        const pids = children.map((c) => c.pid);
        await new Promise((r) => setTimeout(r, 500));
        expect(pids.filter(alive)).toEqual(pids);

        parent.kill('SIGKILL');
        expect(await waitGone(pids, 2000)).toEqual([]);
      });
    }
  }

  it('kills children synchronously when the parent exits normally', async () => {
    // No parent-death signal: only `process.on('exit')` can kill the child here.
    const { parent, children } = await startParent('export', 'none', 'exit');
    await new Promise((resolve) => parent.once('exit', resolve));
    expect(
      await waitGone(
        children.map((c) => c.pid),
        500,
      ),
    ).toEqual([]);
  });
});
