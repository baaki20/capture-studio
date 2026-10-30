/**
 * Writer and recovery (§4.6.2, R1.21): a child process records a screen stream through the real
 * write path (engine muxer → MessagePort → utility writer) and is SIGKILLed at 20 random offsets.
 * Recovery (finalize with `recovering`) must yield a probe-valid file whose media reaches within
 * 2 s of the kill.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import { finalizeRecording } from '../../src/utility/media/finalize';

const ROOT = path.join(import.meta.dirname, '../..');
const CHILD = path.join(import.meta.dirname, 'helpers/stream-writer-child.ts');
const RUNS = 20;
/** R1.21: every stream up to at most 2 s before the kill. */
const MAX_LOSS_S = 2;
/** Kill offsets after media time 0, in seconds (the source is 10 s long). */
const MIN_OFFSET_S = 0.5;
const MAX_OFFSET_S = 7;

let ffmpeg: FfmpegLocation;
let work: string;
let source: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-writer-kill-'));
  source = path.join(work, 'source.mp4');
  // 30 fps H.264 with a keyframe every second, like the recorder's cadence (KeyframeCadence).
  execFileSync(
    ffmpeg.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30:duration=10',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '30',
      '-bf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-y',
      source,
    ],
    { timeout: 60_000 },
  );
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

interface Run {
  offsetS: number;
  fedS: number;
  recoveredS: number | null;
  error: string | null;
}

async function killAt(index: number, offsetS: number): Promise<Run> {
  const dir = path.join(work, `run-${String(index)}`);
  await fs.mkdir(dir);
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, source, dir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  const startedAt = await new Promise<number>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('writer child did not start')), 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const newline = out.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      resolve((JSON.parse(out.slice(0, newline)) as { startedAt: number }).startedAt);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`writer child exited early (${String(code)})`));
    });
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const wait = startedAt + offsetS * 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  // Media time fed by the moment of the kill.
  const fedS = (Date.now() - startedAt) / 1000;
  child.kill('SIGKILL');
  await exited;

  const [screen] = await finalizeRecording({
    ffmpegPath: ffmpeg.ffmpeg,
    ffprobePath: ffmpeg.ffprobe,
    dir,
    streams: [{ kind: 'screen', expect: { video: 1, audio: 0 } }],
    recovering: true,
  });
  return {
    offsetS,
    fedS,
    recoveredS: screen?.ok && screen.durationUs !== null ? screen.durationUs / 1e6 : null,
    error: screen?.ok ? null : (screen?.error ?? 'no result'),
  };
}

describe('stream writer killed mid-recording (R1.21, §4.6.2)', () => {
  it(`recovers every stream to within ${String(MAX_LOSS_S)} s of a SIGKILL at ${String(RUNS)} random offsets`, async () => {
    const offsets = Array.from(
      { length: RUNS },
      () => MIN_OFFSET_S + Math.random() * (MAX_OFFSET_S - MIN_OFFSET_S),
    );
    const runs: Run[] = [];
    // Four writers at a time keep the test short without starving the real-time pacing.
    for (let i = 0; i < RUNS; i += 4) {
      runs.push(
        ...(await Promise.all(offsets.slice(i, i + 4).map((offset, j) => killAt(i + j, offset)))),
      );
    }
    const report = runs.map(
      (r) =>
        `kill at ${r.fedS.toFixed(2)} s → ${r.recoveredS === null ? `none (${String(r.error)})` : `${r.recoveredS.toFixed(2)} s`}`,
    );
    for (const run of runs) {
      if (run.recoveredS === null) {
        // Only a kill before the first fragment was complete may leave nothing to recover.
        expect(run.fedS, report.join('\n')).toBeLessThan(MAX_LOSS_S);
      } else {
        expect(run.fedS - run.recoveredS, report.join('\n')).toBeLessThanOrEqual(MAX_LOSS_S);
        expect(run.recoveredS, report.join('\n')).toBeLessThanOrEqual(run.fedS + 0.1);
      }
    }
  }, 300_000);
});
