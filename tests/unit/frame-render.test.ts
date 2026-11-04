/**
 * Frame-render export helpers (§1.7, D4): path choice, frame timing, the yuv420p frame layout
 * and its packing, and the BT.709 conversion the shader implements.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  frameCount,
  frameSpec,
  frameTimeUs,
  needsFrameRender,
  pickTimeUs,
  rgbToYuv709,
  unpackYuv,
  yuvFrameBytes,
  yuvTarget,
} from '../../src/shared/export/frame-render';
import type { Project } from '../../src/shared/project/schema';
import { recordedProject, trackByName } from '../fixtures/editor-project';

function base(): Project {
  return recordedProject({ durationUs: 10_000_000, mic: true, system: false });
}

type VideoTrack = Extract<Project['timeline']['tracks'][number], { type: 'video' }>;
type OverlayLayout = Extract<VideoTrack['layout'], { kind: 'overlay' }>;

/** A copy of the base project with its face track (an overlay) changed. */
function withFace(change: (face: VideoTrack, layout: OverlayLayout) => void): Project {
  const doc = structuredClone(base());
  const face = trackByName(doc, 'Face');
  if (face.type !== 'video' || face.layout.kind !== 'overlay') throw new Error('no face overlay');
  change(face, face.layout);
  return doc;
}

describe('needsFrameRender (D4)', () => {
  it('keeps a Phase 1 project on the filter graph', () => {
    expect(needsFrameRender(base())).toBe(false);
  });

  it('ignores audio-only v2 fields and markers', () => {
    const doc = structuredClone(base());
    const mic = trackByName(doc, 'Voice');
    if (mic.type !== 'audio') throw new Error('no voice track');
    mic.volumeKeyframes = [{ tUs: 0, gainDb: -6, easing: 'linear' }];
    mic.cleanup = { noise: 'light', normalize: true };
    const clip = mic.clips[0];
    if (clip) clip.gainDb = -3;
    doc.timeline.markers = [{ id: 'mrk_1', tUs: 0, label: 'Intro', chapter: true }];
    expect(needsFrameRender(doc)).toBe(false);
  });

  it('renders frames for any v2 visual feature', () => {
    const cases: Project[] = [
      withFace((face, layout) => {
        face.layoutKeyframes = [{ tUs: 0, mode: 'full', layout: { ...layout }, easing: 'linear' }];
      }),
      withFace((_face, layout) => {
        layout.zoom = 1.5;
      }),
      withFace((_face, layout) => {
        layout.border = { width: 0.004, color: '#FFFFFF' };
      }),
      withFace((_face, layout) => {
        layout.shadow = { blur: 0.02, offsetX: 0, offsetY: 0.01, color: '#000000' };
      }),
      withFace((face) => {
        const clip = face.clips[0];
        if (clip) clip.fadeInUs = 500_000;
      }),
      withFace((face) => {
        const clip = face.clips[0];
        if (clip) clip.transitionIn = { kind: 'dissolve', durationUs: 500_000 };
      }),
      withFace((face) => {
        const clip = face.clips[0];
        if (clip) {
          clip.speed = 2;
          clip.durationUs = (clip.sourceEndUs - clip.sourceStartUs) / 2;
        }
      }),
    ];
    const timeline = (change: (t: Project['timeline']) => void) => {
      const doc = structuredClone(base());
      change(doc.timeline);
      return doc;
    };
    cases.push(
      timeline((t) => {
        t.camera = [{ tUs: 0, rect: { x: 0, y: 0, width: 0.5, height: 0.5 }, easing: 'linear' }];
      }),
      timeline((t) => {
        t.beautify = {
          background: { type: 'color', color: '#202020' },
          padding: 0.05,
          cornerRadius: 0.02,
        };
      }),
      timeline((t) => {
        t.objectTracks = [
          {
            id: 'trk_O1',
            name: 'Objects',
            locked: false,
            hidden: false,
            items: [
              {
                id: 'obj_1',
                kind: 'highlight',
                inUs: 0,
                outUs: 1_000_000,
                box: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
                color: '#FFFF00',
              },
            ],
          },
        ];
      }),
    );
    for (const doc of cases) expect(needsFrameRender(doc)).toBe(true);
  });

  it('does not count an empty object track or an empty camera', () => {
    const doc = structuredClone(base());
    doc.timeline.objectTracks = [
      { id: 'trk_O1', name: 'Objects', locked: false, hidden: false, items: [] },
    ];
    doc.timeline.camera = [];
    expect(needsFrameRender(doc)).toBe(false);
  });
});

describe('frame timing', () => {
  it('counts frames as the filter graph does and spaces them by 1/F', () => {
    expect(frameCount(6_000_000, 30)).toBe(180);
    expect(frameCount(1_016_667, 30)).toBe(31);
    expect(frameTimeUs(0, 30)).toBe(0);
    expect(frameTimeUs(1, 30)).toBe(33_333);
    expect(frameTimeUs(2, 30)).toBe(66_667);
    expect(frameTimeUs(30, 30)).toBe(1_000_000);
  });

  it('builds the spec from the export options', () => {
    const doc = base();
    expect(frameSpec(doc, { fps: 'project', resolution: '720p' }, 2_000_000)).toEqual({
      width: 1280,
      height: 720,
      fps: doc.timeline.frameRate,
      frames: 2 * doc.timeline.frameRate,
    });
    expect(frameSpec(doc, { fps: 60, resolution: 'canvas' }, 1_000_000).frames).toBe(60);
  });

  it('picks the source frame nearest to the file time, like fps=round=near', () => {
    // A 30 fps source has frames at k/30 s. FFmpeg's fps filter shows frame k for output times
    // in [k − ½, k + ½) frames; the pick time with "latest frame ≤ pick" must agree.
    const sourceFps = 30;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.constantFrom(24, 25, 30, 50, 60),
        (t, fps) => {
          const nearest = Math.round((t * sourceFps) / 1_000_000 + 1e-9);
          const pick = pickTimeUs(t, fps);
          const frames = [nearest - 1, nearest, nearest + 1].filter((k) => k >= 0);
          const shown = Math.max(
            ...frames.filter((k) => Math.round((k * 1_000_000) / sourceFps) <= pick),
          );
          // Same export and source rate: the frame at or nearest to t.
          if (fps === sourceFps) expect(shown).toBe(nearest);
          // Never more than half an output frame early.
          expect((shown * 1_000_000) / sourceFps - t).toBeLessThan(500_000 / fps + 1);
        },
      ),
    );
  });
});

describe('yuv420p frames', () => {
  it('has W×H luma and two quarter-size chroma planes', () => {
    expect(yuvFrameBytes(1920, 1080)).toBe(1920 * 1080 * 1.5);
    expect(yuvTarget(1920, 1080)).toEqual({
      width: 480,
      height: 2160,
      lumaTexels: 480,
      chromaTexels: 240,
    });
    // Widths that are not multiples of 8 still pack (with padding texels).
    expect(yuvTarget(1366, 768)).toMatchObject({ width: 342, lumaTexels: 342, chromaTexels: 171 });
  });

  it('unpacks the packed read-back into planar bytes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }).map((n) => n * 2),
        fc.integer({ min: 1, max: 8 }).map((n) => n * 2),
        (width, height) => {
          const target = yuvTarget(width, height);
          const stride = target.width * 4;
          const readback = new Uint8Array(stride * target.height).fill(255);
          // Y sample (x, y) = (x + 3y) % 251; U and V rows carry their plane in the value.
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) readback[y * stride + x] = (x + 3 * y) % 251;
          }
          for (let r = 0; r < height / 2; r++) {
            for (let x = 0; x < width / 2; x++) {
              readback[(height + r) * stride + x] = 1 + ((x + r) % 100);
              readback[(height + height / 2 + r) * stride + x] = 101 + ((x + r) % 100);
            }
          }
          const out = unpackYuv(readback, width, height);
          expect(out.length).toBe(yuvFrameBytes(width, height));
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) expect(out[y * width + x]).toBe((x + 3 * y) % 251);
          }
          const cw = width / 2;
          const ch = height / 2;
          const u = width * height;
          const v = u + cw * ch;
          for (let r = 0; r < ch; r++) {
            for (let x = 0; x < cw; x++) {
              expect(out[u + r * cw + x]).toBe(1 + ((x + r) % 100));
              expect(out[v + r * cw + x]).toBe(101 + ((x + r) % 100));
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('rejects a short read-back', () => {
    expect(() => unpackYuv(new Uint8Array(10), 4, 4)).toThrow(/too short/);
  });

  it('converts to limited-range BT.709 codes', () => {
    expect(rgbToYuv709(0, 0, 0)).toEqual([16, 128, 128]);
    expect(rgbToYuv709(1, 1, 1)).toEqual([235, 128, 128]);
    expect(rgbToYuv709(1, 0, 0)).toEqual([63, 102, 240]);
    expect(rgbToYuv709(0, 1, 0)).toEqual([173, 42, 26]);
    expect(rgbToYuv709(0, 0, 1)).toEqual([32, 240, 118]);
    expect(rgbToYuv709(1, 0, 1)).toEqual([78, 214, 230]);
  });
});
