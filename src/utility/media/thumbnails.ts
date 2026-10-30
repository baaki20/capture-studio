/**
 * Timeline thumbnails (§4.3.5): one frame every 2 s, scaled to 90 px high, tiled into JPEG
 * sprite sheets `cache/<mediaId>.thumbs.N.jpg` (N from 0) with a JSON index
 * `cache/<mediaId>.thumbs.json`. Thumbnail `i` is at sheet `⌊i / (columns × rows)⌋`, cell
 * `i mod (columns × rows)` in row-major order, and shows the frame near `i × intervalUs`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ThumbnailIndex } from '../../shared/ipc/media-utility';
import { writeJsonAtomic } from './fs-utils';
import { filterComplexArgs, runFfmpeg } from './ffmpeg-runner';
import { probeMedia } from './probe';

export const THUMB_INTERVAL_US = 2_000_000;
export const THUMB_HEIGHT = 90;
export const THUMB_COLUMNS = 10;
export const THUMB_ROWS = 10;

export interface ThumbnailOptions {
  ffmpegPath: string;
  ffprobePath: string;
  input: string;
  outDir: string;
  mediaId: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number | null) => void;
  /** For tests. */
  columns?: number;
  rows?: number;
}

export function thumbnailIndexPath(outDir: string, mediaId: string): string {
  return path.join(outDir, `${mediaId}.thumbs.json`);
}

/** `scale=-2:90` width: the aspect-correct width rounded to an even number. */
export function thumbWidth(width: number, height: number): number {
  return Math.max(2, 2 * Math.round((width * THUMB_HEIGHT) / height / 2));
}

export async function generateThumbnails(
  options: ThumbnailOptions,
): Promise<{ indexPath: string; index: ThumbnailIndex }> {
  const columns = options.columns ?? THUMB_COLUMNS;
  const rows = options.rows ?? THUMB_ROWS;
  const probe = await probeMedia(
    options.ffprobePath,
    options.input,
    options.signal ? { signal: options.signal } : {},
  );
  if (!probe.ok) throw probe.error;
  const video = probe.value.streams.find((s) => s.codecType === 'video');
  if (!video?.width || !video.height)
    throw new Error(`thumbnails: no video stream in ${options.input}`);

  await fs.mkdir(options.outDir, { recursive: true });
  const prefix = `${options.mediaId}.thumbs.`;
  for (const name of await fs.readdir(options.outDir)) {
    if (name.startsWith(prefix) && name.endsWith('.jpg'))
      await fs.rm(path.join(options.outDir, name));
  }

  // The first output (null) counts thumbnails; its `frame=` progress value is the exact count.
  // Graphs always go through a script file (§1.10, §9.7).
  const seconds = THUMB_INTERVAL_US / 1_000_000;
  const graphPath = path.join(options.outDir, `.${options.mediaId}.thumbs.graph`);
  await fs.writeFile(
    graphPath,
    `[0:v:0]fps=1/${String(seconds)},scale=-2:${String(THUMB_HEIGHT)},split=2[count][thumbs];` +
      `[thumbs]tile=${String(columns)}x${String(rows)}[sheets]\n`,
  );
  // Decode keyframes only first: recordings have one about every second (R1.13), and a thumbnail
  // every 2 s does not need the frames between them (about twice as fast). A file with sparse
  // keyframes yields too few thumbnails that way, so it is decoded in full instead.
  const render = async (keyframesOnly: boolean): Promise<number> => {
    let count = 0;
    const result = await runFfmpeg({
      ffmpegPath: options.ffmpegPath,
      ...(probe.value.durationUs ? { durationUs: probe.value.durationUs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (p) => {
        if (p.frame !== null) count = p.frame;
        options.onProgress?.(p.fraction);
      },
      args: [
        ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []),
        '-i',
        options.input,
        ...filterComplexArgs(graphPath),
        '-map',
        '[count]',
        '-f',
        'null',
        '-',
        '-map',
        '[sheets]',
        '-q:v',
        '5',
        '-start_number',
        '0',
        '-y',
        path.join(options.outDir, `${prefix}%d.jpg`),
      ],
    });
    if (!result.ok) {
      throw new Error(
        result.error.kind === 'failed'
          ? `thumbnails: ffmpeg failed: ${result.error.stderrTail.trim().split('\n').slice(-3).join(' ')}`
          : `thumbnails: ${result.error.kind}`,
      );
    }
    return count;
  };
  let count: number;
  try {
    count = await render(true);
    const expected = probe.value.durationUs
      ? Math.floor(probe.value.durationUs / THUMB_INTERVAL_US) + 1
      : 0;
    if (count < expected - 1) {
      for (const name of await fs.readdir(options.outDir)) {
        if (name.startsWith(prefix) && name.endsWith('.jpg'))
          await fs.rm(path.join(options.outDir, name));
      }
      count = await render(false);
    }
  } finally {
    await fs.rm(graphPath, { force: true });
  }

  const sheets: string[] = [];
  const perSheet = columns * rows;
  for (let i = 0; i < Math.ceil(count / perSheet); i += 1) sheets.push(`${prefix}${String(i)}.jpg`);
  const index: ThumbnailIndex = {
    version: 1,
    mediaId: options.mediaId,
    intervalUs: THUMB_INTERVAL_US,
    tileWidth: thumbWidth(video.width, video.height),
    tileHeight: THUMB_HEIGHT,
    columns,
    rows,
    count,
    sheets,
  };
  const indexPath = thumbnailIndexPath(options.outDir, options.mediaId);
  await writeJsonAtomic(indexPath, index);
  return { indexPath, index };
}
