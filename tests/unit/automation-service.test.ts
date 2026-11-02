/**
 * The automation methods, wired to a real editor automation handler (document store, history)
 * through a fake link, so a request runs the same code as in the app without Electron.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AutomationService,
  type AutomationServiceDeps,
} from '../../src/main/automation/automation-service';
import { EditorLinkError, type EditorLink } from '../../src/main/automation/editor-link';
import type { ExportJobEvent } from '../../src/main/ipc/export-handlers';
import { createAutomationHandler } from '../../src/renderer/editor/automation';
import { createDocumentStore } from '../../src/renderer/editor/store/document-store';
import {
  EDITOR_AUTOMATION_COMMANDS,
  type EditorAutomationCommand,
} from '../../src/shared/ipc/editor-automation';
import { PEAK_WINDOW_US } from '../../src/shared/project/peaks';
import type { ProjectV1 } from '../../src/shared/project/schema';
import { counterIds, recordedProject } from '../fixtures/editor-project';

const S = 1_000_000;
const OPTIONS = { resolution: '720p', fps: 30, quality: 'draft', encoder: 'auto' } as const;

/** An editor window: a real document store and automation handler behind a link. */
function fakeEditor(doc: ProjectV1, readOnly = false) {
  const docStore = createDocumentStore({ opOptions: { generateId: counterIds('E') } });
  docStore.getState().load({ doc, revision: 0, mediaUrls: {}, readOnly });
  const handler = createAutomationHandler({
    docStore,
    autosave: { flush: () => Promise.resolve() },
    capture: () => Promise.resolve({ pngBase64: 'iVBOR', width: 320, height: 180 }),
  });
  const link = {
    command: async (command: EditorAutomationCommand, payload: unknown) => {
      const result = await handler.handle(command, payload);
      if (!result.ok) {
        throw new EditorLinkError(result.error.code, result.error.message, result.error.details);
      }
      return EDITOR_AUTOMATION_COMMANDS[command].response.parse(result.value);
    },
  } as unknown as EditorLink;
  return { docStore, link };
}

/** Peaks for an audio media: loud except inside `quiet` (file-local µs). */
function peaksBytes(durationUs: number, quiet: [number, number][]): ArrayBuffer {
  const pairs = Math.ceil(durationUs / PEAK_WINDOW_US);
  const out = new Int16Array(pairs * 2);
  for (let i = 0; i < pairs; i++) {
    const t = i * PEAK_WINDOW_US;
    const level = quiet.some(([a, b]) => t >= a && t < b) ? 20 : 15_000;
    out[i * 2] = -level;
    out[i * 2 + 1] = level;
  }
  return out.buffer;
}

function setup(options: { doc?: ProjectV1; readOnly?: boolean } = {}) {
  const doc = options.doc ?? recordedProject({ pauses: [] });
  const editors = new Map<string, ReturnType<typeof fakeEditor>>();
  const listeners = new Set<(event: ExportJobEvent) => void>();
  const peaks = new Map<
    string,
    { status: 'ready' | 'pending' | 'unavailable'; bytes?: ArrayBuffer }
  >();
  const ensure = vi.fn((projectId: string) => {
    if (projectId !== doc.id)
      return Promise.reject(new EditorLinkError('editor-unavailable', 'no'));
    let editor = editors.get(projectId);
    if (!editor) {
      editor = fakeEditor(doc, options.readOnly);
      editors.set(projectId, editor);
    }
    return Promise.resolve(editor.link);
  });
  const startExport = vi.fn((_request: { projectId: string; doc?: ProjectV1 }) =>
    Promise.resolve({
      jobId: 'job_01',
      status: 'started' as const,
      path: '/exports/Lesson test.mp4',
      message: null,
    }),
  );
  const cancelExport = vi.fn();
  const deps: AutomationServiceDeps = {
    appVersion: '0.1.0',
    listProjects: () =>
      Promise.resolve([
        {
          id: doc.id,
          name: doc.name,
          createdAt: doc.createdAt,
          durationUs: 60 * S,
          components: ['screen'],
          thumbUrl: null,
          state: 'complete',
        },
      ]),
    openProjects: () => [...editors.keys()],
    readProject: (id) =>
      Promise.resolve(id === doc.id ? { doc, readOnly: options.readOnly ?? false } : null),
    editors: { live: (id) => editors.get(id)?.link ?? null, ensure },
    peaksFile: (_projectId, mediaId) => {
      const entry = peaks.get(mediaId);
      return Promise.resolve(
        entry?.status === 'ready'
          ? { status: 'ready', path: mediaId }
          : { status: entry?.status ?? 'unavailable', path: null },
      );
    },
    readFile: (file) => Promise.resolve(peaks.get(file)?.bytes ?? new ArrayBuffer(0)),
    exports: {
      start: startExport,
      cancel: cancelExport,
      onJobEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const service = new AutomationService(deps);
  const emit = (event: ExportJobEvent) => {
    for (const l of listeners) l(event);
  };
  return {
    doc,
    deps,
    service,
    editors,
    ensure,
    peaks,
    emit,
    startExport,
    cancelExport,
    h: service.handlers,
  };
}

describe('AutomationService', () => {
  it('lists projects with whether they are open', async () => {
    const { h, doc } = setup();
    const { projects } = await h['projects.list']({});
    expect(projects).toEqual([
      expect.objectContaining({ id: doc.id, name: 'Lesson test', state: 'complete', open: false }),
    ]);
  });

  it('reads the saved project without opening an editor, and dry runs without one too', async () => {
    const { h, doc, ensure } = setup();
    const got = await h['project.get']({ projectId: doc.id });
    expect(got).toMatchObject({ version: 0, live: false, readOnly: false });
    const dry = await h['project.edit']({
      projectId: doc.id,
      label: 'Preview',
      dryRun: true,
      ops: [{ type: 'cutRange', inUs: 0, outUs: 3 * S }],
    });
    expect(dry).toMatchObject({ applied: false, undoLabel: null });
    expect(dry.change.duration.deltaSeconds).toBe(-3);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('edits in the editor (opening it), then reads live and undoes', async () => {
    const { h, doc, ensure, editors } = setup();
    const edit = await h['project.edit']({
      projectId: doc.id,
      label: 'Cut the intro',
      ifVersion: 0,
      ops: [{ type: 'cutRange', inUs: 0, outUs: 3 * S }],
    });
    expect(ensure).toHaveBeenCalledWith(doc.id);
    expect(edit).toMatchObject({ applied: true, version: 1, undoLabel: 'Cut the intro' });
    expect(editors.get(doc.id)?.docStore.getState().undoLabel).toBe('Cut the intro');

    const live = await h['project.get']({ projectId: doc.id });
    expect(live).toMatchObject({ live: true, version: 1 });

    const undone = await h['project.undo']({ projectId: doc.id });
    expect(undone).toMatchObject({ done: true, label: 'Cut the intro' });
    expect(undone.change.duration.deltaSeconds).toBe(3);
  });

  it('refuses unknown, read-only and recording projects before opening anything', async () => {
    const unknown = setup();
    await expect(
      unknown.h['project.edit']({
        projectId: 'prj_NOPE',
        label: 'x',
        ops: [{ type: 'split', atUs: S }],
      }),
    ).rejects.toMatchObject({ code: 'unknown-project' });

    const readOnly = setup({ readOnly: true });
    await expect(
      readOnly.h['project.edit']({
        projectId: readOnly.doc.id,
        label: 'x',
        ops: [{ type: 'split', atUs: S }],
      }),
    ).rejects.toMatchObject({ code: 'read-only' });
    expect(readOnly.ensure).not.toHaveBeenCalled();

    const recording = recordedProject();
    recording.recording = { ...recording.recording!, state: 'finalizing' };
    const busy = setup({ doc: recording });
    await expect(busy.h['project.get']({ projectId: recording.id })).rejects.toMatchObject({
      code: 'recording',
    });
  });

  it('passes on editor refusals with their codes', async () => {
    const { h, doc } = setup();
    await expect(
      h['project.edit']({
        projectId: doc.id,
        label: 'Hide audio',
        ops: [{ type: 'setHidden', trackId: doc.timeline.tracks[2]!.id, hidden: true }],
      }),
    ).rejects.toMatchObject({ code: 'op-failed', details: { opCode: 'wrong-track-type' } });
  });

  it('undo on a closed project does nothing', async () => {
    const { h, doc, ensure } = setup();
    expect(await h['project.undo']({ projectId: doc.id })).toMatchObject({ done: false });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('finds pauses from the peaks cache, and asks to retry while it is generated', async () => {
    const { h, doc, peaks } = setup();
    const mic = doc.media.find((m) => m.role === 'microphone')!;
    const system = doc.media.find((m) => m.role === 'system-audio')!;
    peaks.set(mic.id, { status: 'pending' });
    const request = { projectId: doc.id, thresholdDb: -40, minDurationUs: S, padUs: 100_000 };
    await expect(h['audio.silences'](request)).rejects.toMatchObject({ code: 'not-ready' });

    peaks.set(mic.id, { status: 'ready', bytes: peaksBytes(mic.durationUs, [[10 * S, 13 * S]]) });
    peaks.set(system.id, { status: 'ready', bytes: peaksBytes(system.durationUs, [[0, 60 * S]]) });
    const result = await h['audio.silences'](request);
    expect(result.missingMediaIds).toEqual([]);
    expect(result.ranges).toHaveLength(1);
    const [range] = result.ranges;
    expect((range!.endUs - range!.startUs) / S).toBeCloseTo(2.8, 1);
  });

  it('captures frames through the editor', async () => {
    const { h, doc } = setup();
    expect(await h['preview.frame']({ projectId: doc.id, atUs: 2 * S, maxWidth: 320 })).toEqual({
      pngBase64: 'iVBOR',
      width: 320,
      height: 180,
      atUs: 2 * S,
    });
  });

  it('exports the live document and tracks the job', async () => {
    const { h, doc, emit, startExport, cancelExport } = setup();
    await h['project.edit']({
      projectId: doc.id,
      label: 'Cut',
      ops: [{ type: 'cutRange', inUs: 0, outUs: S }],
    });
    const started = await h['export.start']({ projectId: doc.id, options: OPTIONS });
    expect(started).toMatchObject({ status: 'started', jobId: 'job_01' });
    const call = startExport.mock.calls[0]![0];
    expect(call.doc).toBeDefined();
    expect(call.doc).not.toEqual(doc);

    emit({ type: 'progress', jobId: 'job_01', fraction: 0.4, etaSec: 12 });
    expect(await h['export.status']({ jobId: 'job_01' })).toMatchObject({
      state: 'running',
      fraction: 0.4,
      etaSec: 12,
    });
    expect(await h['export.cancel']({ jobId: 'job_01' })).toEqual({ cancelled: true });
    expect(cancelExport).toHaveBeenCalledWith('job_01');
    emit({ type: 'error', jobId: 'job_01', message: 'Export cancelled.', cancelled: true });
    expect(await h['export.status']({ jobId: 'job_01' })).toMatchObject({ state: 'cancelled' });
    expect(await h['export.cancel']({ jobId: 'job_01' })).toEqual({ cancelled: false });
    await expect(h['export.status']({ jobId: 'job_02' })).rejects.toMatchObject({
      code: 'unknown-job',
    });
  });
});
