import { describe, expect, it } from 'vitest';
import { proposeAutoZoom, timelineClicks } from '../../src/shared/project/auto-zoom';
import { cameraAt } from '../../src/shared/project/camera-keyframes';
import { DEFAULT_CURSOR_EFFECTS } from '../../src/shared/project/cursor-effects';
import { TimelineOpSchema } from '../../src/shared/project/op-schema';
import { applyOp, applyOpWithPatches } from '../../src/shared/project/timeline-ops';
import type { Project } from '../../src/shared/project/schema';
import { CURSOR_MEDIA_ID, cursorProject, cursorTrack } from '../fixtures/cursor-project';
import { exampleProject } from '../fixtures/example-project';

const tracks = new Map([[CURSOR_MEDIA_ID, cursorTrack()]]);

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe('auto-zoom proposals (R3.11)', () => {
  it('places presses on the timeline and the canvas', () => {
    const clicks = timelineClicks(cursorProject(), tracks);
    expect(clicks.map((c) => c.tUs)).toEqual([2_000_000, 2_300_000, 9_000_000]);
    expect(clicks[0]?.x).toBeCloseTo(0.5, 5);
    expect(clicks[0]?.y).toBeCloseTo(0.5, 5);
  });

  it('groups close presses into one zoom around them', () => {
    const proposals = proposeAutoZoom(cursorProject(), tracks);
    expect(proposals).toHaveLength(2);
    const [first, second] = proposals;
    expect(first).toMatchObject({ startUs: 1_400_000, endUs: 3_500_000, clicks: 2 });
    expect(first?.rect.width).toBeCloseTo(0.5, 5);
    // Centred between (960, 540) and (1000, 560).
    expect((first?.rect.x ?? 0) + (first?.rect.width ?? 0) / 2).toBeCloseTo(980 / 1920, 5);
    // The last press is near the corner: the view moves inside the canvas.
    expect(second?.rect.x).toBeCloseTo(0.5, 5);
    expect(second?.clicks).toBe(1);
  });

  it('follows the clip mapping (a cut shifts later presses)', () => {
    const doc = cursorProject();
    const cut = value(applyOp(doc, { type: 'rippleDelete', clipIds: ['clp_1'] }));
    // clp_1 covered 0–120 s, so no press is on the timeline any more.
    expect(timelineClicks(cut, tracks)).toHaveLength(0);
    const sped = value(applyOp(doc, { type: 'setSpeed', inUs: 0, outUs: 4_000_000, speed: 2 }));
    expect(timelineClicks(sped, tracks).map((c) => c.tUs)).toEqual([
      1_000_000, 1_150_000, 7_000_000,
    ]);
  });

  it('leaves manual zooms alone, fits between them and respects a range', () => {
    const doc = value(
      applyOp(cursorProject(), {
        type: 'setCameraZoom',
        startUs: 1_800_000,
        endUs: 2_600_000,
        rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      }),
    );
    // The first group is inside the manual zoom; the second is free.
    expect(proposeAutoZoom(doc, tracks).map((p) => p.clicks)).toEqual([1]);
    // A manual zoom ending just before the last press: the auto zoom starts after it.
    const near = value(
      applyOp(cursorProject(), {
        type: 'setCameraZoom',
        startUs: 7_000_000,
        endUs: 8_600_000,
        rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      }),
    );
    const last = proposeAutoZoom(near, tracks).at(-1);
    expect(last?.startUs).toBeGreaterThan(8_600_000);
    const added = value(applyOp(near, { type: 'addCameraZooms', zooms: [last!] }));
    expect(cameraAt(added.timeline.camera, 8_000_000).width).toBeCloseTo(0.5, 5);
    expect(cameraAt(added.timeline.camera, 9_500_000).width).toBeCloseTo(0.5, 5);
    expect(
      proposeAutoZoom(cursorProject(), tracks, { range: { inUs: 0, outUs: 5_000_000 } }),
    ).toHaveLength(1);
  });

  it('proposes nothing without a cursor track', () => {
    expect(proposeAutoZoom(exampleProject(), tracks)).toEqual([]);
    expect(proposeAutoZoom(cursorProject(), new Map())).toEqual([]);
  });
});

describe('addCameraZooms and setCursorEffects', () => {
  it('adds every proposal in one undoable step', () => {
    const doc = cursorProject();
    const zooms = proposeAutoZoom(doc, tracks);
    const result = value(applyOpWithPatches(doc, { type: 'addCameraZooms', zooms }));
    expect(cameraAt(result.doc.timeline.camera, 2_500_000).width).toBeCloseTo(0.5, 5);
    expect(cameraAt(result.doc.timeline.camera, 9_500_000).width).toBeCloseTo(0.5, 5);
    expect(cameraAt(result.doc.timeline.camera, 5_000_000).width).toBe(1);
    // One step: the inverse patches restore the original camera.
    expect(result.inversePatches.length).toBeGreaterThan(0);
    expect(result.doc.timeline.camera?.length).toBeGreaterThan(4);
  });

  it('refuses an empty list or a bad range', () => {
    const doc = cursorProject();
    expect(applyOp(doc, { type: 'addCameraZooms', zooms: [] })).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-do' },
    });
    expect(
      applyOp(doc, {
        type: 'addCameraZooms',
        zooms: [{ startUs: 5, endUs: 5, rect: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-value' } });
  });

  it('sets, clamps and removes cursor effects', () => {
    const doc = cursorProject();
    const set = value(
      applyOp(doc, {
        type: 'setCursorEffects',
        effects: { ...DEFAULT_CURSOR_EFFECTS, smoothing: 3, size: 0.1 },
      }),
    );
    expect(set.timeline.cursorEffects).toMatchObject({ smoothing: 1, size: 0.5 });
    const removed: Project = value(applyOp(set, { type: 'setCursorEffects', effects: null }));
    expect(removed.timeline.cursorEffects).toBeUndefined();
    expect(applyOp(removed, { type: 'setCursorEffects', effects: null })).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-do' },
    });
  });

  it('refuses cursor effects without a cursor track', () => {
    expect(
      applyOp(exampleProject(), { type: 'setCursorEffects', effects: DEFAULT_CURSOR_EFFECTS }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-value' } });
  });

  it('accepts both from automation', () => {
    expect(
      TimelineOpSchema.safeParse({ type: 'setCursorEffects', effects: DEFAULT_CURSOR_EFFECTS })
        .success,
    ).toBe(true);
    expect(
      TimelineOpSchema.safeParse({
        type: 'addCameraZooms',
        zooms: [{ startUs: 0, endUs: 10, rect: { x: 0, y: 0, width: 1, height: 1 } }],
      }).success,
    ).toBe(true);
  });
});
