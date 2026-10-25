/**
 * Undo/redo history of Immer patches for the project document (§1.7 "Undo", R1.43).
 *
 * - Each entry holds the forward patches and inverse patches of one user-visible step.
 * - **Coalescing:** an edit is merged into the previous entry when both carry the same
 *   `coalesceKey` and arrive within `coalesceMs` of each other (a slider being dragged, repeated
 *   nudges), or when both happen inside one open gesture (`beginGesture` … `endGesture`: one
 *   drag is one step, whatever it changes). `seal()` stops the top entry from absorbing more.
 * - At least 200 steps (default 500); the oldest entries are dropped beyond the limit.
 * - In memory only.
 */
import { applyPatches, type Patch } from 'immer';
import type { ProjectV1 } from '../../../shared/project/schema';

export const DEFAULT_HISTORY_LIMIT = 500;
export const MIN_HISTORY_LIMIT = 200;
export const DEFAULT_COALESCE_MS = 600;

export interface HistoryEntry {
  /** Short description for menus ("Split", "Move clip"). */
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  coalesceKey: string | null;
  /** Gesture this entry belongs to, if any. */
  gesture: number | null;
  /** Time of the latest edit merged into the entry (ms). */
  at: number;
  /** A sealed entry never absorbs later edits. */
  sealed: boolean;
}

export interface HistoryOptions {
  limit?: number;
  coalesceMs?: number;
  now?: () => number;
}

export interface RecordInput {
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  coalesceKey?: string | null;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private gesture: number | null = null;
  private gestureCounter = 0;
  private readonly limit: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;

  constructor(options: HistoryOptions = {}) {
    this.limit = Math.max(MIN_HISTORY_LIMIT, options.limit ?? DEFAULT_HISTORY_LIMIT);
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.now = options.now ?? Date.now;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  get size(): number {
    return this.undoStack.length;
  }

  get inGesture(): boolean {
    return this.gesture !== null;
  }

  /** Starts a gesture: every edit until `endGesture` becomes one step. */
  beginGesture(): void {
    this.seal();
    this.gesture = ++this.gestureCounter;
  }

  endGesture(): void {
    this.gesture = null;
    this.seal();
  }

  /** Stops the newest entry from absorbing further edits. */
  seal(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.sealed = true;
  }

  record(input: RecordInput): void {
    if (input.patches.length === 0) return;
    const at = this.now();
    const key = input.coalesceKey ?? null;
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    const sameGesture = top !== undefined && this.gesture !== null && top.gesture === this.gesture;
    const sameKey =
      top !== undefined &&
      this.gesture === null &&
      top.gesture === null &&
      key !== null &&
      top.coalesceKey === key &&
      at - top.at <= this.coalesceMs;
    if (top && !top.sealed && (sameGesture || sameKey)) {
      top.patches = [...top.patches, ...input.patches];
      top.inversePatches = [...input.inversePatches, ...top.inversePatches];
      top.at = at;
      return;
    }
    this.undoStack.push({
      label: input.label,
      patches: input.patches,
      inversePatches: input.inversePatches,
      coalesceKey: key,
      gesture: this.gesture,
      at,
      sealed: false,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  /** Reverts the newest step; returns the restored document, or null when there is none. */
  undo(doc: ProjectV1): ProjectV1 | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    entry.sealed = true;
    this.redoStack.push(entry);
    return applyPatches(doc, entry.inversePatches);
  }

  /** Re-applies the newest undone step; returns the document, or null when there is none. */
  redo(doc: ProjectV1): ProjectV1 | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return applyPatches(doc, entry.patches);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
  }
}
