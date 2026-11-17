import { describe, expect, it } from 'vitest';
import { needsFrameRender } from '../../src/shared/export/frame-render';
import {
  DEFAULT_CURSOR_EFFECTS,
  cursorEffectsActive,
  cursorEffectsAvailability,
  sceneCursorPlans,
  type CursorDrawPlan,
} from '../../src/shared/project/cursor-effects';
import { checkProjectInvariants } from '../../src/shared/project/invariants';
import { sceneAt } from '../../src/shared/project/scene';
import { ProjectSchema, type Project } from '../../src/shared/project/schema';
import {
  CURSOR_MEDIA_ID,
  cursorMediaItem,
  cursorProject,
  cursorTrack,
} from '../fixtures/cursor-project';
import { exampleProject } from '../fixtures/example-project';

const tracks = new Map([[CURSOR_MEDIA_ID, cursorTrack()]]);

function plansAt(doc: Project, tUs: number): CursorDrawPlan[] {
  return sceneCursorPlans(doc, tracks, sceneAt(doc, tUs));
}

/** Where a plan's anchor lands on the output frame. */
function anchorOf(plan: CursorDrawPlan): { x: number; y: number } {
  return { x: plan.rect.x + plan.anchor.x, y: plan.rect.y + plan.anchor.y };
}

function withEffects(doc: Project, patch: Partial<typeof DEFAULT_CURSOR_EFFECTS> = {}): Project {
  doc.timeline.cursorEffects = { ...DEFAULT_CURSOR_EFFECTS, ...patch };
  return doc;
}

describe('cursor tracks in the project', () => {
  it('validates a project with a cursor track', () => {
    expect(ProjectSchema.safeParse(cursorProject()).success).toBe(true);
  });

  it('requires the track to belong to a video, and never to be a clip', () => {
    const doc = cursorProject();
    const cursor = doc.cursorTracks.find((t) => t.id === CURSOR_MEDIA_ID);
    if (cursor) cursor.screenMediaId = 'med_m';
    expect(checkProjectInvariants(doc).map((v) => v.code)).toContain('cursor-track');

    // A clip cannot name a cursor track: it is not media.
    const clipped = cursorProject();
    const clip = clipped.timeline.tracks[0]?.clips[0];
    if (clip) clip.mediaId = CURSOR_MEDIA_ID;
    expect(checkProjectInvariants(clipped).map((v) => v.code)).toContain('missing-media');

    const duplicate = cursorProject();
    duplicate.cursorTracks.push({ ...cursorMediaItem(false) });
    expect(checkProjectInvariants(duplicate).map((v) => v.code)).toContain('duplicate-id');
  });
});

describe('availability (R3.12)', () => {
  it('explains a recording without a track', () => {
    const wayland = cursorEffectsAvailability(exampleProject());
    expect(wayland).toMatchObject({ available: false, drawn: false });
    expect(wayland.reason).toMatch(/Wayland/);
    const other = exampleProject();
    if (other.recording) other.recording.platform.session = 'x11';
    expect(cursorEffectsAvailability(other).reason).toMatch(/no cursor track/);
  });

  it('explains a missing track file', () => {
    const doc = cursorProject();
    const track = doc.cursorTracks.find((t) => t.id === CURSOR_MEDIA_ID);
    if (track) track.status = 'missing';
    expect(cursorEffectsAvailability(doc).reason).toMatch(/missing or damaged/);
  });

  it('allows rings everywhere but the drawn cursor only without the system cursor', () => {
    expect(cursorEffectsAvailability(cursorProject({ inVideo: false }))).toMatchObject({
      available: true,
      drawn: true,
      reason: null,
      drawnReason: null,
    });
    const baked = cursorEffectsAvailability(cursorProject({ inVideo: true }));
    expect(baked).toMatchObject({ available: true, drawn: false });
    expect(baked.drawnReason).toMatch(/part of this recording/);
  });
});

describe('draw plans', () => {
  it('draws a ring at the click and the cursor on top', () => {
    const plans = plansAt(withEffects(cursorProject()), 2_100_000);
    expect(plans.map((p) => p.picture.kind)).toEqual(['ring', 'cursor']);
    const [ring, cursor] = plans;
    if (!ring || !cursor) throw new Error('missing plans');
    expect(anchorOf(ring).x).toBeCloseTo(960, 5);
    expect(anchorOf(ring).y).toBeCloseTo(540, 5);
    expect(ring.opacity).toBeLessThan(1);
    // Between the clicks the cursor moves from (960, 540) toward (1000, 560).
    expect(anchorOf(cursor).x).toBeGreaterThan(960);
  });

  it('grows and fades rings over their duration', () => {
    const doc = withEffects(cursorProject());
    const early = plansAt(doc, 2_050_000).find((p) => p.picture.kind === 'ring');
    const late = plansAt(doc, 2_250_000).find((p) => p.picture.kind === 'ring');
    if (early?.picture.kind !== 'ring' || late?.picture.kind !== 'ring') throw new Error();
    expect(late.picture.radiusPx).toBeGreaterThan(early.picture.radiusPx);
    expect(late.opacity).toBeLessThan(early.opacity);
    expect(plansAt(doc, 2_900_000).some((p) => p.picture.kind === 'ring')).toBe(false);
  });

  it('draws no cursor when the video shows the system cursor, or when hidden', () => {
    const baked = plansAt(withEffects(cursorProject({ inVideo: true })), 2_100_000);
    expect(baked.map((p) => p.picture.kind)).toEqual(['ring']);
    const hidden = plansAt(withEffects(cursorProject(), { hide: true }), 2_100_000);
    expect(hidden.map((p) => p.picture.kind)).toEqual(['ring']);
  });

  it('puts the highlight under everything', () => {
    const doc = withEffects(cursorProject(), {
      highlight: { ...DEFAULT_CURSOR_EFFECTS.highlight, enabled: true },
    });
    expect(plansAt(doc, 2_100_000).map((p) => p.picture.kind)).toEqual([
      'highlight',
      'ring',
      'cursor',
    ]);
  });

  it('scales the cursor with the size setting', () => {
    const size = (s: number) => {
      const plan = plansAt(withEffects(cursorProject(), { size: s }), 500_000)[0];
      return plan?.picture.kind === 'cursor' ? plan.picture.heightPx : 0;
    };
    expect(size(2)).toBeCloseTo(2 * size(1), 0);
  });

  it('follows the camera zoom', () => {
    const doc = withEffects(cursorProject());
    doc.timeline.camera = [
      { tUs: 0, rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, easing: 'hold' },
    ];
    // (1000, 560) on the canvas → 2 × (1000 − 480, 560 − 270) on the output.
    const cursor = plansAt(doc, 2_300_000).find((p) => p.picture.kind === 'cursor');
    if (!cursor) throw new Error('no cursor');
    expect(anchorOf(cursor).x).toBeCloseTo(1040, 5);
    expect(anchorOf(cursor).y).toBeCloseTo(580, 5);
  });

  it('draws the cursor by default where the video lacks it, without rings', () => {
    const doc = cursorProject();
    expect(plansAt(doc, 2_100_000).map((p) => p.picture.kind)).toEqual(['cursor']);
    expect(cursorEffectsActive(doc)).toBe(true);
    expect(needsFrameRender(doc)).toBe(true);
    const baked = cursorProject({ inVideo: true });
    expect(cursorEffectsActive(baked)).toBe(false);
    expect(needsFrameRender(baked)).toBe(false);
  });

  it('draws nothing before the track has loaded or outside the layer', () => {
    const doc = withEffects(cursorProject());
    expect(sceneCursorPlans(doc, new Map(), sceneAt(doc, 2_100_000))).toEqual([]);
    const track = doc.timeline.tracks[0];
    if (track?.type === 'video' && track.layout.kind === 'screen') {
      track.layout.crop = { x: 0, y: 0, width: 800, height: 400 };
    }
    expect(plansAt(doc, 2_100_000)).toEqual([]);
  });
});
