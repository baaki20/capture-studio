/**
 * Main ⇄ editor commands for automation (assistant edits through the automation socket). Main
 * sends `automation.request` events `{ requestId, command, payload }` to one editor window; the
 * editor answers with the `automation.reply` invoke, `{ requestId, ok, value | error }`, and
 * announces with `automation.ready` once its project is loaded. Main validates replies against
 * `EDITOR_AUTOMATION_COMMANDS` (`main/automation/editor-link.ts`); the editor validates payloads
 * (`renderer/editor/automation.ts`).
 *
 * Kept apart from `contract.ts` so the socket protocol (`shared/automation/protocol.ts`) can reuse
 * the result schemas without an import cycle.
 */
import { z } from 'zod';
import { TimelineOpSchema } from '../project/op-schema';
import { ProjectStructureSchema } from '../project/schema';

const TimeSummarySchema = z.object({ seconds: z.number(), timecode: z.string() });

/** Mirrors `ChangeSummary` (`project/change-summary.ts`); a type test keeps them equal. */
export const ChangeSummarySchema = z.object({
  changed: z.boolean(),
  duration: z.object({
    before: TimeSummarySchema,
    after: TimeSummarySchema,
    deltaSeconds: z.number(),
  }),
  clips: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
  }),
  lines: z.array(z.string()),
});

export const EditResultSchema = z.object({
  /** False for a dry run, or when nothing changed. */
  applied: z.boolean(),
  /** The editor document's version after the request. */
  version: z.int().nonnegative(),
  change: ChangeSummarySchema,
  /** The undo step's label, when one was recorded. */
  undoLabel: z.string().nullable(),
});

export const HistoryResultSchema = z.object({
  /** False when there was nothing to undo or redo. */
  done: z.boolean(),
  /** The label of the step that was undone or redone. */
  label: z.string().nullable(),
  version: z.int().nonnegative(),
  change: ChangeSummarySchema,
});

export const FrameResultSchema = z.object({
  pngBase64: z.string(),
  width: z.int().positive(),
  height: z.int().positive(),
  atUs: z.int().nonnegative(),
});

/** Most operations in one edit request. */
export const MAX_AUTOMATION_BATCH_OPS = 200;

function command<P extends z.ZodType, R extends z.ZodType>(payload: P, response: R) {
  return { payload, response };
}

export const EDITOR_AUTOMATION_COMMANDS = {
  /** The live document and its version (bumped on every change, undo, redo and reload). */
  snapshot: command(
    z.strictObject({}),
    z.object({
      doc: ProjectStructureSchema,
      version: z.int().nonnegative(),
      readOnly: z.boolean(),
    }),
  ),
  apply: command(
    z.strictObject({
      label: z.string().min(1).max(120),
      ops: z.array(TimelineOpSchema).min(1).max(MAX_AUTOMATION_BATCH_OPS),
      dryRun: z.boolean().optional(),
      ifVersion: z.int().nonnegative().optional(),
    }),
    EditResultSchema,
  ),
  undo: command(z.strictObject({}), HistoryResultSchema),
  redo: command(z.strictObject({}), HistoryResultSchema),
  /** Saves pending edits now (before an export reads the file). */
  flush: command(z.strictObject({}), z.object({ saveStatus: z.string() })),
  /** The composed preview frame at a timeline time, as PNG, at most `maxWidth` wide. */
  capture: command(
    z.strictObject({ atUs: z.int().nonnegative(), maxWidth: z.int().min(64).max(1920) }),
    FrameResultSchema,
  ),
} as const;

export type EditorAutomationCommand = keyof typeof EDITOR_AUTOMATION_COMMANDS;
export const EDITOR_AUTOMATION_COMMAND_NAMES = Object.keys(EDITOR_AUTOMATION_COMMANDS) as [
  EditorAutomationCommand,
  ...EditorAutomationCommand[],
];
export type EditorAutomationPayload<C extends EditorAutomationCommand> = z.infer<
  (typeof EDITOR_AUTOMATION_COMMANDS)[C]['payload']
>;
export type EditorAutomationResponse<C extends EditorAutomationCommand> = z.infer<
  (typeof EDITOR_AUTOMATION_COMMANDS)[C]['response']
>;

/** Errors the editor reports; a subset of the socket's `AutomationErrorCode`s. */
export const EDITOR_AUTOMATION_ERROR_CODES = [
  'invalid-params',
  'busy',
  'conflict',
  'read-only',
  'op-failed',
  'not-ready',
  'internal',
] as const;

export const EditorAutomationErrorSchema = z.object({
  code: z.enum(EDITOR_AUTOMATION_ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type EditorAutomationError = z.infer<typeof EditorAutomationErrorSchema>;

export const EditorAutomationRequestSchema = z.object({
  requestId: z.int().nonnegative(),
  command: z.enum(EDITOR_AUTOMATION_COMMAND_NAMES),
  payload: z.unknown(),
});
export type EditorAutomationRequest = z.infer<typeof EditorAutomationRequestSchema>;

export const EditorAutomationReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ requestId: z.int().nonnegative(), ok: z.literal(true), value: z.unknown() }),
  z.strictObject({
    requestId: z.int().nonnegative(),
    ok: z.literal(false),
    error: EditorAutomationErrorSchema,
  }),
]);
export type EditorAutomationReply = z.infer<typeof EditorAutomationReplySchema>;
