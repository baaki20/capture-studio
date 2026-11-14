/**
 * Pack and Unpack (R2.34): a project folder round-trips through a zip without `cache/`; the zip
 * is standard (Python's `zipfile` reads it, and Zip64 archives it writes unpack); unsafe or
 * damaged archives are refused and leave nothing behind.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkEntryName,
  filesToPack,
  packProject,
  unpackProject,
} from '../../src/main/projects/pack';

let work: string;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-pack-'));
});
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

/** Runs Python with `script`, passing `args` (no shell). */
function python(script: string, ...args: string[]): string {
  // UTF-8 output whatever the console code page (Windows defaults to a legacy one).
  return execFileSync('python3', ['-I', '-c', script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}

async function makeProject(): Promise<string> {
  const root = path.join(work, 'Lesson ü.cstudio');
  await fs.mkdir(path.join(root, 'media'), { recursive: true });
  await fs.mkdir(path.join(root, 'cache'), { recursive: true });
  await fs.mkdir(path.join(root, 'logs'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({ id: 'x', pad: 'a'.repeat(5000) }),
  );
  // Larger than the in-memory limit, so it is streamed and its CRC patched in.
  const big = Buffer.alloc(17 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
  await fs.writeFile(path.join(root, 'media', 'screen.mp4'), big);
  await fs.writeFile(path.join(root, 'media', 'empty.bin'), '');
  await fs.writeFile(path.join(root, 'cache', 'peaks.bin'), 'regenerated');
  await fs.writeFile(path.join(root, 'project.json.tmp'), 'leftover');
  await fs.writeFile(path.join(root, 'logs', 'recording.json'), '{}');
  await fs.symlink('/etc/hostname', path.join(root, 'media', 'link'));
  return root;
}

describe('pack', () => {
  it('lists every file except cache/, temp files and links', async () => {
    const root = await makeProject();
    expect((await filesToPack(root)).map((f) => f.name)).toEqual([
      'Lesson ü.cstudio/logs/recording.json',
      'Lesson ü.cstudio/media/empty.bin',
      'Lesson ü.cstudio/media/screen.mp4',
      'Lesson ü.cstudio/project.json',
    ]);
  });

  it('writes a standard zip that unpacks to the same files', async () => {
    const root = await makeProject();
    const zip = path.join(work, 'out.zip');
    const progress: number[] = [];
    const result = await packProject(root, zip, (p) => progress.push(p.doneBytes / p.totalBytes));
    expect(result.files).toBe(4);
    expect(progress.at(-1)).toBe(1);
    // An independent reader agrees (names, sizes, checksums).
    const listed = python(
      'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint("\\n".join(i.filename + " " + str(i.compress_type) for i in z.infolist()))',
      zip,
    );
    expect(listed).toContain('Lesson ü.cstudio/project.json 8');
    expect(listed).toContain('Lesson ü.cstudio/media/screen.mp4 0');

    const dest = path.join(work, 'dest');
    await fs.mkdir(dest);
    const unpacked = await unpackProject(zip, dest, () => Promise.resolve('Copy.cstudio'));
    expect(unpacked).toBe(path.join(dest, 'Copy.cstudio'));
    for (const rel of [
      'project.json',
      'media/screen.mp4',
      'media/empty.bin',
      'logs/recording.json',
    ]) {
      const [copy, original] = await Promise.all([
        fs.readFile(path.join(unpacked, rel)),
        fs.readFile(path.join(root, rel)),
      ]);
      expect(copy.equals(original), rel).toBe(true);
    }
    await expect(fs.stat(path.join(unpacked, 'cache'))).rejects.toThrow();
    expect(await fs.readdir(dest)).toEqual(['Copy.cstudio']);
  });

  it('refuses a folder that is not a project', async () => {
    await fs.mkdir(path.join(work, 'Other'));
    await expect(packProject(path.join(work, 'Other'), path.join(work, 'o.zip'))).rejects.toThrow(
      /Only project folders/,
    );
  });
});

describe('unpack', () => {
  /** A zip made by Python: `entries` as [name, text]; Zip64 and deflate when asked. */
  function pyZip(file: string, entries: [string, string][], options = '') {
    python(
      `import sys, json, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", ${options || 'zipfile.ZIP_STORED'}) as z:\n  for n, t in json.loads(sys.argv[2]):\n    with z.open(n, "w", force_zip64=True) as f: f.write(t.encode())`,
      file,
      JSON.stringify(entries),
    );
  }

  it('reads Zip64 and deflated archives made by other tools', async () => {
    const zip = path.join(work, 'py.zip');
    pyZip(
      zip,
      [
        ['Py.cstudio/project.json', '{"a":1}'],
        ['Py.cstudio/media/a.txt', 'hello '.repeat(1000)],
      ],
      'zipfile.ZIP_DEFLATED',
    );
    const root = await unpackProject(zip, work);
    expect(await fs.readFile(path.join(root, 'media', 'a.txt'), 'utf8')).toBe(
      'hello '.repeat(1000),
    );
  });

  it.each([
    [[['../evil.cstudio/project.json', '{}']], /unsafe name/],
    [[['/abs.cstudio/project.json', '{}']], /unsafe name/],
    [[['A.cstudio/../../x', '{}']], /unsafe name/],
    [
      [
        ['A.cstudio/project.json', '{}'],
        ['B.cstudio/project.json', '{}'],
      ],
      /more than one folder/,
    ],
    [[['A.cstudio/media/x', '{}']], /no project.json/],
    [[['notes/project.json', '{}']], /not inside/],
  ] as [[string, string][], RegExp][])('refuses %j', async (entries, why) => {
    const zip = path.join(work, 'bad.zip');
    pyZip(zip, entries);
    const dest = path.join(work, 'dest');
    await fs.mkdir(dest);
    await expect(unpackProject(zip, dest)).rejects.toThrow(why);
    expect(await fs.readdir(dest)).toEqual([]);
  });

  it('refuses links, damaged data and files that are not zips', async () => {
    const zip = path.join(work, 'link.zip');
    python(
      'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1], "w")\nz.writestr("L.cstudio/project.json", "{}")\ni = zipfile.ZipInfo("L.cstudio/media/l")\ni.create_system = 3\ni.external_attr = (0o120777 << 16)\nz.writestr(i, "/etc/passwd")\nz.close()',
      zip,
    );
    await expect(unpackProject(zip, work)).rejects.toThrow(/link or special/);

    const good = path.join(work, 'good.zip');
    pyZip(good, [['G.cstudio/project.json', '{"value":"abcdefgh"}']]);
    const bytes = await fs.readFile(good);
    bytes[bytes.indexOf('abcdefgh')] = 0x78;
    await fs.writeFile(good, bytes);
    const dest = path.join(work, 'dest');
    await fs.mkdir(dest);
    await expect(unpackProject(good, dest)).rejects.toThrow(/damaged/);
    expect(await fs.readdir(dest)).toEqual([]);

    await fs.writeFile(path.join(work, 'plain.zip'), 'not a zip');
    await expect(unpackProject(path.join(work, 'plain.zip'), work)).rejects.toThrow(/not a zip/);
  });

  it('checks entry names', () => {
    expect(checkEntryName('A.cstudio/media/screen.mp4')).toBeNull();
    expect(checkEntryName('A.cstudio/')).toBeNull();
    for (const bad of [
      'A.cstudio\\x',
      'C:/A.cstudio/x',
      'A.cstudio//x',
      'A.cstudio/./x',
      'A.cstudio/a\u0001',
    ]) {
      expect(checkEntryName(bad)).toMatch(/unsafe/);
    }
  });
});
