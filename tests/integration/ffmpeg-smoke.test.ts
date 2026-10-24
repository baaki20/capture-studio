/**
 * Smoke test for the bundled FFmpeg (spec §4.5 step 3): the pinned binaries are present and
 * unmodified, encode with libx264 + AAC, report progress, cancel, and ffprobe reads the result.
 * Needs `npm run fetch:ffmpeg` first.
 */
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import {
  filterComplexScriptArgs,
  runFfmpeg,
  type FfmpegProgress,
} from '../../src/utility/media/ffmpeg-runner';
import { probeFfmpegVersion, probeMedia, type FfmpegVersion } from '../../src/utility/media/probe';

const ROOT = path.join(import.meta.dirname, '../..');

interface ManifestFile {
  sha256: string | null;
}
interface Manifest {
  builds: Record<string, { version: string; files: Record<string, ManifestFile> }>;
}
const manifest = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/ffmpeg-manifest.json'), 'utf8'),
) as Manifest;

let ffmpeg: FfmpegLocation;
let version: FfmpegVersion;
let work: string;

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  const probed = await probeFfmpegVersion(ffmpeg.ffmpeg);
  if (!probed.ok) throw probed.error;
  version = probed.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ffmpeg-'));
});

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

describe('bundled FFmpeg', () => {
  it('matches the pinned manifest', async () => {
    const pin = manifest.builds[ffmpeg.platformKey];
    expect(pin, `no manifest entry for ${ffmpeg.platformKey}`).toBeDefined();
    expect(version.version.startsWith(pin!.version)).toBe(true);
    for (const [name, file] of Object.entries(pin!.files)) {
      expect(await sha256(path.join(ffmpeg.dir, name)), name).toBe(file.sha256);
    }
    const probeVersion = await probeFfmpegVersion(ffmpeg.ffprobe);
    expect(probeVersion.ok && probeVersion.value.version).toBe(version.version);
  });

  it('encodes H.264 + AAC MP4 with progress, and ffprobe reads it', async () => {
    const output = path.join(work, 'smoke.mp4');
    const progress: FfmpegProgress[] = [];
    const result = await runFfmpeg({
      ffmpegPath: ffmpeg.ffmpeg,
      durationUs: 2_000_000,
      onProgress: (p) => progress.push(p),
      args: [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=48000',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-y',
        output,
      ],
    });
    expect(result.ok ? 'ok' : result.error).toBe('ok');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatchObject({ done: true, fraction: 1 });

    const probed = await probeMedia(ffmpeg.ffprobe, output);
    if (!probed.ok) throw probed.error;
    expect(probed.value.formatName).toContain('mp4');
    expect(Math.abs((probed.value.durationUs ?? 0) - 2_000_000)).toBeLessThan(50_000);
    const video = probed.value.streams.find((s) => s.codecType === 'video');
    const audio = probed.value.streams.find((s) => s.codecType === 'audio');
    expect(video).toMatchObject({ codecName: 'h264', width: 640, height: 360, frameRate: 30 });
    expect(audio).toMatchObject({ codecName: 'aac', sampleRate: 48000, channels: 2 });
  });

  it('accepts a filter graph from a script file with the version-selected flag', async () => {
    const script = path.join(work, 'graph.txt');
    await fs.writeFile(script, '[0:v]scale=320:180,format=yuv420p[v]\n');
    const output = path.join(work, 'graph.mp4');
    const result = await runFfmpeg({
      ffmpegPath: ffmpeg.ffmpeg,
      args: [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30:duration=1',
        ...filterComplexScriptArgs(version.release, script),
        '-map',
        '[v]',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-y',
        output,
      ],
    });
    expect(result.ok ? 'ok' : result.error).toBe('ok');
    const probed = await probeMedia(ffmpeg.ffprobe, output);
    expect(probed.ok && probed.value.streams[0]).toMatchObject({ width: 320, height: 180 });
  });

  it('cancels a long job and removes the partial output', async () => {
    const output = path.join(work, 'cancelled.mp4');
    const controller = new AbortController();
    const started = Date.now();
    const result = await runFfmpeg({
      ffmpegPath: ffmpeg.ffmpeg,
      signal: controller.signal,
      removeOnFailure: [output],
      onProgress: () => controller.abort(),
      args: [
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30',
        '-t',
        '600',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-y',
        output,
      ],
    });
    expect(result).toEqual({ ok: false, error: { kind: 'cancelled' } });
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(fs.access(output)).rejects.toThrow();
  });

  it('reports ffprobe failures as errors', async () => {
    const bogus = path.join(work, 'not-media.mp4');
    await fs.writeFile(bogus, 'definitely not an mp4');
    const probed = await probeMedia(ffmpeg.ffprobe, bogus);
    expect(probed.ok).toBe(false);
  });
});
