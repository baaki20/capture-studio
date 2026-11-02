/**
 * Tool failures as MCP results (`isError`), worded so the model knows what to do next.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppError } from './app-client';

/** A mistake in a tool's own arguments (bad time, unknown track name, …). */
export class ToolInputError extends Error {
  override name = 'ToolInputError';
}

/** An edit refused while preparing it locally, reported like the app would. */
export function opFailure(message: string, opCode: string, index?: number): AppError {
  return new AppError('op-failed', message, index === undefined ? { opCode } : { opCode, index });
}

const OP_HINTS: Partial<Record<string, string>> = {
  'track-locked': 'A track involved is locked; unlock it with set_track { locked: false } first.',
  'unknown-clip': 'Clip IDs change when clips are split or cut; call get_project for current IDs.',
  'unknown-track': 'Call get_project for the current track names and IDs.',
  'wrong-track-type':
    'That setting does not apply to this kind of track (gain, mute and solo are audio; hide and layout are video).',
  'nothing-to-do':
    'There was nothing at that time to act on; check the clip times with get_project.',
  overlap:
    'Another clip is in the way on that track; pick a free spot or allow the nearest free one.',
  'cannot-link': 'Linked clips must start together, last equally long and sit on different tracks.',
};

function hintFor(error: AppError): string | null {
  switch (error.code) {
    case 'app-unavailable':
    case 'protocol':
      return null;
    case 'conflict':
      return 'The project changed in the editor since it was read. Call get_project again and redo the edit.';
    case 'busy':
      return 'The user is dragging something in the editor. Wait a moment and try again.';
    case 'recording':
      return 'Wait until the recording has finished and been saved.';
    case 'unknown-project':
      return 'Call list_projects for the available project IDs.';
    case 'read-only':
      return 'This project can only be read in this version of Capture Studio.';
    case 'not-ready':
      return 'Try again in a few seconds.';
    case 'editor-unavailable':
      return 'The editor window may have been closed. Try again; it reopens when needed.';
    case 'op-failed': {
      const opCode = error.details?.opCode;
      return typeof opCode === 'string' ? (OP_HINTS[opCode] ?? null) : null;
    }
    default:
      return null;
  }
}

export function errorResult(error: unknown): CallToolResult {
  let text: string;
  if (error instanceof AppError) {
    const hint = hintFor(error);
    text = hint ? `${error.message}\n${hint}` : error.message;
  } else if (error instanceof ToolInputError) {
    text = error.message;
  } else {
    text = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { content: [{ type: 'text', text }], isError: true };
}
