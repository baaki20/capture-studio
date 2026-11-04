/**
 * Export graph builder (§4.3.9, §4.6.2 "golden graphs"): the command line and filter script for
 * canonical projects match the stored files in `golden/export/`, and the builder's rules
 * (inputs, frame counts, masks, audio chain, encoder settings) hold. No FFmpeg needed.
 *
 * After an intended change to the graph, update the golden files with
 * `npx vitest run tests/integration/export-graph.test.ts -u` and review the diff.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExportOptions } from '../../src/shared/ipc/contract';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { applyOp, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import {
  buildExportGraph,
  exportSize,
  mediaRuns,
  resolveExportSettings,
  toBt709,
  type ExportGraph,
  type MediaColor,
} from '../../src/utility/media/export/graph-builder';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const STANDARD: ExportOptions = {
  resolution: 'canvas',
  fps: 'project',
  quality: 'standard',
  encoder: 'auto',
};

function edit(doc: ProjectV1, ...ops: TimelineOp[]): ProjectV1 {
  const generateId = counterIds('E');
  return ops.reduce((d, op) => unwrap(applyOp(d, op, { generateId })), doc);
}

/** Video media tagged BT.601, as WebCodecs recordings are. */
function bt601(doc: ProjectV1): Map<string, MediaColor> {
  return new Map(
    doc.media
      .filter((m) => m.kind === 'video')
      .map((m) => [m.id, { matrix: 'smpte170m', range: 'tv' }]),
  );
}

function graph(
  doc: ProjectV1,
  options: Partial<ExportOptions> = {},
  hardware: string | null = null,
  mediaColor: Map<string, MediaColor> = bt601(doc),
): ExportGraph {
  const settings = resolveExportSettings(doc, { ...STANDARD, ...options }, hardware);
  return unwrap(
    buildExportGraph({
      doc,
      projectRoot: '/projects/Lesson.cstudio',
      settings,
      outputPath: '/exports/.Lesson.mp4.0000.part',
      filterScriptPath: '/tmp/cs-export/graph.txt',
      maskDir: '/tmp/cs-export',
      mediaColor,
    }),
  );
}

function golden(g: ExportGraph): string {
  return [
    '# args',
    ...g.args.map((a) => `  ${a}`),
    '# masks',
    ...g.masks.map(
      (m) =>
        `  ${m.path} ${String(m.width)}x${String(m.height)} ${m.mask.shape} r=${String(m.mask.radiusPx)}`,
    ),
    `# expectedDurationUs ${String(g.expectedDurationUs)}`,
    '# filter script',
    g.filterScriptText,
  ].join('\n');
}

const id = (doc: ProjectV1, name: string) => trackByName(doc, name).id;

/** Canonical projects (§4.6.2). */
const CANONICAL: Record<string, () => ExportGraph> = {
  'default-with-pause': () => graph(recordedProject()),
  'screen-only': () =>
    graph(recordedProject({ camera: false, mic: false, system: false, pauses: [] })),
  'region-crop': () =>
    graph(recordedProject({ region: { x: 258, y: 106, width: 1402, height: 922 }, pauses: [] })),
  'face-rounded-mirror': () => {
    const doc = recordedProject({ pauses: [] });
    return graph(
      edit(doc, {
        type: 'setLayout',
        trackId: id(doc, 'Face'),
        layout: { shape: 'rounded', cornerRadius: 0.25, mirror: true },
      }),
    );
  },
  'face-rectangle': () => {
    const doc = recordedProject({ pauses: [] });
    return graph(
      edit(doc, { type: 'setLayout', trackId: id(doc, 'Face'), layout: { shape: 'rectangle' } }),
    );
  },
  'face-hidden': () => {
    const doc = recordedProject({ pauses: [] });
    return graph(edit(doc, { type: 'setHidden', trackId: id(doc, 'Face'), hidden: true }));
  },
  'cut-and-gain': () => {
    const doc = recordedProject({ pauses: [] });
    return graph(
      edit(
        doc,
        { type: 'cutRange', inUs: 10_000_000, outUs: 15_000_000 },
        { type: 'setGain', trackId: id(doc, 'System audio'), gainDb: -6 },
        { type: 'setGain', trackId: id(doc, 'Voice'), gainDb: 3.5 },
      ),
    );
  },
  'muted-and-solo': () => {
    const doc = recordedProject({ pauses: [] });
    return graph(
      edit(
        doc,
        { type: 'setMuted', trackId: id(doc, 'System audio'), muted: true },
        { type: 'setSolo', trackId: id(doc, 'Voice'), solo: true },
      ),
    );
  },
  'deleted-gap': () => {
    const doc = recordedProject({ pauses: [] });
    const screenClip = trackByName(doc, 'Screen').clips[0]?.id ?? '';
    const split = edit(
      doc,
      { type: 'split', atUs: 20_000_000 },
      { type: 'split', atUs: 30_000_000 },
    );
    const middle = trackByName(split, 'Screen').clips[1]?.id ?? screenClip;
    return graph(edit(split, { type: 'delete', clipIds: [middle] }));
  },
  '720p-draft-60fps': () =>
    graph(recordedProject({ pauses: [] }), { resolution: '720p', quality: 'draft', fps: 60 }),
  '1080p-high-from-1440p': () =>
    graph(recordedProject({ screenSize: { width: 2560, height: 1440 }, pauses: [] }), {
      resolution: '1080p',
      quality: 'high',
    }),
  'vaapi-encoder': () => graph(recordedProject({ pauses: [] }), {}, 'h264_vaapi'),
  'nudge-face-voice': () => {
    const doc = recordedProject({ pauses: [] });
    const faceVoice = doc.components.find((c) => c.type === 'face-voice')?.id ?? '';
    return graph(
      edit(doc, { type: 'nudge', target: { componentId: faceVoice }, syncAdjustUs: 500_000 }),
    );
  },
  'moved-earlier': () => {
    // The last third of every track moved before the middle one: a second, seeked input per
    // media for the out-of-order clips.
    let doc = edit(
      recordedProject({ pauses: [] }),
      { type: 'split', atUs: 20_000_000 },
      { type: 'split', atUs: 40_000_000 },
    );
    for (const track of doc.timeline.tracks) {
      const middle = track.clips[1]?.id ?? '';
      doc = edit(doc, {
        type: 'move',
        clipId: middle,
        toStartUs: 60_000_000,
        includeLinked: false,
      });
    }
    return graph(edit(doc, { type: 'cutRange', inUs: 20_000_000, outUs: 40_000_000 }));
  },
  'letterbox-untagged': () => {
    const doc = recordedProject({ pauses: [] });
    const wide: ProjectV1 = {
      ...doc,
      timeline: {
        ...doc.timeline,
        canvas: { width: 2560, height: 1080, background: { type: 'color', color: '#3080c0' } },
      },
    };
    return graph(wide, {}, null, new Map());
  },
};

describe('export graph golden files (§4.6.2)', () => {
  for (const [name, build] of Object.entries(CANONICAL)) {
    it(name, async () => {
      await expect(golden(build())).toMatchFileSnapshot(`golden/export/${name}.txt`);
    });
  }

  it('is deterministic', () => {
    for (const build of Object.values(CANONICAL)) expect(golden(build())).toBe(golden(build()));
  });
});

describe('export graph rules (§4.3.9)', () => {
  it('uses one -i per media and per mask, and repeats the mask in the graph', () => {
    const g = graph(recordedProject());
    const inputs = g.args.flatMap((a, i) => (a === '-i' ? [g.args[i + 1]] : []));
    expect(inputs).toEqual([
      '/projects/Lesson.cstudio/media/screen.mp4',
      '/projects/Lesson.cstudio/media/camera.mp4',
      '/projects/Lesson.cstudio/media/microphone.mp4',
      '/projects/Lesson.cstudio/media/system-audio.mp4',
      '/tmp/cs-export/mask-0.png',
    ]);
    expect(g.args).not.toContain('-loop');
    expect(g.filterScriptText).toContain('[4:v:0]format=gray,loop=loop=-1:size=1,setpts=N/30/TB');
    expect(g.masks).toHaveLength(1);
    expect(g.masks[0]?.mask.shape).toBe('circle');
  });

  it('opens a media file again, seeked, for clips that play out of file order', () => {
    const g = CANONICAL['moved-earlier']?.();
    if (!g) throw new Error('missing canonical case');
    const inputs = g.inputs.map((i) => [path.basename(i.path), i.seek?.startUs ?? null]);
    expect(inputs).toEqual([
      ['screen.mp4', null],
      ['camera.mp4', null],
      ['microphone.mp4', null],
      ['system-audio.mp4', null],
      // The moved clips read from just under 20 s (start offsets): inputs opened a second
      // earlier, on the frame grid for video and on a whole second for audio.
      ['screen.mp4', expect.any(Number) as unknown],
      ['camera.mp4', expect.any(Number) as unknown],
      ['microphone.mp4', 18_000_000],
      ['system-audio.mp4', 18_000_000],
      ['mask-0.png', null],
    ]);
    for (const input of g.inputs.slice(4, 6)) {
      const startUs = input.seek?.startUs ?? NaN;
      const frames = (startUs * 30) / 1e6;
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
      expect(startUs).toBeLessThanOrEqual(19_000_000);
      expect(startUs).toBeGreaterThan(18_000_000);
    }
    const args = g.args.join(' ');
    expect(args).toContain(
      '-noaccurate_seek -ss 18.000000 -i /projects/Lesson.cstudio/media/microphone.mp4',
    );
    // Each input feeds pieces in file order; the seeked ones get their timestamps back.
    expect(g.filterScriptText).toMatch(
      /\[4:v:0\]setpts=PTS\+[\d.]+\/TB,fps=30:start_time=[\d.]+\[/,
    );
    expect(g.filterScriptText).toContain('[6:a:0]asetpts=PTS+18.000000/TB');
  });

  it('groups uses of a file into runs that play in file order without overlapping', () => {
    const use = (startS: number, endS: number, fileS: number) => ({
      startUs: startS * 1e6,
      endUs: endS * 1e6,
      fileStartUs: fileS * 1e6,
      fileEndUs: (fileS + endS - startS) * 1e6,
    });
    // In order (split clips, a gap between): one run.
    expect(mediaRuns([use(0, 10, 0), use(10, 20, 10), use(30, 40, 25)])).toEqual([0, 0, 0]);
    // Moved earlier: the clip from the start of the file needs its own run.
    expect(mediaRuns([use(0, 10, 50), use(10, 20, 0)])).toEqual([0, 1]);
    // Playing at the same time (two tracks): separate runs, even in file order.
    expect(mediaRuns([use(0, 10, 0), use(5, 15, 20)])).toEqual([0, 1]);
    // First fit: a later clip joins the first run it can follow.
    expect(mediaRuns([use(0, 10, 50), use(10, 20, 0), use(20, 30, 70)])).toEqual([0, 1, 0]);
    // A small overlap in file time (rounding) stays in the run.
    expect(mediaRuns([use(0, 10, 0), use(10, 20, 9.95)])).toEqual([0, 0]);
  });

  it('passes the graph as a script with -/filter_complex (§9.7)', () => {
    const g = graph(recordedProject());
    expect(g.args).not.toContain('-filter_complex_script');
    expect(g.args).not.toContain('-filter_complex');
    expect(g.args[g.args.indexOf('-/filter_complex') + 1]).toBe('/tmp/cs-export/graph.txt');
  });

  it('gives every track exactly the timeline frame count', () => {
    const doc = edit(recordedProject(), { type: 'cutRange', inUs: 3_333_333, outUs: 7_777_777 });
    for (const fps of [30, 60] as const) {
      const g = graph(doc, { fps });
      const durationFrames = Math.round((g.expectedDurationUs * fps) / 1e6);
      // Group piece frame counts per concat (one per track).
      const lines = g.filterScriptText.split('\n');
      const frames = new Map<string, number>();
      for (const line of lines) {
        const label = /\[(p\d+)\];$/.exec(line)?.[1];
        if (!label) continue;
        const clip = /trim=end_frame=(\d+)/.exec(line);
        const gap = /^color=c=[^:]+:s=\d+x\d+:r=(\d+):d=([\d.]+)/.exec(line);
        const n = clip
          ? Number(clip[1])
          : gap
            ? Math.ceil(Number(gap[2]) * Number(gap[1]) - 1e-9)
            : 0;
        frames.set(label, n);
      }
      const concats = lines.filter((l) => l.includes('concat=') || /^\[p\d+\]null/.test(l));
      expect(concats.length).toBe(2);
      for (const line of concats) {
        const used = [...line.matchAll(/\[(p\d+)\]/g)].map((m) => m[1] ?? '');
        const total = used.reduce((sum, l) => sum + (frames.get(l) ?? 0), 0);
        expect(total).toBe(durationFrames);
      }
    }
  });

  it('converts BT.601 sources to BT.709 once per piece, and leaves BT.709 alone', () => {
    expect(toBt709({ matrix: 'bt709', range: 'tv' })).toBeNull();
    expect(toBt709(undefined)).toBeNull();
    expect(toBt709({ matrix: 'smpte170m', range: 'tv' })).toBe(
      'colorspace=all=bt709:iall=bt601-6-525:irange=tv:range=tv:fast=1',
    );
    expect(toBt709({ matrix: 'bt709', range: 'pc' })).toBe(
      'colorspace=all=bt709:iall=bt709:irange=pc:range=tv:fast=1',
    );
    const text = graph(recordedProject()).filterScriptText;
    const clipLines = text.split('\n').filter((l) => l.includes('trim=end_frame'));
    expect(clipLines.length).toBeGreaterThan(0);
    for (const line of clipLines) expect(line).toContain('iall=bt601-6-525');
    expect(text).toContain(
      'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
    );
    expect(text).not.toContain('rgba');
  });

  it('maps qualities to x264 presets and CRF', () => {
    const args = (quality: ExportOptions['quality']) => graph(recordedProject(), { quality }).args;
    const pick = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
    expect([pick(args('draft'), '-preset'), pick(args('draft'), '-crf')]).toEqual([
      'veryfast',
      '28',
    ]);
    expect([pick(args('standard'), '-preset'), pick(args('standard'), '-crf')]).toEqual([
      'medium',
      '21',
    ]);
    expect([pick(args('high'), '-preset'), pick(args('high'), '-crf')]).toEqual(['slow', '18']);
    const a = args('standard');
    expect(a.join(' ')).toContain('-c:a aac -b:a 192k -ar 48000 -ac 2');
    expect(a.join(' ')).toContain('-movflags +faststart');
    expect(a.join(' ')).toContain('-profile:v high -pix_fmt yuv420p');
  });

  it('resamples audio whose clock ratio is off by 1 ppm or more', () => {
    // Fixture ratios: mic 1.0000183 (18.3 ppm), system 0.999995 (5 ppm): both corrected.
    const text = graph(recordedProject()).filterScriptText;
    expect(text).toContain('asetrate=47999.121616,aresample=48000');
    expect(text).toContain('asetrate=48000.240001,aresample=48000');
    const exact = recordedProject();
    for (const m of exact.media) if (m.kind === 'audio') m.clockRatio = 1 + 5e-7;
    expect(graph(exact).filterScriptText).not.toContain('asetrate');
    const drifting = recordedProject();
    const media = drifting.media.find((m) => m.role === 'microphone');
    if (media) media.clockRatio = 1.00005;
    expect(graph(drifting).filterScriptText).toContain('asetrate=47997.60012,aresample=48000');
  });

  it('mixes without normalisation and limits the peak', () => {
    const text = graph(recordedProject()).filterScriptText;
    expect(text).toMatch(/amix=inputs=\d+:normalize=0:dropout_transition=0,alimiter=limit=0\.98/);
    expect(text).toContain('apad[aout]');
  });

  it('uses silence when nothing is audible', () => {
    const doc = recordedProject({ mic: false, system: false });
    expect(graph(doc).filterScriptText).toContain('anullsrc=r=48000:cl=stereo[aout]');
  });

  it('keeps the export size even and the aspect ratio', () => {
    expect(exportSize({ width: 1402, height: 922 }, '1080p')).toEqual({
      width: 1642,
      height: 1080,
    });
    expect(exportSize({ width: 1402, height: 922 }, '720p')).toEqual({ width: 1094, height: 720 });
    expect(exportSize({ width: 1080, height: 1920 }, '720p')).toEqual({ width: 720, height: 1280 });
    expect(exportSize({ width: 2880, height: 1800 }, 'canvas')).toEqual({
      width: 2880,
      height: 1800,
    });
  });

  it('only uses a hardware encoder it can drive, and only on Auto', () => {
    const doc = recordedProject();
    expect(resolveExportSettings(doc, STANDARD, 'h264_vaapi').encoder).toBe('h264_vaapi');
    expect(
      resolveExportSettings(doc, { ...STANDARD, encoder: 'software' }, 'h264_vaapi').encoder,
    ).toBe('libx264');
    expect(resolveExportSettings(doc, STANDARD, 'hevc_magic').encoder).toBe('libx264');
    expect(resolveExportSettings(doc, STANDARD, null).encoder).toBe('libx264');
  });

  it('refuses offline media (R1.29) and empty timelines', () => {
    const doc = recordedProject();
    const camera = doc.media.find((m) => m.role === 'camera');
    if (camera) camera.status = 'missing';
    const result = buildExportGraph({
      doc,
      projectRoot: '/p',
      settings: resolveExportSettings(doc, STANDARD, null),
      outputPath: '/o.mp4',
      filterScriptPath: '/g.txt',
      maskDir: '/m',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('offline');
      expect(result.error.message).toContain('media/camera.mp4');
    }

    const empty = recordedProject();
    for (const track of empty.timeline.tracks) track.clips = [];
    const none = buildExportGraph({
      doc: empty,
      projectRoot: '/p',
      settings: resolveExportSettings(empty, STANDARD, null),
      outputPath: '/o.mp4',
      filterScriptPath: '/g.txt',
      maskDir: '/m',
    });
    expect(none.ok).toBe(false);
  });

  it('ignores hidden offline video and muted offline audio', () => {
    const doc = recordedProject();
    const camera = doc.media.find((m) => m.role === 'camera');
    if (camera) camera.status = 'missing';
    const hidden = edit(doc, { type: 'setHidden', trackId: id(doc, 'Face'), hidden: true });
    expect(graph(hidden).args).not.toContain('/projects/Lesson.cstudio/media/camera.mp4');
  });
});
