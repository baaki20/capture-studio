/**
 * v2 scene resolution (`easing.ts`, `scene.ts`): keyframe interpolation, the camera (§5 P2
 * acceptance b), face layout keyframes, beautify and objects. Phase 1 projects must resolve to
 * exactly the render plan's layers.
 */
import fc from 'fast-check';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { ease, interpolate, keyframeSpan, lerp } from '../../src/shared/project/easing';
import { layersAt } from '../../src/shared/project/render-plan';
import {
  applyCamera,
  cameraRectAt,
  coverCrop,
  objectFade,
  objectsAt,
  sceneAt,
  screenAreaAt,
  zoomCrop,
} from '../../src/shared/project/scene';
import { EASINGS, type OverlayLayout, type Project } from '../../src/shared/project/schema';
import { timelineDurationUs } from '../../src/shared/project/timeline-ops';
import { arbRecordedProject, recordedProject } from '../fixtures/editor-project';

const S = 1_000_000;

function face(doc: Project) {
  const track = doc.timeline.tracks.find((t) => t.name === 'Face');
  if (track?.type !== 'video' || track.layout.kind !== 'overlay') throw new Error('no face');
  return { track, layout: track.layout };
}

describe('easing', () => {
  it.each(EASINGS)('%s starts at 0, ends at 1 and stays in [0, 1]', (e) => {
    expect(ease(e, 0)).toBe(0);
    expect(ease(e, 1)).toBe(1);
    for (let i = 0; i <= 100; i++) {
      const v = ease(e, i / 100);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('shapes the curve', () => {
    expect(ease('linear', 0.25)).toBe(0.25);
    expect(ease('ease-in', 0.5)).toBeLessThan(0.5);
    expect(ease('ease-out', 0.5)).toBeGreaterThan(0.5);
    expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5, 12);
    expect(ease('hold', 0.99)).toBe(0);
  });

  it('finds the span around a time', () => {
    const keys = [
      { tUs: 0, easing: 'linear' as const, v: 0 },
      { tUs: 10, easing: 'linear' as const, v: 100 },
      { tUs: 20, easing: 'hold' as const, v: 50 },
    ];
    expect(keyframeSpan([], 5)).toBeNull();
    expect(keyframeSpan(keys, -5)).toMatchObject({ from: keys[0], to: keys[0] });
    expect(keyframeSpan(keys, 5)).toMatchObject({ from: keys[0], to: keys[1], progress: 0.5 });
    expect(keyframeSpan(keys, 25)).toMatchObject({ from: keys[2], to: keys[2] });
    const value = (t: number) => interpolate(keys, t, (k) => k.v, lerp);
    expect(value(5)).toBe(50);
    expect(value(10)).toBe(100);
    expect(value(15)).toBe(75);
    expect(value(30)).toBe(50);
  });
});

describe('camera', () => {
  const zoomed = (doc: Project) =>
    produce(doc, (d) => {
      d.timeline.camera = [
        { tUs: S, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: 'ease-in-out' },
        { tUs: 3 * S, rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, easing: 'hold' },
      ];
    });

  it('interpolates the rect within 1 px of the pure function at any time (acceptance b)', () => {
    const doc = zoomed(recordedProject());
    const { width: W, height: H } = doc.timeline.canvas;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 * S }), (t) => {
        const rect = cameraRectAt(doc, t);
        const x = t <= S ? 0 : t >= 3 * S ? 1 : (t - S) / (2 * S);
        const e = x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
        expect(Math.abs(rect.x * W - 0.5 * e * W)).toBeLessThanOrEqual(1);
        expect(Math.abs(rect.width * W - (1 - 0.5 * e) * W)).toBeLessThanOrEqual(1);
        expect(Math.abs(rect.y * H - 0.5 * e * H)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('zooms screen layers and objects but not the face', () => {
    const doc = produce(zoomed(recordedProject()), (d) => {
      d.timeline.objectTracks = [
        {
          id: 'trk_OBJ',
          name: 'Objects',
          locked: false,
          hidden: false,
          items: [
            {
              id: 'obj_A',
              kind: 'highlight',
              inUs: 0,
              outUs: 10 * S,
              box: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 },
              color: '#FFFF00',
            },
          ],
        },
      ];
    });
    const plain = sceneAt(recordedProject(), 4 * S);
    const scene = sceneAt(doc, 4 * S);
    const screen = scene.layers.find((l) => l.kind === 'screen')!;
    const faceLayer = scene.layers.find((l) => l.kind === 'overlay')!;
    expect(screen.destRect).toEqual({ x: -1920, y: -1080, width: 3840, height: 2160 });
    expect(faceLayer.destRect).toEqual(plain.layers.find((l) => l.kind === 'overlay')!.destRect);
    expect(scene.objects[0]!.rectPx).toEqual({ x: 0, y: 0, width: 960, height: 540 });
  });

  it('maps rects through the camera', () => {
    const canvas = { width: 1000, height: 500 };
    expect(
      applyCamera(
        { x: 500, y: 250, width: 100, height: 50 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
        canvas,
      ),
    ).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
});

describe('Phase 1 projects', () => {
  it('resolve to exactly the render plan layers at any time', () => {
    fc.assert(
      fc.property(arbRecordedProject, fc.double({ min: 0, max: 1, noNaN: true }), (doc, f) => {
        const t = Math.floor(f * timelineDurationUs(doc));
        const scene = sceneAt(doc, t);
        expect(
          scene.layers.map(({ opacity: _o, tint: _t, border: _b, shadow: _s, ...l }) => l),
        ).toEqual(layersAt(doc, t));
        expect(
          scene.layers.every((l) => l.opacity === 1 && !l.tint && !l.border && !l.shadow),
        ).toBe(true);
        expect(scene.objects).toEqual([]);
        expect(scene.background).toEqual(doc.timeline.canvas.background);
      }),
      { numRuns: 100 },
    );
  });
});

describe('face layout keyframes', () => {
  function keyed(modes: { tUs: number; mode: 'overlay' | 'full' | 'side-by-side' | 'hidden' }[]) {
    const base = recordedProject();
    return produce(base, (d) => {
      const { track, layout } = face(d);
      track.layoutKeyframes = modes.map((m) => ({ ...m, layout, easing: 'linear' as const }));
    });
  }

  it('settles on each mode exactly', () => {
    const doc = keyed([
      { tUs: S, mode: 'overlay' },
      { tUs: 3 * S, mode: 'full' },
      { tUs: 5 * S, mode: 'side-by-side' },
      { tUs: 7 * S, mode: 'hidden' },
    ]);
    const plain = sceneAt(recordedProject(), S).layers.find((l) => l.kind === 'overlay')!;
    const at = (t: number) => sceneAt(doc, t).layers;
    const faceAt = (t: number) => at(t).find((l) => l.kind === 'overlay')!;
    const screenAt = (t: number) => at(t).find((l) => l.kind === 'screen')!;

    expect(faceAt(S).destRect).toEqual(plain.destRect);
    expect(faceAt(S).sourceRect).toEqual(plain.sourceRect);

    expect(faceAt(3 * S).destRect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(faceAt(3 * S).mask).toEqual({ shape: 'rectangle', radiusPx: 0 });

    expect(faceAt(5 * S).destRect).toEqual({ x: 960, y: 0, width: 960, height: 1080 });
    expect(screenAt(5 * S).destRect.x + screenAt(5 * S).destRect.width).toBeLessThanOrEqual(960);

    expect(faceAt(8 * S).opacity).toBe(0);
    expect(faceAt(8 * S).destRect).toEqual(plain.destRect);
  });

  it('eases between modes and crops the face to fill its box', () => {
    const doc = keyed([
      { tUs: S, mode: 'overlay' },
      { tUs: 3 * S, mode: 'full' },
    ]);
    const mid = sceneAt(doc, 2 * S).layers.find((l) => l.kind === 'overlay')!;
    const start = sceneAt(doc, S).layers.find((l) => l.kind === 'overlay')!;
    expect(mid.destRect.width).toBeGreaterThan(start.destRect.width);
    expect(mid.destRect.width).toBeLessThan(1920);
    const srcAspect = mid.sourceRect.width / mid.sourceRect.height;
    const dstAspect = mid.destRect.width / mid.destRect.height;
    expect(Math.abs(srcAspect - dstAspect)).toBeLessThan(0.02);
  });

  it('fades the face out when hidden', () => {
    const doc = keyed([
      { tUs: S, mode: 'overlay' },
      { tUs: 3 * S, mode: 'hidden' },
    ]);
    expect(sceneAt(doc, 2 * S).layers.find((l) => l.kind === 'overlay')!.opacity).toBeCloseTo(
      0.5,
      9,
    );
  });

  it('moves the screen into the left half while side by side', () => {
    const doc = keyed([
      { tUs: S, mode: 'overlay' },
      { tUs: 3 * S, mode: 'side-by-side' },
    ]);
    expect(screenAreaAt(doc, S).width).toBe(1920);
    expect(screenAreaAt(doc, 2 * S).width).toBe(1440);
    expect(screenAreaAt(doc, 4 * S).width).toBe(960);
  });

  it('applies face zoom, border and shadow', () => {
    const doc = produce(recordedProject(), (d) => {
      const { layout } = face(d);
      const styled: OverlayLayout = layout;
      styled.zoom = 2;
      styled.border = { width: 0.005, color: '#FFFFFF' };
      styled.shadow = { blur: 0.02, offsetX: 0, offsetY: 0.01, color: '#00000080' };
    });
    const plain = sceneAt(recordedProject(), S).layers.find((l) => l.kind === 'overlay')!;
    const styled = sceneAt(doc, S).layers.find((l) => l.kind === 'overlay')!;
    expect(styled.sourceRect.width).toBe(Math.round(plain.sourceRect.width / 2));
    expect(styled.border).toEqual({ widthPx: 5.4, color: '#FFFFFF' });
    expect(styled.shadow?.blurPx).toBeCloseTo(21.6, 9);
  });
});

describe('beautify', () => {
  it('pads, rounds and replaces the background', () => {
    const doc = produce(recordedProject(), (d) => {
      d.timeline.beautify = {
        background: { type: 'gradient', from: '#000000', to: '#FFFFFF', angleDeg: 90 },
        padding: 0.1,
        cornerRadius: 0.02,
        shadow: { blur: 0.02, offsetX: 0, offsetY: 0.01, color: '#00000080' },
      };
    });
    const scene = sceneAt(doc, S);
    const screen = scene.layers.find((l) => l.kind === 'screen')!;
    expect(screen.destRect.x).toBeGreaterThanOrEqual(108);
    expect(screen.destRect.y).toBeGreaterThanOrEqual(108);
    expect(screen.destRect.x + screen.destRect.width).toBeLessThanOrEqual(1920 - 108);
    expect(screen.mask).toEqual({ shape: 'rounded', radiusPx: 21.6 });
    expect(scene.background).toMatchObject({ type: 'gradient' });
  });
});

describe('objects', () => {
  const item = {
    id: 'obj_A',
    kind: 'blur' as const,
    inUs: S,
    outUs: 5 * S,
    box: { x: 0, y: 0, width: 0.1, height: 0.1 },
    radius: 0.01,
    fadeInUs: S,
    fadeOutUs: 2 * S,
    keyframes: [
      { tUs: S, box: { x: 0, y: 0, width: 0.1, height: 0.1 }, easing: 'linear' as const },
      { tUs: 3 * S, box: { x: 0.5, y: 0, width: 0.1, height: 0.1 }, easing: 'linear' as const },
    ],
  };

  it('are visible from in to out, with fades and keyframes', () => {
    const doc = produce(recordedProject(), (d) => {
      d.timeline.objectTracks = [
        { id: 'trk_OBJ', name: 'Objects', locked: false, hidden: false, items: [item] },
      ];
    });
    expect(objectsAt(doc, S - 1)).toEqual([]);
    expect(objectsAt(doc, 5 * S)).toEqual([]);
    const mid = objectsAt(doc, 2 * S)[0]!;
    expect(mid.box.x).toBeCloseTo(0.25, 9);
    expect(mid.opacity).toBe(1);
    expect(objectFade(item, 1.5 * S)).toBeCloseTo(0.5, 9);
    expect(objectFade(item, 4.5 * S)).toBeCloseTo(0.25, 9);
  });

  it('are skipped on hidden tracks', () => {
    const doc = produce(recordedProject(), (d) => {
      d.timeline.objectTracks = [
        { id: 'trk_OBJ', name: 'Objects', locked: false, hidden: true, items: [item] },
      ];
    });
    expect(objectsAt(doc, 2 * S)).toEqual([]);
  });
});

describe('crop helpers', () => {
  it('cover-crops to the target aspect, centred', () => {
    expect(
      coverCrop({ x: 0, y: 0, width: 1280, height: 720 }, { width: 100, height: 100 }),
    ).toEqual({
      x: 280,
      y: 0,
      width: 720,
      height: 720,
    });
  });

  it('zooms into the centre', () => {
    expect(zoomCrop({ x: 0, y: 0, width: 100, height: 50 }, 2)).toEqual({
      x: 25,
      y: 12,
      width: 50,
      height: 25,
    });
  });
});
