/** Small file helpers for the media utility (main's `atomic-file.ts` is out of reach by design). */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Writes JSON through a temp file, fsync and rename, so readers see the old or the new file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${String(process.pid)}.tmp`);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}
