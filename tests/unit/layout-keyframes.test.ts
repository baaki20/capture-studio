/**
 * Face layout keyframe operations (R2.1–R2.4): setLayoutKeyframe, removeLayoutKeyframe,
 * moveLayoutKeyframe, setFaceMode (per-segment layouts), style through setLayout on keyframed
 * tracks, and keyframes moving with cuts. What the face shows is checked through `sceneAt`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  faceModeSegment,
  faceStateAt,
  keyframesThroughCut,
} from '../../src/shared/project/layout-keyframes';
import { sceneAt } from '../../src/shared/project/scene';
import type {
  FaceMode,
  LayoutKeyframe,
  OverlayLayout,
  Project,
  VideoTrack,
} from '../../src/shared/project/schema';
import { applyOp, type TimelineOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

function project(): Project {
  return recordedProject({
    durationUs: 20_000_000,
    pauses: [],
    mic: true,
    system: false,
    screenSize: { width: 1280, height: 720 },
    cameraSize: { width: 640, height: 480 },
    offsets: { screen: 0, camera: 0, microphone: 0 },
  });
}

function faceOf(doc: Project): VideoTrack & { layout: OverlayLayout } {
  const face = trackByName(doc, 'Face');
  if (face.type !== 'video' || face.layout.kind !== 'overlay') throw new Error('no face overlay');
  return face as VideoTrack & { layout: OverlayLayout };
}

function apply(doc: Project, ...ops: TimelineOp[]): Project {
  const generateId = counterIds('K');
  return ops.reduce((d, op) => unwrap(applyOp(d, op, { generateId })), doc);
}

function tryApply(doc: Project, op: TimelineOp) {
  return applyOp(doc, op, { generateId: counterIds('K') });
}

/** The face layer's mode-defining numbers at `tUs`: box and opacity. */
function faceAt(doc: Project, tUs: number) {
  const id = faceOf(doc).id;
  const layer = sceneAt(doc, tUs).layers.find((l) => l.trackId === id);
  return layer ? { rect: layer.destRect, opacity: layer.opacity } : null;
}

const FULL = { x: 0, y: 0, width: 1280, height: 720 };

describe('setLayoutKeyframe', () => {
  it('keeps the static layout until a later first keyframe (anchor at 0)', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const before = faceAt(doc, 1_000_000);
    const edited = apply(doc, {
      type: 'setLayoutKeyframe',
      trackId: id,
      tUs: 5_000_000,
      mode: 'full',
    });
    const keys = faceOf(edited).layoutKeyframes ?? [];
    expect(keys.map((k) => [k.tUs, k.mode, k.easing])).toEqual([
      [0, 'overlay', 'hold'],
      [5_000_000, 'full', 'ease-in-out'],
    ]);
    expect(faceAt(edited, 1_000_000)).toEqual(before);
    expect(faceAt(edited, 4_999_999)).toEqual(before);
    expect(faceAt(edited, 5_000_000)?.rect).toEqual(FULL);
  });

  it('changes the keyframe at a time in place, layout fields clamped', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const edited = apply(
      doc,
      { type: 'setLayoutKeyframe', trackId: id, tUs: 0, mode: 'overlay' },
      {
        type: 'setLayoutKeyframe',
        trackId: id,
        tUs: 0,
        layout: { centerX: 2, width: 0.9 },
        easing: 'linear',
      },
    );
    const [key] = faceOf(edited).layoutKeyframes ?? [];
    expect(faceOf(edited).layoutKeyframes).toHaveLength(1);
    expect(key?.easing).toBe('linear');
    expect(key?.layout.width).toBeLessThanOrEqual(0.5);
    // Clamped inside the canvas: the box ends at the right edge at most.
    const rect = faceAt(edited, 0)?.rect;
    expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(1280);
    // The static layout is untouched.
    expect(faceOf(edited).layout).toEqual(faceOf(doc).layout);
  });

  it('eases between keyframes and holds with `hold`', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const eased = apply(
      doc,
      { type: 'setLayoutKeyframe', trackId: id, tUs: 0, mode: 'overlay', easing: 'linear' },
      { type: 'setLayoutKeyframe', trackId: id, tUs: 2_000_000, mode: 'full' },
    );
    const a = faceAt(eased, 0)?.rect;
    const mid = faceAt(eased, 1_000_000)?.rect;
    expect(mid?.width).toBeCloseTo(((a?.width ?? 0) + 1280) / 2, -1);
    const held = apply(eased, { type: 'setLayoutKeyframe', trackId: id, tUs: 0, easing: 'hold' });
    expect(faceAt(held, 1_999_999)?.rect).toEqual(a);
  });

  it('refuses non-overlay tracks, locked tracks and bad times', () => {
    const doc = project();
    const screen = trackByName(doc, 'Screen').id;
    const id = faceOf(doc).id;
    expect(
      tryApply(doc, { type: 'setLayoutKeyframe', trackId: screen, tUs: 0, mode: 'full' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'wrong-track-type' },
    });
    expect(tryApply(doc, { type: 'setLayoutKeyframe', trackId: id, tUs: -1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-value' },
    });
    const locked = apply(doc, { type: 'setLocked', trackId: id, locked: true });
    expect(tryApply(locked, { type: 'setLayoutKeyframe', trackId: id, tUs: 0 })).toMatchObject({
      ok: false,
      error: { code: 'track-locked' },
    });
  });
});

describe('removeLayoutKeyframe and moveLayoutKeyframe', () => {
  it('removes one, and the field when none are left (back to the static layout)', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const keyed = apply(doc, { type: 'setLayoutKeyframe', trackId: id, tUs: 0, mode: 'hidden' });
    expect(faceAt(keyed, 0)?.opacity).toBe(0);
    const removed = apply(keyed, { type: 'removeLayoutKeyframe', trackId: id, tUs: 0 });
    expect('layoutKeyframes' in faceOf(removed)).toBe(false);
    expect(faceAt(removed, 0)).toEqual(faceAt(doc, 0));
    expect(tryApply(removed, { type: 'removeLayoutKeyframe', trackId: id, tUs: 0 })).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-do' },
    });
  });

  it('moves a keyframe past others and refuses to land on one', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const keyed = apply(
      doc,
      { type: 'setLayoutKeyframe', trackId: id, tUs: 1_000_000, mode: 'full' },
      { type: 'setLayoutKeyframe', trackId: id, tUs: 3_000_000, mode: 'hidden' },
    );
    const moved = apply(keyed, {
      type: 'moveLayoutKeyframe',
      trackId: id,
      fromUs: 1_000_000,
      toUs: 4_000_000,
    });
    expect((faceOf(moved).layoutKeyframes ?? []).map((k) => [k.tUs, k.mode])).toEqual([
      [0, 'overlay'],
      [3_000_000, 'hidden'],
      [4_000_000, 'full'],
    ]);
    expect(
      tryApply(moved, {
        type: 'moveLayoutKeyframe',
        trackId: id,
        fromUs: 4_000_000,
        toUs: 3_000_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'overlap' } });
    expect(
      tryApply(moved, { type: 'moveLayoutKeyframe', trackId: id, fromUs: 7, toUs: 9 }),
    ).toMatchObject({ ok: false, error: { code: 'nothing-to-do' } });
  });
});

describe('setFaceMode (per-segment layouts, R2.2)', () => {
  const modes: FaceMode[] = ['full', 'side-by-side', 'hidden'];

  it.each(modes)('shows %s inside the range and the old layout outside, with a cut', (mode) => {
    const doc = project();
    const id = faceOf(doc).id;
    const edited = apply(doc, {
      type: 'setFaceMode',
      trackId: id,
      startUs: 4_000_000,
      endUs: 8_000_000,
      mode,
      easeUs: 0,
    });
    const outside = faceAt(doc, 0);
    expect(faceAt(edited, 3_999_999)).toEqual(outside);
    expect(faceAt(edited, 8_000_000)).toEqual(outside);
    expect(faceAt(edited, 12_000_000)).toEqual(outside);
    for (const t of [4_000_000, 6_000_000, 7_999_999]) {
      const inside = faceAt(edited, t);
      if (mode === 'full') expect(inside?.rect).toEqual(FULL);
      if (mode === 'side-by-side')
        expect(inside?.rect).toEqual({ x: 640, y: 0, width: 640, height: 720 });
      if (mode === 'hidden') expect(inside?.opacity).toBe(0);
    }
  });

  it('eases in before the start and out before the end', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const edited = apply(doc, {
      type: 'setFaceMode',
      trackId: id,
      startUs: 4_000_000,
      endUs: 8_000_000,
      mode: 'full',
      easeUs: 500_000,
    });
    const outside = faceAt(doc, 0)?.rect;
    expect(faceAt(edited, 3_500_000)?.rect).toEqual(outside);
    const entering = faceAt(edited, 3_750_000)?.rect;
    expect(entering?.width).toBeGreaterThan(outside?.width ?? 0);
    expect(entering?.width).toBeLessThan(1280);
    expect(faceAt(edited, 4_000_000)?.rect).toEqual(FULL);
    expect(faceAt(edited, 7_500_000)?.rect).toEqual(FULL);
    expect(faceAt(edited, 7_750_000)?.rect.width).toBeLessThan(1280);
    expect(faceAt(edited, 8_000_000)?.rect).toEqual(outside);
  });

  it('replaces keyframes inside the range and keeps the ones after', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const edited = apply(
      doc,
      { type: 'setLayoutKeyframe', trackId: id, tUs: 5_000_000, mode: 'hidden' },
      { type: 'setLayoutKeyframe', trackId: id, tUs: 10_000_000, mode: 'side-by-side' },
      { type: 'setFaceMode', trackId: id, startUs: 4_000_000, endUs: 6_000_000, mode: 'full' },
    );
    // After the segment: what was showing at 6 s (hidden), then side by side from 10 s.
    expect(faceAt(edited, 5_000_000)?.rect).toEqual(FULL);
    expect(faceAt(edited, 6_000_000)?.opacity).toBe(0);
    expect(faceAt(edited, 10_000_000)?.rect.x).toBe(640);
  });

  it('starts at 0 without an anchor, and refuses bad ranges', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const edited = apply(doc, {
      type: 'setFaceMode',
      trackId: id,
      startUs: 0,
      endUs: 1_000_000,
      mode: 'full',
    });
    expect(faceOf(edited).layoutKeyframes?.[0]).toMatchObject({ tUs: 0, mode: 'full' });
    expect(
      tryApply(doc, { type: 'setFaceMode', trackId: id, startUs: 5, endUs: 5, mode: 'full' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-value' },
    });
    expect(
      tryApply(doc, {
        type: 'setFaceMode',
        trackId: id,
        startUs: 0,
        endUs: 9,
        mode: 'full',
        easeUs: 3_000_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-value' } });
  });

  it('holds the mode for any range and ease (property)', () => {
    const layout = faceOf(project()).layout;
    const arbKeys = fc
      .uniqueArray(fc.integer({ min: 0, max: 20_000_000 }), { maxLength: 5 })
      .map((times) =>
        times
          .sort((a, b) => a - b)
          .map((tUs, i): LayoutKeyframe => ({
            tUs,
            mode: (['overlay', 'full', 'hidden'] as const)[i % 3] ?? 'overlay',
            layout,
            easing: 'linear',
          })),
      );
    fc.assert(
      fc.property(
        arbKeys,
        fc.integer({ min: 0, max: 15_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        (keys, start, length, ease) => {
          const end = start + length;
          const e = Math.min(ease, Math.floor(length / 2));
          const before = faceStateAt(keys, layout, end);
          const out = faceModeSegment(keys, layout, start, end, 'side-by-side', e);
          const times = out.map((k) => k.tUs);
          expect(times).toEqual([...new Set(times)].sort((a, b) => a - b));
          // Settled in the mode from start until the change out begins.
          expect(faceStateAt(out, layout, start).mode).toBe('side-by-side');
          expect(faceStateAt(out, layout, Math.max(start, end - e - 1)).mode).toBe('side-by-side');
          // From the end, back to what was there.
          expect(faceStateAt(out, layout, end).mode).toBe(before.mode);
        },
      ),
    );
  });
});

describe('style (R2.3–R2.4)', () => {
  it('sets zoom, border and shadow on the whole track, and removes them with null', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const keyed = apply(
      doc,
      { type: 'setLayoutKeyframe', trackId: id, tUs: 0, mode: 'overlay' },
      { type: 'setLayoutKeyframe', trackId: id, tUs: 3_000_000, mode: 'full' },
      {
        type: 'setLayout',
        trackId: id,
        layout: {
          zoom: 9,
          border: { width: 0.01, color: '#FFFFFF' },
          shadow: { blur: 0.02, offsetX: 0, offsetY: 0.01, color: '#00000080' },
        },
      },
    );
    const face = faceOf(keyed);
    for (const layout of [face.layout, ...(face.layoutKeyframes ?? []).map((k) => k.layout)]) {
      expect(layout.zoom).toBe(4);
      expect(layout.border).toEqual({ width: 0.01, color: '#FFFFFF' });
      expect(layout.shadow?.blur).toBe(0.02);
    }
    const layer = sceneAt(keyed, 0).layers.find((l) => l.trackId === id);
    expect(layer?.border).toEqual({ widthPx: 7.2, color: '#FFFFFF' });
    expect(layer?.shadow).toMatchObject({ blurPx: 14.4, offsetYPx: 7.2 });
    const cleared = apply(keyed, {
      type: 'setLayout',
      trackId: id,
      layout: { border: null, shadow: null },
    });
    expect('border' in faceOf(cleared).layout).toBe(false);
    expect((faceOf(cleared).layoutKeyframes ?? []).every((k) => !('shadow' in k.layout))).toBe(
      true,
    );
  });

  it('refuses style on the screen track', () => {
    const doc = project();
    const screen = trackByName(doc, 'Screen').id;
    expect(
      tryApply(doc, { type: 'setLayout', trackId: screen, layout: { border: null } }),
    ).toMatchObject({ ok: false, error: { code: 'wrong-track-type' } });
  });
});

describe('keyframes through cuts', () => {
  const layout = faceOf(project()).layout;
  const key = (tUs: number, mode: FaceMode): LayoutKeyframe => ({
    tUs,
    mode,
    layout,
    easing: 'hold',
  });

  it('shifts later keyframes and keeps what showed at the cut end', () => {
    const keys = [
      key(0, 'overlay'),
      key(2_000_000, 'full'),
      key(3_000_000, 'hidden'),
      key(6_000_000, 'side-by-side'),
    ];
    expect(keyframesThroughCut(keys, 1_000_000, 4_000_000)).toEqual([
      key(0, 'overlay'),
      key(1_000_000, 'hidden'),
      key(3_000_000, 'side-by-side'),
    ]);
    expect(keyframesThroughCut([key(1_000_000, 'full')], 1_000_000, 2_000_000)).toEqual([
      key(1_000_000, 'full'),
    ]);
  });

  it('moves keyframes with a ripple cut of the timeline, unless the track is locked', () => {
    const doc = project();
    const id = faceOf(doc).id;
    const keyed = apply(doc, {
      type: 'setFaceMode',
      trackId: id,
      startUs: 10_000_000,
      endUs: 12_000_000,
      mode: 'full',
    });
    const cut = apply(keyed, { type: 'cutRange', inUs: 2_000_000, outUs: 5_000_000 });
    expect(faceAt(cut, 7_000_000)?.rect).toEqual(FULL);
    expect(faceAt(cut, 9_000_000)?.rect).not.toEqual(FULL);
    const locked = apply(keyed, { type: 'setLocked', trackId: id, locked: true });
    const cutLocked = apply(locked, { type: 'cutRange', inUs: 2_000_000, outUs: 5_000_000 });
    expect(faceOf(cutLocked).layoutKeyframes).toEqual(faceOf(keyed).layoutKeyframes);
  });
});
