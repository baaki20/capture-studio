/**
 * Export formats and presets (P2, R2.24–R2.28, acceptance e).
 *
 * - **Formats:** MP4 with H.264 (hardware when verified) or HEVC; WebM with VP9 or AV1; animated
 *   GIF (two-pass palette, a choice of dither); audio only as M4A (AAC), Opus or MP3. A still
 *   frame as PNG is saved from the editor's preview picture (the same compositor).
 * - **Presets** fill the dialog: "YouTube 1080p", "Small GIF" and a few more.
 * - **Advanced arguments** are extra FFmpeg output options typed as text: split into words (with
 *   quotes; never run by a shell) and checked, so they cannot change the inputs, the graph, the
 *   mapping, the container or the output file.
 */
import type { ExportOptions } from '../ipc/contract';

export const EXPORT_FORMATS = [
  'mp4',
  'mp4-hevc',
  'webm-vp9',
  'webm-av1',
  'gif',
  'm4a',
  'opus',
  'mp3',
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface FormatInfo {
  label: string;
  /** File extension, with the dot. */
  extension: string;
  /** FFmpeg muxer. */
  muxer: string;
  video: 'h264' | 'hevc' | 'vp9' | 'av1' | 'gif' | null;
  audio: 'aac' | 'opus' | 'mp3' | null;
}

export const FORMATS: Record<ExportFormat, FormatInfo> = {
  mp4: { label: 'MP4 (H.264)', extension: '.mp4', muxer: 'mp4', video: 'h264', audio: 'aac' },
  'mp4-hevc': { label: 'MP4 (HEVC)', extension: '.mp4', muxer: 'mp4', video: 'hevc', audio: 'aac' },
  'webm-vp9': {
    label: 'WebM (VP9)',
    extension: '.webm',
    muxer: 'webm',
    video: 'vp9',
    audio: 'opus',
  },
  'webm-av1': {
    label: 'WebM (AV1)',
    extension: '.webm',
    muxer: 'webm',
    video: 'av1',
    audio: 'opus',
  },
  gif: { label: 'Animated GIF', extension: '.gif', muxer: 'gif', video: 'gif', audio: null },
  m4a: { label: 'Audio: M4A (AAC)', extension: '.m4a', muxer: 'ipod', video: null, audio: 'aac' },
  opus: { label: 'Audio: Opus', extension: '.opus', muxer: 'ogg', video: null, audio: 'opus' },
  mp3: { label: 'Audio: MP3', extension: '.mp3', muxer: 'mp3', video: null, audio: 'mp3' },
};

export function formatOf(options: Pick<ExportOptions, 'format'>): ExportFormat {
  return options.format ?? 'mp4';
}

export function isAudioOnly(format: ExportFormat): boolean {
  return FORMATS[format].video === null;
}

/** GIF settings: frame rate, widest width (null: the export size), dither. */
export interface GifOptions {
  fps: number;
  maxWidth: number | null;
  dither: 'none' | 'bayer' | 'floyd_steinberg' | 'sierra2_4a';
  /** 0–5: the Bayer pattern's scale (bigger = less visible pattern, more banding). */
  bayerScale: number;
  /** Palette size, 2–256. */
  colors: number;
}

export const DEFAULT_GIF: GifOptions = {
  fps: 15,
  maxWidth: 640,
  dither: 'sierra2_4a',
  bayerScale: 2,
  colors: 256,
};

/**
 * The filters turning the export picture (`[in]`) into a GIF (`[out]`): frame rate and size,
 * then a palette made from the whole clip (`stats_mode=full`) and applied with the dither.
 */
export function gifFilters(gif: GifOptions, input: string, output: string): string {
  const scale = gif.maxWidth ? `,scale='min(iw,${String(gif.maxWidth)})':-2:flags=lanczos` : '';
  const dither =
    gif.dither === 'bayer'
      ? `dither=bayer:bayer_scale=${String(Math.min(5, Math.max(0, Math.round(gif.bayerScale))))}`
      : `dither=${gif.dither}`;
  return (
    `[${input}]fps=${String(gif.fps)}${scale},split[gif_a][gif_b];` +
    `[gif_a]palettegen=max_colors=${String(gif.colors)}:stats_mode=full[gif_p];` +
    `[gif_b][gif_p]paletteuse=${dither}[${output}]`
  );
}

/** Size target of the "Small GIF" preset (acceptance e): bytes per second of video. */
export const SMALL_GIF_BYTES_PER_SECOND = 250_000;

export interface ExportPreset {
  id: string;
  label: string;
  /** What the preset is for, shown under the choice. */
  note: string;
  options: Omit<ExportOptions, 'encoder' | 'videoPath'>;
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: 'youtube-1080p',
    label: 'YouTube 1080p',
    note: 'MP4 H.264, 1080p, high quality',
    options: { format: 'mp4', resolution: '1080p', fps: 'project', quality: 'high' },
  },
  {
    id: 'small-gif',
    label: 'Small GIF',
    note: 'GIF 480 px wide, 10 fps, 128 colours with a fine dither: a small file for chats and docs',
    options: {
      format: 'gif',
      resolution: '720p',
      fps: 'project',
      quality: 'standard',
      gif: { fps: 10, maxWidth: 480, dither: 'bayer', bayerScale: 3, colors: 128 },
    },
  },
  {
    id: 'web-vp9',
    label: 'Web (WebM VP9)',
    note: 'WebM VP9 with Opus, 1080p',
    options: { format: 'webm-vp9', resolution: '1080p', fps: 'project', quality: 'standard' },
  },
  {
    id: 'archive-hevc',
    label: 'Archive (HEVC)',
    note: 'MP4 HEVC at the canvas size, high quality, smaller than H.264',
    options: { format: 'mp4-hevc', resolution: 'canvas', fps: 'project', quality: 'high' },
  },
  {
    id: 'podcast-mp3',
    label: 'Podcast (MP3)',
    note: 'Audio only, MP3',
    options: { format: 'mp3', resolution: 'canvas', fps: 'project', quality: 'standard' },
  },
];

/** Output options advanced arguments may not set: they would change what the export is. */
const BLOCKED = new Set([
  '-i',
  '-y',
  '-n',
  '-f',
  '-map',
  '-map_metadata',
  '-map_chapters',
  '-filter_complex',
  '-lavfi',
  '-vf',
  '-af',
  '-filter',
  '-filter_script',
  '-c',
  '-codec',
  '-c:v',
  '-c:a',
  '-codec:v',
  '-codec:a',
  '-vcodec',
  '-acodec',
  '-t',
  '-to',
  '-ss',
  '-sseof',
  '-progress',
  '-stats',
  '-report',
  '-dump',
  '-attach',
  '-dump_attachment',
  '-vn',
  '-an',
  '-loglevel',
  '-v',
  '-hide_banner',
  '-nostdin',
  '-stdin',
  '-pass',
  '-passlogfile',
  '-protocol_whitelist',
  '-safe',
  '-movflags',
  '-hwaccel',
]);

/** Splits text into words: spaces separate them; '…' and "…" keep spaces inside. */
function words(text: string): string[] | null {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(current);
  return out;
}

/**
 * Advanced FFmpeg output arguments from the dialog's text (R2.28): the words, or why not (see
 * `checkAdvancedArgs`).
 */
export function parseAdvancedArgs(
  text: string,
): { ok: true; args: string[] } | { ok: false; message: string } {
  const list = words(text);
  if (!list) return { ok: false, message: 'A quote is not closed.' };
  const problem = checkAdvancedArgs(list);
  return problem ? { ok: false, message: problem } : { ok: true, args: list };
}

/**
 * Why a list of advanced arguments is refused, or null. Options start with `-` and are not ones
 * that change inputs, graph, mapping, codecs, container or output; values cannot be file paths
 * or URLs; nothing contains control characters. The utility checks again before running FFmpeg.
 */
export function checkAdvancedArgs(list: readonly string[]): string | null {
  if (list.length > 64) return 'Too many arguments.';
  for (const word of list) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(word)) return 'Arguments cannot contain control characters.';
    if (word.startsWith('-') && !/^-?\d/.test(word.slice(1))) {
      const option = word.split(':')[0] ?? word;
      if (
        BLOCKED.has(word) ||
        BLOCKED.has(option) ||
        option.startsWith('-filter') ||
        option.startsWith('-map')
      ) {
        return `${word} is set by Capture Studio and cannot be changed here.`;
      }
    } else if (
      /^[/\\~]/.test(word) ||
      /^[A-Za-z][\w+.-]*:\/\//.test(word) ||
      /^[A-Za-z]:[\\/]/.test(word)
    ) {
      return `${word} looks like a file or address; arguments cannot name files.`;
    }
  }
  if (list.length > 0 && !list[0]?.startsWith('-')) {
    return 'Arguments start with an option, like -tune film.';
  }
  return null;
}
