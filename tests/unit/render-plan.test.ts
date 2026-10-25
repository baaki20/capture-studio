import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { refToFileUs } from '../../src/shared/project/media-time';
import {
  MASK_COVERAGE_GLSL,
  audioSegments,
  clipCoverage,
  containRect,
  dbToLinear,
  layerFileTimeUs,
  layersAt,
  maskAlpha,
  maskCoverage,
  segmentAt,
  segmentLayersAt,
  segments,
  smoothstep,
  videoTrackPlans,
} from '../../src/shared/project/render-plan';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { applyOp, clipEndUs, timelineDurationUs } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import {
  arbOpTemplate,
  arbRecordedProject,
  counterIds,
  recordedProject,
  resolveOp,
  trackByName,
} from '../fixtures/editor-project';
import { exampleProject } from '../fixtures/example-project';

const S = 1_000_000;

function edit(doc: ProjectV1, ...ops: Parameters<typeof applyOp>[1][]): ProjectV1 {
  const generateId = counterIds('E');
  return ops.reduce((d, op) => unwrap(applyOp(d, op, { generateId })), doc);
}

describe('layersAt', () => {
  it('composites the cropped screen and the face overlay (§4.4.2 example)', () => {
    const doc = exampleProject();
    const layers = layersAt(doc, 60 * S);
    expect(layers.map((l) => l.kind)).toEqual(['screen', 'overlay']);
    const [screen, face] = layers;
    expect(screen).toMatchObject({
      sourceRect: { x: 0, y: 0, width: 1920, height: 1080 },
      destRect: { x: 0, y: 0, width: 1920, height: 1080 },
      mask: { shape: 'rectangle', radiusPx: 0 },
      mirror: false,
      fileTimeUs: 60 * S,
      offline: false,
    });
    expect(face).toMatchObject({
      sourceRect: { x: 280, y: 0, width: 720, height: 720 },
      destRect: { x: 1498, y: 694, width: 384, height: 384 },
      mask: { shape: 'circle', radiusPx: 192 },
      fileTimeUs: 60 * S - 41_200,
    });
  });

  it('maps timeline time through pauses and the media clock', () => {
    const doc = exampleProject();
    // Timeline 130 s is in the second screen clip: session 145.5 s.
    const [screen] = layersAt(doc, 130 * S);
    expect(screen?.refTimeUs).toBe(145_500_000);
    expect(screen?.fileTimeUs).toBe(145_500_000);
    // No face after 120 s.
    expect(layersAt(doc, 130 * S)).toHaveLength(1);
  });

  it('letterboxes an uncropped screen with "contain"', () => {
    const doc = exampleProject();
    const screenTrack = doc.timeline.tracks[0]!;
    const next = edit(doc, { type: 'setLayout', trackId: screenTrack.id, layout: { crop: null } });
    const [screen] = layersAt(next, 10 * S);
    // 2880 × 1800 (16:10) into 1920 × 1080: 1728 × 1080, centred.
    expect(screen?.destRect).toEqual({ x: 96, y: 0, width: 1728, height: 1080 });
    expect(containRect({ width: 1080, height: 1920 }, { width: 1920, height: 1080 })).toEqual({
      x: 656,
      y: 0,
      width: 608,
      height: 1080,
    });
  });

  it('honours hide, mirror, nudges and offline media', () => {
    const doc = exampleProject();
    const face = doc.timeline.tracks[1]!;
    const hidden = edit(doc, { type: 'setHidden', trackId: face.id, hidden: true });
    expect(layersAt(hidden, 60 * S).map((l) => l.kind)).toEqual(['screen']);

    const mirrored = edit(doc, { type: 'setLayout', trackId: face.id, layout: { mirror: true } });
    expect(layersAt(mirrored, 60 * S)[1]?.mirror).toBe(true);

    const nudged = edit(doc, {
      type: 'nudge',
      target: { componentId: 'cmp_face' },
      syncAdjustUs: -50_000,
    });
    // A −50 ms nudge shows the camera 50 ms later in its file at the same timeline time.
    expect(layersAt(nudged, 60 * S)[1]?.fileTimeUs).toBe(60 * S - 41_200 + 50_000);

    const offline = structuredClone(doc);
    offline.media[1]!.status = 'missing';
    expect(layersAt(offline, 60 * S)[1]?.offline).toBe(true);
  });

  it('gives a rounded mask its radius in canvas pixels', () => {
    const doc = exampleProject();
    const face = doc.timeline.tracks[1]!;
    const rounded = edit(doc, {
      type: 'setLayout',
      trackId: face.id,
      layout: { shape: 'rounded', cornerRadius: 0.25 },
    });
    const layer = layersAt(rounded, 60 * S)[1]!;
    expect(layer.destRect.width).toBe(384);
    expect(layer.destRect.height).toBe(216);
    expect(layer.mask).toEqual({ shape: 'rounded', radiusPx: 54 });
  });
});

describe('segments', () => {
  it('partitions the timeline where the layer set changes', () => {
    const doc = exampleProject();
    const list = segments(doc);
    expect(list.map((s) => [s.startUs, s.endUs, s.layers.length])).toEqual([
      [0, 41_200, 1],
      [41_200, 120 * S, 2],
      [120 * S, 723 * S, 1],
    ]);
    expect(segments({ ...doc, timeline: { ...doc.timeline, tracks: [] } })).toEqual([]);
  });

  it('gives file in and out points per layer', () => {
    const doc = exampleProject();
    const seg = segments(doc)[2]!;
    expect(seg.layers[0]).toMatchObject({
      refStartUs: 135_500_000,
      refEndUs: 738_500_000,
      fileStartUs: 135_500_000,
      fileEndUs: 738_500_000,
    });
    expect(layerFileTimeUs(seg, seg.layers[0]!, 200 * S)).toBe(215_500_000);
    expect(segmentAt(segments(doc), 120 * S)).toEqual(seg);
    expect(segmentAt(segments(doc), 723 * S)).toBeNull();
  });

  it('partitions [0, duration) and agrees with layersAt at every boundary ± 1 µs (property)', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.array(arbOpTemplate, { maxLength: 12 }),
        (initial, templates) => {
          let doc = initial;
          const generateId = counterIds('G');
          for (const t of templates) {
            const r = applyOp(doc, resolveOp(doc, t), { generateId });
            if (r.ok) doc = r.value;
          }
          const list = segments(doc);
          const duration = timelineDurationUs(doc);
          if (duration === 0) {
            expect(list).toEqual([]);
            return;
          }
          expect(list[0]?.startUs).toBe(0);
          expect(list[list.length - 1]?.endUs).toBe(duration);
          list.forEach((s, i) => {
            expect(s.endUs).toBeGreaterThan(s.startUs);
            if (i > 0) expect(s.startUs).toBe(list[i - 1]!.endUs);
          });
          for (const s of list) {
            for (const t of [s.startUs - 1, s.startUs, s.startUs + 1, s.endUs - 1]) {
              if (t < 0 || t >= duration) continue;
              const seg = segmentAt(list, t);
              expect(seg).not.toBeNull();
              expect(segmentLayersAt(seg!, t)).toEqual(layersAt(doc, t));
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('videoTrackPlans', () => {
  it('covers the timeline per visible track with clip and gap pieces', () => {
    const doc = exampleProject();
    const plans = videoTrackPlans(doc);
    expect(plans.map((p) => p.trackId)).toEqual(['trk_s', 'trk_f']);
    const face = plans[1]!;
    expect(face.pieces.map((p) => [p.kind, p.startUs, p.endUs])).toEqual([
      ['gap', 0, 41_200],
      ['clip', 41_200, 120 * S],
      ['gap', 120 * S, 723 * S],
    ]);
    const clip = face.pieces[1];
    expect(clip?.kind === 'clip' && clip.layer.fileStartUs).toBe(0);
  });

  it('pieces are contiguous for random edits', () => {
    const doc = edit(
      recordedProject(),
      { type: 'cutRange', inUs: 3 * S, outUs: 4 * S },
      { type: 'split', atUs: 10 * S },
    );
    const duration = timelineDurationUs(doc);
    for (const plan of videoTrackPlans(doc)) {
      let cursor = 0;
      for (const piece of plan.pieces) {
        expect(piece.startUs).toBe(cursor);
        cursor = piece.endUs;
      }
      expect(cursor).toBe(duration);
    }
  });
});

describe('audioSegments', () => {
  it('lists audio clips with file in/out, clock ratio and gain', () => {
    const doc = exampleProject();
    const list = audioSegments(doc);
    expect(list).toHaveLength(1);
    const voice = list[0]!;
    const mic = doc.media.find((m) => m.id === 'med_m')!;
    expect(voice).toMatchObject({
      trackId: 'trk_v',
      timelineStartUs: 41_200,
      timelineEndUs: 120 * S,
      fileStartUs: refToFileUs(mic, 41_200),
      fileEndUs: refToFileUs(mic, 120 * S),
      clockRatio: 1.0000183,
      gainDb: 0,
      linearGain: 1,
      audible: true,
    });
    expect(voice.fileEndSeconds).toBeCloseTo((120 * S - 12_800) / 1.0000183 / S, 9);
  });

  it('applies mute and solo', () => {
    const doc = recordedProject();
    const voice = trackByName(doc, 'Voice').id;
    const system = trackByName(doc, 'System audio').id;
    const tracksOf = (d: ProjectV1) => [...new Set(audioSegments(d).map((a) => a.trackId))];
    expect(tracksOf(doc)).toEqual([voice, system]);
    expect(tracksOf(edit(doc, { type: 'setMuted', trackId: voice, muted: true }))).toEqual([
      system,
    ]);
    expect(tracksOf(edit(doc, { type: 'setSolo', trackId: voice, solo: true }))).toEqual([voice]);
    // A soloed but muted track stays silent.
    expect(
      tracksOf(
        edit(
          doc,
          { type: 'setSolo', trackId: voice, solo: true },
          { type: 'setMuted', trackId: voice, muted: true },
        ),
      ),
    ).toEqual([]);
    const all = audioSegments(edit(doc, { type: 'setMuted', trackId: voice, muted: true }), {
      includeInaudible: true,
    });
    expect(all.filter((a) => !a.audible).every((a) => a.linearGain === 0)).toBe(true);
    const gained = audioSegments(edit(doc, { type: 'setGain', trackId: system, gainDb: -6 }));
    expect(gained.find((a) => a.trackId === system)?.linearGain).toBeCloseTo(dbToLinear(-6));
  });

  it('follows the clips through edits', () => {
    const doc = edit(recordedProject(), { type: 'cutRange', inUs: 3 * S, outUs: 4 * S });
    for (const a of audioSegments(doc)) {
      const clip = doc.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === a.clipId)!;
      expect(a.timelineEndUs).toBe(clipEndUs(clip));
      expect(a.refEndUs - a.refStartUs).toBe(a.timelineEndUs - a.timelineStartUs);
    }
  });
});

describe('non-destructive sync nudge (R1.42)', () => {
  const nudgeFace = (doc: ProjectV1, syncAdjustUs: number) =>
    edit(doc, { type: 'nudge', target: { componentId: 'cmp_face' }, syncAdjustUs });

  it('shows a gap where the nudged camera file does not cover the clip', () => {
    // Camera content now starts 1 s later (ref 1 041 200); the clip still starts at 41 200.
    const doc = nudgeFace(exampleProject(), 1 * S);
    expect(doc.timeline.tracks[1]!.clips[0]).toEqual(exampleProject().timeline.tracks[1]!.clips[0]);
    expect(layersAt(doc, 500_000).map((l) => l.kind)).toEqual(['screen']);
    expect(layersAt(doc, 1_041_200).map((l) => l.kind)).toEqual(['screen', 'overlay']);
    expect(layersAt(doc, 1_041_200)[1]?.fileTimeUs).toBe(0);
    expect(segments(doc).map((s) => [s.startUs, s.endUs, s.layers.length])).toEqual([
      [0, 1_041_200, 1],
      [1_041_200, 120 * S, 2],
      [120 * S, 723 * S, 1],
    ]);
    const face = videoTrackPlans(doc).find((p) => p.trackId === 'trk_f')!;
    expect(face.pieces.map((p) => [p.kind, p.startUs, p.endUs])).toEqual([
      ['gap', 0, 1_041_200],
      ['clip', 1_041_200, 120 * S],
      ['gap', 120 * S, 723 * S],
    ]);
  });

  it('plays silence where the nudged mic file does not cover the clip', () => {
    const doc = nudgeFace(exampleProject(), 1 * S);
    const voice = audioSegments(doc).find((a) => a.trackId === 'trk_v')!;
    // The mic starts at 12 800 in session time, so its content now begins at 1 012 800.
    expect(voice.timelineStartUs).toBe(1_012_800);
    expect(voice.refStartUs).toBe(1_012_800);
    expect(voice.fileStartUs).toBe(0);
    expect(voice.timelineEndUs).toBe(120 * S);
  });

  it('cuts the tail when the nudge moves the file earlier', () => {
    const doc = exampleProject();
    // Extend the face clip to the camera's end, then nudge earlier by 2 s.
    const clip = doc.timeline.tracks[1]!.clips[0]!;
    const camera = doc.media[1]!;
    const coverage = clipCoverage(clip, { ...camera, syncAdjustUs: -2 * S });
    expect(coverage).toEqual({ startUs: 41_200, endUs: 120 * S });
    const atEnd = { ...clip, sourceEndUs: 41_200 + camera.durationUs };
    expect(clipCoverage(atEnd, { ...camera, syncAdjustUs: -2 * S })).toEqual({
      startUs: 41_200,
      endUs: 41_200 + camera.durationUs - 2 * S,
    });
    // Fully outside: no coverage.
    expect(clipCoverage(clip, { ...camera, syncAdjustUs: 200 * S })).toBeNull();
  });

  it('agrees between layersAt, segments and audioSegments for random nudges (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2 * S, max: 2 * S }), fc.nat(130 * S), (nudge, t) => {
        const doc = nudgeFace(exampleProject(), nudge);
        const seg = segmentAt(segments(doc), t);
        const direct = layersAt(doc, t);
        expect(seg ? segmentLayersAt(seg, t) : []).toEqual(direct);
        for (const layer of direct) {
          expect(layer.fileTimeUs).toBeGreaterThanOrEqual(0);
        }
        for (const a of audioSegments(doc)) {
          expect(a.fileStartUs).toBeGreaterThanOrEqual(0);
          expect(a.timelineEndUs).toBeGreaterThan(a.timelineStartUs);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('mask function', () => {
  const circle = { shape: 'circle' as const, radiusPx: 0 };

  it('covers a rectangle fully', () => {
    expect(maskAlpha({ shape: 'rectangle', radiusPx: 0 }, 8, 4).every((a) => a === 255)).toBe(true);
  });

  it('anti-aliases a circle over about one pixel', () => {
    const size = 64;
    const alpha = maskAlpha(circle, size, size);
    expect(alpha[32 * size + 32]).toBe(255);
    expect(alpha[0]).toBe(0);
    // The edge is partially covered.
    expect(alpha.some((a) => a > 0 && a < 255)).toBe(true);
    const row = Array.from(alpha.subarray(32 * size, 33 * size));
    // Symmetric (mirror does not change the mask).
    expect(row).toEqual([...row].reverse());
    // Coverage is 0.5 exactly on the boundary.
    expect(maskCoverage(circle, size, size, 0, 32)).toBeCloseTo(0.5);
  });

  it('rounds corners by the radius', () => {
    const mask = { shape: 'rounded' as const, radiusPx: 10 };
    expect(maskCoverage(mask, 100, 50, 0.5, 0.5)).toBe(0);
    expect(maskCoverage(mask, 100, 50, 50.5, 0.5)).toBe(1);
    expect(maskCoverage(mask, 100, 50, 10.5, 10.5)).toBe(1);
  });

  it('matches the GLSL source', () => {
    expect(MASK_COVERAGE_GLSL).toContain('smoothstep(-0.5, 0.5, d)');
    expect(smoothstep(-0.5, 0.5, 0)).toBe(0.5);
  });
});
