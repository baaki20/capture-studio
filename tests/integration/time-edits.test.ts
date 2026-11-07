/**
 * Speed, chapters and preview audio renders against the real bundled FFmpeg (R2.18, R2.20):
 * - the preview's audio render of a 2× range keeps the pitch (a 440 Hz tone stays 440 Hz) and
 *   lasts half as long;
 * - an export with a 2× range is shorter by half the range, and the sped-up audio keeps its
 *   pitch, as the preview render does (same `atempo` filters);
 * - chapter markers become MP4 chapters with their titles, from 0:00.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import type { ExportOptions } from '../../src/shared/ipc/contract';
import type { Project } from '../../src/shared/project/schema';
import { applyOp, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { renderAudio } from '../../src/utility/media/audio-render';
import { runExportJob } from '../../src/utility/media/export/export-job';
import { counterIds, recordedProject } from '../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../..');
const SECONDS = 6;
const S = 1_000_000;
const OPTIONS: ExportOptions = {
  resolution: 'canvas',
  fps: 30,
  quality: 'draft',
  encoder: 'software',
  // The video of sped-up clips needs the frame render (parity harness); this checks audio.
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

/** Mono 48 kHz samples of `file` from `fromS` for `lengthS` seconds. */
function samples(file: string, fromS: number, lengthS: number): Int16Array {
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
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
}

/** Frequency of a steady tone, from its rising zero crossings. */
function toneHz(pcm: Int16Array): number {
  let crossings = 0;
  for (let i = 1; i < pcm.length; i++) {
    if ((pcm[i - 1] ?? 0) < 0 && (pcm[i] ?? 0) >= 0) crossings += 1;
  }
  return crossings / (pcm.length / 48_000);
}

function durationS(file: string): number {
  const out = execFileSync(
    ffmpeg.ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

function edit(doc: Project, ...ops: TimelineOp[]): Project {
  const generateId = counterIds('T');
  return ops.reduce((d, op) => unwrap(applyOp(d, op, { generateId })), doc);
}

function project(): Project {
  return recordedProject({
    durationUs: SECONDS * S,
    pauses: [],
    system: false,
    screenSize: { width: 320, height: 180 },
    cameraSize: { width: 160, height: 120 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
}

async function exportDoc(doc: Project, name: string): Promise<string> {
  const output = path.join(work, name);
  const result = await runExportJob({
    ffmpegPath: ffmpeg.ffmpeg,
    ffprobePath: ffmpeg.ffprobe,
    root,
    doc,
    options: OPTIONS,
    hardwareEncoder: null,
    output,
    overwrite: true,
  });
  expect(result.output).toBe(output);
  return output;
}

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-time-'));
  root = path.join(work, 'Time.cstudio');
  const media = path.join(root, 'media');
  await fs.mkdir(media, { recursive: true });
  const video = (name: string, size: string, color: string) =>
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${size}:r=30:d=${String(SECONDS)}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      path.join(media, name),
    ]);
  video('screen.mp4', '320x180', 'blue');
  video('camera.mp4', '160x120', 'red');
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:r=48000:d=${String(SECONDS)}`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    path.join(media, 'microphone.mp4'),
  ]);
});

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

describe('preview audio renders', () => {
  it('keep the pitch at 2× and last half as long', async () => {
    const output = path.join(root, 'cache', 'audio', 'test.wav');
    await renderAudio({
      ffmpegPath: ffmpeg.ffmpeg,
      input: path.join(root, 'media', 'microphone.mp4'),
      output,
      startSeconds: 1,
      endSeconds: 3,
      speed: 2,
    });
    expect(durationS(output)).toBeCloseTo(1, 1);
    expect(toneHz(samples(output, 0.2, 0.6))).toBeCloseTo(440, -1);
  });
});

describe('export with speed', () => {
  it('shortens the timeline and keeps the pitch of the sped-up audio', async () => {
    const doc = edit(project(), { type: 'setSpeed', inUs: S, outUs: 3 * S, speed: 2 });
    const file = await exportDoc(doc, 'speed.mp4');
    expect(durationS(file)).toBeCloseTo(SECONDS - 1, 1);
    // 1.2–1.8 s plays 1.4–2.6 s of the recording at twice the speed: still 440 Hz.
    expect(toneHz(samples(file, 1.2, 0.6))).toBeCloseTo(440, -1);
    expect(toneHz(samples(file, 3, 1))).toBeCloseTo(440, -1);
  });
});

describe('chapters', () => {
  it('turns chapter markers into MP4 chapters from 0:00', async () => {
    const doc = edit(
      project(),
      { type: 'addMarker', marker: { id: 'mrk_A1', tUs: 2 * S, label: 'Setup', chapter: true } },
      { type: 'addMarker', marker: { id: 'mrk_A2', tUs: 4 * S, label: '', chapter: true } },
      { type: 'addMarker', marker: { id: 'mrk_A3', tUs: 5 * S, label: 'Note', chapter: false } },
    );
    const file = await exportDoc(doc, 'chapters.mp4');
    const out = execFileSync(
      ffmpeg.ffprobe,
      ['-v', 'error', '-show_chapters', '-of', 'json', file],
      { encoding: 'utf8' },
    );
    const chapters = (
      JSON.parse(out) as {
        chapters: { start_time: string; end_time: string; tags?: { title?: string } }[];
      }
    ).chapters;
    expect(chapters.map((c) => [Number(c.start_time), Number(c.end_time), c.tags?.title])).toEqual([
      [0, 2, 'Start'],
      [2, 4, 'Setup'],
      [4, SECONDS, 'Chapter 2'],
    ]);
  });
});
