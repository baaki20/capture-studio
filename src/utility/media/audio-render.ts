/**
 * Preview audio renders (R2.18, plan risk 3): a media's file range played at a clip's speed with
 * its pitch kept, as the export's filter graph does (`atrim → asetpts → atempo`, from
 * `audio-speed.ts`), written as 16-bit WAV at the file's own rate and channels. The preview
 * scheduler plays it in place of the sped-up segment.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atempoFilters } from '../../shared/project/audio-speed';
import { spawnChild } from './child-processes';
import { retryTransientFsErrors } from '../../shared/fs-retry';

export interface AudioRenderOptions {
  ffmpegPath: string;
  input: string;
  output: string;
  startSeconds: number;
  endSeconds: number;
  speed: number;
  signal?: AbortSignal;
}

const seconds = (s: number) => s.toFixed(6);

export async function renderAudio(options: AudioRenderOptions): Promise<{ output: string }> {
  const filters = [
    `atrim=start=${seconds(options.startSeconds)}:end=${seconds(options.endSeconds)}`,
    'asetpts=PTS-STARTPTS',
    ...atempoFilters(options.speed),
  ];
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  const tmp = `${options.output}.tmp.wav`;
  await new Promise<void>((resolve, reject) => {
    const child = spawnChild(
      options.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-i',
        options.input,
        '-map',
        '0:a:0',
        '-af',
        filters.join(','),
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        tmp,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`audio render: ffmpeg exited with ${String(code)}: ${stderr.trim()}`));
    });
  });
  await retryTransientFsErrors(() => fs.rename(tmp, options.output), process.platform);
  return { output: options.output };
}
