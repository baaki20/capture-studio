/**
 * Structured errors over IPC invoke channels.
 *
 * Electron passes only an Error's `message` from a main handler to the renderer, prefixed with
 * "Error invoking remote method '<channel>': ". To let renderers branch on an error code (a stale
 * `project.save` revision, for example) instead of on wording, the router re-throws every handler
 * error that carries a string `code` as an Error whose message ends with
 * `CS_IPC_ERROR:{"code":…,"message":…}`. Renderers read it back with `ipcErrorCode` or
 * `decodeIpcError`; errors without the envelope decode to null.
 */

export const IPC_ERROR_MARKER = 'CS_IPC_ERROR:';

export interface IpcErrorInfo {
  code: string;
  message: string;
}

/** The message main throws for a coded error. */
export function encodeIpcError(info: IpcErrorInfo): string {
  return `${IPC_ERROR_MARKER}${JSON.stringify({ code: info.code, message: info.message })}`;
}

/** The code and message of an error that crossed IPC with the envelope, else null. */
export function decodeIpcError(error: unknown): IpcErrorInfo | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (text === null) return null;
  const at = text.lastIndexOf(IPC_ERROR_MARKER);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(at + IPC_ERROR_MARKER.length)) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { code?: unknown }).code === 'string' &&
      typeof (parsed as { message?: unknown }).message === 'string'
    ) {
      const { code, message } = parsed as IpcErrorInfo;
      return { code, message };
    }
  } catch {
    // Not an envelope after all.
  }
  return null;
}

export function ipcErrorCode(error: unknown): string | null {
  return decodeIpcError(error)?.code ?? null;
}

/** A readable message for any rejection: the envelope's message, or the error's own. */
export function ipcErrorMessage(error: unknown): string {
  const decoded = decodeIpcError(error);
  if (decoded) return decoded.message;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}
