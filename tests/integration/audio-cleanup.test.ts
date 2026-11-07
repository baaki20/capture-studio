/**
 * Step 7 audio in real exports (bundled FFmpeg; R2.12–R2.16, acceptance c):
 * - clip gain and a fade-in shape the voice's level;
 * - a volume keyframe lowers the track from its time on;
 * - ducking lowers the system audio while the voice speaks (the voice muted, so only the system
 *   audio is heard; ducking still follows it);
 * - noise reduction lowers a noise floor;
 * - normalization brings the export to −16 ±1 LUFS, measured with `ebur128`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import type { ExportOptions } from '../../src/shared/ipc/contract';
import type { Project } from '../../src/shared/project/schema';
import { applyOp, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { runExportJob } from '../../src/utility/media/export/export-job';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../..');
const SECONDS = 6;
const S = 1_000_000;
const OPTIONS: ExportOptions = {
  resolution: 'canvas',
  fps: 30,
  quality: 'draft',
  encoder: 'software',
  videoPath: 'graph',
};

let ffmpeg: FfmpegLocation;
let work: string;
let root: string;

function ff(args: string[]): Buffer {
  return execFileSync(ffmpeg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** RMS level (dBFS) of `file`'s audio from `fromS` for `lengthS`. */
function rmsDb(file: string, fromS: number, lengthS: number): number {
  const raw = ff([
    '-ss',
    String(fromS),
    '-t',
    String(lengthS),
    '-i',
    file,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    's16le',
    '-',
  ]);
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  let sum = 0;
  for (const v of pcm) sum += (v / 32768) ** 2;
  return 10 * Math.log10(Math.max(1e-12, sum / Math.max(1, pcm.length)));
}

/** Integrated loudness (LUFS) from `ebur128`'s summary. */
function integratedLufs(file: string): number {
  const run = spawnSync(
    ffmpeg.ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const matches = [...run.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) throw new Error(`no loudness in: ${run.stderr.slice(-400)}`);
  return Number(last);
}

function edit(doc: Project, ...ops: TimelineOp[]): Project {
  const generateId = counterIds('A');
  return ops.reduce((d, op) => unwrap(applyOp(d, op, { generateId })), doc);
}

function project(): Project {
  const doc = recordedProject({
    durationUs: SECONDS * S,
    pauses: [],
    system: true,
    screenSize: { width: 320, height: 180 },
    cameraSize: { width: 160, height: 120 },
    offsets: { screen: 0, camera: 0, microphone: 0, 'system-audio': 0 },
  });
  for (const m of doc.media) m.clockRatio = 1;
  return doc;
}

async function exportDoc(doc: Project, name: string): Promise<string> {
  const output = path.join(work, name);
  await runExportJob({
    ffmpegPath: ffmpeg.ffmpeg,
    ffprobePath: ffmpeg.ffprobe,
    root,
    doc,
    options: OPTIONS,
    hardwareEncoder: null,
    output,
    overwrite: true,
  });
  return output;
}

const voice = (doc: Project) => trackByName(doc, 'Voice');
const system = (doc: Project) => trackByName(doc, 'System audio');

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-audio-'));
  root = path.join(work, 'Audio.cstudio');
  const media = path.join(root, 'media');
  await fs.mkdir(media, { recursive: true });
  const d = String(SECONDS);
  const video = (name: string, size: string) =>
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=c=gray:s=${size}:r=30:d=${d}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      path.join(media, name),
    ]);
  video('screen.mp4', '320x180');
  video('camera.mp4', '160x120');
  // Voice: noise alone for 2 s, then a tone over the noise from 2 s to 4 s, then noise again.
  ff([
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=c=white:a=0.003:r=48000:d=${d}`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:r=48000:d=${d}`,
    '-filter_complex',
    "[1]volume=0.5,volume=enable='lt(t,2)+gte(t,4)':volume=0[t];[0][t]amix=inputs=2:normalize=0",
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    path.join(media, 'microphone.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=1000:r=48000:d=${d}`,
    '-af',
    'volume=0.3',
    '-ac',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    path.join(media, 'system-audio.mp4'),
  ]);
});

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

describe('clip gain, fades and volume keyframes', () => {
  it('shape the level of the voice', async () => {
    const base = edit(project(), { type: 'setMuted', trackId: system(project()).id, muted: true });
    const plain = await exportDoc(base, 'plain.mp4');
    const clip = voice(base).clips[0]!;
    const shaped = await exportDoc(
      edit(
        base,
        { type: 'setClipAudio', clipIds: [clip.id], gainDb: -6, fadeInUs: 2 * S },
        {
          type: 'setVolumeKeyframe',
          trackId: voice(base).id,
          tUs: 3.5 * S,
          gainDb: 0,
          easing: 'hold',
        },
        { type: 'setVolumeKeyframe', trackId: voice(base).id, tUs: 3.5 * S + 1, gainDb: -20 },
      ),
      'shaped.mp4',
    );
    // Halfway through the fade-in: −6 dB of gain and half amplitude (−6 dB) → about −12 dB.
    expect(rmsDb(shaped, 0.9, 0.2) - rmsDb(plain, 0.9, 0.2)).toBeCloseTo(-12, 0);
    // After the fade, before the keyframe: −6 dB.
    expect(rmsDb(shaped, 2.5, 0.8) - rmsDb(plain, 2.5, 0.8)).toBeCloseTo(-6, 0);
    // After the keyframe: −6 − 20 dB.
    expect(rmsDb(shaped, 3.7, 0.25) - rmsDb(plain, 3.7, 0.25)).toBeCloseTo(-26, 0);
  });
});

describe('ducking', () => {
  it('lowers the system audio while the voice speaks', async () => {
    const doc = project();
    const ducked = edit(
      doc,
      { type: 'setMuted', trackId: voice(doc).id, muted: true },
      {
        type: 'setCleanup',
        trackId: system(doc).id,
        cleanup: {
          duck: { byTrackId: voice(doc).id, amountDb: -12, attackMs: 100, releaseMs: 300 },
        },
      },
    );
    const file = await exportDoc(ducked, 'ducked.mp4');
    const before = rmsDb(file, 1, 0.5);
    // The voice's noise is quieter than the threshold; its tone (2–4 s) is not.
    expect(rmsDb(file, 3, 0.5) - before).toBeCloseTo(-12, 0);
    expect(rmsDb(file, 5, 0.5) - before).toBeCloseTo(0, 0);
  });
});

describe('noise reduction', () => {
  it('lowers the noise floor of the voice', async () => {
    const doc = edit(project(), { type: 'setMuted', trackId: system(project()).id, muted: true });
    const plain = await exportDoc(doc, 'noisy.mp4');
    const cleaned = await exportDoc(
      edit(doc, { type: 'setCleanup', trackId: voice(doc).id, cleanup: { noise: 'strong' } }),
      'cleaned.mp4',
    );
    expect(rmsDb(cleaned, 0.5, 1) - rmsDb(plain, 0.5, 1)).toBeLessThan(-6);
    // The cleaned audio is kept in the project cache for the preview.
    await expect(fs.stat(path.join(root, 'cache', 'audio'))).resolves.toBeTruthy();
  });
});

describe('loudness normalization', () => {
  it('brings the export to −16 ±1 LUFS (acceptance c)', async () => {
    const doc = project();
    const quiet = edit(
      doc,
      { type: 'setGain', trackId: system(doc).id, gainDb: -20 },
      { type: 'setCleanup', trackId: voice(doc).id, cleanup: { normalize: true } },
    );
    const file = await exportDoc(quiet, 'normalized.mp4');
    expect(Math.abs(integratedLufs(file) - -16)).toBeLessThanOrEqual(1);
  });
});
