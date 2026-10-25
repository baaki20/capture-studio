/**
 * Autosave for the editor document (§1.7 "Autosave", R1.28).
 *
 * - Watches a `DocumentStore`; 1.5 s after the last edit (debounced) it calls `project.save`
 *   with the revision it last saved at. Main writes atomically, keeps `.bak` and a rolling copy
 *   in `backups/` (`main/projects/project-store.ts`).
 * - One save at a time; edits made during a save are saved by the next one.
 * - **Stale revision** (main or another window wrote the project since): the editor reloads the
 *   project from disk (`project.open`), replaces its document and clears undo history, and sets a
 *   `reloaded` notice that carries the replaced local version (`discardedDoc`), so the UI can
 *   offer "Restore my edits" (`restoreDiscarded()`).
 * - Other failures set `saveStatus: 'error'` with a notice and retry after `retryMs`.
 * - Read-only projects are never saved.
 * - `flush()` saves immediately (window close, before export); `dispose()` stops watching.
 *
 * Usage in the editor: `const autosave = startAutosave(store, window.csEditor.project)`.
 */
import { ipcErrorCode, ipcErrorMessage } from '../../../shared/ipc/errors';
import type { ProjectV1 } from '../../../shared/project/schema';
import type { DocumentStore, ProjectOpenResult, ProjectSaveRequest } from './document-store';

export const AUTOSAVE_DEBOUNCE_MS = 1_500;
export const AUTOSAVE_RETRY_MS = 5_000;

/** The parts of the editor preload's `project` API autosave uses. */
export interface AutosaveProjectApi {
  open(id: string): Promise<ProjectOpenResult>;
  save(request: ProjectSaveRequest): Promise<{ revision: number }>;
}

export interface AutosaveOptions {
  debounceMs?: number;
  retryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Whether a `project.save` rejection means the revision was stale. */
  isStaleRevision?: (error: unknown) => boolean;
}

export interface Autosave {
  /** Saves now if there are unsaved edits; resolves when the document on disk is current. */
  flush(): Promise<void>;
  dispose(): void;
}

/**
 * Main rejects a stale save with `ProjectStoreError('stale-revision', …)`; the IPC router carries
 * its code across in a structured envelope (`shared/ipc/errors.ts`).
 */
export function isStaleRevisionError(error: unknown): boolean {
  return ipcErrorCode(error) === 'stale-revision';
}

function errorMessage(error: unknown): string {
  return ipcErrorMessage(error);
}

export function startAutosave(
  store: DocumentStore,
  api: AutosaveProjectApi,
  options: AutosaveOptions = {},
): Autosave {
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const retryMs = options.retryMs ?? AUTOSAVE_RETRY_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const isStale = options.isStaleRevision ?? isStaleRevisionError;

  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const needsSave = () => {
    const s = store.getState();
    return s.doc !== null && s.projectId !== null && !s.readOnly && s.doc !== s.savedDoc;
  };

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = (ms: number) => {
    cancelTimer();
    if (disposed) return;
    timer = setTimer(() => {
      timer = null;
      void run();
    }, ms);
  };

  const saveOnce = async (): Promise<void> => {
    const state = store.getState();
    const { projectId, doc, revision } = state;
    if (!needsSave() || projectId === null || doc === null) return;
    state.markSaving();
    try {
      const saved = await api.save({ id: projectId, revision, doc });
      if (store.getState().projectId !== projectId) return;
      store.getState().markSaved(saved.revision, doc);
    } catch (error) {
      if (store.getState().projectId !== projectId) return;
      if (isStale(error)) {
        await reload(projectId);
      } else {
        store.getState().markSaveFailed(`Could not save the project: ${errorMessage(error)}`);
        schedule(retryMs);
      }
    }
  };

  const reload = async (projectId: string): Promise<void> => {
    const local: ProjectV1 | null = store.getState().doc;
    try {
      const open = await api.open(projectId);
      store.getState().reloadFromDisk(open, {
        kind: 'reloaded',
        message:
          'The project was changed outside this editor, so it was reloaded. Your unsaved edits can be restored.',
        ...(local ? { discardedDoc: local } : {}),
      });
    } catch (error) {
      store.getState().markSaveFailed(`Could not reload the project: ${errorMessage(error)}`);
      schedule(retryMs);
    }
  };

  const run = async (): Promise<void> => {
    if (inFlight) {
      await inFlight;
      if (needsSave()) return run();
      return;
    }
    cancelTimer();
    inFlight = saveOnce().finally(() => {
      inFlight = null;
    });
    await inFlight;
    // Edits made while saving are picked up by the subscription's debounce timer.
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.doc === previous.doc && state.savedDoc === previous.savedDoc) return;
    if (needsSave()) schedule(debounceMs);
    else cancelTimer();
  });

  return {
    async flush() {
      cancelTimer();
      await run();
      if (needsSave() && store.getState().saveStatus !== 'error') await run();
    },
    dispose() {
      disposed = true;
      cancelTimer();
      unsubscribe();
    },
  };
}
