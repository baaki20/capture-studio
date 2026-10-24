/**
 * Crash-safe file writes and fallback reads (§1.8).
 *
 * Write: `<file>.tmp` + fsync → copy the current file to `<file>.bak` → rename `.tmp` over the
 * file → fsync the directory. Optionally a dated copy goes into a weekly backup folder.
 * Load order: file → `.tmp` → `.bak` → weekly copies, newest first.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const TMP_SUFFIX = '.tmp';
export const BAK_SUFFIX = '.bak';

export interface AtomicWriteOptions {
  /** Keep the file being replaced as `<file>.bak`. Default true. */
  backup?: boolean;
  /** File mode for new files, e.g. 0o600 for secrets. */
  mode?: number;
}

async function writeAndSync(
  filePath: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const handle = await fs.open(filePath, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** fsync a directory so a rename inside it is durable. Not supported on Windows; ignored there. */
async function syncDir(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is best effort (EISDIR/EPERM on some platforms).
  } finally {
    await handle?.close();
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = filePath + TMP_SUFFIX;
  await writeAndSync(tmpPath, data, options.mode);

  if (options.backup ?? true) {
    let current: Buffer | undefined;
    try {
      current = await fs.readFile(filePath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (current) {
      const bakPath = filePath + BAK_SUFFIX;
      const bakTmpPath = bakPath + TMP_SUFFIX;
      await writeAndSync(bakTmpPath, current, options.mode);
      await fs.rename(bakTmpPath, bakPath);
    }
  }

  await fs.rename(tmpPath, filePath);
  await syncDir(dir);
}

export interface WeeklyBackupOptions {
  dir: string;
  /** Number of dated copies to keep. Default 10. */
  keep?: number;
  /** Minimum age of the newest copy before another is made. Default 7 days. */
  intervalMs?: number;
  now?: () => Date;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function stamp(date: Date): string {
  // 2026-10-24T14:05:12.345Z → 20261024T140512Z (sortable, file-name safe)
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

function parseStamp(text: string): number | null {
  const m = STAMP_RE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function splitName(filePath: string): { stem: string; ext: string } {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  return { stem: base.slice(0, base.length - ext.length), ext };
}

/** Weekly copies of `filePath`, newest first: `<dir>/<stem>-<UTC stamp><ext>`. */
export async function listWeeklyBackups(
  filePath: string,
  dir: string,
): Promise<{ path: string; time: number }[]> {
  const { stem, ext } = splitName(filePath);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const prefix = `${stem}-`;
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(ext))
    .map((n) => ({
      path: path.join(dir, n),
      time: parseStamp(n.slice(prefix.length, n.length - ext.length)),
    }))
    .filter((b): b is { path: string; time: number } => b.time !== null)
    .sort((a, b) => b.time - a.time);
}

/**
 * Copies `filePath` into the weekly folder if the newest copy is older than the interval, then
 * prunes to the newest `keep` copies. Returns the new copy's path, or null if none was made.
 */
export async function rotateWeeklyBackup(
  filePath: string,
  options: WeeklyBackupOptions,
): Promise<string | null> {
  const now = (options.now ?? (() => new Date()))();
  const keep = options.keep ?? 10;
  const interval = options.intervalMs ?? WEEK_MS;
  const existing = await listWeeklyBackups(filePath, options.dir);
  const newest = existing[0];
  if (newest && now.getTime() - newest.time < interval) return null;

  const content = await fs.readFile(filePath);
  const { stem, ext } = splitName(filePath);
  const target = path.join(options.dir, `${stem}-${stamp(now)}${ext}`);
  await writeFileAtomic(target, content, { backup: false });

  const all = await listWeeklyBackups(filePath, options.dir);
  await Promise.all(all.slice(keep).map((b) => fs.rm(b.path, { force: true })));
  return target;
}

export type LoadSource = 'file' | 'tmp' | 'bak' | 'weekly';

export interface LoadFailure {
  source: LoadSource;
  path: string;
  error: string;
}

export type LoadResult<T> =
  | { status: 'loaded'; value: T; source: LoadSource; path: string; failures: LoadFailure[] }
  /** No candidate file exists (first run). */
  | { status: 'missing' }
  /** At least one candidate exists, but none could be parsed. */
  | { status: 'unreadable'; failures: LoadFailure[] };

/**
 * Reads the first candidate that `parse` accepts. `parse` receives the file text and must throw
 * on anything it cannot use (bad JSON, failed validation).
 */
export async function readFileWithFallback<T>(
  filePath: string,
  parse: (text: string) => T,
  options: { weeklyDir?: string } = {},
): Promise<LoadResult<T>> {
  const candidates: { source: LoadSource; path: string }[] = [
    { source: 'file', path: filePath },
    { source: 'tmp', path: filePath + TMP_SUFFIX },
    { source: 'bak', path: filePath + BAK_SUFFIX },
  ];
  if (options.weeklyDir) {
    for (const backup of await listWeeklyBackups(filePath, options.weeklyDir)) {
      candidates.push({ source: 'weekly', path: backup.path });
    }
  }

  const failures: LoadFailure[] = [];
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await fs.readFile(candidate.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) continue;
      failures.push({ ...candidate, error: String(error) });
      continue;
    }
    try {
      return { status: 'loaded', value: parse(text), ...candidate, failures };
    } catch (error) {
      failures.push({
        ...candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures.length === 0 ? { status: 'missing' } : { status: 'unreadable', failures };
}

/**
 * Moves an unreadable file aside as `<file>.corrupt-<stamp>` so it is kept for inspection but
 * never loaded or backed up again. Returns the new path, or null if the file did not exist.
 */
export async function quarantineFile(
  filePath: string,
  now: Date = new Date(),
): Promise<string | null> {
  const target = `${filePath}.corrupt-${stamp(now)}`;
  try {
    await fs.rename(filePath, target);
    return target;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
