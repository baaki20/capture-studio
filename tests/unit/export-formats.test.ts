/**
 * Export formats (P2 step 9; R2.24–R2.28): format table, GIF filters, presets, advanced
 * arguments, the command line per format, and the dialog's helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  checkAdvancedArgs,
  DEFAULT_GIF,
  EXPORT_FORMATS,
  EXPORT_PRESETS,
  FORMATS,
  gifFilters,
  isAudioOnly,
  parseAdvancedArgs,
  type ExportFormat,
} from '../../src/shared/export/formats';
import { ExportOptionsSchema, type ExportOptions } from '../../src/shared/ipc/contract';
import type { Project } from '../../src/shared/project/schema';
import { unwrap } from '../../src/shared/result';
import {
  applyPreset,
  exportRequestOptions,
  formatControls,
  targetForFormat,
} from '../../src/renderer/editor/export/export-dialog-state';
import {
  buildExportGraph,
  resolveExportSettings,
} from '../../src/utility/media/export/graph-builder';
import { recordedProject } from '../fixtures/editor-project';

const BASE: ExportOptions = {
  resolution: 'canvas',
  fps: 30,
  quality: 'draft',
  encoder: 'software',
};

function project(): Project {
  const doc = recordedProject({
    durationUs: 4_000_000,
    pauses: [],
    system: false,
    screenSize: { width: 1280, height: 720 },
    cameraSize: { width: 320, height: 240 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
  for (const m of doc.media) m.clockRatio = 1;
  return doc;
}

function graph(options: Partial<ExportOptions>, hardware: string | null = null) {
  const doc = project();
  return buildExportGraph({
    doc,
    projectRoot: '/p',
    settings: resolveExportSettings(doc, { ...BASE, ...options }, hardware),
    outputPath: '/p/out',
    filterScriptPath: '/w/video.txt',
    audioScriptPath: '/w/audio.txt',
    maskDir: '/w',
  });
}

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('format table', () => {
  it('has an extension, a muxer and at least one stream per format', () => {
    for (const f of EXPORT_FORMATS) {
      expect(FORMATS[f].extension).toMatch(/^\.[a-z0-9]+$/);
      expect(FORMATS[f].video ?? FORMATS[f].audio).not.toBeNull();
    }
    expect(EXPORT_FORMATS.filter(isAudioOnly)).toEqual(['m4a', 'opus', 'mp3']);
  });

  it('presets are valid export options', () => {
    for (const preset of EXPORT_PRESETS) {
      expect(() => ExportOptionsSchema.parse({ ...preset.options, encoder: 'auto' })).not.toThrow();
    }
  });
});

describe('gifFilters', () => {
  it('makes one palette from the whole clip and applies it with the dither', () => {
    const text = gifFilters(
      { fps: 10, maxWidth: 480, dither: 'bayer', bayerScale: 9, colors: 128 },
      'in',
      'out',
    );
    expect(text).toBe(
      "[in]fps=10,scale='min(iw,480)':-2:flags=lanczos,split[gif_a][gif_b];" +
        '[gif_a]palettegen=max_colors=128:stats_mode=full[gif_p];' +
        '[gif_b][gif_p]paletteuse=dither=bayer:bayer_scale=5[out]',
    );
    expect(gifFilters({ ...DEFAULT_GIF, maxWidth: null }, 'a', 'b')).not.toContain('scale=');
  });
});

describe('advanced arguments (R2.28)', () => {
  it.each([
    ['-tune film', ['-tune', 'film']],
    ['-metadata "title=A lesson"', ['-metadata', 'title=A lesson']],
    ["-x264-params 'keyint=60:min-keyint=30'", ['-x264-params', 'keyint=60:min-keyint=30']],
    ['  ', []],
    ['-crf -5', ['-crf', '-5']],
  ])('accepts %s', (text, args) => {
    expect(parseAdvancedArgs(text)).toEqual({ ok: true, args });
  });

  it.each([
    ['-i other.mp4', /cannot be changed/],
    ['-filter_complex x', /cannot be changed/],
    ['-c:v libx265', /cannot be changed/],
    ['-map 0', /cannot be changed/],
    ['-f matroska', /cannot be changed/],
    ['-y', /cannot be changed/],
    ['-movflags +faststart', /cannot be changed/],
    ['-metadata /etc/passwd', /file or address/],
    ['-metadata ~/secret', /file or address/],
    ['-metadata http://x.example/a', /file or address/],
    ['-metadata C:\\x', /file or address/],
    ['film', /start with an option/],
    ['-metadata "unclosed', /quote/],
  ])('refuses %s', (text, why) => {
    const result = parseAdvancedArgs(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(why);
  });

  it('refuses control characters and long lists', () => {
    expect(checkAdvancedArgs(['-metadata', 'a\nb'])).toMatch(/control/);
    expect(checkAdvancedArgs(Array.from({ length: 65 }, () => '-an'))).toMatch(/Too many/);
  });
});

describe('command line per format', () => {
  it.each([
    ['mp4', 'libx264', 'aac', 'mp4'],
    ['mp4-hevc', 'libx265', 'aac', 'mp4'],
    ['webm-vp9', 'libvpx-vp9', 'libopus', 'webm'],
    ['webm-av1', 'libsvtav1', 'libopus', 'webm'],
  ] as const)('%s encodes with %s and %s into %s', (format, video, audio, muxer) => {
    const { args } = unwrap(graph({ format }));
    expect(after(args, '-c:v')).toBe(video);
    expect(after(args, '-c:a')).toBe(audio);
    expect(after(args, '-f')).toBe(muxer);
    expect(args.includes('+faststart')).toBe(muxer === 'mp4');
  });

  it.each([
    ['m4a', 'aac', 'ipod'],
    ['opus', 'libopus', 'ogg'],
    ['mp3', 'libmp3lame', 'mp3'],
  ] as const)('%s has audio only (%s in %s)', (format, audio, muxer) => {
    const built = unwrap(graph({ format }));
    expect(built.args).not.toContain('-c:v');
    expect(built.args.filter((a) => a.startsWith('[') && a.endsWith(']'))).toEqual(['[aout]']);
    expect(after(built.args, '-c:a')).toBe(audio);
    expect(after(built.args, '-f')).toBe(muxer);
  });

  it('gif has no audio and ends in the palette filters', () => {
    const built = unwrap(graph({ format: 'gif', gif: DEFAULT_GIF }));
    expect(built.args.filter((a) => a.startsWith('[') && a.endsWith(']'))).toEqual(['[gout]']);
    expect(built.args).not.toContain('-c:a');
    expect(after(built.args, '-f')).toBe('gif');
    expect(built.videoScriptText).toContain('palettegen=max_colors=256:stats_mode=full');
  });

  it('uses the hardware encoder only for MP4 H.264', () => {
    expect(after(unwrap(graph({ encoder: 'auto' }, 'h264_vaapi')).args, '-c:v')).toBe('h264_vaapi');
    expect(
      after(unwrap(graph({ encoder: 'auto', format: 'webm-vp9' }, 'h264_vaapi')).args, '-c:v'),
    ).toBe('libvpx-vp9');
  });

  it('puts advanced arguments before the muxer, and checks them again', () => {
    const { args } = unwrap(graph({ advancedArgs: ['-tune', 'film'] }));
    expect(args.indexOf('-tune')).toBeLessThan(args.indexOf('-f'));
    const bad = graph({ advancedArgs: ['-i', 'x.mp4'] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid');
  });
});

describe('export dialog helpers', () => {
  it('swaps the target extension for the format', () => {
    expect(targetForFormat('/v/Exports/Lesson.mp4', 'gif')).toBe('/v/Exports/Lesson.gif');
    expect(targetForFormat('/v/Exports/Lesson.v2.mp4', 'webm-vp9')).toBe(
      '/v/Exports/Lesson.v2.webm',
    );
    expect(targetForFormat('C:\\Exports\\Lesson.MP4', 'mp4')).toBe('C:\\Exports\\Lesson.MP4');
    expect(targetForFormat('/v/Lesson', 'mp3')).toBe('/v/Lesson.mp3');
  });

  it('shows the options each format uses', () => {
    const shown = (f: ExportFormat) => formatControls(f);
    expect(shown('mp4')).toEqual({ resolution: true, quality: true, encoder: true, gif: false });
    expect(shown('webm-av1')).toMatchObject({ encoder: false, quality: true });
    expect(shown('gif')).toEqual({ resolution: true, quality: false, encoder: false, gif: true });
    expect(shown('mp3')).toEqual({ resolution: false, quality: false, encoder: false, gif: false });
  });

  it('applies a preset and keeps the encoder', () => {
    const small = applyPreset({ ...BASE, encoder: 'auto' }, 'small-gif');
    expect(small).toMatchObject({ format: 'gif', encoder: 'auto', gif: { maxWidth: 480 } });
    const back = applyPreset(small, 'youtube-1080p');
    expect(back).toMatchObject({ format: 'mp4', resolution: '1080p', quality: 'high' });
    expect(back.gif).toBeUndefined();
    expect(applyPreset(BASE, 'no-such')).toBe(BASE);
  });

  it('sends only the options the format uses', () => {
    const options: ExportOptions = {
      ...BASE,
      encoder: 'auto',
      format: 'webm-vp9',
      gif: DEFAULT_GIF,
      requireHardware: true,
    };
    expect(exportRequestOptions(options, [])).toEqual({
      ...BASE,
      encoder: 'auto',
      format: 'webm-vp9',
    });
    expect(exportRequestOptions({ ...options, format: 'mp4' }, ['-tune', 'film'])).toMatchObject({
      requireHardware: true,
      advancedArgs: ['-tune', 'film'],
    });
    expect(exportRequestOptions({ ...options, format: 'gif' }, null).gif).toEqual(DEFAULT_GIF);
  });
});
