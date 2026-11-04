/**
 * Export against the real bundled FFmpeg (§4.6.2, R1.46–R1.48): a synthetic project generated
 * with lavfi (screen with coloured sections, camera, mic and system sines) is exported with a
 * cut and gain changes; the file is checked for duration, streams and tags, the face circle
 * mask, the cut and the audio level change. Cancel and file-exists behaviour (R1.47), the
 * media utility's `export` job, and one real recorded project (when present on this machine).
 * Needs `npm run fetch:ffmpeg` first.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import type { ExportOptions } from '../../src/shared/ipc/contract';
import {
  JOB_RESULT_SCHEMAS,
  MediaUtilityEventSchema,
  type MediaUtilityEvent,
} from '../../src/shared/ipc/media-utility';
import { parseProject } from '../../src/shared/project/migrations';
import { layersAt, maskAlpha } from '../../src/shared/project/render-plan';
import type { ProjectV1 } from '../../src/shared/project/schema';
import {
  applyOp,
  timelineDurationUs,
  type TimelineOp,
} from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { ExportError, runExportJob } from '../../src/utility/media/export/export-job';
import { writeMaskPng } from '../../src/utility/media/export/mask-png';
import { probeMedia } from '../../src/utility/media/probe';
import { MediaService } from '../../src/utility/media/service';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const ROOT = path.join(import.meta.dirname, '../..');
const REAL_PROJECTS = path.join(os.homedir(), 'Videos', 'Capture Studio');

const W = 640;
const H = 360;
const OPTIONS: ExportOptions = {
  resolution: 'canvas',
  fps: 'project',
  quality: 'draft',
  encoder: 'software',
};

let ffmpeg: FfmpegLocation;
let work: string;
let project: string;

function ff(args: string[]): string {
  return execFileSync(ffmpeg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Like WebCodecs recordings: tagged BT.601 (lavfi's `color` draws BT.601 values). */
const BT601 = [
  '-pix_fmt',
  'yuv420p',
  '-colorspace',
  'smpte170m',
  '-color_primaries',
  'smpte170m',
  '-color_trc',
  'smpte170m',
];

/** Synthetic media for a project folder; the screen is blue, yellow 2–3 s, then green. */
function makeMedia(dir: string, seconds: number): void {
  const media = path.join(dir, 'media');
  execFileSync('mkdir', ['-p', media]);
  const color = (c: string, d: number) =>
    `color=c=${c}:s=${String(W)}x${String(H)}:r=30:d=${String(d)}`;
  ff([
    '-f',
    'lavfi',
    '-i',
    `${color('blue', 2)}[a];${color('yellow', 1)}[b];${color('green', seconds - 3)}[c];[a][b][c]concat=n=3[out0]`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    ...BT601,
    path.join(media, 'screen.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=320x240:r=30:d=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    ...BT601,
    path.join(media, 'camera.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:r=48000:d=${String(seconds)}`,
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    path.join(media, 'microphone.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=f=1000:r=48000:d=${String(seconds)}`,
    '-ac',
    '2',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    path.join(media, 'system-audio.mp4'),
  ]);
}

function syntheticProject(seconds: number): ProjectV1 {
  return recordedProject({
    durationUs: seconds * 1_000_000,
    pauses: [],
    screenSize: { width: W, height: H },
    cameraSize: { width: 320, height: 240 },
    offsets: { screen: 0, camera: 0, microphone: 0, 'system-audio': 0 },
  });
}

function edit(doc: ProjectV1, ...ops: TimelineOp[]): ProjectV1 {
  const generateId = counterIds('X');
  return ops.reduce((d, op) => unwrap(applyOp(d, op, { generateId })), doc);
}

/** One decoded RGB frame of a file at time `t`. */
function frameAt(file: string, t: number, width = W, height = H): Buffer {
  const out = execFileSync(
    ffmpeg.ffmpeg,
    [
      '-v',
      'error',
      '-ss',
      String(t),
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  expect(out.length).toBe(width * height * 3);
  return out;
}

function pixel(frame: Buffer, x: number, y: number, width = W): [number, number, number] {
  const i = (Math.round(y) * width + Math.round(x)) * 3;
  return [frame[i] ?? 0, frame[i + 1] ?? 0, frame[i + 2] ?? 0];
}

type Rgb = [number, number, number];
const near = (a: Rgb, b: Rgb, tolerance = 10) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tolerance);
const isRed = ([r, g, b]: Rgb) => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]: Rgb) => b > 200 && r < 60 && g < 60;
const isGreen = ([r, g, b]: Rgb) => g > 90 && r < 60 && b < 60;

/** Mean volume (dB) of a file's audio, from `volumedetect` (which reports on stderr). */
function meanVolume(file: string): number {
  const run = spawnSync(
    ffmpeg.ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const m = /mean_volume: (-?[\d.]+) dB/.exec(run.stderr);
  if (!m?.[1]) throw new Error(`no mean_volume in: ${run.stderr.slice(-500)}`);
  return Number(m[1]);
}

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-export-'));
  project = path.join(work, 'Synthetic.cstudio');
  makeMedia(project, 6.2);
});

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

describe('export of a synthetic project (R1.46, R1.48)', () => {
  const base = () =>
    edit(syntheticProject(6), { type: 'cutRange', inUs: 2_000_000, outUs: 3_000_000 });

  it('exports the cut timeline with the face circle, BT.709 H.264 and AAC', async () => {
    const doc = base();
    expect(timelineDurationUs(doc)).toBe(5_000_000);
    const output = path.join(work, 'out', 'cut.mp4');
    const fractions: number[] = [];
    const result = await runExportJob({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      root: project,
      doc,
      options: OPTIONS,
      hardwareEncoder: null,
      output,
      overwrite: false,
      onProgress: (f) => {
        if (f !== null) fractions.push(f);
      },
    });
    expect(result).toMatchObject({
      output,
      encoder: 'libx264',
      fallback: null,
      durationUs: 5_000_000,
    });
    expect(fractions.at(-1)).toBe(1);

    const probe = unwrap(await probeMedia(ffmpeg.ffprobe, output));
    const video = probe.streams.filter((s) => s.codecType === 'video');
    const audio = probe.streams.filter((s) => s.codecType === 'audio');
    expect(video).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(Math.abs((probe.durationUs ?? 0) - 5_000_000)).toBeLessThanOrEqual(
      1_000_000 / 30 + 25_000,
    );

    const streams = JSON.parse(
      execFileSync(
        ffmpeg.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', output],
        { encoding: 'utf8' },
      ),
    ) as { streams: Record<string, unknown>[]; format: Record<string, unknown> };
    const v = streams.streams.find((s) => s.codec_type === 'video') ?? {};
    const a = streams.streams.find((s) => s.codec_type === 'audio') ?? {};
    expect(v).toMatchObject({
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      width: W,
      height: H,
      color_space: 'bt709',
      color_primaries: 'bt709',
      color_transfer: 'bt709',
      color_range: 'tv',
    });
    expect(Math.abs(Number(v.duration) - 5)).toBeLessThanOrEqual(1 / 30 + 1e-6);
    expect(Number(v.nb_frames)).toBe(150);
    expect(a).toMatchObject({
      codec_name: 'aac',
      profile: 'LC',
      sample_rate: '48000',
      channels: 2,
    });
    expect(Number(a.bit_rate)).toBeGreaterThan(150_000);

    // +faststart: the moov atom precedes mdat.
    const head = (await fs.readFile(output)).subarray(0, 4096).toString('latin1');
    const moov = head.indexOf('moov');
    expect(moov).toBeGreaterThan(0);
    if (head.includes('mdat')) expect(moov).toBeLessThan(head.indexOf('mdat'));

    // Face circle where the render plan puts it (R1.48): red inside, screen outside.
    const face = layersAt(doc, 1_000_000).find((l) => l.kind === 'overlay');
    expect(face?.mask.shape).toBe('circle');
    if (!face) return;
    const r = face.destRect;
    const frame = frameAt(output, 1.0);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    expect(isRed(pixel(frame, cx, cy))).toBe(true);
    // Colours survive the BT.601 → BT.709 conversion.
    expect(pixel(frame, cx, cy)).toSatisfy((p: Rgb) => near(p, [255, 0, 0]));
    expect(pixel(frame, 10, 10)).toSatisfy((p: Rgb) => near(p, [0, 0, 255]));
    expect(isRed(pixel(frame, cx + r.width * 0.4, cy))).toBe(true);
    expect(isRed(pixel(frame, cx, cy - r.height * 0.4))).toBe(true);
    // Bounding-box corners are outside the circle: the screen shows through.
    expect(isBlue(pixel(frame, r.x + 2, r.y + 2))).toBe(true);
    expect(isBlue(pixel(frame, r.x + r.width - 3, r.y + r.height - 3))).toBe(true);
    // Just outside the box, and far away.
    expect(isBlue(pixel(frame, r.x - 4, cy))).toBe(true);
    expect(isBlue(pixel(frame, 10, 10))).toBe(true);
    // Bounding box within 2 px: the red extent along the centre row.
    const row = Array.from({ length: W }, (_, x) => isRed(pixel(frame, x, cy)));
    const left = row.indexOf(true);
    const right = row.lastIndexOf(true);
    expect(Math.abs(left - r.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(right + 1 - (r.x + r.width))).toBeLessThanOrEqual(2);

    // The cut: 2–3 s (yellow) is gone; timeline 2.5 s shows session 3.5 s (green).
    expect(isBlue(pixel(frameAt(output, 1.9), 10, 10))).toBe(true);
    expect(isGreen(pixel(frameAt(output, 2.1), 10, 10))).toBe(true);
    for (const t of [0.5, 1.5, 2.5, 3.5, 4.5]) {
      const [rr, gg, bb] = pixel(frameAt(output, t), 10, 10);
      expect(rr > 150 && gg > 150 && bb < 80, `yellow at ${String(t)} s`).toBe(false);
    }
  });

  it('applies track gain and mute to the mix', async () => {
    const doc = base();
    const voice = trackByName(doc, 'Voice').id;
    const system = trackByName(doc, 'System audio').id;
    const reference = edit(doc, { type: 'setMuted', trackId: voice, muted: true });
    const quieter = edit(reference, { type: 'setGain', trackId: system, gainDb: -12 });
    const run = (d: ProjectV1, name: string) =>
      runExportJob({
        ffmpegPath: ffmpeg.ffmpeg,
        ffprobePath: ffmpeg.ffprobe,
        root: project,
        doc: d,
        options: OPTIONS,
        hardwareEncoder: null,
        output: path.join(work, 'out', name),
        overwrite: true,
      });
    const [a, b] = await Promise.all([run(reference, 'ref.mp4'), run(quieter, 'quiet.mp4')]);
    const delta = meanVolume(b.output) - meanVolume(a.output);
    expect(delta).toBeGreaterThan(-12.6);
    expect(delta).toBeLessThan(-11.4);
  });
});

describe('mask PNG', () => {
  it('decodes in FFmpeg to exactly the render plan mask', async () => {
    const mask = { shape: 'circle' as const, radiusPx: 45 };
    const file = path.join(work, 'mask.png');
    await writeMaskPng(file, mask, 90, 90);
    const gray = execFileSync(ffmpeg.ffmpeg, [
      '-v',
      'error',
      '-i',
      file,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ]);
    expect(new Uint8Array(gray)).toEqual(maskAlpha(mask, 90, 90));
  });
});

describe('background colour', () => {
  const BG: Rgb = [0x30, 0x80, 0xc0];
  const withBackground = (doc: ProjectV1, width: number): ProjectV1 => ({
    ...doc,
    timeline: {
      ...doc.timeline,
      canvas: { ...doc.timeline.canvas, width, background: { type: 'color', color: '#3080C0' } },
    },
  });
  const run = (doc: ProjectV1, name: string) =>
    runExportJob({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      root: project,
      doc,
      options: OPTIONS,
      hardwareEncoder: null,
      output: path.join(work, 'bg', name),
      overwrite: true,
    });

  it('fills screen gaps with the background (screen track as base)', async () => {
    const doc = edit(
      withBackground(syntheticProject(3), W),
      { type: 'split', atUs: 1_000_000 },
      { type: 'split', atUs: 2_000_000 },
    );
    const middle = trackByName(doc, 'Screen').clips[1]?.id ?? '';
    const result = await run(edit(doc, { type: 'delete', clipIds: [middle] }), 'gap.mp4');
    expect(pixel(frameAt(result.output, 0.5), 10, 10)).toSatisfy((p: Rgb) => near(p, [0, 0, 255]));
    expect(pixel(frameAt(result.output, 1.5), 10, 10)).toSatisfy((p: Rgb) => near(p, BG));
  });

  it('letterboxes in the background colour', async () => {
    const result = await run(withBackground(syntheticProject(2), 720), 'letterbox.mp4');
    const frame = frameAt(result.output, 0.5, 720, H);
    expect(pixel(frame, 10, 100, 720)).toSatisfy((p: Rgb) => near(p, BG));
    expect(pixel(frame, 715, 100, 720)).toSatisfy((p: Rgb) => near(p, BG));
    expect(pixel(frame, 60, 100, 720)).toSatisfy((p: Rgb) => near(p, [0, 0, 255]));
  });
});

describe('export job file handling (R1.47)', () => {
  it('never overwrites without confirmation and leaves no temp files', async () => {
    const dir = path.join(work, 'exists');
    await fs.mkdir(dir, { recursive: true });
    const output = path.join(dir, 'taken.mp4');
    await fs.writeFile(output, 'keep me');
    await expect(
      runExportJob({
        ffmpegPath: ffmpeg.ffmpeg,
        ffprobePath: ffmpeg.ffprobe,
        root: project,
        doc: syntheticProject(2),
        options: OPTIONS,
        hardwareEncoder: null,
        output,
        overwrite: false,
      }),
    ).rejects.toMatchObject({ code: 'exists' });
    expect(await fs.readFile(output, 'utf8')).toBe('keep me');
    expect(await fs.readdir(dir)).toEqual(['taken.mp4']);
  });

  it('cancel mid-export leaves no output and no temp file', async () => {
    const dir = path.join(work, 'cancel');
    await fs.mkdir(dir, { recursive: true });
    const output = path.join(dir, 'cancelled.mp4');
    const controller = new AbortController();
    let progressed = 0;
    const started = performance.now();
    const job = runExportJob({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      root: project,
      doc: syntheticProject(6),
      options: { ...OPTIONS, resolution: '1080p', quality: 'high' },
      hardwareEncoder: null,
      output,
      overwrite: false,
      signal: controller.signal,
      onProgress: (f) => {
        progressed += 1;
        if (f !== null && f < 1) controller.abort();
      },
    });
    const error = await job.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).code).toBe('cancelled');
    expect(progressed).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(existsSync(output)).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('fails a stalled FFmpeg (watchdog) without leaving files', async () => {
    const dir = path.join(work, 'stall');
    await fs.mkdir(dir, { recursive: true });
    const error = await runExportJob({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      root: project,
      doc: syntheticProject(6),
      options: { ...OPTIONS, resolution: '1080p', quality: 'high' },
      hardwareEncoder: null,
      output: path.join(dir, 'stalled.mp4'),
      overwrite: false,
      stallTimeoutMs: 1,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'failed' });
    expect((error as Error).message).toMatch(/stopped responding/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('fails an FFmpeg that keeps reporting without advancing (watchdog)', async () => {
    // A deadlocked FFmpeg 7+ still writes progress blocks on schedule, all at the same position.
    const dir = path.join(work, 'frozen');
    await fs.mkdir(dir, { recursive: true });
    const fake = path.join(work, 'frozen-ffmpeg.sh');
    await fs.writeFile(
      fake,
      '#!/bin/sh\nwhile :; do printf "frame=12\\nout_time_us=400000\\nprogress=continue\\n"; sleep 0.05; done\n',
      { mode: 0o755 },
    );
    const error = await runExportJob({
      ffmpegPath: fake,
      ffprobePath: ffmpeg.ffprobe,
      root: project,
      doc: syntheticProject(6),
      options: OPTIONS,
      hardwareEncoder: null,
      output: path.join(dir, 'frozen.mp4'),
      overwrite: false,
      stallTimeoutMs: 500,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'failed' });
    expect((error as Error).message).toMatch(/stopped responding/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('leaves no temp file when the process exits mid-export (app quit)', async () => {
    const dir = path.join(work, 'quit');
    await fs.mkdir(dir, { recursive: true });
    const job = path.join(work, 'quit-job.json');
    await fs.writeFile(
      job,
      JSON.stringify({
        ffmpegPath: ffmpeg.ffmpeg,
        ffprobePath: ffmpeg.ffprobe,
        root: project,
        doc: syntheticProject(6),
        options: { ...OPTIONS, resolution: '1080p', quality: 'high' },
        hardwareEncoder: null,
        output: path.join(dir, 'quit.mp4'),
        overwrite: false,
        tempDir: work,
      }),
    );
    const listing = execFileSync(
      path.join(ROOT, 'node_modules/.bin/tsx'),
      [path.join(ROOT, 'tests/fixtures/export/exit-mid-export.ts'), job],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 },
    );
    // The temp output existed when the process exited…
    expect(JSON.parse(listing)).toEqual([
      expect.stringMatching(/^\.quit\.mp4\.[0-9a-f]{8}\.part$/),
    ]);
    // …and the exit hook deleted it, with the private work folder.
    expect(await fs.readdir(dir)).toEqual([]);
    expect((await fs.readdir(work)).filter((n) => n.startsWith('cs-export-'))).toEqual([]);
  });

  it('refuses missing media with a clear message (R1.29)', async () => {
    const dir = path.join(work, 'missing.cstudio');
    await fs.mkdir(path.join(dir, 'media'), { recursive: true });
    await fs.copyFile(
      path.join(project, 'media', 'screen.mp4'),
      path.join(dir, 'media', 'screen.mp4'),
    );
    await expect(
      runExportJob({
        ffmpegPath: ffmpeg.ffmpeg,
        ffprobePath: ffmpeg.ffprobe,
        root: dir,
        doc: syntheticProject(2),
        options: OPTIONS,
        hardwareEncoder: null,
        output: path.join(work, 'missing.mp4'),
        overwrite: false,
      }),
    ).rejects.toMatchObject({
      code: 'offline',
      message: expect.stringContaining('media/camera.mp4') as unknown,
    });
    expect(existsSync(path.join(work, 'missing.mp4'))).toBe(false);
  });
});

describe('media utility export job', () => {
  it('runs through MediaService with progress and a schema-valid result', async () => {
    const events: MediaUtilityEvent[] = [];
    const service = new MediaService({
      emit: (e) => events.push(MediaUtilityEventSchema.parse(e)),
    });
    try {
      await service.handle({
        type: 'init',
        ffmpegPath: ffmpeg.ffmpeg,
        ffprobePath: ffmpeg.ffprobe,
      });
      const output = path.join(work, 'service', 'svc.mp4');
      await service.handle({
        type: 'job',
        jobId: 'exp1',
        job: {
          kind: 'export',
          root: project,
          doc: syntheticProject(2),
          options: { ...OPTIONS, resolution: '720p', fps: 60 },
          hardwareEncoder: null,
          output,
          overwrite: false,
        },
      });
      const done = events.find((e) => e.type === 'job.done' && e.jobId === 'exp1');
      expect(done, JSON.stringify(events.filter((e) => e.type === 'job.error'))).toBeDefined();
      const result = JOB_RESULT_SCHEMAS.export.parse(
        done?.type === 'job.done' ? done.result : null,
      );
      expect(result.output).toBe(output);
      expect(events.some((e) => e.type === 'job.progress' && e.jobId === 'exp1')).toBe(true);
      const probe = unwrap(await probeMedia(ffmpeg.ffprobe, output));
      const v = probe.streams.find((s) => s.codecType === 'video');
      expect([v?.width, v?.height]).toEqual([1280, 720]);
    } finally {
      await service.shutdown();
    }
  });
});

/**
 * The smallest finished real recording on this machine, if any (never modified: copied to a temp
 * dir). A recording in progress has no clips yet, so only complete or recovered projects count.
 */
function realProjectDir(): string | null {
  if (!existsSync(REAL_PROJECTS)) return null;
  const listing = execFileSync(
    'sh',
    ['-c', `du -s "${REAL_PROJECTS}"/*.cstudio 2>/dev/null | sort -n | cut -f2-`],
    { encoding: 'utf8' },
  );
  for (const dir of listing.split('\n').filter(Boolean)) {
    try {
      const doc = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8')) as {
        recording?: { state?: string };
      };
      if (doc.recording?.state === 'complete' || doc.recording?.state === 'recovered') return dir;
    } catch {
      // Unreadable or missing project.json: not a candidate.
    }
  }
  return null;
}

describe('export of a real recorded project', () => {
  const source = realProjectDir();
  it.skipIf(!source)(
    'matches the timeline duration with one video and one audio stream',
    async () => {
      if (!source) return;
      const copy = path.join(work, 'real.cstudio');
      await fs.cp(source, copy, { recursive: true });
      const parsed = parseProject(
        JSON.parse(await fs.readFile(path.join(copy, 'project.json'), 'utf8')),
      );
      if (!parsed.ok) throw new Error(parsed.message);
      const doc = parsed.project;
      const output = path.join(work, 'real.mp4');
      const result = await runExportJob({
        ffmpegPath: ffmpeg.ffmpeg,
        ffprobePath: ffmpeg.ffprobe,
        root: copy,
        doc,
        options: { ...OPTIONS, quality: 'standard', encoder: 'auto' },
        hardwareEncoder: null,
        output,
        overwrite: false,
      });
      const durationUs = timelineDurationUs(doc);
      const probe = unwrap(await probeMedia(ffmpeg.ffprobe, output));
      expect(probe.streams.filter((s) => s.codecType === 'video')).toHaveLength(1);
      expect(probe.streams.filter((s) => s.codecType === 'audio')).toHaveLength(1);
      const frame = 1_000_000 / doc.timeline.frameRate;
      expect(Math.abs((probe.durationUs ?? 0) - durationUs)).toBeLessThanOrEqual(frame + 25_000);
      console.info(
        `real export: ${(durationUs / 1e6).toFixed(1)} s of ${String(doc.timeline.canvas.width)}x${String(doc.timeline.canvas.height)} in ${(result.elapsedMs / 1000).toFixed(1)} s (${(durationUs / 1000 / result.elapsedMs).toFixed(2)}x real time)`,
      );
    },
    300_000,
  );
});
