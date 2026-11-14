/**
 * A socket path for a test server: a file in `dir` on Linux and macOS, a uniquely named pipe on
 * Windows (Node cannot listen on a file path there).
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const namedPipes = process.platform === 'win32';

export function testSocketPath(dir: string, ...parts: string[]): string {
  if (namedPipes) return `\\\\.\\pipe\\cs-test-${randomBytes(6).toString('hex')}`;
  return path.join(dir, ...parts);
}
