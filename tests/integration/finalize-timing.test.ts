/**
 * Finalize timing (R1.20): finalizing a recording (remux, probe and drift fits, through the real
 * media utility service) on a synthetic recorder-shaped fixture. The project is ready, and the
 * editor opens, right after the drift fits; peaks and thumbnails follow in the background
 * (R1.44), so they are timed and reported separately and are not part of the 10 s.
 * CI runs a 1-minute recording and checks the result (timing is only reported); `CS_PERF=1` runs
 * the requirement's 10 minutes on the projects disk (`~/.cache/capture-studio-tests`, or
 * `CS_PERF_DIR`) and asserts at most 10 s.
 * Needs `npm run fetch:ffmpeg` first.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import { benchFinalize } from '../wayland/lib/finalize-bench';

const ROOT = path.join(import.meta.dirname, '../..');
const PERF = process.env.CS_PERF === '1';
const MINUTES = PERF ? 10 : 1;
const LIMIT_MS = 10_000;

let ffmpeg: FfmpegLocation;
let work: string;

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  const base = PERF
    ? (process.env.CS_PERF_DIR ?? path.join(os.homedir(), '.cache', 'capture-studio-tests'))
    : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  work = await fs.mkdtemp(path.join(base, 'cs-finalize-'));
});

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

describe(`finalize timing (R1.20, ${String(MINUTES)}-minute recording)`, () => {
  it(
    PERF ? `finalizes within ${String(LIMIT_MS / 1000)} s` : 'finalizes every stream',
    async () => {
      const result = await benchFinalize({
        ffmpeg: ffmpeg.ffmpeg,
        ffprobe: ffmpeg.ffprobe,
        minutes: MINUTES,
        workDir: work,
      });
      // Stop → project ready: what the user waits for before the editor opens.
      const readyMs = result.finalizeMs + result.driftMs;
      console.info(
        `finalize ${String(MINUTES)} min (${(result.bytes / 1e6).toFixed(0)} MB): ` +
          `ready after ${String(readyMs)} ms = remux/probe ${String(result.finalizeMs)} + drift ` +
          `${String(result.driftMs)}; background peaks/thumbnails ${String(result.cachesMs)} ms ` +
          JSON.stringify(result.jobs),
      );
      expect(result.streams.map((s) => [s.kind, s.ok])).toEqual([
        ['screen', true],
        ['camera', true],
        ['mic', true],
        ['system', true],
      ]);
      for (const s of result.streams) {
        expect(Math.abs((s.durationUs ?? 0) - MINUTES * 60e6)).toBeLessThan(1.5e6);
      }
      // Timing is asserted only on the quiet perf run: under the parallel test suite FFmpeg jobs
      // compete for the CPU, and a 1-minute fixture says little about the 10-minute requirement.
      if (PERF) expect(readyMs).toBeLessThanOrEqual(LIMIT_MS);
    },
    600_000,
  );
});
