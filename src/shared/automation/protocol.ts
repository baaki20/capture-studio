/**
 * The automation socket protocol: how an outside client (the Capture Studio MCP server) drives the
 * running app. JSON lines over a Unix socket in a private folder under user data, only while the
 * user has turned automation on in Settings.
 *
 * - Request: `{ id, method, params }`. Response: `{ id, ok: true, result }` or
 *   `{ id, ok: false, error: { code, message } }`. One JSON object per line.
 * - Every method and its params are listed in `AUTOMATION_METHODS`; anything else is refused.
 *   There is no way to run code, and no file paths go in (exports are written where main
 *   decides, as for the editor).
 * - Times are integer µs, as everywhere in the app; clients convert at their own edge.
 * - Edits are `TimelineOp`s (without `replaceDocument`) applied by the project's editor window,
 *   which opens if needed: the user sees every change, and each request is one undo step.
 */
import { z } from 'zod';
import { ExportOptionsSchema, ExportStartResultSchema } from '../ipc/contract';
import {
  ChangeSummarySchema,
  EditResultSchema,
  FrameResultSchema,
  HistoryResultSchema,
  MAX_AUTOMATION_BATCH_OPS,
} from '../ipc/editor-automation';
import { TimelineOpSchema } from '../project/op-schema';
import { ProjectV1StructureSchema, prefixedId } from '../project/schema';

export const AUTOMATION_PROTOCOL_VERSION = 1;
/**
 * The socket is `<userData>/automation/automation.sock`; the folder is private to the user (0700)
 * and the socket itself is 0600.
 */
export const AUTOMATION_DIR_NAME = 'automation';
export const AUTOMATION_SOCKET_NAME = 'automation.sock';
/** Longest request line accepted; longer input closes the connection. */
export const AUTOMATION_MAX_LINE_BYTES = 1_048_576;
/** Most operations in one `project.edit`. */
export const AUTOMATION_MAX_BATCH_OPS = MAX_AUTOMATION_BATCH_OPS;

export const AUTOMATION_ERROR_CODES = [
  /** Not JSON, or not a request envelope. */
  'bad-request',
  'unknown-method',
  'invalid-params',
  'unknown-project',
  'unknown-job',
  /** The project is still recording or finalizing. */
  'recording',
  /** Made by a newer app version; opened read-only. */
  'read-only',
  /** The user is in the middle of a drag; retry shortly. */
  'busy',
  /** `ifVersion` no longer matches the editor's document. */
  'conflict',
  /** Waveform data is still being generated; retry shortly. */
  'not-ready',
  /** An edit operation was refused; `details` has the `OpError` code and batch index. */
  'op-failed',
  'export-failed',
  /** The editor window did not answer in time, or closed. */
  'editor-unavailable',
  'internal',
] as const;
export type AutomationErrorCode = (typeof AUTOMATION_ERROR_CODES)[number];

export const AutomationErrorSchema = z.object({
  code: z.enum(AUTOMATION_ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AutomationError = z.infer<typeof AutomationErrorSchema>;

export const AutomationRequestSchema = z.strictObject({
  id: z.int().nonnegative(),
  method: z.string().max(64),
  params: z.unknown().optional(),
});
export type AutomationRequest = z.infer<typeof AutomationRequestSchema>;

export const AutomationResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.int().nonnegative(), ok: z.literal(true), result: z.unknown() }),
  /** `id` is null when the request line could not be read at all. */
  z.object({
    id: z.int().nonnegative().nullable(),
    ok: z.literal(false),
    error: AutomationErrorSchema,
  }),
]);
export type AutomationResponse = z.infer<typeof AutomationResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Shared pieces

const ProjectId = prefixedId('prj');
const JobId = prefixedId('job');
const ProjectRef = z.strictObject({ projectId: ProjectId });

export { ChangeSummarySchema };

export const UsRangeSchema = z.object({ startUs: z.int(), endUs: z.int() });

const ProjectListItemSchema = z.object({
  id: ProjectId,
  name: z.string(),
  createdAt: z.string(),
  durationUs: z.number().nonnegative(),
  state: z.enum(['recording', 'finalizing', 'complete', 'recovered', 'failed']),
  /** Open in an editor window right now. */
  open: z.boolean(),
});

const ExportStatusSchema = z.object({
  jobId: JobId,
  projectId: ProjectId,
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  fraction: z.number().min(0).max(1),
  etaSec: z.number().nonnegative().nullable(),
  outputPath: z.string().nullable(),
  message: z.string().nullable(),
});

// ---------------------------------------------------------------------------------------------
// Methods

function method<P extends z.ZodType, R extends z.ZodType>(params: P, result: R) {
  return { params, result };
}

export const AUTOMATION_METHODS = {
  /** First call on a connection: checks that both sides speak the same protocol. */
  hello: method(
    z.strictObject({ client: z.string().min(1).max(100), protocolVersion: z.int().positive() }),
    z.object({
      app: z.literal('capture-studio'),
      appVersion: z.string(),
      protocolVersion: z.int().positive(),
    }),
  ),
  'projects.list': method(
    z.strictObject({}),
    z.object({ projects: z.array(ProjectListItemSchema) }),
  ),
  /** The editor's live document when the project is open, otherwise the saved one. */
  'project.get': method(
    ProjectRef,
    z.object({
      doc: ProjectV1StructureSchema,
      /** Pass back as `ifVersion` to refuse an edit if the document changed in between. */
      version: z.int().nonnegative(),
      live: z.boolean(),
      readOnly: z.boolean(),
    }),
  ),
  /** Applies operations in order as one undo step in the editor (opening it if needed). */
  'project.edit': method(
    z.strictObject({
      projectId: ProjectId,
      /** The undo label shown in the editor, e.g. "Remove pauses". */
      label: z.string().min(1).max(120),
      ops: z.array(TimelineOpSchema).min(1).max(AUTOMATION_MAX_BATCH_OPS),
      dryRun: z.boolean().optional(),
      ifVersion: z.int().nonnegative().optional(),
    }),
    EditResultSchema,
  ),
  'project.undo': method(ProjectRef, HistoryResultSchema),
  'project.redo': method(ProjectRef, HistoryResultSchema),
  /** Pauses on the timeline where every audible audio track is quiet (`project/silence.ts`). */
  'audio.silences': method(
    z.strictObject({
      projectId: ProjectId,
      thresholdDb: z.number().min(-90).max(0),
      minDurationUs: z.int().min(10_000).max(600_000_000),
      padUs: z.int().min(0).max(5_000_000),
    }),
    z.object({
      ranges: z.array(UsRangeSchema),
      version: z.int().nonnegative(),
      /** Audio media without waveform data; their clips never count as quiet. */
      missingMediaIds: z.array(z.string()),
    }),
  ),
  /** The composed frame at a timeline time, as rendered by the editor's preview. */
  'preview.frame': method(
    z.strictObject({
      projectId: ProjectId,
      atUs: z.int().nonnegative(),
      maxWidth: z.int().min(64).max(1920),
    }),
    FrameResultSchema,
  ),
  /** Exports the editor's current document (or the saved one) to main's default location. */
  'export.start': method(
    z.strictObject({
      projectId: ProjectId,
      options: ExportOptionsSchema,
      overwrite: z.boolean().optional(),
    }),
    ExportStartResultSchema,
  ),
  'export.status': method(z.strictObject({ jobId: JobId }), ExportStatusSchema),
  'export.cancel': method(z.strictObject({ jobId: JobId }), z.object({ cancelled: z.boolean() })),
} as const;

export type AutomationMethod = keyof typeof AUTOMATION_METHODS;
export type AutomationParams<M extends AutomationMethod> = z.infer<
  (typeof AUTOMATION_METHODS)[M]['params']
>;
export type AutomationResult<M extends AutomationMethod> = z.infer<
  (typeof AUTOMATION_METHODS)[M]['result']
>;

export function isAutomationMethod(name: string): name is AutomationMethod {
  return Object.hasOwn(AUTOMATION_METHODS, name);
}
