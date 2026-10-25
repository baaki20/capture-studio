/**
 * Editor document layer (step 14): history with coalescing, the Zustand document store, and
 * autosave with revision checks (§1.7, R1.28, R1.43).
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_DEBOUNCE_MS,
  isStaleRevisionError,
  startAutosave,
  type AutosaveProjectApi,
} from '../../src/renderer/editor/store/autosave';
import {
  createDocumentStore,
  type DocumentStore,
  type ProjectOpenResult,
  type ProjectSaveRequest,
} from '../../src/renderer/editor/store/document-store';
import { History, MIN_HISTORY_LIMIT } from '../../src/renderer/editor/store/history';
import { toIpcError } from '../../src/main/ipc/router';
import { ProjectStoreError } from '../../src/main/projects/project-store';
import { encodeIpcError } from '../../src/shared/ipc/errors';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { applyOpWithPatches, clipEndUs } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import {
  arbOpTemplate,
  arbRecordedProject,
  counterIds,
  recordedProject,
  resolveOp,
  trackByName,
} from '../fixtures/editor-project';

const S = 1_000_000;

function openResult(doc: ProjectV1, revision = 0, readOnly = false): ProjectOpenResult {
  return { doc, revision, mediaUrls: {}, readOnly };
}

function loadedStore(doc = recordedProject(), now?: () => number): DocumentStore {
  const store = createDocumentStore({
    opOptions: { generateId: counterIds('U') },
    history: now ? { now } : {},
  });
  store.getState().load(openResult(doc));
  return store;
}

function audioGain(doc: ProjectV1 | null, name: string): number {
  if (!doc) return NaN;
  const track = trackByName(doc, name);
  return track.type === 'audio' ? track.gainDb : NaN;
}

describe('History', () => {
  it('keeps at least 200 steps', () => {
    const history = new History({ limit: 10 });
    const doc = recordedProject();
    const voice = trackByName(doc, 'Voice').id;
    let current = doc;
    for (let i = 0; i < 250; i++) {
      const r = unwrap(
        applyOpWithPatches(current, { type: 'setGain', trackId: voice, gainDb: -(i % 60) - 0.5 }),
      );
      history.record({ label: 'Gain', ...r });
      current = r.doc;
    }
    expect(history.size).toBe(MIN_HISTORY_LIMIT);
  });

  it('ignores empty patch lists', () => {
    const history = new History();
    history.record({ label: 'x', patches: [], inversePatches: [] });
    expect(history.canUndo).toBe(false);
  });
});

describe('document store', () => {
  it('applies operations and undoes and redoes them', () => {
    const store = loadedStore();
    const initial = store.getState().doc;
    const face = trackByName(initial!, 'Face').clips[0]!;
    const result = store.getState().apply({ type: 'split', atUs: 10 * S, clipIds: [face.id] });
    expect(result.ok).toBe(true);
    const split = store.getState().doc!;
    expect(trackByName(split, 'Face').clips).toHaveLength(3);
    expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'Split' });
    expect(store.getState().saveStatus).toBe('pending');

    expect(store.getState().undo()).toBe(true);
    expect(store.getState().doc).toEqual(initial);
    expect(store.getState()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: 'Split' });
    expect(store.getState().redo()).toBe(true);
    expect(store.getState().doc).toEqual(split);
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().undo()).toBe(false);
  });

  it('records refused operations as lastError and no history', () => {
    const store = loadedStore();
    const r = store.getState().apply({ type: 'split', atUs: 900 * S });
    expect(r.ok).toBe(false);
    expect(store.getState().lastError?.code).toBe('nothing-to-do');
    expect(store.getState().canUndo).toBe(false);
    store.getState().clearError();
    expect(store.getState().lastError).toBeNull();
  });

  it('does not record a no-op', () => {
    const store = loadedStore();
    const doc = store.getState().doc!;
    const face = trackByName(doc, 'Face').clips[0]!;
    store.getState().apply({ type: 'trim', clipId: face.id, edge: 'end', toUs: clipEndUs(face) });
    expect(store.getState().canUndo).toBe(false);
    expect(store.getState().doc).toBe(doc);
  });

  it('makes one drag one undo step (gesture)', () => {
    const store = loadedStore();
    const doc = store.getState().doc!;
    const face = trackByName(doc, 'Face').clips[0]!;
    store.getState().beginGesture();
    for (const t of [15, 14, 12, 10]) {
      store.getState().apply({ type: 'trim', clipId: face.id, edge: 'end', toUs: t * S });
    }
    store.getState().apply({ type: 'move', clipId: face.id, toStartUs: 1 * S });
    store.getState().endGesture();
    store.getState().apply({ type: 'trim', clipId: face.id, edge: 'end', toUs: 8 * S });
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().doc).toEqual(doc);
    expect(store.getState().canUndo).toBe(false);
  });

  it('coalesces rapid same-kind edits but not slow or different ones', () => {
    let now = 0;
    const store = loadedStore(recordedProject(), () => now);
    const doc = store.getState().doc!;
    const voice = trackByName(doc, 'Voice').id;
    const system = trackByName(doc, 'System audio').id;
    for (const db of [-1, -2, -3]) {
      now += 100;
      store.getState().apply({ type: 'setGain', trackId: voice, gainDb: db });
    }
    now += 100;
    store.getState().apply({ type: 'setGain', trackId: system, gainDb: -4 });
    now += 5_000;
    store.getState().apply({ type: 'setGain', trackId: voice, gainDb: -9 });

    store.getState().undo();
    expect(audioGain(store.getState().doc, 'Voice')).toBe(-3);
    store.getState().undo();
    expect(audioGain(store.getState().doc, 'System audio')).toBe(0);
    store.getState().undo();
    expect(audioGain(store.getState().doc, 'Voice')).toBe(0);
    expect(store.getState().canUndo).toBe(false);
  });

  it('refuses edits on a read-only project', () => {
    const store = createDocumentStore();
    store.getState().load(openResult(recordedProject(), 0, true));
    const r = store.getState().apply({ type: 'split', atUs: 10 * S });
    expect(!r.ok && r.error.code).toBe('read-only');
    expect(store.getState().saveStatus).toBe('read-only');
    const empty = createDocumentStore();
    expect(empty.getState().apply({ type: 'split', atUs: 0 }).ok).toBe(false);
  });

  it('undo followed by redo is the identity (property)', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.array(arbOpTemplate, { minLength: 1, maxLength: 20 }),
        (initial, templates) => {
          const store = createDocumentStore({ opOptions: { generateId: counterIds('Q') } });
          store.getState().load(openResult(initial));
          const docs: ProjectV1[] = [initial];
          for (const template of templates) {
            const state = store.getState();
            state.beginGesture();
            const result = state.apply(resolveOp(state.doc!, template));
            state.endGesture();
            if (result.ok && result.value !== docs[docs.length - 1]) docs.push(result.value);
          }
          const final = store.getState().doc;
          for (let i = docs.length - 1; i > 0; i--) {
            expect(store.getState().undo()).toBe(true);
            expect(store.getState().doc).toEqual(docs[i - 1]);
          }
          expect(store.getState().undo()).toBe(false);
          for (let i = 1; i < docs.length; i++) expect(store.getState().redo()).toBe(true);
          expect(store.getState().doc).toEqual(final);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fake `project.save`/`project.open` backend with main's revision rule. */
  function api() {
    let revision = 0;
    const saved: { revision: number; doc: ProjectV1 }[] = [];
    const backend = (request: ProjectSaveRequest): Promise<{ revision: number }> => {
      if (request.revision !== revision) {
        return Promise.reject(
          new Error(
            encodeIpcError({
              code: 'stale-revision',
              message: `project x: revision ${String(request.revision)} is stale`,
            }),
          ),
        );
      }
      revision += 1;
      saved.push({ revision, doc: request.doc });
      return Promise.resolve({ revision });
    };
    const save = vi.fn<AutosaveProjectApi['save']>(backend);
    const open = vi.fn<AutosaveProjectApi['open']>(() =>
      Promise.resolve(openResult(recordedProject(), revision)),
    );
    const impl: AutosaveProjectApi = { save: (r) => save(r), open: (id) => open(id) };
    return {
      impl,
      save,
      open,
      backend,
      saved,
      bump: () => {
        revision += 1;
      },
    };
  }

  function gainEdit(store: DocumentStore, db: number) {
    const voice = trackByName(store.getState().doc!, 'Voice').id;
    store.getState().apply({ type: 'setGain', trackId: voice, gainDb: db });
  }

  it('saves once, 1.5 s after the last of several edits (within 2 s, R1.28)', async () => {
    const store = loadedStore();
    const { impl, save, saved } = api();
    const autosave = startAutosave(store, impl);
    gainEdit(store, -1);
    await vi.advanceTimersByTimeAsync(1_000);
    gainEdit(store, -2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saved[0]?.doc).toBe(store.getState().doc);
    expect(store.getState()).toMatchObject({ revision: 1, saveStatus: 'saved' });
    expect(store.getState().savedDoc).toBe(store.getState().doc);
    // A further edit saves again with the new revision.
    gainEdit(store, -3);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }));
    autosave.dispose();
  });

  it('saves edits made during a save with the next revision', async () => {
    const store = loadedStore();
    const gate = { release: () => undefined as unknown };
    const { impl, save, backend } = api();
    save.mockImplementation(async (request) => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return backend(request);
    });
    const autosave = startAutosave(store, impl);
    gainEdit(store, -1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(store.getState().saveStatus).toBe('saving');
    gainEdit(store, -2);
    gate.release();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    gate.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }));
    expect(store.getState().saveStatus).toBe('saved');
    expect(audioGain(store.getState().savedDoc, 'Voice')).toBe(-2);
    autosave.dispose();
  });

  it('reloads and notifies on a stale revision, offering to restore the local edits', async () => {
    const store = loadedStore();
    const { impl, save, open, bump } = api();
    const autosave = startAutosave(store, impl);
    bump(); // Main wrote the project (rename, recovery…).
    gainEdit(store, -7);
    const local = store.getState().doc;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(open).toHaveBeenCalledTimes(1);
    const state = store.getState();
    expect(state.notice?.kind).toBe('reloaded');
    expect(state.notice?.discardedDoc).toBe(local);
    expect(state.revision).toBe(1);
    expect(state.canUndo).toBe(false);
    expect(audioGain(state.doc, 'Voice')).toBe(0);

    // Restoring re-applies the local version and saves it at the new revision.
    expect(store.getState().restoreDiscarded().ok).toBe(true);
    expect(audioGain(store.getState().doc, 'Voice')).toBe(-7);
    expect(store.getState().notice).toBeNull();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }));
    expect(store.getState().saveStatus).toBe('saved');
    autosave.dispose();
  });

  it('reports other failures and retries', async () => {
    const store = loadedStore();
    const { impl, save, backend } = api();
    save.mockImplementationOnce(() => Promise.reject(new Error('EIO: disk on fire')));
    save.mockImplementation(backend);
    const autosave = startAutosave(store, impl, { retryMs: 3_000 });
    gainEdit(store, -1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(store.getState().saveStatus).toBe('error');
    expect(store.getState().notice?.message).toContain('EIO');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(store.getState().saveStatus).toBe('saved');
    autosave.dispose();
  });

  it('flushes immediately and never saves read-only projects', async () => {
    const store = loadedStore();
    const first = api();
    const autosave = startAutosave(store, first.impl);
    gainEdit(store, -1);
    await autosave.flush();
    expect(first.save).toHaveBeenCalledTimes(1);
    autosave.dispose();

    const readOnly = createDocumentStore();
    readOnly.getState().load(openResult(recordedProject(), 0, true));
    const other = api();
    const autosave2 = startAutosave(readOnly, other.impl);
    await autosave2.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(other.save).not.toHaveBeenCalled();
    autosave2.dispose();
  });

  it('recognizes the stale-revision rejection from main by its code, not its wording', () => {
    const fromMain = toIpcError(
      new ProjectStoreError('stale-revision', 'project prj_x: revision 3 is stale (current 4)'),
    ) as Error;
    // What ipcRenderer.invoke rejects with in the renderer.
    const remote = new Error(
      `Error invoking remote method 'project.save': Error: ${fromMain.message}`,
    );
    expect(isStaleRevisionError(remote)).toBe(true);
    // Wording alone is not enough, and other codes are not stale.
    expect(isStaleRevisionError(new Error('project prj_x: revision 3 is stale'))).toBe(false);
    expect(
      isStaleRevisionError(new Error(encodeIpcError({ code: 'read-only', message: 'is stale' }))),
    ).toBe(false);
    expect(isStaleRevisionError(new Error('EIO'))).toBe(false);
  });
});
