/**
 * The editor's project-document store (§1.2 "UI state", §1.7 "Undo"): Zustand (vanilla, so it
 * works outside React) holding the current `Project`, with every edit going through the pure
 * operations in `shared/project/timeline-ops.ts` and recorded as Immer patches in `History`.
 *
 * For the timeline, inspector and preview builders:
 * - `createDocumentStore(options?)` returns a `DocumentStore` (a Zustand `StoreApi`); create one
 *   per editor window and pass it down (context). In React, read it with
 *   `useDocumentStore(store, selector)`.
 * - `store.getState().load(openResult)` after `project.open`.
 * - `apply(op, { coalesceKey?, label? })` performs a `TimelineOp`; it returns the op's `Result`,
 *   and a refused op also lands in `lastError` for a status line. A no-op records nothing.
 * - Wrap pointer drags in `beginGesture()` / `endGesture()`, so a whole drag is one undo step
 *   (R1.43). Without a gesture, repeated edits with the same coalesce key (default: per clip for
 *   move/trim, per track for gain and layout, per target for nudge) within 600 ms merge.
 * - `undo()` / `redo()` return whether anything changed; `canUndo`, `canRedo`, `undoLabel`,
 *   `redoLabel` are in the state for menus.
 * - Saving is done by `autosave.ts`, which calls `markSaving`, `markSaved`, `markSaveFailed` and
 *   `reloadFromDisk`. After a conflict reload, `notice.discardedDoc` holds the local version and
 *   `restoreDiscarded()` re-applies it as one undoable step (it is then saved normally).
 * - `applyBatch(ops, { label })` performs several operations as one undo step, all or nothing
 *   (assistant edits through the automation socket). It refuses with `busy` during a gesture.
 * - Read-only projects (newer format, R1.30) refuse every edit with `read-only`.
 */
import { createStore, useStore, type StoreApi } from 'zustand';
import type { InvokeRequest, InvokeResponse } from '../../../shared/ipc/contract';
import {
  applyOpWithPatches,
  applyOpsWithPatches,
  type BatchOpError,
  type OpError,
  type OpOptions,
  type TimelineOp,
  type TimelineOpType,
} from '../../../shared/project/timeline-ops';
import type { Project } from '../../../shared/project/schema';
import { err, ok, type Result } from '../../../shared/result';
import { History, type HistoryOptions } from './history';

/** What `project.open` returns. */
export type ProjectOpenResult = InvokeResponse<'project.open'>;
/** What `project.save` takes. */
export type ProjectSaveRequest = InvokeRequest<'project.save'>;

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'read-only';

export type EditError = OpError | { code: 'read-only' | 'no-document'; message: string };

/** Why `applyBatch` refused: an operation failed, or the user is mid-drag (`busy`). */
export type BatchEditError = EditError | BatchOpError | { code: 'busy'; message: string };

export interface EditorNotice {
  /** `assistant`: an edit arrived through the automation socket. */
  kind: 'reloaded' | 'save-failed' | 'assistant';
  message: string;
  /** For `reloaded`: the local version that was replaced by the one on disk. */
  discardedDoc?: Project;
}

export interface ApplyOptions {
  /** Edits with the same key in quick succession merge into one undo step. */
  coalesceKey?: string | null;
  /** Undo menu label; defaults to one per operation type. */
  label?: string;
}

export interface DocumentState {
  projectId: string | null;
  doc: Project | null;
  /** The `project.save` revision the current `savedDoc` corresponds to. */
  revision: number;
  /** The document last confirmed on disk (reference-compare with `doc` for "dirty"). */
  savedDoc: Project | null;
  readOnly: boolean;
  mediaUrls: Record<string, string>;
  saveStatus: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  lastError: EditError | null;
  notice: EditorNotice | null;
}

export interface DocumentActions {
  load(open: ProjectOpenResult): void;
  apply(op: TimelineOp, options?: ApplyOptions): Result<Project, EditError>;
  applyBatch(
    ops: readonly TimelineOp[],
    options: { label: string },
  ): Result<Project, BatchEditError>;
  /** Shows an `assistant` notice unless a more important one (reload, save failure) is up. */
  showAssistantNotice(message: string): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): boolean;
  redo(): boolean;
  clearError(): void;
  dismissNotice(): void;
  restoreDiscarded(): Result<Project, EditError>;
  markSaving(): void;
  markSaved(revision: number, savedDoc: Project): void;
  markSaveFailed(message: string): void;
  reloadFromDisk(open: ProjectOpenResult, notice: EditorNotice): void;
}

export type DocumentStoreState = DocumentState & DocumentActions;
export type DocumentStore = StoreApi<DocumentStoreState>;

export interface DocumentStoreOptions {
  history?: HistoryOptions;
  /** Passed to every operation (inject a deterministic ID source in tests). */
  opOptions?: OpOptions;
}

export const OP_LABELS: Record<TimelineOpType, string> = {
  split: 'Split',
  trim: 'Trim clip',
  move: 'Move clip',
  delete: 'Delete',
  rippleDelete: 'Ripple delete',
  cutRange: 'Cut range',
  setGain: 'Change volume',
  setMuted: 'Mute',
  setSolo: 'Solo',
  setHidden: 'Hide track',
  setLocked: 'Lock track',
  setLayout: 'Change layout',
  setLayoutKeyframe: 'Change layout keyframe',
  removeLayoutKeyframe: 'Delete layout keyframe',
  moveLayoutKeyframe: 'Move layout keyframe',
  setFaceMode: 'Change face mode',
  setBeautify: 'Change background',
  setCameraKeyframe: 'Change zoom keyframe',
  removeCameraKeyframe: 'Delete zoom keyframe',
  moveCameraKeyframe: 'Move zoom keyframe',
  setCameraZoom: 'Zoom range',
  nudge: 'Sync nudge',
  unlink: 'Unlink',
  relink: 'Link',
  setMarks: 'Set marks',
  replaceDocument: 'Restore edits',
};

/** Default coalesce key: repeated edits of the same thing merge (drags, sliders, nudges). */
export function defaultCoalesceKey(op: TimelineOp): string | null {
  switch (op.type) {
    case 'move':
      return `move:${op.clipId}`;
    case 'trim':
      return `trim:${op.clipId}:${op.edge}`;
    case 'setGain':
      return `gain:${op.trackId}`;
    case 'setLayout':
      return `layout:${op.trackId}`;
    case 'setLayoutKeyframe':
      return `layout-key:${op.trackId}:${String(op.tUs)}`;
    case 'setBeautify':
      return 'beautify';
    case 'setCameraKeyframe':
      return `camera-key:${String(op.tUs)}`;
    case 'nudge':
      return `nudge:${JSON.stringify(op.target)}`;
    case 'setMarks':
      return 'marks';
    default:
      return null;
  }
}

const EMPTY: DocumentState = {
  projectId: null,
  doc: null,
  revision: 0,
  savedDoc: null,
  readOnly: false,
  mediaUrls: {},
  saveStatus: 'saved',
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  lastError: null,
  notice: null,
};

export function createDocumentStore(options: DocumentStoreOptions = {}): DocumentStore {
  const history = new History(options.history);

  return createStore<DocumentStoreState>()((set, get) => {
    const historyState = () => ({
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    });
    const statusFor = (doc: Project | null, savedDoc: Project | null, readOnly: boolean) =>
      readOnly ? 'read-only' : doc === savedDoc ? 'saved' : 'pending';

    const opened = (open: ProjectOpenResult): Partial<DocumentState> => {
      history.clear();
      return {
        projectId: open.doc.id,
        doc: open.doc,
        savedDoc: open.doc,
        revision: open.revision,
        readOnly: open.readOnly,
        mediaUrls: open.mediaUrls,
        saveStatus: open.readOnly ? 'read-only' : 'saved',
        lastError: null,
        ...historyState(),
      };
    };

    /** The document when edits are allowed, else why not. */
    const editable = (): Result<Project, EditError> => {
      const { doc, readOnly } = get();
      if (!doc) return err({ code: 'no-document', message: 'no project is open' });
      if (readOnly) {
        return err({
          code: 'read-only',
          message: 'this project was made by a newer version and opens read-only',
        });
      }
      return ok(doc);
    };

    const apply = (op: TimelineOp, applyOptions: ApplyOptions = {}) => {
      const target = editable();
      if (!target.ok) {
        set({ lastError: target.error });
        return target;
      }
      const doc = target.value;
      const result = applyOpWithPatches(doc, op, options.opOptions);
      if (!result.ok) {
        set({ lastError: result.error });
        return result;
      }
      const { doc: next, patches, inversePatches } = result.value;
      if (patches.length === 0) return ok(doc);
      history.record({
        label: applyOptions.label ?? OP_LABELS[op.type],
        patches,
        inversePatches,
        coalesceKey:
          applyOptions.coalesceKey === undefined
            ? defaultCoalesceKey(op)
            : applyOptions.coalesceKey,
      });
      set({
        doc: next,
        lastError: null,
        saveStatus: statusFor(next, get().savedDoc, false),
        ...historyState(),
      });
      return ok(next);
    };

    // Errors go back to the caller (the assistant), not to the status line.
    const applyBatch = (
      ops: readonly TimelineOp[],
      batchOptions: { label: string },
    ): Result<Project, BatchEditError> => {
      const target = editable();
      if (!target.ok) return target;
      if (history.inGesture) {
        return err({ code: 'busy', message: 'the user is dragging in the editor' });
      }
      const doc = target.value;
      const result = applyOpsWithPatches(doc, ops, options.opOptions);
      if (!result.ok) return result;
      const { doc: next, patches, inversePatches } = result.value;
      if (patches.length === 0) return ok(doc);
      // A null coalesce key never merges, so the batch stays its own undo step.
      history.record({ label: batchOptions.label, patches, inversePatches, coalesceKey: null });
      history.seal();
      set({
        doc: next,
        saveStatus: statusFor(next, get().savedDoc, false),
        ...historyState(),
      });
      return ok(next);
    };

    const step = (direction: 'undo' | 'redo'): boolean => {
      const { doc, readOnly, savedDoc } = get();
      if (!doc || readOnly) return false;
      const next = direction === 'undo' ? history.undo(doc) : history.redo(doc);
      if (!next) return false;
      set({ doc: next, saveStatus: statusFor(next, savedDoc, false), ...historyState() });
      return true;
    };

    return {
      ...EMPTY,
      load: (open) => {
        set({ ...opened(open), notice: null });
      },
      apply,
      applyBatch,
      showAssistantNotice: (message) => {
        const current = get().notice;
        if (current && current.kind !== 'assistant') return;
        set({ notice: { kind: 'assistant', message } });
      },
      beginGesture: () => {
        history.beginGesture();
      },
      endGesture: () => {
        history.endGesture();
      },
      undo: () => step('undo'),
      redo: () => step('redo'),
      clearError: () => {
        set({ lastError: null });
      },
      dismissNotice: () => {
        set({ notice: null });
      },
      restoreDiscarded: () => {
        const discarded = get().notice?.discardedDoc;
        if (!discarded) {
          return err<EditError>({ code: 'no-document', message: 'nothing to restore' });
        }
        const result = apply({ type: 'replaceDocument', doc: discarded }, { coalesceKey: null });
        if (result.ok) set({ notice: null });
        return result;
      },
      markSaving: () => {
        if (!get().readOnly) set({ saveStatus: 'saving' });
      },
      markSaved: (revision, savedDoc) => {
        const { doc, readOnly } = get();
        set({ revision, savedDoc, saveStatus: statusFor(doc, savedDoc, readOnly) });
      },
      markSaveFailed: (message) => {
        set({ saveStatus: 'error', notice: { kind: 'save-failed', message } });
      },
      reloadFromDisk: (open, notice) => {
        set({ ...opened(open), notice });
      },
    };
  });
}

/** React binding: `useDocumentStore(store, (s) => s.doc)`. */
export function useDocumentStore<T>(
  store: DocumentStore,
  selector: (state: DocumentStoreState) => T,
): T {
  return useStore(store, selector);
}
