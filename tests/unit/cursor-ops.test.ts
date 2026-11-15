import { describe, expect, it } from 'vitest';
import {
  autoZoomOp,
  cursorEffectsOp,
  resetCursorEffectsOp,
  shownCursorEffects,
} from '../../src/renderer/editor/InspectorPanel/cursor-ops';
import { proposeAutoZoom } from '../../src/shared/project/auto-zoom';
import { cameraAt } from '../../src/shared/project/camera-keyframes';
import { DEFAULT_CURSOR_EFFECTS } from '../../src/shared/project/cursor-effects';
import { applyOp } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { CURSOR_MEDIA_ID, cursorProject, cursorTrack } from '../fixtures/cursor-project';

describe('cursor panel operations (R3.10, R3.11)', () => {
  it('starts from what the preview shows: the drawn cursor only, without rings', () => {
    const doc = cursorProject();
    expect(shownCursorEffects(doc).clickRings.enabled).toBe(false);
    const after = unwrap(applyOp(doc, cursorEffectsOp(doc, { smoothing: 0.4 })));
    expect(after.timeline.cursorEffects).toMatchObject({
      smoothing: 0.4,
      clickRings: { enabled: false },
    });
    const baked = cursorProject({ inVideo: true });
    expect(shownCursorEffects(baked)).toEqual(DEFAULT_CURSOR_EFFECTS);
  });

  it('changes one ring or highlight field and keeps the rest', () => {
    const doc = cursorProject({ inVideo: true });
    const op = cursorEffectsOp(doc, { highlight: { enabled: true } });
    expect(op).toMatchObject({
      effects: { highlight: { enabled: true, color: DEFAULT_CURSOR_EFFECTS.highlight.color } },
    });
    expect(resetCursorEffectsOp()).toEqual({ type: 'setCursorEffects', effects: null });
  });

  it('adds only the kept proposals, as one operation', () => {
    const doc = cursorProject();
    const proposals = proposeAutoZoom(doc, new Map([[CURSOR_MEDIA_ID, cursorTrack()]]));
    expect(autoZoomOp([])).toBeNull();
    const kept = proposals.slice(1);
    const after = unwrap(applyOp(doc, autoZoomOp(kept)!));
    expect(cameraAt(after.timeline.camera, 2_500_000).width).toBe(1);
    expect(cameraAt(after.timeline.camera, 9_500_000).width).toBeCloseTo(0.5, 5);
  });
});
