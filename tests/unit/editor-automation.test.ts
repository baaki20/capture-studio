/**
 * The editor's automation handler: assistant edits go through the document store as one undo
 * step, with versions, dry runs, conflicts and error codes the socket can pass on.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  connectEditorAutomation,
  createAutomationHandler,
  type AutomationDeps,
} from '../../src/renderer/editor/automation';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import {
  EDITOR_AUTOMATION_COMMANDS,
  type EditorAutomationReply,
  type EditorAutomationRequest,
} from '../../src/shared/ipc/editor-automation';
import { counterIds, recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;

function setup(overrides: Partial<AutomationDeps> = {}) {
  const docStore = createDocumentStore({ opOptions: { generateId: counterIds('A') } });
  docStore.getState().load({ doc: recordedProject(), revision: 0, mediaUrls: {}, readOnly: false });
  const flush = vi.fn(() => Promise.resolve());
  const handler = createAutomationHandler({
    docStore,
    autosave: { flush },
    capture: () => Promise.resolve(null),
    ...overrides,
  });
  return { docStore, handler, flush };
}

describe('editor automation handler', () => {
  it('applies a batch as one labelled undo step and reports what changed', async () => {
    const { docStore, handler } = setup();
    const before = docStore.getState().doc!;
    const voice = trackByName(before, 'Voice').id;
    const result = await handler.handle('apply', {
      label: 'Trim the start',
      ops: [
        { type: 'cutRange', inUs: 0, outUs: 3 * S },
        { type: 'setGain', trackId: voice, gainDb: 30 },
      ],
    });
    expect(result.ok).toBe(true);
    const value = EDITOR_AUTOMATION_COMMANDS.apply.response.parse(result.ok && result.value);
    expect(value).toMatchObject({ applied: true, version: 1, undoLabel: 'Trim the start' });
    expect(value.change.duration.deltaSeconds).toBe(-3);
    // The clamped gain is what gets reported.
    expect(value.change.lines).toContain('Track "Voice": gainDb 0 → 12');
    expect(docStore.getState().undoLabel).toBe('Trim the start');
    expect(docStore.getState().notice).toMatchObject({ kind: 'assistant' });

    const undone = await handler.handle('undo', {});
    expect(undone.ok && undone.value).toMatchObject({
      done: true,
      label: 'Trim the start',
      version: 2,
    });
    expect(docStore.getState().doc).toEqual(before);
    const redone = await handler.handle('redo', {});
    expect(redone.ok && redone.value).toMatchObject({ done: true, version: 3 });
    const nothing = await handler.handle('redo', {});
    expect(nothing.ok && nothing.value).toMatchObject({ done: false, label: null });
  });

  it('dry runs change nothing', async () => {
    const { docStore, handler } = setup();
    const before = docStore.getState().doc;
    const result = await handler.handle('apply', {
      label: 'Preview',
      dryRun: true,
      ops: [{ type: 'cutRange', inUs: 0, outUs: 5 * S }],
    });
    expect(result.ok && result.value).toMatchObject({
      applied: false,
      version: 0,
      undoLabel: null,
    });
    expect(docStore.getState().doc).toBe(before);
    expect(docStore.getState().canUndo).toBe(false);
  });

  it('counts every document change as a version and refuses stale ifVersion', async () => {
    const { docStore, handler } = setup();
    const snapshot = await handler.handle('snapshot', {});
    expect(snapshot.ok && snapshot.value).toMatchObject({ version: 0, readOnly: false });
    // The user edits in between.
    docStore.getState().apply({ type: 'split', atUs: 10 * S });
    const stale = await handler.handle('apply', {
      label: 'Cut',
      ifVersion: 0,
      ops: [{ type: 'cutRange', inUs: 0, outUs: S }],
    });
    expect(!stale.ok && stale.error).toMatchObject({ code: 'conflict' });
    const fresh = await handler.handle('apply', {
      label: 'Cut',
      ifVersion: 1,
      ops: [{ type: 'cutRange', inUs: 0, outUs: S }],
    });
    expect(fresh.ok).toBe(true);
  });

  it('passes on refused operations, drags in progress and bad payloads', async () => {
    const { docStore, handler } = setup();
    const voice = trackByName(docStore.getState().doc!, 'Voice').id;
    const refused = await handler.handle('apply', {
      label: 'Hide',
      ops: [
        { type: 'setMuted', trackId: voice, muted: true },
        { type: 'setHidden', trackId: voice, hidden: true },
      ],
    });
    expect(!refused.ok && refused.error).toMatchObject({
      code: 'op-failed',
      details: { opCode: 'wrong-track-type', index: 1 },
    });

    docStore.getState().beginGesture();
    const busy = await handler.handle('apply', { label: 'x', ops: [{ type: 'split', atUs: S }] });
    expect(!busy.ok && busy.error.code).toBe('busy');
    docStore.getState().endGesture();

    const bad = await handler.handle('apply', {
      label: 'x',
      ops: [{ type: 'replaceDocument', doc: {} }],
    });
    expect(!bad.ok && bad.error.code).toBe('invalid-params');
  });

  it('flushes autosave and captures frames through its dependencies', async () => {
    const { handler, flush } = setup();
    const flushed = await handler.handle('flush', {});
    expect(flushed.ok && flushed.value).toEqual({ saveStatus: 'saved' });
    expect(flush).toHaveBeenCalledOnce();

    const notReady = await handler.handle('capture', { atUs: 0, maxWidth: 640 });
    expect(!notReady.ok && notReady.error.code).toBe('not-ready');

    const capture = vi.fn(() => Promise.resolve({ pngBase64: 'iVBOR', width: 640, height: 360 }));
    const withPreview = setup({ capture }).handler;
    const frame = await withPreview.handle('capture', { atUs: 5 * S, maxWidth: 640 });
    expect(frame.ok && frame.value).toEqual({
      pngBase64: 'iVBOR',
      width: 640,
      height: 360,
      atUs: 5 * S,
    });
    expect(capture).toHaveBeenCalledWith(5 * S, 640);
  });

  it('refuses edits on read-only projects', async () => {
    const docStore = createDocumentStore();
    docStore
      .getState()
      .load({ doc: recordedProject(), revision: 0, mediaUrls: {}, readOnly: true });
    const handler = createAutomationHandler({
      docStore,
      autosave: { flush: () => Promise.resolve() },
      capture: () => Promise.resolve(null),
    });
    const result = await handler.handle('apply', { label: 'x', ops: [{ type: 'split', atUs: S }] });
    expect(!result.ok && result.error.code).toBe('read-only');
  });
});

describe('connectEditorAutomation', () => {
  it('answers each request on automation.reply and announces readiness', async () => {
    let listener: ((request: EditorAutomationRequest) => void) | null = null;
    const replies: EditorAutomationReply[] = [];
    const ready = vi.fn(() => Promise.resolve());
    const api = {
      onRequest: (l: (request: EditorAutomationRequest) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
      reply: (reply: EditorAutomationReply) => {
        replies.push(reply);
        return Promise.resolve();
      },
      ready,
    };
    const { handler } = setup();
    const off = connectEditorAutomation(api, 'prj_X', handler);
    expect(ready).toHaveBeenCalledWith('prj_X');
    listener!({ requestId: 7, command: 'snapshot', payload: {} });
    listener!({ requestId: 8, command: 'undo', payload: { extra: 1 } });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies.find((r) => r.requestId === 7)).toMatchObject({ ok: true });
    expect(replies.find((r) => r.requestId === 8)).toMatchObject({
      ok: false,
      error: { code: 'invalid-params' },
    });
    off();
    expect(listener).toBeNull();
  });
});
