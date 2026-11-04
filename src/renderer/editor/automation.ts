/**
 * The editor's side of automation (`shared/ipc/editor-automation.ts`): assistant requests that
 * main forwards from the automation socket. Every edit goes through the window's own document
 * store, so it shows in the preview at once, is one undo step labelled with the request's label,
 * and is saved by the normal autosave.
 *
 * - `createAutomationHandler(deps)` answers one command; pure apart from its dependencies, so it
 *   is unit-tested without a window.
 * - `connectEditorAutomation(api, projectId, handler)` subscribes to `automation.request`, replies
 *   on `automation.reply` and announces `automation.ready`.
 *
 * The document version counts every change of the store's document (edits, undo, redo, reloads);
 * a request with `ifVersion` is refused with `conflict` when the user changed something since.
 */
import {
  EDITOR_AUTOMATION_COMMANDS,
  type EditorAutomationCommand,
  type EditorAutomationError,
  type EditorAutomationPayload,
  type EditorAutomationRequest,
} from '../../shared/ipc/editor-automation';
import type { EditorPreloadApi, Unsubscribe } from '../../shared/ipc/preload-api';
import { describeChange } from '../../shared/project/change-summary';
import { applyOpsWithPatches } from '../../shared/project/timeline-ops';
import { err, ok, type Result } from '../../shared/result';
import type { BatchEditError, DocumentStore } from './store/document-store';

export interface CapturedPng {
  pngBase64: string;
  width: number;
  height: number;
}

export interface AutomationDeps {
  docStore: DocumentStore;
  autosave: { flush(): Promise<void> };
  /** The composed frame at `atUs` as PNG, or null while the preview is not ready. */
  capture(atUs: number, maxWidth: number): Promise<CapturedPng | null>;
}

export interface AutomationHandler {
  handle(
    command: EditorAutomationCommand,
    payload: unknown,
  ): Promise<Result<unknown, EditorAutomationError>>;
  readonly version: number;
  dispose(): void;
}

function failure(
  code: EditorAutomationError['code'],
  message: string,
  details?: Record<string, unknown>,
): Result<never, EditorAutomationError> {
  return err(details ? { code, message, details } : { code, message });
}

function fromEditError(error: BatchEditError): Result<never, EditorAutomationError> {
  switch (error.code) {
    case 'busy':
      return failure('busy', `${error.message}; try again in a moment`);
    case 'read-only':
      return failure('read-only', error.message);
    case 'no-document':
      return failure('not-ready', 'the editor has not loaded its project yet');
    default:
      return failure('op-failed', error.message, {
        opCode: error.code,
        ...('index' in error ? { index: error.index } : {}),
      });
  }
}

export function createAutomationHandler(deps: AutomationDeps): AutomationHandler {
  const { docStore } = deps;
  let version = 0;
  const unsubscribe = docStore.subscribe((state, previous) => {
    if (state.doc !== previous.doc) version += 1;
  });

  const historyStep = (direction: 'undo' | 'redo') => {
    const state = docStore.getState();
    const before = state.doc;
    if (!before) return failure('not-ready', 'the editor has not loaded its project yet');
    if (state.readOnly) return failure('read-only', 'this project opens read-only');
    const label = direction === 'undo' ? state.undoLabel : state.redoLabel;
    const done = direction === 'undo' ? state.undo() : state.redo();
    const after = docStore.getState().doc ?? before;
    return ok({ done, label: done ? label : null, version, change: describeChange(before, after) });
  };

  const run = async (
    command: EditorAutomationCommand,
    payload: unknown,
  ): Promise<Result<unknown, EditorAutomationError>> => {
    const parsed = EDITOR_AUTOMATION_COMMANDS[command].payload.safeParse(payload);
    if (!parsed.success) return failure('invalid-params', parsed.error.message);

    switch (command) {
      case 'snapshot': {
        const { doc, readOnly } = docStore.getState();
        if (!doc) return failure('not-ready', 'the editor has not loaded its project yet');
        return ok({ doc, version, readOnly });
      }

      case 'apply': {
        const request = parsed.data as EditorAutomationPayload<'apply'>;
        const state = docStore.getState();
        const before = state.doc;
        if (!before) return failure('not-ready', 'the editor has not loaded its project yet');
        if (state.readOnly) return failure('read-only', 'this project opens read-only');
        if (request.ifVersion !== undefined && request.ifVersion !== version) {
          return failure(
            'conflict',
            'the project changed since it was read; read it again and retry',
            { expected: request.ifVersion, actual: version },
          );
        }
        if (request.dryRun) {
          const trial = applyOpsWithPatches(before, request.ops);
          if (!trial.ok) return fromEditError(trial.error);
          return ok({
            applied: false,
            version,
            change: describeChange(before, trial.value.doc),
            undoLabel: null,
          });
        }
        const result = state.applyBatch(request.ops, { label: request.label });
        if (!result.ok) return fromEditError(result.error);
        const applied = result.value !== before;
        if (applied) {
          docStore
            .getState()
            .showAssistantNotice(`Assistant: ${request.label}. Press Ctrl+Z to undo.`);
        }
        return ok({
          applied,
          version,
          change: describeChange(before, result.value),
          undoLabel: applied ? request.label : null,
        });
      }

      case 'undo':
      case 'redo':
        return historyStep(command);

      case 'flush':
        await deps.autosave.flush();
        return ok({ saveStatus: docStore.getState().saveStatus });

      case 'capture': {
        const { atUs, maxWidth } = parsed.data as EditorAutomationPayload<'capture'>;
        const png = await deps.capture(atUs, maxWidth);
        if (!png) return failure('not-ready', 'the preview is not ready yet; try again shortly');
        return ok({ ...png, atUs });
      }
    }
  };

  return {
    handle: async (command, payload) => {
      try {
        return await run(command, payload);
      } catch (error) {
        return failure('internal', error instanceof Error ? error.message : String(error));
      }
    },
    get version() {
      return version;
    },
    dispose: unsubscribe,
  };
}

export function connectEditorAutomation(
  api: NonNullable<EditorPreloadApi['automation']>,
  projectId: string,
  handler: Pick<AutomationHandler, 'handle'>,
): Unsubscribe {
  const off = api.onRequest((request: EditorAutomationRequest) => {
    void handler
      .handle(request.command, request.payload)
      .then((result) =>
        api
          .reply(
            result.ok
              ? { requestId: request.requestId, ok: true, value: result.value }
              : { requestId: request.requestId, ok: false, error: result.error },
          )
          .catch(() => undefined),
      );
  });
  void api.ready(projectId).catch(() => undefined);
  return off;
}
