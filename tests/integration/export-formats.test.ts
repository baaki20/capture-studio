/**
 * Export formats against the real bundled FFmpeg (R2.24–R2.28, acceptance e): each format plays
 * (ffprobe sees the right codecs and duration); "Small GIF" stays under its size target and a
 * smooth gradient shows no banding (short runs of one colour, unlike the same GIF without
 * dither); advanced arguments reach FFmpeg, and unsafe ones are refused; a required hardware
 * encoder that is missing fails the export instead of falling back.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import { EXPORT_PRESETS, SMALL_GIF_BYTES_PER_SECOND } from '../../src/shared/export/formats';
import type { ExportOptions } from '../../src/shared/ipc/contract';
import type { Project } from '../../src/shared/project/schema';
import { runExportJob } from '../../src/utility/media/export/export-job';
import { recordedProject } from '../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../..');
const SECONDS = 6;
const BASE: ExportOptions = {
  resolution: 'canvas',
  fps: 30,
  quality: 'draft',
  encoder: 'software',
  videoPath: 'graph',
};

let ffmpeg: FfmpegLocation;
let work: string;
let busy: string;
let smooth: string;

function ff(args: string[]): void {
  execFileSync(ffmpeg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

function probe(file: string): {
  streams: { codec_name: string; codec_type: string }[];
  format: { duration: string };
} {
  return JSON.parse(
    execFileSync(
      ffmpeg.ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { encoding: 'utf8' },
    ),
  ) as never;
}

function project(seconds: number): Project {
  const doc = recordedProject({
    durationUs: seconds * 1e6,
    pauses: [],
    system: false,
    screenSize: { width: 1280, height: 720 },
    cameraSize: { width: 320, height: 240 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
  for (const m of doc.media) m.clockRatio = 1;
  return doc;
}

async function makeProject(name: string, screenSource: string): Promise<string> {
  const root = path.join(work, `${name}.cstudio`);
  const media = path.join(root, 'media');
  await fs.mkdir(media, { recursive: true });
  const d = String(SECONDS);
  ff([
    '-f',
    'lavfi',
    '-i',
    `${screenSource}:d=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '12',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=320x240:r=30:d=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    path.join(media, 'camera.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:r=48000:d=${d}`,
    '-c:a',
    'aac',
    path.join(media, 'microphone.mp4'),
  ]);
  return root;
}

async function exportAs(
  root: string,
  options: Partial<ExportOptions>,
  name: string,
  doc = project(SECONDS),
): Promise<string> {
  const output = path.join(work, name);
  await runExportJob({
    ffmpegPath: ffmpeg.ffmpeg,
    ffprobePath: ffmpeg.ffprobe,
    root,
    doc,
    options: { ...BASE, ...options },
    hardwareEncoder: null,
    output,
    overwrite: true,
  });
  return output;
}

/** Longest run of one colour along the middle row of a GIF's first frame, in pixels. */
function longestRun(gif: string): number {
  const probeOut = probe(gif) as unknown as { streams: { width: number; height: number }[] };
  const { width, height } = probeOut.streams[0]!;
  const raw = execFileSync(
    ffmpeg.ffmpeg,
    ['-v', 'error', '-i', gif, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 << 20 },
  );
  const row = Math.floor(height / 2) * width * 3;
  let longest = 0;
  let run = 0;
  for (let x = 1; x < width; x++) {
    const same = [0, 1, 2].every((c) => raw[row + x * 3 + c] === raw[row + (x - 1) * 3 + c]);
    run = same ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest + 1;
}

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-formats-'));
  busy = await makeProject('Busy', 'testsrc2=s=1280x720:r=30');
  smooth = await makeProject(
    'Smooth',
    'gradients=s=1280x720:r=30:c0=0x203080:c1=0xE0A040:x0=0:y0=0:x1=1280:y1=0:speed=0',
  );
});

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

describe('formats', () => {
  it.each([
    ['mp4-hevc', 'out-hevc.mp4', 'hevc', 'aac'],
    ['webm-vp9', 'out-vp9.webm', 'vp9', 'opus'],
    ['webm-av1', 'out-av1.webm', 'av1', 'opus'],
  ] as const)(
    '%s plays with its codecs',
    async (format, name, video, audio) => {
      const file = await exportAs(busy, { format }, name);
      const info = probe(file);
      expect(info.streams.map((s) => s.codec_name).sort()).toEqual([audio, video].sort());
      expect(Number(info.format.duration)).toBeCloseTo(SECONDS, 0);
    },
    180_000,
  );

  it.each([
    ['m4a', 'out.m4a', 'aac'],
    ['opus', 'out.opus', 'opus'],
    ['mp3', 'out.mp3', 'mp3'],
  ] as const)('%s is audio only', async (format, name, audio) => {
    const info = probe(await exportAs(busy, { format }, name));
    expect(info.streams.map((s) => s.codec_type)).toEqual(['audio']);
    expect(info.streams[0]?.codec_name).toBe(audio);
    expect(Number(info.format.duration)).toBeCloseTo(SECONDS, 0);
  });
});

describe('Small GIF (acceptance e)', () => {
  const small = EXPORT_PRESETS.find((p) => p.id === 'small-gif')!.options;

  it('stays under its size target', async () => {
    const file = await exportAs(busy, small, 'small.gif');
    const info = probe(file) as unknown as { streams: { codec_name: string; width: number }[] };
    expect(info.streams[0]).toMatchObject({ codec_name: 'gif', width: 480 });
    expect((await fs.stat(file)).size).toBeLessThan(SMALL_GIF_BYTES_PER_SECOND * SECONDS);
  }, 120_000);

  it('dithers a smooth gradient instead of banding it', async () => {
    const dithered = longestRun(await exportAs(smooth, small, 'smooth.gif'));
    const banded = longestRun(
      await exportAs(
        smooth,
        { ...small, gif: { ...small.gif!, dither: 'none', colors: 16 } },
        'banded.gif',
      ),
    );
    expect(banded).toBeGreaterThan(20);
    expect(dithered).toBeLessThan(8);
  }, 120_000);
});

describe('advanced arguments and hardware', () => {
  it('passes checked arguments to FFmpeg and refuses unsafe ones', async () => {
    const file = await exportAs(
      busy,
      { advancedArgs: ['-metadata', 'title=Lesson one'] },
      'meta.mp4',
    );
    const tags = execFileSync(
      ffmpeg.ffprobe,
      ['-v', 'error', '-show_entries', 'format_tags=title', '-of', 'csv=p=0', file],
      { encoding: 'utf8' },
    );
    expect(tags.trim()).toBe('Lesson one');
    await expect(
      exportAs(busy, { advancedArgs: ['-i', '/etc/hostname'] }, 'bad.mp4'),
    ).rejects.toThrow(/cannot be changed here/);
  });

  it('fails a required hardware encoder that is missing instead of using software', async () => {
    await expect(
      exportAs(busy, { encoder: 'auto', requireHardware: true }, 'hw.mp4'),
    ).rejects.toThrow(/hardware encoder/);
  });
});
