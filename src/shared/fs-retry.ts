/**
 * Windows refuses to rename over (or move) a file that another process has open for a moment,
 * typically a virus scanner or the search indexer looking at a file we just wrote. Those errors
 * (`EPERM`, `EBUSY`, `EACCES`) clear within a second, so file moves retry them there with short
 * back-offs. Elsewhere they are real errors and fail at once. Pure: the caller passes the file
 * operation and the platform.
 */

/** The shared core has no Node or DOM types; every process it runs in has a timer. */
const timers = globalThis as unknown as { setTimeout(callback: () => void, ms: number): unknown };

const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** About 1.5 s in total. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

export function isTransientFsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

export async function retryTransientFsErrors<T>(
  operation: () => Promise<T>,
  platform: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => timers.setTimeout(r, ms)),
): Promise<T> {
  for (const delay of platform === 'win32' ? TRANSIENT_RETRY_DELAYS_MS : []) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFsError(error)) throw error;
      await sleep(delay);
    }
  }
  return operation();
}
