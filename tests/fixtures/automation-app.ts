/**
 * The app's automation side without Electron: `AutomationService` with a fake library, export
 * service and peaks cache, and editor windows that are real document stores with the real
 * automation handler. `app` is an `AppApi` that validates params like the socket does, so MCP
 * tools can be tested end to end in memory.
 */
import { AppError, type AppApi } from '../../src/mcp/app-client';
import { AutomationFailure } from '../../src/main/automation/automation-server';
import { AutomationService } from '../../src/main/automation/automation-service';
import { EditorLinkError, type EditorLink } from '../../src/main/automation/editor-link';
import type { ExportJobEvent } from '../../src/main/ipc/export-handlers';
import { createAutomationHandler } from '../../src/renderer/editor/automation';
import {
  createDocumentStore,
  type DocumentStore,
} from '../../src/renderer/editor/store/document-store';
import { AUTOMATION_METHODS } from '../../src/shared/automation/protocol';
import {
  EDITOR_AUTOMATION_COMMANDS,
  type EditorAutomationCommand,
} from '../../src/shared/ipc/editor-automation';
import { PEAK_WINDOW_US } from '../../src/shared/project/peaks';
import type { Project } from '../../src/shared/project/schema';
import { counterIds } from './editor-project';

/** Peaks for an audio media: loud except inside `quiet` (file-local µs ranges). */
export function peaksBytes(durationUs: number, quiet: [number, number][]): ArrayBuffer {
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

export interface FakeApp {
  app: AppApi;
  service: AutomationService;
  /** The open editor's store, once an edit opened it. */
  editor(): DocumentStore | null;
  peaks: Map<string, ArrayBuffer>;
  exports: { started: unknown[]; emit(event: ExportJobEvent): void };
  frames: { width: number; height: number; pngBase64: string };
}

export function fakeApp(doc: Project): FakeApp {
  let store: DocumentStore | null = null;
  let link: EditorLink | null = null;
  const peaks = new Map<string, ArrayBuffer>();
  const listeners = new Set<(event: ExportJobEvent) => void>();
  const started: unknown[] = [];
  const frames = { width: 320, height: 180, pngBase64: 'iVBORw0KGgoAAAA' };

  const openEditor = (): EditorLink => {
    store = createDocumentStore({ opOptions: { generateId: counterIds('M') } });
    store.getState().load({ doc, revision: 0, mediaUrls: {}, readOnly: false });
    const handler = createAutomationHandler({
      docStore: store,
      autosave: { flush: () => Promise.resolve() },
      capture: () => Promise.resolve({ ...frames }),
    });
    link = {
      command: async (command: EditorAutomationCommand, payload: unknown) => {
        const result = await handler.handle(command, payload);
        if (!result.ok) {
          throw new EditorLinkError(result.error.code, result.error.message, result.error.details);
        }
        return EDITOR_AUTOMATION_COMMANDS[command].response.parse(result.value);
      },
    } as unknown as EditorLink;
    return link;
  };

  const service = new AutomationService({
    appVersion: '0.1.0',
    listProjects: () =>
      Promise.resolve([
        {
          id: doc.id,
          name: doc.name,
          createdAt: doc.createdAt,
          durationUs: 60_000_000,
          components: ['screen'],
          thumbUrl: null,
          state: 'complete',
        },
      ]),
    openProjects: () => (link ? [doc.id] : []),
    readProject: (id) => Promise.resolve(id === doc.id ? { doc, readOnly: false } : null),
    editors: {
      live: (id) => (id === doc.id ? link : null),
      ensure: (id) =>
        id === doc.id
          ? Promise.resolve(link ?? openEditor())
          : Promise.reject(new EditorLinkError('editor-unavailable', 'no such editor')),
    },
    peaksFile: (_projectId, mediaId) =>
      Promise.resolve(
        peaks.has(mediaId)
          ? { status: 'ready', path: mediaId }
          : { status: 'unavailable', path: null },
      ),
    readFile: (file) => Promise.resolve(peaks.get(file) ?? new ArrayBuffer(0)),
    exports: {
      start: (request) => {
        started.push(request);
        return Promise.resolve({
          jobId: `job_${String(started.length).padStart(2, '0')}`,
          status: 'started',
          path: '/exports/Lesson test.mp4',
          message: null,
        });
      },
      cancel: () => undefined,
      onJobEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const app: AppApi = {
    call: async (method, params) => {
      const handler = service.handlers[method] as (p: unknown) => Promise<unknown>;
      try {
        const result = await handler(AUTOMATION_METHODS[method].params.parse(params));
        return AUTOMATION_METHODS[method].result.parse(result) as never;
      } catch (error) {
        if (error instanceof AutomationFailure) {
          throw new AppError(error.code, error.message, error.details);
        }
        throw error;
      }
    },
  };

  return {
    app,
    service,
    editor: () => store,
    peaks,
    exports: {
      started,
      emit: (event) => {
        for (const l of listeners) l(event);
      },
    },
    frames,
  };
}
