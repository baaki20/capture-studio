/**
 * Importing a picture, video or audio file into a project (R2.21) and making preview proxies
 * (acceptance g).
 *
 * Import probes the file, then puts a copy the editor can play into the project's `media/`:
 * - a still picture becomes a one-frame H.264 video (even size, yuv420p), placed on the timeline
 *   as a freeze frame of any length, so the preview, the export and every edit treat it like
 *   any other video (transparency is lost);
 * - a video or audio file in a container and codecs the editor plays (MP4/MOV or WebM/Matroska
 *   with H.264, VP8, VP9 or AV1 video; AAC, Opus, MP3 or Vorbis audio) is copied as it is;
 * - anything else is converted: video to H.264/AAC MP4, audio to AAC M4A.
 * The result lists the copy's streams; a file with picture and sound gives both.
 *
 * Proxies are 720p H.264 copies with a keyframe every half second and the source's timestamps,
 * for the preview of large videos only; the export always reads the original.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnChild } from './child-processes';
import { probeMedia, type ProbeResult } from './probe';
import { retryTransientFsErrors } from '../../shared/fs-retry';

export interface ImportedFile {
  kind: 'video' | 'audio';
  /** A still picture (one frame; placed as a freeze frame). */
  still: boolean;
  /** Absolute path of the copy in the project. */
  path: string;
  durationUs: number;
  video?: { codec: string; width: number; height: number; frameRateNominal: number };
  audio?: { codec: string; sampleRate: number; channels: number };
}

export interface ImportOptions {
  ffmpegPath: string;
  ffprobePath: string;
  input: string;
  /** The project's `media/` folder. */
  mediaDir: string;
  /** File name to use, without extension (unique in the folder). */
  baseName: string;
  signal?: AbortSignal;
}

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'opus', 'mp3', 'vorbis']);
const STILL_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'tiff', 'gif', 'jpegls']);

function ffmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, ...(signal ? { signal } : {}) },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with ${String(code)}: ${stderr.trim()}`)),
    );
  });
}

async function probe(options: ImportOptions, file: string): Promise<ProbeResult> {
  const result = await probeMedia(options.ffprobePath, file, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!result.ok) throw new Error(`Cannot read ${path.basename(file)}: ${result.error.message}`);
  return result.value;
}

function isStill(info: ProbeResult): boolean {
  const video = info.streams.find((s) => s.codecType === 'video');
  if (!video || info.streams.some((s) => s.codecType === 'audio')) return false;
  const format = info.formatName ?? '';
  return (
    format.includes('image2') ||
    format.endsWith('_pipe') ||
    (STILL_CODECS.has(video.codecName ?? '') && (info.durationUs ?? 0) < 100_000)
  );
}

function playable(info: ProbeResult): boolean {
  const format = info.formatName ?? '';
  const container =
    format.includes('mp4') ||
    format.includes('mov') ||
    format.includes('webm') ||
    format.includes('matroska');
  if (!container) return false;
  return info.streams.every((s) => {
    if (s.codecType === 'video') return PLAYABLE_VIDEO.has(s.codecName ?? '');
    if (s.codecType === 'audio') return PLAYABLE_AUDIO.has(s.codecName ?? '');
    return true;
  });
}

/** Imports one file (see the file comment). */
export async function importMedia(options: ImportOptions): Promise<{ files: ImportedFile[] }> {
  const info = await probe(options, options.input);
  const hasVideo = info.streams.some((s) => s.codecType === 'video');
  const hasAudio = info.streams.some((s) => s.codecType === 'audio');
  if (!hasVideo && !hasAudio) {
    throw new Error(`${path.basename(options.input)} has no picture or sound.`);
  }
  await fs.mkdir(options.mediaDir, { recursive: true });
  const still = isStill(info);
  const sourceExt = path.extname(options.input).toLowerCase() || (hasVideo ? '.mp4' : '.m4a');
  let output: string;
  if (still) {
    output = path.join(options.mediaDir, `${options.baseName}.mp4`);
    await ffmpeg(
      options.ffmpegPath,
      [
        '-i',
        options.input,
        '-frames:v',
        '1',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '12',
        '-r',
        '30',
        output,
      ],
      options.signal,
    );
  } else if (playable(info)) {
    output = path.join(options.mediaDir, `${options.baseName}${sourceExt}`);
    await fs.copyFile(options.input, output);
  } else if (hasVideo) {
    output = path.join(options.mediaDir, `${options.baseName}.mp4`);
    await ffmpeg(
      options.ffmpegPath,
      [
        '-i',
        options.input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        output,
      ],
      options.signal,
    );
  } else {
    output = path.join(options.mediaDir, `${options.baseName}.m4a`);
    await ffmpeg(
      options.ffmpegPath,
      [
        '-i',
        options.input,
        '-map',
        '0:a:0',
        '-c:a',
        'aac',
        '-b:a',
        '256k',
        '-movflags',
        '+faststart',
        output,
      ],
      options.signal,
    );
  }
  const copy = await probe(options, output);
  const files: ImportedFile[] = [];
  const video = copy.streams.find((s) => s.codecType === 'video');
  const audio = copy.streams.find((s) => s.codecType === 'audio');
  const duration = (s: { durationUs: number | null } | undefined) =>
    Math.max(1, Math.round(s?.durationUs ?? copy.durationUs ?? 0));
  if (video?.width && video.height) {
    files.push({
      kind: 'video',
      still,
      path: output,
      durationUs: still ? 33_334 : duration(video),
      video: {
        codec: video.codecName ?? 'unknown',
        width: video.width,
        height: video.height,
        frameRateNominal: video.frameRate ?? 30,
      },
    });
  }
  if (audio && !still) {
    files.push({
      kind: 'audio',
      still: false,
      path: output,
      durationUs: duration(audio),
      audio: {
        codec: audio.codecName ?? 'unknown',
        sampleRate: audio.sampleRate ?? 48_000,
        channels: audio.channels ?? 2,
      },
    });
  }
  if (files.length === 0) throw new Error(`${path.basename(options.input)} could not be imported.`);
  return { files };
}

/** Height of preview proxies. */
export const PROXY_HEIGHT = 720;

/** A preview proxy of a video (see the file comment). */
export async function makeProxy(options: {
  ffmpegPath: string;
  input: string;
  output: string;
  signal?: AbortSignal;
}): Promise<{ output: string }> {
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  const tmp = `${options.output}.tmp.mp4`;
  await ffmpeg(
    options.ffmpegPath,
    [
      '-copyts',
      '-i',
      options.input,
      '-map',
      '0:v:0',
      '-an',
      // One output frame per source frame at the source's own time, never resampled to a
      // constant rate (the preview maps the proxy's timestamps onto the original's).
      '-fps_mode',
      'passthrough',
      '-vf',
      `scale=-2:${String(PROXY_HEIGHT)}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-g',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'mp4',
      tmp,
    ],
    options.signal,
  );
  await retryTransientFsErrors(() => fs.rename(tmp, options.output), process.platform);
  return { output: options.output };
}
