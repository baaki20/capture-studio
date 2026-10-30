/**
 * Is a media file usable (R1.29)? A file can be present and still unusable: unreadable
 * (permissions, I/O errors), empty, truncated or not media at all. Such files are offline like
 * missing ones, so the editor offers Relink and export is blocked with a clear message instead of
 * failing inside FFmpeg.
 *
 * Main never runs FFmpeg (§1.3), so the check is a structural probe that reads only box headers:
 *
 * - **MP4 / ISO BMFF** (every recorded and finalized file): the top-level boxes must chain exactly
 *   to the end of the file (a truncated file ends inside a box), start with `ftyp`, and include a
 *   `moov` holding at least one `trak` and media data (`mdat`, or `moof` fragments) that is not
 *   empty.
 * - **WebM/Matroska, WAV, Ogg** (possible relink choices): recognised by their signature.
 *
 * Results are cached by path, size, modification time and inode, so reopening a project costs one
 * `stat` per media.
 */
import { constants, promises as fs, type Stats } from 'node:fs';

export type MediaHealth =
  { state: 'ok' } | { state: 'missing' } | { state: 'unreadable'; reason: string };

/** Top-level boxes walked before giving up (a real file has a handful). */
const MAX_BOXES = 10_000;

interface BoxHeader {
  type: string;
  start: number;
  /** Header length (8, or 16 with a 64-bit size). */
  headerSize: number;
  size: number;
}

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** Box header at `start`, or a reason why there is none. */
async function boxAt(
  handle: fs.FileHandle,
  start: number,
  end: number,
): Promise<BoxHeader | string> {
  if (end - start < 8) return `a box header is cut off at byte ${String(start)}`;
  const head = await readAt(handle, start, 16);
  if (head.length < 8) return `a box header is cut off at byte ${String(start)}`;
  const type = head.toString('latin1', 4, 8);
  let size = head.readUInt32BE(0);
  let headerSize = 8;
  if (size === 1) {
    if (head.length < 16) return `a box header is cut off at byte ${String(start)}`;
    size = Number(head.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = end - start; // to the end of the enclosing range
  }
  if (size < headerSize) return `the "${type}" box at byte ${String(start)} has an invalid size`;
  if (start + size > end) {
    return `the file is truncated (the "${type}" box needs ${String(start + size - end)} more bytes)`;
  }
  return { type, start, headerSize, size };
}

async function boxesIn(
  handle: fs.FileHandle,
  start: number,
  end: number,
): Promise<BoxHeader[] | string> {
  const boxes: BoxHeader[] = [];
  for (let at = start; at < end;) {
    if (boxes.length >= MAX_BOXES) return 'too many boxes';
    const box = await boxAt(handle, at, end);
    if (typeof box === 'string') return box;
    boxes.push(box);
    at += box.size;
  }
  return boxes;
}

async function checkIsoBmff(handle: fs.FileHandle, size: number): Promise<MediaHealth> {
  const top = await boxesIn(handle, 0, size);
  if (typeof top === 'string') return { state: 'unreadable', reason: top };
  if (top[0]?.type !== 'ftyp')
    return { state: 'unreadable', reason: 'it does not start with "ftyp"' };
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return { state: 'unreadable', reason: 'it has no "moov" box (no stream information)' };
  const children = await boxesIn(handle, moov.start + moov.headerSize, moov.start + moov.size);
  if (typeof children === 'string') return { state: 'unreadable', reason: children };
  if (!children.some((b) => b.type === 'trak')) {
    return { state: 'unreadable', reason: 'it contains no streams' };
  }
  const data = top.filter((b) => b.type === 'mdat' || b.type === 'moof');
  if (!data.some((b) => b.size > b.headerSize)) {
    return { state: 'unreadable', reason: 'it contains no media data' };
  }
  return { state: 'ok' };
}

/** Inspects one file (no cache). */
export async function inspectMediaFile(fullPath: string): Promise<MediaHealth> {
  let stat: Stats;
  try {
    stat = await fs.stat(fullPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { state: 'missing' }
      : { state: 'unreadable', reason: `it cannot be accessed (${code ?? 'error'})` };
  }
  if (!stat.isFile()) return { state: 'missing' };
  if (stat.size === 0) return { state: 'unreadable', reason: 'the file is empty' };
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(fullPath, constants.O_RDONLY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return {
      state: 'unreadable',
      reason:
        code === 'EACCES' || code === 'EPERM'
          ? 'permission denied'
          : `it cannot be opened (${code})`,
    };
  }
  try {
    const head = await readAt(handle, 0, 12);
    if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') {
      return await checkIsoBmff(handle, stat.size);
    }
    if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return { state: 'ok' }; // EBML
    if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF') {
      return head.toString('latin1', 8, 12) === 'WAVE'
        ? { state: 'ok' }
        : { state: 'unreadable', reason: 'it is not a media file' };
    }
    if (head.length >= 4 && head.toString('latin1', 0, 4) === 'OggS') return { state: 'ok' };
    return { state: 'unreadable', reason: 'it is not a media file (or is damaged)' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return { state: 'unreadable', reason: `reading it failed (${code})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `inspectMediaFile` with results cached by path, size, mtime and inode. */
export class MediaHealthCache {
  private readonly entries = new Map<string, { stamp: string; health: MediaHealth }>();

  async check(fullPath: string): Promise<MediaHealth> {
    const stat = await fs.stat(fullPath).catch(() => null);
    // Missing and inaccessible files are cheap to re-check and never cached.
    if (!stat?.isFile()) return inspectMediaFile(fullPath);
    const stamp = `${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ino)}`;
    const cached = this.entries.get(fullPath);
    if (cached?.stamp === stamp) return cached.health;
    const health = await inspectMediaFile(fullPath);
    // Permissions can change without touching size or mtime: only cache content verdicts.
    const permission = health.state === 'unreadable' && /permission|cannot be/.test(health.reason);
    if (!permission) this.entries.set(fullPath, { stamp, health });
    else this.entries.delete(fullPath);
    return health;
  }
}
