/**
 * Export memory with clips out of file order (§4.3.9): a clip moved before one that plays an
 * earlier part of the same file must not make FFmpeg buffer the decoded frames in between. The
 * graph opens the file again, seeked, for such clips (`graph-builder.ts`); this runs the real
 * FFmpeg on a long synthetic source with its halves swapped, samples the process's peak RSS
 * (`VmHWM` in /proc/<pid>/status), and checks it stays near the in-order export's, and that the
 * seeked input shows exactly the frames the timeline asks for.
 *
 * With one input per file, the swapped export of this source peaked at about 480 MB (against
 * 110 MB in order).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { applyOp, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import {
  buildExportGraph,
  resolveExportSettings,
} from '../../src/utility/media/export/graph-builder';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../..');
const SECONDS = 60;
const W = 640;
const H = 360;

let ffmpeg: FfmpegLocation;
let work: string;
let project: string;

function edit(doc: ProjectV1, ...ops: TimelineOp[]): ProjectV1 {
  const generateId = counterIds('M');
  return ops.reduce((d, op) => unwrap(applyOp(d, op, { generateId })), doc);
}

/** Screen and voice of SECONDS, split in two halves. */
function halves(): ProjectV1 {
  const doc = recordedProject({
    durationUs: SECONDS * 1_000_000,
    screenSize: { width: W, height: H },
    camera: false,
    system: false,
    pauses: [],
    offsets: { screen: 0, camera: 0, microphone: 0, 'system-audio': 0 },
  });
  return edit(doc, { type: 'split', atUs: (SECONDS / 2) * 1_000_000 });
}

/** The second half first: move it after the end, then the first half after it, then close the gap. */
function swapped(): ProjectV1 {
  let doc = halves();
  const half = (SECONDS / 2) * 1_000_000;
  for (const name of ['Screen', 'Voice']) {
    const [first, second] = trackByName(doc, name).clips.map((c) => c.id);
    doc = edit(
      doc,
      { type: 'move', clipId: second ?? '', toStartUs: 2 * half, includeLinked: false },
      { type: 'move', clipId: first ?? '', toStartUs: 3 * half, includeLinked: false },
    );
  }
  return edit(doc, { type: 'cutRange', inUs: 0, outUs: 2 * half });
}

/** Runs the export of `doc` and returns FFmpeg's peak RSS in MB. */
async function exportPeakMb(doc: ProjectV1, name: string): Promise<number> {
  const settings = resolveExportSettings(
    doc,
    { resolution: 'canvas', fps: 'project', quality: 'draft', encoder: 'software' },
    null,
  );
  const script = path.join(work, `${name}.txt`);
  const audioScript = path.join(work, `${name}-audio.txt`);
  const graph = unwrap(
    buildExportGraph({
      doc,
      projectRoot: project,
      settings,
      outputPath: path.join(work, `${name}.mp4`),
      filterScriptPath: script,
      audioScriptPath: audioScript,
      maskDir: work,
    }),
  );
  await fs.writeFile(script, graph.videoScriptText);
  await fs.writeFile(audioScript, graph.audioScriptText);
  const child = spawn(ffmpeg.ffmpeg, ['-hide_banner', '-nostats', ...graph.args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  let peakKb = 0;
  const sample = (): void => {
    try {
      const status = readFileSync(`/proc/${String(child.pid)}/status`, 'utf8');
      peakKb = Math.max(peakKb, Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0));
    } catch {
      // Exited between samples.
    }
  };
  const timer = setInterval(sample, 25);
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  clearInterval(timer);
  expect(code, stderr.slice(-1000)).toBe(0);
  return peakKb / 1024;
}

/** Grey thumbnails of every frame in `[t, t + d)` of a file. */
function frames(file: string, t: number, d: number): Buffer[] {
  const out = execFileSync(
    ffmpeg.ffmpeg,
    ['-v', 'error', '-ss', String(t), '-t', String(d), '-i', file].concat([
      '-vf',
      'scale=80:45,format=gray',
      '-f',
      'rawvideo',
      '-',
    ]),
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const size = 80 * 45;
  return Array.from({ length: out.length / size }, (_, i) =>
    out.subarray(i * size, (i + 1) * size),
  );
}

/** Index of the frame in `candidates` closest to `frame` (mean absolute difference). */
function closest(frame: Buffer, candidates: Buffer[]): number {
  let best = -1;
  let bestDiff = Infinity;
  candidates.forEach((c, i) => {
    let sum = 0;
    for (let k = 0; k < c.length; k++) sum += Math.abs((c[k] ?? 0) - (frame[k] ?? 0));
    if (sum < bestDiff) {
      bestDiff = sum;
      best = i;
    }
  });
  return best;
}

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-export-memory-'));
  project = path.join(work, 'Long.cstudio');
  const media = path.join(project, 'media');
  await fs.mkdir(media, { recursive: true });
  const ff = (args: string[]) =>
    execFileSync(ffmpeg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  // A moving picture (every frame differs) with a keyframe every 2 s, and noise for the voice.
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=${String(W)}x${String(H)}:r=30:d=${String(SECONDS)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '60',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=r=48000:a=0.3:d=${String(SECONDS)}:seed=7`,
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    path.join(media, 'microphone.mp4'),
  ]);
}, 60_000);

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

describe.runIf(existsSync('/proc/self/status'))('export memory (§4.3.9)', () => {
  it('stays bounded when a clip moves before an earlier part of its file', async () => {
    const inOrder = await exportPeakMb(halves(), 'in-order');
    const reversed = await exportPeakMb(swapped(), 'swapped');
    // One input per file buffered the whole first half here: ~480 MB.
    expect(reversed).toBeLessThan(inOrder + 80);
    expect(reversed).toBeLessThan(300);

    // The seeked input shows exactly the frames asked for: timeline 30 s + k is file 0 s + k,
    // and timeline k is file 30 s + k.
    const output = path.join(work, 'swapped.mp4');
    for (const [timelineS, fileS] of [
      [30.5, 0.5],
      [45, 15],
      [0.5, 30.5],
    ] as const) {
      const shown = frames(output, timelineS, 0.2);
      const source = frames(path.join(project, 'media', 'screen.mp4'), fileS - 0.2, 0.6);
      // Source frames start 6 frames before `fileS`.
      expect(shown.map((f) => closest(f, source) - 6)).toEqual(shown.map((_, i) => i));
    }
  }, 120_000);
});
