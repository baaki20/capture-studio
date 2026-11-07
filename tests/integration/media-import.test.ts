/**
 * Importing files and preview proxies against the real bundled FFmpeg (R2.21, acceptance g):
 * a picture becomes a one-frame H.264 video; a playable MP4 is copied (picture and sound); a WAV
 * and an MPEG-4 AVI are converted; a 4K video gets a 720p proxy with the same timestamps.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegLocation } from '../../src/main/ffmpeg/locate';
import { importMedia, makeProxy } from '../../src/utility/media/media-import';
import { probeMedia } from '../../src/utility/media/probe';

const ROOT = path.join(import.meta.dirname, '../..');
let ffmpeg: FfmpegLocation;
let work: string;
let sources: string;
let mediaDir: string;

function ff(args: string[]): void {
  execFileSync(ffmpeg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

const imp = (input: string, baseName: string) =>
  importMedia({
    ffmpegPath: ffmpeg.ffmpeg,
    ffprobePath: ffmpeg.ffprobe,
    input,
    mediaDir,
    baseName,
  });

beforeAll(async () => {
  const located = await locateFfmpeg({ isPackaged: false, resourcesPath: '', appPath: ROOT });
  if (!located.ok) throw located.error;
  ffmpeg = located.value;
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-import-'));
  sources = path.join(work, 'sources');
  mediaDir = path.join(work, 'Project.cstudio', 'media');
  await fs.mkdir(sources, { recursive: true });
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=orange:s=301x201',
    '-frames:v',
    '1',
    path.join(sources, 'logo.png'),
  ]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', path.join(sources, 'music.wav')]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x240:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path.join(sources, 'clip.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x240:r=25:d=2',
    '-c:v',
    'mpeg4',
    path.join(sources, 'old.avi'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=3840x2160:r=30:d=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    path.join(sources, 'big.mp4'),
  ]);
});

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

describe('importMedia', () => {
  it('turns a picture into a one-frame video at an even size', async () => {
    const { files } = await imp(path.join(sources, 'logo.png'), 'logo');
    expect(files).toEqual([
      expect.objectContaining({
        kind: 'video',
        still: true,
        durationUs: 33_334,
        video: expect.objectContaining({ codec: 'h264', width: 300, height: 200 }) as unknown,
      }),
    ]);
    expect(path.basename(files[0]!.path)).toBe('logo.mp4');
  });

  it('copies a playable MP4 with picture and sound, and converts WAV and AVI', async () => {
    const clip = await imp(path.join(sources, 'clip.mp4'), 'clip');
    expect(clip.files.map((f) => [f.kind, f.still])).toEqual([
      ['video', false],
      ['audio', false],
    ]);
    const original = await fs.readFile(path.join(sources, 'clip.mp4'));
    expect(await fs.readFile(clip.files[0]!.path)).toEqual(original);
    const music = await imp(path.join(sources, 'music.wav'), 'music');
    expect(music.files).toEqual([
      expect.objectContaining({
        kind: 'audio',
        audio: expect.objectContaining({ codec: 'aac' }) as unknown,
      }),
    ]);
    expect(path.extname(music.files[0]!.path)).toBe('.m4a');
    const old = await imp(path.join(sources, 'old.avi'), 'old');
    expect(old.files[0]).toMatchObject({ kind: 'video', video: { codec: 'h264' } });
    expect(old.files[0]!.durationUs).toBeGreaterThan(1_900_000);
  });
});

describe('makeProxy', () => {
  it('makes a 720p proxy of a 4K video with the same timestamps', async () => {
    const output = path.join(work, 'cache', 'big.proxy.mp4');
    await makeProxy({ ffmpegPath: ffmpeg.ffmpeg, input: path.join(sources, 'big.mp4'), output });
    const probe = await probeMedia(ffmpeg.ffprobe, output);
    if (!probe.ok) throw probe.error;
    const video = probe.value.streams.find((s) => s.codecType === 'video');
    expect([video?.width, video?.height]).toEqual([1280, 720]);
    const pts = (file: string) =>
      execFileSync(
        ffmpeg.ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'frame=pts_time',
          '-of',
          'csv=p=0',
          '-read_intervals',
          '%+#5',
          file,
        ],
        { encoding: 'utf8' },
      ).trim();
    expect(pts(output)).toBe(pts(path.join(sources, 'big.mp4')));
  });
});
