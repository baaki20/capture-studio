/**
 * Present but unusable media (R1.29, defect D-4): unreadable, empty, truncated or not media at
 * all is offline like a missing file, with the reason.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkMediaPresence } from '../../src/main/projects/editor-media';
import { inspectMediaFile, MediaHealthCache } from '../../src/main/projects/media-check';
import { exampleProject } from '../fixtures/example-project';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-media-check-'));
});

afterEach(async () => {
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

/** A minimal faststart MP4: ftyp, moov(trak), mdat. */
function mp4(): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1')),
    box(
      'moov',
      Buffer.concat([box('mvhd', Buffer.alloc(100)), box('trak', box('tkhd', Buffer.alloc(84)))]),
    ),
    box('mdat', Buffer.alloc(4096, 7)),
  ]);
}

async function write(name: string, data: Buffer | string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  return file;
}

describe('inspectMediaFile', () => {
  it('accepts a well-formed MP4 and other media signatures', async () => {
    expect(await inspectMediaFile(await write('ok.mp4', mp4()))).toEqual({ state: 'ok' });
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    expect(await inspectMediaFile(await write('x.webm', webm))).toEqual({ state: 'ok' });
    const wav = Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1');
    expect(await inspectMediaFile(await write('x.wav', wav))).toEqual({ state: 'ok' });
  });

  it('reports missing, empty, truncated, garbage and stream-less files', async () => {
    expect(await inspectMediaFile(path.join(dir, 'gone.mp4'))).toEqual({ state: 'missing' });
    expect(await inspectMediaFile(await write('empty.mp4', ''))).toMatchObject({
      state: 'unreadable',
      reason: 'the file is empty',
    });
    const whole = mp4();
    const truncated = await inspectMediaFile(
      await write('cut.mp4', whole.subarray(0, whole.length - 100)),
    );
    expect(truncated).toMatchObject({ state: 'unreadable' });
    expect(truncated.state === 'unreadable' && truncated.reason).toMatch(/truncated/);
    expect(
      await inspectMediaFile(await write('junk.mp4', 'hello, this is not a video')),
    ).toMatchObject({
      state: 'unreadable',
    });
    const noTrak = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', box('mvhd')),
      box('mdat', Buffer.alloc(8)),
    ]);
    expect(await inspectMediaFile(await write('notrak.mp4', noTrak))).toMatchObject({
      state: 'unreadable',
      reason: 'it contains no streams',
    });
  });

  it.skipIf(process.getuid?.() === 0)('reports a file without read permission', async () => {
    const file = await write('locked.mp4', mp4());
    await fs.chmod(file, 0o000);
    expect(await inspectMediaFile(file)).toEqual({
      state: 'unreadable',
      reason: 'permission denied',
    });
  });

  it('caches by size and modification time', async () => {
    const cache = new MediaHealthCache();
    const file = await write('a.mp4', mp4());
    expect(await cache.check(file)).toEqual({ state: 'ok' });
    await fs.writeFile(file, 'garbage now');
    expect((await cache.check(file)).state).toBe('unreadable');
  });
});

describe('checkMediaPresence (R1.29)', () => {
  it('marks unreadable media offline with the reason, and usable ones ok', async () => {
    const doc = exampleProject();
    const root = path.join(dir, 'P.cstudio');
    await fs.mkdir(path.join(root, 'media'), { recursive: true });
    const [screen, camera, ...rest] = doc.media;
    await fs.writeFile(path.join(root, screen!.path), 'not an mp4 at all');
    for (const m of rest) await fs.writeFile(path.join(root, m.path), mp4());
    const { doc: checked, offline } = await checkMediaPresence(root, doc, new MediaHealthCache());
    expect(checked.media.map((m) => m.status)).toEqual(['missing', 'missing', 'ok', 'ok']);
    expect(offline[screen!.id]).toMatchObject({ reason: 'unreadable' });
    expect(offline[camera!.id]).toEqual({ reason: 'missing', detail: null });
  });
});
