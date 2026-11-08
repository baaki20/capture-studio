/**
 * Noise reduction of a media's whole audio into the project cache (R2.14, D6): the preview plays
 * the result and the export reads it, so both hear the same (`audio-cleanup.ts`). 16-bit WAV at
 * the file's own rate and channels, from the file's start, so file times stay the same.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  NOISE_ANALYSIS_RATE,
  NoiseFloorMeter,
  noiseFilter,
  type NoiseMode,
} from '../../shared/project/audio-cleanup';
import { spawnChild } from './child-processes';
import { retryTransientFsErrors } from '../../shared/fs-retry';

export interface CleanAudioOptions {
  ffmpegPath: string;
  input: string;
  output: string;
  noise: Exclude<NoiseMode, 'off'>;
  signal?: AbortSignal;
}

/** Runs FFmpeg, handing stdout to `onData`; resolves when it exits cleanly. */
function run(
  ffmpegPath: string,
  args: string[],
  signal?: AbortSignal,
  onData?: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(signal ? { signal } : {}),
      },
    );
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => onData?.(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`noise reduction: ffmpeg exited with ${String(code)}: ${stderr.trim()}`));
    });
  });
}

export async function cleanAudio(options: CleanAudioOptions): Promise<{ output: string }> {
  // 1. The noise floor, from mono samples streamed through the meter (an odd byte waits).
  const meter = new NoiseFloorMeter();
  let carry: Buffer | null = null;
  await run(
    options.ffmpegPath,
    [
      '-i',
      options.input,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      String(NOISE_ANALYSIS_RATE),
      '-f',
      's16le',
      '-',
    ],
    options.signal,
    (chunk) => {
      const bytes: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      const even = bytes.length - (bytes.length % 2);
      carry = even < bytes.length ? bytes.subarray(even) : null;
      const copy = new Int16Array(even / 2);
      for (let i = 0; i < copy.length; i++) copy[i] = bytes.readInt16LE(i * 2);
      meter.push(copy);
    },
  );
  const floor = meter.floorDb();
  // 2. The whole audio through `afftdn` tuned to it.
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  const tmp = `${options.output}.tmp.wav`;
  await run(
    options.ffmpegPath,
    [
      '-y',
      '-i',
      options.input,
      '-map',
      '0:a:0',
      '-af',
      noiseFilter(options.noise, floor),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      tmp,
    ],
    options.signal,
  );
  await retryTransientFsErrors(() => fs.rename(tmp, options.output), process.platform);
  return { output: options.output };
}
