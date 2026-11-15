/**
 * Operations of the inspector's cursor panel (R3.10–R3.12): edits to the cursor effects start
 * from the effects in force (`effectiveCursorEffects`), so the first change keeps what the
 * preview already showed; auto-zoom adds the proposals the user kept as one step.
 */
import type { AutoZoomProposal } from '../../../shared/project/auto-zoom';
import {
  DEFAULT_CURSOR_EFFECTS,
  effectiveCursorEffects,
} from '../../../shared/project/cursor-effects';
import type { CursorEffects, Project } from '../../../shared/project/schema';
import type { TimelineOp } from '../../../shared/project/timeline-ops';

export interface CursorEffectsPatch {
  smoothing?: number;
  size?: number;
  hide?: boolean;
  clickRings?: Partial<CursorEffects['clickRings']>;
  highlight?: Partial<CursorEffects['highlight']>;
}

/** The effects the panel shows (the defaults when none are in force). */
export function shownCursorEffects(doc: Project): CursorEffects {
  return effectiveCursorEffects(doc) ?? DEFAULT_CURSOR_EFFECTS;
}

export function cursorEffectsOp(doc: Project, patch: CursorEffectsPatch): TimelineOp {
  const base = shownCursorEffects(doc);
  return {
    type: 'setCursorEffects',
    effects: {
      smoothing: patch.smoothing ?? base.smoothing,
      size: patch.size ?? base.size,
      hide: patch.hide ?? base.hide,
      clickRings: { ...base.clickRings, ...patch.clickRings },
      highlight: { ...base.highlight, ...patch.highlight },
    },
  };
}

/** Back to no effects (the drawn cursor only, where the video lacks the system cursor). */
export function resetCursorEffectsOp(): TimelineOp {
  return { type: 'setCursorEffects', effects: null };
}

/** The kept proposals as one operation, or null when none is kept. */
export function autoZoomOp(proposals: readonly AutoZoomProposal[]): TimelineOp | null {
  if (proposals.length === 0) return null;
  return {
    type: 'addCameraZooms',
    zooms: proposals.map(({ startUs, endUs, rect, easeUs }) => ({ startUs, endUs, rect, easeUs })),
  };
}
