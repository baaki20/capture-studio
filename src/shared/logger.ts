/** The logging surface modules depend on. electron-log's logger satisfies it; tests pass a stub. */
export interface Logger {
  info(...params: unknown[]): void;
  warn(...params: unknown[]): void;
  error(...params: unknown[]): void;
  debug?(...params: unknown[]): void;
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
