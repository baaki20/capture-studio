import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listWeeklyBackups,
  quarantineFile,
  readFileWithFallback,
  rotateWeeklyBackup,
  writeFileAtomic,
} from '../../src/main/settings/atomic-file';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-atomic-'));
  file = path.join(dir, 'doc.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const parseJson = (text: string): unknown => JSON.parse(text);

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp file', async () => {
    await writeFileAtomic(file, '{"v":1}');
    expect(await fs.readFile(file, 'utf8')).toBe('{"v":1}');
    expect((await fs.readdir(dir)).sort()).toEqual(['doc.json']);
  });

  it('keeps the previous version as .bak', async () => {
    await writeFileAtomic(file, '{"v":1}');
    await writeFileAtomic(file, '{"v":2}');
    await writeFileAtomic(file, '{"v":3}');
    expect(await fs.readFile(file, 'utf8')).toBe('{"v":3}');
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('{"v":2}');
    expect((await fs.readdir(dir)).sort()).toEqual(['doc.json', 'doc.json.bak']);
  });

  it('can skip the backup and set a file mode', async () => {
    await writeFileAtomic(file, 'a', { backup: false });
    await writeFileAtomic(file, 'b', { backup: false, mode: 0o600 });
    expect(await fs.readdir(dir)).toEqual(['doc.json']);
    if (process.platform !== 'win32') {
      await writeFileAtomic(path.join(dir, 'secret.json'), 's', { mode: 0o600 });
      expect((await fs.stat(path.join(dir, 'secret.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('creates missing parent folders', async () => {
    const nested = path.join(dir, 'a', 'b', 'c.json');
    await writeFileAtomic(nested, 'x');
    expect(await fs.readFile(nested, 'utf8')).toBe('x');
  });
});

describe('readFileWithFallback (load order file → .tmp → .bak → weekly)', () => {
  it('reports a missing file', async () => {
    expect(await readFileWithFallback(file, parseJson)).toEqual({ status: 'missing' });
  });

  it('prefers the main file', async () => {
    await fs.writeFile(file, '{"v":"file"}');
    await fs.writeFile(`${file}.bak`, '{"v":"bak"}');
    const result = await readFileWithFallback(file, parseJson);
    expect(result).toMatchObject({
      status: 'loaded',
      source: 'file',
      value: { v: 'file' },
      failures: [],
    });
  });

  it('falls back to .tmp when the file is corrupt (killed between write and rename)', async () => {
    await fs.writeFile(file, '{"v":"fi'); // truncated
    await fs.writeFile(`${file}.tmp`, '{"v":"tmp"}');
    await fs.writeFile(`${file}.bak`, '{"v":"bak"}');
    const result = await readFileWithFallback(file, parseJson);
    expect(result).toMatchObject({ status: 'loaded', source: 'tmp', value: { v: 'tmp' } });
    expect(result.status === 'loaded' && result.failures.map((f) => f.source)).toEqual(['file']);
  });

  it('falls back to .bak, then to the newest weekly copy', async () => {
    const weeklyDir = path.join(dir, 'Backup');
    await fs.mkdir(weeklyDir);
    await fs.writeFile(path.join(weeklyDir, 'doc-20261001T000000Z.json'), '{"v":"old weekly"}');
    await fs.writeFile(path.join(weeklyDir, 'doc-20261015T000000Z.json'), '{"v":"new weekly"}');
    await fs.writeFile(file, 'garbage');
    await fs.writeFile(`${file}.tmp`, '');
    await fs.writeFile(`${file}.bak`, '{"v":"bak"}');

    expect(await readFileWithFallback(file, parseJson, { weeklyDir })).toMatchObject({
      source: 'bak',
    });

    await fs.writeFile(`${file}.bak`, '\u0000\u0000');
    const result = await readFileWithFallback(file, parseJson, { weeklyDir });
    expect(result).toMatchObject({
      status: 'loaded',
      source: 'weekly',
      value: { v: 'new weekly' },
    });
  });

  it('treats a parse that throws (failed validation) like corruption', async () => {
    await fs.writeFile(file, '{"v":-1}');
    await fs.writeFile(`${file}.bak`, '{"v":1}');
    const result = await readFileWithFallback(file, (text) => {
      const value = JSON.parse(text) as { v: number };
      if (value.v < 0) throw new Error('negative');
      return value;
    });
    expect(result).toMatchObject({ status: 'loaded', source: 'bak', value: { v: 1 } });
    expect(result.status === 'loaded' && result.failures[0]?.error).toBe('negative');
  });

  it('reports unreadable when every copy is bad', async () => {
    await fs.writeFile(file, 'bad');
    await fs.writeFile(`${file}.bak`, 'also bad');
    const result = await readFileWithFallback(file, parseJson);
    expect(result.status).toBe('unreadable');
    expect(result.status === 'unreadable' && result.failures.map((f) => f.source)).toEqual([
      'file',
      'bak',
    ]);
  });
});

describe('weekly backups', () => {
  it('copies at most once per interval and keeps the newest N', async () => {
    const weeklyDir = path.join(dir, 'Backup');
    await fs.writeFile(file, '{}');
    let now = new Date('2026-01-01T00:00:00Z');
    const opts = { dir: weeklyDir, keep: 3, now: () => now };

    expect(await rotateWeeklyBackup(file, opts)).toMatch(/doc-20260101T000000Z\.json$/);
    now = new Date('2026-01-03T00:00:00Z');
    expect(await rotateWeeklyBackup(file, opts)).toBeNull(); // younger than a week

    for (let week = 1; week <= 4; week++) {
      now = new Date(Date.UTC(2026, 0, 1 + week * 7));
      await rotateWeeklyBackup(file, opts);
    }
    const kept = await listWeeklyBackups(file, weeklyDir);
    expect(kept.map((b) => path.basename(b.path))).toEqual([
      'doc-20260129T000000Z.json',
      'doc-20260122T000000Z.json',
      'doc-20260115T000000Z.json',
    ]);
  });
});

describe('quarantineFile', () => {
  it('moves a damaged file aside', async () => {
    await fs.writeFile(file, 'bad');
    const moved = await quarantineFile(file, new Date('2026-10-24T10:00:00Z'));
    expect(moved).toBe(`${file}.corrupt-20261024T100000Z`);
    expect(await fs.readFile(moved!, 'utf8')).toBe('bad');
    expect(await quarantineFile(file)).toBeNull();
  });
});
