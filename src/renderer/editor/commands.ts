/**
 * Runs editor commands (from the keyboard map, toolbar and menus) against the document store,
 * the UI store and the transport. Edits go through `DocumentStore.apply`, so each is one undo
 * step and every refusal lands in the status line.
 */
import { findClip, timelineDurationUs, type TimelineOp } from '../../shared/project/timeline-ops';
import type { EditorCommand } from './keyboard';
import type { DocumentStore, EditError } from './store/document-store';
import { clampScroll, fitView, timeToX, zoomAround } from './Timeline/geometry';
import type { UiStore } from './ui-store';

export interface TransportControls {
  toggle(): void;
  shuttle(direction: -1 | 0 | 1): void;
  step(frames: number): void;
  home(): void;
  end(): void;
}

export interface CommandContext {
  docStore: DocumentStore;
  ui: UiStore;
  transport: TransportControls;
  /** Width of the timeline canvas in CSS px (for zoom). */
  timelineWidth: () => number;
}

export const ZOOM_STEP = 1.5;

/** A short message for a refused edit. */
export function errorText(error: EditError, command?: EditorCommand): string {
  if (error.code === 'nothing-to-do' && command === 'split')
    return 'Nothing to split at the playhead.';
  if (error.code === 'track-locked') return 'That clip is on a locked track.';
  return error.message.charAt(0).toUpperCase() + error.message.slice(1);
}

function apply(ctx: CommandContext, op: TimelineOp, command: EditorCommand): boolean {
  const result = ctx.docStore.getState().apply(op);
  ctx.ui.getState().setStatus(result.ok ? null : errorText(result.error, command));
  return result.ok;
}

/** The selection without clips that no longer exist (after undo, delete). */
export function liveSelection(ctx: Pick<CommandContext, 'docStore' | 'ui'>): string[] {
  const doc = ctx.docStore.getState().doc;
  if (!doc) return [];
  return ctx.ui.getState().selection.filter((id) => findClip(doc, id) !== null);
}

export function runCommand(command: EditorCommand, ctx: CommandContext): void {
  const ui = ctx.ui.getState();
  const docState = ctx.docStore.getState();
  const doc = docState.doc;
  const playhead = ui.playheadUs;

  switch (command) {
    case 'play-toggle':
      ctx.transport.toggle();
      return;
    case 'shuttle-reverse':
      ctx.transport.shuttle(-1);
      return;
    case 'shuttle-pause':
      ctx.transport.shuttle(0);
      return;
    case 'shuttle-forward':
      ctx.transport.shuttle(1);
      return;
    case 'frame-back':
      ctx.transport.step(-1);
      return;
    case 'frame-forward':
      ctx.transport.step(1);
      return;
    case 'go-start':
      ctx.transport.home();
      return;
    case 'go-end':
      ctx.transport.end();
      return;
    case 'undo':
    case 'redo': {
      const changed = command === 'undo' ? docState.undo() : docState.redo();
      ui.setStatus(changed ? null : command === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.');
      ui.select(liveSelection(ctx));
      return;
    }
    case 'toggle-snap':
      ui.setSnapping(!ui.snapping);
      ui.setStatus(ui.snapping ? 'Snapping off.' : 'Snapping on.');
      return;
    case 'deselect':
      ui.select([]);
      ui.setOverlaySelected(false);
      return;
    case 'zoom-fit':
    case 'zoom-in':
    case 'zoom-out': {
      const width = ctx.timelineWidth();
      if (!doc || width <= 0) return;
      const view =
        command === 'zoom-fit'
          ? fitView(timelineDurationUs(doc), width)
          : zoomAround(
              ui.view,
              command === 'zoom-in' ? ZOOM_STEP : 1 / ZOOM_STEP,
              Math.max(0, Math.min(width, timeToX(ui.view, playhead))),
            );
      ui.setView(clampScroll(view, timelineDurationUs(doc), width));
      return;
    }
    default:
      break;
  }

  if (!doc) return;
  const selection = liveSelection(ctx);
  const marks = doc.timeline.marks;
  switch (command) {
    case 'split':
      apply(
        ctx,
        { type: 'split', atUs: playhead, ...(selection.length ? { clipIds: selection } : {}) },
        command,
      );
      return;
    case 'delete':
    case 'ripple-delete':
      if (selection.length === 0) {
        ui.setStatus('Select clips to delete.');
        return;
      }
      if (
        apply(
          ctx,
          { type: command === 'delete' ? 'delete' : 'rippleDelete', clipIds: selection },
          command,
        )
      ) {
        ui.select([]);
      }
      return;
    case 'mark-in':
      apply(
        ctx,
        {
          type: 'setMarks',
          inUs: playhead,
          outUs: marks.outUs !== null && marks.outUs > playhead ? marks.outUs : null,
        },
        command,
      );
      return;
    case 'mark-out':
      apply(
        ctx,
        {
          type: 'setMarks',
          inUs: marks.inUs !== null && marks.inUs < playhead ? marks.inUs : null,
          outUs: playhead,
        },
        command,
      );
      return;
    case 'clear-marks':
      apply(ctx, { type: 'setMarks', inUs: null, outUs: null }, command);
      return;
    case 'cut-range':
      if (marks.inUs === null || marks.outUs === null) {
        ui.setStatus('Set an In and an Out mark first (I and O).');
        return;
      }
      if (apply(ctx, { type: 'cutRange', inUs: marks.inUs, outUs: marks.outUs }, command)) {
        ui.select([]);
        ui.setPlayhead(marks.inUs);
      }
      return;
    default:
      return;
  }
}
