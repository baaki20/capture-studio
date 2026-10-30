/**
 * Names of export temp files (§4.3.9, R1.47). FFmpeg writes `.<output name>.<token>.part` next to
 * the target (hidden, same filesystem, so the final rename is atomic); the token is 8 hex
 * digits. Main uses the same names to delete what an export left behind when the media utility
 * was killed mid-export, and to sweep stale ones at startup, so only files of this exact shape
 * are ever touched.
 */

const TOKEN = /^[0-9a-f]{8}$/;

/** File name (no folder) of the temp output for `outputName` (a file name, no folder). */
export function exportTempName(outputName: string, token: string): string {
  if (!TOKEN.test(token)) throw new Error(`export temp token must be 8 hex digits: ${token}`);
  return `.${outputName}.${token}.part`;
}

/** The output file name a temp file name belongs to, or null when it is not one of ours. */
export function exportTempOwner(fileName: string): string | null {
  if (!fileName.startsWith('.') || !fileName.endsWith('.part')) return null;
  const stem = fileName.slice(1, -'.part'.length);
  const dot = stem.lastIndexOf('.');
  if (dot <= 0) return null;
  const token = stem.slice(dot + 1);
  return TOKEN.test(token) ? stem.slice(0, dot) : null;
}
