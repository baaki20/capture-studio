/**
 * Media utility jobs against the real bundled FFmpeg (spec §4.6.2): finalize (including a
 * truncated recording), peaks, thumbnails, the encoder probe, system-audio ingest from a
 * synthetic PCM source, and the request dispatcher. Needs `npm run fetch:ffmpeg` first.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import {
  JOB_RESULT_SCHEMAS,
  MediaUtilityEventSchema,
  type MediaUtilityEvent,
} from '../../src/shared/ipc/media-utility';
import { probeEncoders } from '../../src/utility/media/encoder-probe';
import { finalizeRecording } from '../../src/utility/media/finalize';
import { PcmIngest } from '../../src/utility/media/pcm-ingest';
import { generatePeaks } from '../../src/utility/media/peaks';
import { probeMedia } from '../../src/utility/media/probe';
import { MediaService } from '../../src/utility/media/service';
import { generateThumbnails } from '../../src/utility/media/thumbnails';

const ROOT = path.join(import.meta.dirname, '../..');

let ffmpeg: FfmpegLocation;
let work: string;

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-media-utility-'));
});

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

function ff(args: string[]): string {
  return execFileSync(ffmpeg.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const FRAGMENTED = [
  '-movflags',
  '+frag_keyframe+empty_moov+default_base_moof',
  '-frag_duration',
  '1000000',
  '-f',
  'mp4',
];

/** A recorder-like fragmented screen file: H.264, keyframe every 1 s, ≤1 s fragments. */
function makeScreenRec(file: string, seconds: number): void {
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=30:duration=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '30',
    '-pix_fmt',
    'yuv420p',
    ...FRAGMENTED,
    '-y',
    file,
  ]);
}

/** A recorder-like fragmented Opus file. */
function makeAudioRec(file: string, seconds: number): void {
  ff([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:sample_rate=48000:duration=${String(seconds)}`,
    '-ac',
    '2',
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    '-movflags',
    '+empty_moov+default_base_moof',
    '-frag_duration',
    '1000000',
    '-f',
    'mp4',
    '-y',
    file,
  ]);
}

async function newDir(name: string): Promise<string> {
  const dir = path.join(work, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

describe('finalize (§4.3.5)', () => {
  it('remuxes each .rec with faststart, validates, keeps sync data and deletes .rec', async () => {
    const dir = await newDir('finalize-ok');
    makeScreenRec(path.join(dir, 'screen.rec.mp4'), 4);
    makeAudioRec(path.join(dir, 'mic.rec.mp4'), 4);
    const sync = {
      version: 1,
      nominalRate: 48000,
      checkpoints: [
        [1_000_000, 48000],
        [2_000_100, 96000],
      ],
    };
    await fs.writeFile(path.join(dir, 'mic.sync.json'), JSON.stringify(sync));
    const progress: number[] = [];

    const results = await finalizeRecording({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      dir,
      streams: [
        { kind: 'screen', expect: { video: 1, audio: 0 } },
        { kind: 'mic', expect: { video: 0, audio: 1 } },
      ],
      onProgress: (f) => progress.push(f),
    });
    expect(JOB_RESULT_SCHEMAS.finalize.parse({ streams: results }).streams).toHaveLength(2);
    const [screen, mic] = results;

    expect(screen).toMatchObject({
      kind: 'screen',
      ok: true,
      error: null,
      recDeleted: true,
      sync: null,
    });
    expect(screen!.video).toMatchObject({ codec: 'h264', width: 640, height: 360 });
    expect(Math.abs(screen!.durationUs! - 4_000_000)).toBeLessThan(100_000);
    expect(mic).toMatchObject({ kind: 'mic', ok: true, sync, recDeleted: true });
    expect(mic!.audio).toEqual({ codec: 'opus', sampleRate: 48000, channels: 2 });
    expect(progress).toEqual([0.5, 1]);

    expect(await exists(path.join(dir, 'screen.rec.mp4'))).toBe(false);
    expect(await exists(path.join(dir, 'mic.rec.mp4'))).toBe(false);
    // +faststart: the moov box comes before mdat.
    const head = await fs.readFile(path.join(dir, 'screen.mp4'));
    expect(head.indexOf('moov')).toBeGreaterThan(0);
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat'));
  });

  it('recovers a truncated recording (crash mid-fragment)', async () => {
    const dir = await newDir('finalize-truncated');
    const rec = path.join(dir, 'screen.rec.mp4');
    makeScreenRec(rec, 6);
    const full = await fs.readFile(rec);
    await fs.writeFile(rec, full.subarray(0, Math.floor(full.length * 0.6)));

    const [screen] = await finalizeRecording({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      dir,
      streams: [{ kind: 'screen', expect: { video: 1, audio: 0 } }],
      recovering: true,
    });
    expect(screen).toMatchObject({ ok: true, recDeleted: true });
    expect(screen!.durationUs).toBeGreaterThan(1_000_000);
    expect(screen!.durationUs).toBeLessThan(6_000_000);
    const probe = await probeMedia(ffmpeg.ffprobe, path.join(dir, 'screen.mp4'));
    expect(probe.ok).toBe(true);
  });

  it('keeps the .rec file when a check fails, and finalizes the other streams', async () => {
    const dir = await newDir('finalize-fail');
    await fs.writeFile(path.join(dir, 'camera.rec.mp4'), 'not an mp4 at all');
    makeAudioRec(path.join(dir, 'system.rec.mp4'), 2);
    makeAudioRec(path.join(dir, 'mic.rec.mp4'), 2);
    await fs.writeFile(path.join(dir, 'mic.sync.json'), '{ broken');

    const results = await finalizeRecording({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      dir,
      streams: [
        { kind: 'camera', expect: { video: 1, audio: 0 } },
        { kind: 'system', expect: { video: 1, audio: 0 } }, // wrong expectation
        { kind: 'mic', expect: { video: 0, audio: 1 } }, // unreadable sync file
        { kind: 'screen', expect: { video: 1, audio: 0 } }, // never recorded
      ],
    });
    expect(results.map((r) => [r.kind, r.ok, r.recDeleted])).toEqual([
      ['camera', false, false],
      ['system', false, false],
      ['mic', false, false],
      ['screen', false, false],
    ]);
    expect(results[0]!.error).toContain('remux failed');
    expect(results[1]!.error).toBe('expected 1 video + 0 audio streams, found 0 + 1');
    expect(results[2]!.error).toContain('unreadable mic.sync.json');
    expect(results[3]!.error).toBe('screen.rec.mp4 is missing');
    for (const kind of ['camera', 'system', 'mic']) {
      expect(await exists(path.join(dir, `${kind}.rec.mp4`)), kind).toBe(true);
      expect(await exists(path.join(dir, `${kind}.mp4`)), kind).toBe(false);
    }
  });

  it('completes a finalize that crashed between remux and delete', async () => {
    const dir = await newDir('finalize-rerun');
    makeAudioRec(path.join(dir, 'mic.rec.mp4'), 2);
    const spec = [{ kind: 'mic' as const, expect: { video: 0, audio: 1 } }];
    await finalizeRecording({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      dir,
      streams: spec,
    });
    const [again] = await finalizeRecording({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      dir,
      streams: spec,
    });
    expect(again).toMatchObject({ ok: true, recDeleted: true });
  });
});

describe('peaks', () => {
  it('writes one [min, max] Int16 pair per 10 ms', async () => {
    const dir = await newDir('peaks');
    const input = path.join(dir, 'mic.mp4');
    // 2 s of 1 kHz at amplitude 0.5, then 1 s of silence.
    ff([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000:duration=2',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono:d=1',
      '-filter_complex',
      '[0]volume=4[a];[a][1]concat=n=2:v=0:a=1',
      '-c:a',
      'libopus',
      '-y',
      input,
    ]);
    const output = path.join(dir, 'cache', 'med_1.peaks');
    const result = await generatePeaks({ ffmpegPath: ffmpeg.ffmpeg, input, output });
    expect(JOB_RESULT_SCHEMAS.peaks.parse(result)).toEqual(result);
    expect(Math.abs(result.pairs - 300)).toBeLessThanOrEqual(2);

    const bytes = await fs.readFile(output);
    expect(bytes.length).toBe(result.pairs * 4);
    const pair = (i: number) => [bytes.readInt16LE(i * 4), bytes.readInt16LE(i * 4 + 2)] as const;
    const [min, max] = pair(100);
    expect(max).toBeGreaterThan(12_000);
    expect(min).toBeLessThan(-12_000);
    const [qMin, qMax] = pair(280);
    expect(Math.max(Math.abs(qMin), Math.abs(qMax))).toBeLessThan(200);
  });
});

describe('thumbnails', () => {
  it('tiles one thumbnail per 2 s into sprite sheets with an index', async () => {
    const dir = await newDir('thumbs');
    const input = path.join(dir, 'screen.mp4');
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=25',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-y',
      input,
    ]);
    const outDir = path.join(dir, 'cache');
    const progress: (number | null)[] = [];
    const { index, indexPath } = await generateThumbnails({
      ffmpegPath: ffmpeg.ffmpeg,
      ffprobePath: ffmpeg.ffprobe,
      input,
      outDir,
      mediaId: 'med_screen',
      columns: 3,
      rows: 2,
      onProgress: (p) => progress.push(p),
    });
    expect(index).toEqual({
      version: 1,
      mediaId: 'med_screen',
      intervalUs: 2_000_000,
      tileWidth: 160,
      tileHeight: 90,
      columns: 3,
      rows: 2,
      count: 13,
      sheets: ['med_screen.thumbs.0.jpg', 'med_screen.thumbs.1.jpg', 'med_screen.thumbs.2.jpg'],
    });
    expect(JSON.parse(await fs.readFile(indexPath, 'utf8'))).toEqual(index);
    const sheet = await probeMedia(ffmpeg.ffprobe, path.join(outDir, 'med_screen.thumbs.0.jpg'));
    expect(sheet.ok && sheet.value.streams[0]).toMatchObject({ width: 480, height: 180 });
    expect((await fs.readdir(outDir)).sort()).toEqual(
      [...index.sheets, 'med_screen.thumbs.json'].sort(),
    );
    expect(progress.length).toBeGreaterThan(0);
  });
});

describe('encoder probe', () => {
  it('finds a working libx264 and reports each hardware encoder', async () => {
    const report = await probeEncoders({ ffmpegPath: ffmpeg.ffmpeg });
    expect(JOB_RESULT_SCHEMAS['encoders.probe'].parse(report)).toEqual(report);
    expect(report.software).toBe('libx264');
    expect(report.encoders.find((e) => e.name === 'libx264')).toMatchObject({
      listed: true,
      works: true,
      error: null,
    });
    for (const name of ['h264_vaapi', 'h264_nvenc', 'h264_qsv']) {
      const entry = report.encoders.find((e) => e.name === name);
      expect(entry, name).toBeDefined();
      // On the dev machine these fail (no VA driver, no NVENC); that is expected.
      if (!entry!.works) expect(entry!.error, name).toBeTruthy();
    }
    if (report.hardware)
      expect(report.encoders.find((e) => e.name === report.hardware)?.works).toBe(true);
  }, 120_000);
});

describe('system-audio ingest (synthetic PCM instead of pw-record)', () => {
  it('encodes Opus fMP4, writes drift checkpoints and silences the paused span', async () => {
    const dir = await newDir('pcm');
    const errors: string[] = [];
    const firsts: number[] = [];
    const ingest = new PcmIngest({
      ffmpegPath: ffmpeg.ffmpeg,
      dir,
      // A real-time 440 Hz stereo tone, raw s16le 48 kHz on stdout (what `pw-record -a … -` gives).
      command: {
        file: ffmpeg.ffmpeg,
        args: [
          '-hide_banner',
          '-loglevel',
          'error',
          '-re',
          '-readrate_initial_burst',
          '0',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          '-af',
          'volume=8',
          '-ac',
          '2',
          '-f',
          's16le',
          '-',
        ],
      },
      syncWriteIntervalMs: 500,
      onError: (m) => errors.push(m),
      onFirstAudio: (us) => firsts.push(us),
    });

    const startUs = (performance.timeOrigin + performance.now()) * 1000;
    await new Promise((r) => setTimeout(r, 1200));
    ingest.pause();
    await new Promise((r) => setTimeout(r, 800));
    ingest.resume();
    await new Promise((r) => setTimeout(r, 1200));
    // While recording, sync.json already exists (crash safety).
    expect(await exists(ingest.syncPath)).toBe(true);
    const result = await ingest.stop();

    expect(errors).toEqual([]);
    expect(firsts).toHaveLength(1);
    expect(Math.abs(firsts[0]! - startUs)).toBeLessThan(1_000_000);
    expect(result.firstSampleUs).toBe(firsts[0]);
    expect(result.samples / 48000).toBeGreaterThan(2.5);
    expect(result.silencedSamples / 48000).toBeGreaterThan(0.6);
    expect(result.silencedSamples / 48000).toBeLessThan(1.0);
    expect(result.checkpoints).toBeGreaterThanOrEqual(3);

    const sync = JSON.parse(await fs.readFile(result.syncPath, 'utf8')) as {
      checkpoints: [number, number][];
    };
    expect(sync.checkpoints).toHaveLength(result.checkpoints);
    // Arrival-calibrated: samples advance at ~48 kHz against the utility clock. The synthetic
    // source bursts ~0.5 s at start (FFmpeg -re), so the first checkpoint is skipped.
    const [first, last] = [sync.checkpoints[1]!, sync.checkpoints.at(-1)!];
    const rate = ((last[1] - first[1]) * 1_000_000) / (last[0] - first[0]);
    expect(Math.abs(rate - 48000)).toBeLessThan(48000 * 0.05);

    const probe = await probeMedia(ffmpeg.ffprobe, result.path);
    if (!probe.ok) throw probe.error;
    expect(probe.value.streams).toEqual([
      expect.objectContaining({
        codecType: 'audio',
        codecName: 'opus',
        sampleRate: 48000,
        channels: 2,
      }),
    ]);
    expect(Math.abs(probe.value.durationUs! - (result.samples * 1_000_000) / 48000)).toBeLessThan(
      100_000,
    );

    // Exactly one silent stretch, about as long as the pause.
    const detect = spawnSync(
      ffmpeg.ffmpeg,
      [
        '-hide_banner',
        '-nostats',
        '-i',
        result.path,
        '-af',
        'silencedetect=n=-50dB:d=0.3',
        '-f',
        'null',
        '-',
      ],
      { encoding: 'utf8' },
    );
    const silences = [...detect.stderr.matchAll(/silence_duration: ([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(silences).toHaveLength(1);
    expect(silences[0]).toBeGreaterThan(0.6);
    expect(silences[0]).toBeLessThan(1.0);
  }, 30_000);
});

describe('MediaService (dispatcher)', () => {
  it('initializes, runs jobs, and rejects malformed requests', async () => {
    const events: MediaUtilityEvent[] = [];
    const service = new MediaService({
      emit: (e) => events.push(MediaUtilityEventSchema.parse(e)),
    });
    try {
      expect(
        await service.handle({ type: 'job', jobId: 'early', job: { kind: 'encoders.probe' } }),
      ).toBe(true);
      expect(events.at(-1)).toEqual({
        type: 'job.error',
        jobId: 'early',
        message: 'FFmpeg is not available',
        cancelled: false,
      });

      await service.handle({
        type: 'init',
        ffmpegPath: ffmpeg.ffmpeg,
        ffprobePath: ffmpeg.ffprobe,
      });
      const ready = events.at(-1);
      expect(ready).toMatchObject({ type: 'ready', error: null });
      expect(ready?.type === 'ready' ? ready.ffmpegVersion : null).toMatch(/^n9\./);

      const dir = await newDir('service');
      makeAudioRec(path.join(dir, 'system.rec.mp4'), 2);
      await service.handle({
        type: 'job',
        jobId: 'j1',
        job: {
          kind: 'finalize',
          dir,
          streams: [{ kind: 'system', expect: { video: 0, audio: 1 } }],
        },
      });
      const done = events.find((e) => e.type === 'job.done' && e.jobId === 'j1');
      expect(done).toMatchObject({ kind: 'finalize' });
      expect(
        JOB_RESULT_SCHEMAS.finalize.parse((done as { result: unknown }).result).streams[0],
      ).toMatchObject({ ok: true });
      expect(events.some((e) => e.type === 'job.progress' && e.jobId === 'j1')).toBe(true);

      await service.handle({
        type: 'job',
        jobId: 'j2',
        job: {
          kind: 'peaks',
          input: path.join(dir, 'missing.mp4'),
          output: path.join(dir, 'x.peaks'),
        },
      });
      expect(events.at(-1)).toMatchObject({ type: 'job.error', jobId: 'j2', cancelled: false });

      expect(
        await service.handle({ type: 'job', jobId: 'j3', job: { kind: 'shell', cmd: 'rm' } }),
      ).toBe(false);

      await service.handle({ type: 'clock.ping', id: 9, sentUs: 1 });
      expect(events.at(-1)).toMatchObject({ type: 'clock.pong', id: 9, sentUs: 1 });
    } finally {
      await service.shutdown();
    }
  }, 60_000);
});
