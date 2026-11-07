/**
 * Pack and Unpack (R2.34, spec §2.1): a project folder as one `.zip` for sharing, and back.
 *
 * - **Pack** writes every regular file of `<Name>.cstudio/` under that folder name, except
 *   `cache/` (peaks, thumbnails, proxies and cleaned audio are rebuilt on open) and atomic-write
 *   leftovers. Media are stored as they are (already compressed); small text files are deflated.
 *   Entries larger than 4 GiB, or past 4 GiB in the archive, use Zip64. The archive is written to
 *   a temporary name and renamed when complete.
 * - **Unpack** reads only what it understands: stored or deflated entries, no encryption, no
 *   links, every name inside one top-level `*.cstudio/` folder, no absolute paths, `..`, `\` or
 *   drive letters. Each entry's size and CRC-32 are checked. It extracts into a temporary folder
 *   next to the destination and renames it when everything is there.
 *
 * Plain zip, so any archive tool opens a pack; and a folder zipped by hand unpacks too.
 */
import { createReadStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import zlib from 'node:zlib';
import { PROJECT_EXTENSION } from '../../shared/project/schema';

/** Folders and files Pack leaves out (relative to the project folder). */
const SKIPPED_DIRS = new Set(['cache']);
const SKIPPED_SUFFIXES = ['.tmp', '.partial'];
/** Files up to this size are read whole and deflated when that makes them smaller. */
const DEFLATE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const U32 = 0xffffffff;
const U16 = 0xffff;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const FLAG_UTF8 = 0x0800;

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

interface FileToPack {
  /** Path inside the archive (`/`-separated, starting with the folder name). */
  name: string;
  file: string;
  size: number;
  mtime: Date;
}

interface CentralRecord {
  name: Buffer;
  method: 0 | 8;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** The files Pack writes, in a stable order. */
export async function filesToPack(root: string): Promise<FileToPack[]> {
  const top = path.basename(root);
  const out: FileToPack[] = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!relative && SKIPPED_DIRS.has(entry.name)) continue;
        await walk(full, rel);
      } else if (entry.isFile()) {
        if (SKIPPED_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
        const stat = await fs.stat(full);
        out.push({ name: `${top}/${rel}`, file: full, size: stat.size, mtime: stat.mtime });
      }
      // Links and special files are left out.
    }
  };
  await walk(root, '');
  if (out.length > MAX_ENTRIES) throw new PackError('The project has too many files to pack.');
  return out;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zip64Extra(values: number[]): Buffer {
  if (values.length === 0) return Buffer.alloc(0);
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return extra;
}

function localHeader(record: CentralRecord, zip64: boolean): Buffer {
  const extra = zip64 ? zip64Extra([record.size, record.compressed]) : Buffer.alloc(0);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(SIG_LOCAL, 0);
  header.writeUInt16LE(zip64 ? 45 : 20, 4);
  header.writeUInt16LE(FLAG_UTF8, 6);
  header.writeUInt16LE(record.method, 8);
  header.writeUInt16LE(record.time, 10);
  header.writeUInt16LE(record.date, 12);
  header.writeUInt32LE(record.crc >>> 0, 14);
  header.writeUInt32LE(zip64 ? U32 : record.compressed, 18);
  header.writeUInt32LE(zip64 ? U32 : record.size, 22);
  header.writeUInt16LE(record.name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, record.name, extra]);
}

function centralHeader(record: CentralRecord): Buffer {
  const big: number[] = [];
  if (record.size >= U32) big.push(record.size);
  if (record.compressed >= U32) big.push(record.compressed);
  if (record.offset >= U32) big.push(record.offset);
  const extra = zip64Extra(big);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(SIG_CENTRAL, 0);
  header.writeUInt16LE((3 << 8) | 45, 4); // made by Unix, zip 4.5
  header.writeUInt16LE(big.length > 0 ? 45 : 20, 6);
  header.writeUInt16LE(FLAG_UTF8, 8);
  header.writeUInt16LE(record.method, 10);
  header.writeUInt16LE(record.time, 12);
  header.writeUInt16LE(record.date, 14);
  header.writeUInt32LE(record.crc >>> 0, 16);
  header.writeUInt32LE(Math.min(record.compressed, U32), 20);
  header.writeUInt32LE(Math.min(record.size, U32), 24);
  header.writeUInt16LE(record.name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
  header.writeUInt32LE(Math.min(record.offset, U32), 42);
  return Buffer.concat([header, record.name, extra]);
}

function endRecords(count: number, cdOffset: number, cdSize: number): Buffer {
  const parts: Buffer[] = [];
  const needs64 = count >= U16 || cdOffset >= U32 || cdSize >= U32;
  if (needs64) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(SIG_END64, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE((3 << 8) | 45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(count), 24);
    end64.writeBigUInt64LE(BigInt(count), 32);
    end64.writeBigUInt64LE(BigInt(cdSize), 40);
    end64.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG_LOCATOR64, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(end64, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(Math.min(count, U16), 8);
  end.writeUInt16LE(Math.min(count, U16), 10);
  end.writeUInt32LE(Math.min(cdSize, U32), 12);
  end.writeUInt32LE(Math.min(cdOffset, U32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/** Streams `file` to `handle` at `position`; resolves with its CRC-32 and byte count. */
async function copyInto(
  handle: FileHandle,
  file: string,
  position: number,
): Promise<{ crc: number; bytes: number }> {
  let crc = 0;
  let bytes = 0;
  await pipeline(
    createReadStream(file, { highWaterMark: 1 << 20 }),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        crc = zlib.crc32(chunk, crc);
        handle.write(chunk, 0, chunk.length, position + bytes).then(() => {
          bytes += chunk.length;
          callback();
        }, callback);
      },
    }),
  );
  return { crc, bytes };
}

export interface PackProgress {
  doneBytes: number;
  totalBytes: number;
}

/**
 * Packs the project folder `root` into `output` (replacing it). Resolves with the number of files
 * and bytes packed.
 */
export async function packProject(
  root: string,
  output: string,
  onProgress?: (progress: PackProgress) => void,
): Promise<{ files: number; bytes: number }> {
  if (!path.basename(root).endsWith(PROJECT_EXTENSION)) {
    throw new PackError('Only project folders can be packed.');
  }
  const files = await filesToPack(root);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const partial = `${output}.partial`;
  const handle = await fs.open(partial, 'w');
  const records: CentralRecord[] = [];
  let position = 0;
  let doneBytes = 0;
  try {
    for (const entry of files) {
      const name = Buffer.from(entry.name, 'utf8');
      const { time, date } = dosTime(entry.mtime);
      const record: CentralRecord = {
        name,
        method: 0,
        crc: 0,
        compressed: entry.size,
        size: entry.size,
        offset: position,
        time,
        date,
      };
      const zip64 = entry.size >= U32;
      if (entry.size <= DEFLATE_MAX_BYTES) {
        const data = await fs.readFile(entry.file);
        record.size = data.length;
        record.crc = zlib.crc32(data);
        const deflated = zlib.deflateRawSync(data);
        const body = deflated.length < data.length ? deflated : data;
        record.method = body === data ? 0 : 8;
        record.compressed = body.length;
        const header = localHeader(record, false);
        await handle.write(header, 0, header.length, position);
        await handle.write(body, 0, body.length, position + header.length);
        position += header.length + body.length;
      } else {
        // Sizes are known from stat; the CRC is patched in after the copy.
        const header = localHeader(record, zip64);
        const copied = await copyInto(handle, entry.file, position + header.length);
        if (copied.bytes !== entry.size) {
          throw new PackError(`${entry.name} changed while it was packed.`);
        }
        record.crc = copied.crc;
        const patched = localHeader(record, zip64);
        await handle.write(patched, 0, patched.length, position);
        position += header.length + copied.bytes;
      }
      records.push(record);
      doneBytes += entry.size;
      onProgress?.({ doneBytes, totalBytes });
    }
    const central = Buffer.concat(records.map(centralHeader));
    const end = endRecords(records.length, position, central.length);
    await handle.write(central, 0, central.length, position);
    await handle.write(end, 0, end.length, position + central.length);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(partial, { force: true });
    throw error;
  }
  await handle.close();
  await fs.rename(partial, output);
  return { files: records.length, bytes: totalBytes };
}

// ---------------------------------------------------------------------------------------------
// Unpack

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  /** Unix mode from the external attributes (0 when the archive was not made on Unix). */
  mode: number;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new PackError('The archive is cut short.');
  return buffer;
}

function readZip64(extra: Buffer, wanted: { size: boolean; compressed: boolean; offset: boolean }) {
  const out: { size?: number; compressed?: number; offset?: number } = {};
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const length = extra.readUInt16LE(i + 2);
    if (id === 0x0001) {
      let p = i + 4;
      const next = (): number => {
        if (p + 8 > i + 4 + length) throw new PackError('A Zip64 field is damaged.');
        const value = Number(extra.readBigUInt64LE(p));
        p += 8;
        return value;
      };
      if (wanted.size) out.size = next();
      if (wanted.compressed) out.compressed = next();
      if (wanted.offset) out.offset = next();
      return out;
    }
    i += 4 + length;
  }
  return out;
}

/** The central directory of the zip at `handle`. */
export async function readEntries(handle: FileHandle): Promise<ZipEntry[]> {
  const { size } = await handle.stat();
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = await readAt(handle, size - tailLength, tailLength);
  let endAt = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_END) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new PackError('This file is not a zip archive.');
  let count = tail.readUInt16LE(endAt + 10);
  let cdSize = tail.readUInt32LE(endAt + 12);
  let cdOffset = tail.readUInt32LE(endAt + 16);
  if ((count === U16 || cdSize === U32 || cdOffset === U32) && endAt >= 20) {
    const locator = tail.subarray(endAt - 20, endAt);
    if (locator.readUInt32LE(0) === SIG_LOCATOR64) {
      const end64 = await readAt(handle, Number(locator.readBigUInt64LE(8)), 56);
      if (end64.readUInt32LE(0) !== SIG_END64) throw new PackError('The Zip64 end is damaged.');
      count = Number(end64.readBigUInt64LE(32));
      cdSize = Number(end64.readBigUInt64LE(40));
      cdOffset = Number(end64.readBigUInt64LE(48));
    }
  }
  if (count > MAX_ENTRIES) throw new PackError('The archive has too many entries.');
  if (cdOffset + cdSize > size) throw new PackError('The archive is cut short.');
  const cd = await readAt(handle, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new PackError('The archive directory is damaged.');
    }
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressed = cd.readUInt32LE(p + 20);
    let entrySize = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    const madeBy = cd.readUInt16LE(p + 4) >> 8;
    const external = cd.readUInt32LE(p + 38);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    const big = readZip64(extra, {
      size: entrySize === U32,
      compressed: compressed === U32,
      offset: offset === U32,
    });
    entrySize = big.size ?? entrySize;
    compressed = big.compressed ?? compressed;
    offset = big.offset ?? offset;
    entries.push({
      name,
      method,
      flags,
      crc,
      compressed,
      size: entrySize,
      offset,
      mode: madeBy === 3 ? external >>> 16 : 0,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Why an entry name is refused, or null. Names are relative, `/`-separated, inside one
 * `*.cstudio` folder, without `.` or `..` segments, backslashes, drive letters or control
 * characters.
 */
export function checkEntryName(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return `unsafe name “${name}”`;
  }
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return `unsafe name “${name}”`;
  if (!parts[0]?.endsWith(PROJECT_EXTENSION)) {
    return `“${name}” is not inside a ${PROJECT_EXTENSION} folder`;
  }
  return null;
}

/** The project folder name inside a pack (its first segment), after checking every entry. */
export function packedFolder(entries: readonly ZipEntry[]): string {
  if (entries.length === 0) throw new PackError('The archive is empty.');
  let folder: string | null = null;
  for (const entry of entries) {
    const problem = checkEntryName(entry.name);
    if (problem) throw new PackError(`This is not a Capture Studio pack: ${problem}.`);
    const top = entry.name.split('/')[0] ?? '';
    if (folder !== null && top !== folder) {
      throw new PackError('This is not a Capture Studio pack: it holds more than one folder.');
    }
    folder = top;
    if (entry.flags & 0x0001) throw new PackError('Encrypted archives are not supported.');
    if (entry.method !== 0 && entry.method !== 8) {
      throw new PackError(`“${entry.name}” uses a compression method that is not supported.`);
    }
    const type = entry.mode & 0o170000;
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
      throw new PackError(`“${entry.name}” is a link or special file.`);
    }
  }
  if (folder === null || !entries.some((e) => e.name === `${folder}/project.json`)) {
    throw new PackError('This is not a Capture Studio pack: it has no project.json.');
  }
  return folder;
}

/** The `length` bytes at `start`, in chunks (a stream that never closes the shared handle). */
async function* chunks(handle: FileHandle, start: number, length: number): AsyncGenerator<Buffer> {
  for (let done = 0; done < length;) {
    const size = Math.min(1 << 20, length - done);
    yield await readAt(handle, start + done, size);
    done += size;
  }
}

async function extractEntry(handle: FileHandle, entry: ZipEntry, target: string): Promise<void> {
  const local = await readAt(handle, entry.offset, 30);
  if (local.readUInt32LE(0) !== SIG_LOCAL) throw new PackError(`“${entry.name}” is damaged.`);
  const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let crc = 0;
  let bytes = 0;
  const source =
    entry.compressed > 0 ? Readable.from(chunks(handle, start, entry.compressed)) : null;
  const out = await fs.open(target, 'wx');
  try {
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > entry.size) {
          callback(new PackError(`“${entry.name}” is larger than the archive says.`));
          return;
        }
        crc = zlib.crc32(chunk, crc);
        out.write(chunk).then(() => callback(), callback);
      },
    });
    if (source) {
      await (entry.method === 8
        ? pipeline(source, zlib.createInflateRaw(), sink)
        : pipeline(source, sink));
    }
  } finally {
    await out.close();
  }
  if (bytes !== entry.size || crc >>> 0 !== entry.crc >>> 0) {
    throw new PackError(`“${entry.name}” is damaged (size or checksum does not match).`);
  }
}

/**
 * Unpacks the pack at `zipFile` into `destDir/<folder>` where `<folder>` is the packed folder
 * name, or the name `chooseFolder` gives for it (to avoid an existing one). Resolves with the
 * new project folder.
 */
export async function unpackProject(
  zipFile: string,
  destDir: string,
  chooseFolder: (packed: string) => Promise<string> = (packed) => Promise.resolve(packed),
): Promise<string> {
  const handle = await fs.open(zipFile, 'r');
  try {
    const entries = await readEntries(handle);
    const packed = packedFolder(entries);
    const folder = await chooseFolder(packed);
    if (checkEntryName(`${folder}/x`)) throw new PackError(`Invalid folder name “${folder}”.`);
    const final = path.join(destDir, folder);
    const temp = path.join(destDir, `.${folder}.unpacking`);
    await fs.rm(temp, { recursive: true, force: true });
    await fs.mkdir(temp, { recursive: true });
    try {
      for (const entry of entries) {
        const relative = entry.name.slice(packed.length + 1);
        if (relative === '' || entry.name.endsWith('/')) continue;
        const target = path.join(temp, ...relative.split('/'));
        // checkEntryName already refuses `..`; this keeps it true whatever the platform does.
        if (!target.startsWith(temp + path.sep)) throw new PackError(`unsafe name “${entry.name}”`);
        await extractEntry(handle, entry, target);
      }
      await fs.rename(temp, final);
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true });
      throw error;
    }
    return final;
  } finally {
    await handle.close();
  }
}
