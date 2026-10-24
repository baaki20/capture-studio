import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMediaHandler,
  mediaUrl,
  mimeTypeFor,
  parseRange,
  ProjectRootRegistry,
  resolveMediaPath,
} from '../../src/main/projects/media-protocol';

let base: string;
let root: string;
const registry = new ProjectRootRegistry();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const handler = createMediaHandler({ registry, logger, allowedOrigins: ['http://localhost:5173'] });
const CONTENT = Buffer.from('0123456789abcdefghij'); // 20 bytes
const ID = 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0';

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-media-')));
  root = path.join(base, 'Lesson.cstudio');
  await fs.mkdir(path.join(root, 'media'), { recursive: true });
  await fs.mkdir(path.join(root, 'cache'), { recursive: true });
  await fs.writeFile(path.join(root, 'media', 'screen.mp4'), CONTENT);
  await fs.writeFile(path.join(root, 'media', 'with space #1.mp4'), CONTENT);
  await fs.writeFile(path.join(root, 'cache', 'empty.peaks'), '');
  await fs.writeFile(path.join(base, 'secret.txt'), 'top secret');
  await fs.writeFile(path.join(base, 'Lesson.cstudio-evil'), 'sibling');
  // Symlinks: one escaping the project, one staying inside.
  await fs.symlink(path.join(base, 'secret.txt'), path.join(root, 'media', 'escape.mp4'));
  await fs.symlink(base, path.join(root, 'outside-dir'));
  await fs.symlink(path.join(root, 'media', 'screen.mp4'), path.join(root, 'media', 'alias.mp4'));
  registry.register(ID, root);
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  handler(new Request(url, { method, headers }));

describe('cs-media protocol (§4.3.10, R1.52)', () => {
  it('serves a project file with the spec headers', async () => {
    const res = await get(mediaUrl(ID, 'media/screen.mp4'));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONTENT);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Content-Length')).toBe('20');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('matches project ids case-insensitively and decodes path segments', async () => {
    expect(mediaUrl(ID, 'media/with space #1.mp4')).toBe(
      `cs-media://${ID.toLowerCase()}/media/with%20space%20%231.mp4`,
    );
    const res = await get(mediaUrl(ID, 'media/with space #1.mp4'));
    expect(res.status).toBe(200);
    expect((await get(`cs-media://${ID}/media/screen.mp4`)).status).toBe(200);
  });

  it('serves symlinks that stay inside the project', async () => {
    const res = await get(mediaUrl(ID, 'media/alias.mp4'));
    expect(res.status).toBe(200);
  });

  it.each([
    [
      'dot-dot (normalized by the URL parser, still inside or missing)',
      `cs-media://${ID}/../secret.txt`,
      404,
    ],
    ['encoded dot-dot', `cs-media://${ID}/media/%2e%2e/%2e%2e/secret.txt`, 404],
    ['encoded slash', `cs-media://${ID}/media/..%2f..%2fsecret.txt`, 403],
    ['encoded backslash', `cs-media://${ID}/media/..%5c..%5csecret.txt`, 403],
    ['double-encoded dot-dot segment', `cs-media://${ID}/%252e%252e/secret.txt`, 404],
    ['encoded NUL', `cs-media://${ID}/media/screen.mp4%00.txt`, 403],
    ['symlink to a file outside', mediaUrl(ID, 'media/escape.mp4'), 403],
    ['symlinked directory outside', `cs-media://${ID}/outside-dir/secret.txt`, 403],
    ['sibling folder sharing the prefix', `cs-media://${ID}/..%2fLesson.cstudio-evil`, 403],
    ['unknown project', 'cs-media://prj_unknown/media/screen.mp4', 404],
    ['project root itself', `cs-media://${ID}/`, 404],
    ['a directory', `cs-media://${ID}/media`, 404],
    ['missing file', mediaUrl(ID, 'media/none.mp4'), 404],
  ])('refuses %s', async (_name, url, status) => {
    const res = await get(url);
    expect(res.status).toBe(status);
    expect(await res.text()).toBe('');
  });

  it('never resolves an escaping path, whatever the status', async () => {
    for (const url of [
      `cs-media://${ID}/%2e%2e%2fsecret.txt`,
      `cs-media://${ID}/media/%2E%2E/%2E%2E/secret.txt`,
      `cs-media://${ID}/outside-dir/Lesson.cstudio/media/screen.mp4`,
    ]) {
      const resolved = await resolveMediaPath(registry, url);
      if (resolved.ok) expect(resolved.path.startsWith(root + path.sep)).toBe(true);
    }
  });

  it('logs refused traversal attempts', async () => {
    logger.warn.mockClear();
    await get(mediaUrl(ID, 'media/escape.mp4'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('leaves the project folder'));
  });

  it('answers Range requests with 206 and Content-Range', async () => {
    const mid = await get(mediaUrl(ID, 'media/screen.mp4'), { Range: 'bytes=2-5' });
    expect(mid.status).toBe(206);
    expect(mid.headers.get('Content-Range')).toBe('bytes 2-5/20');
    expect(mid.headers.get('Content-Length')).toBe('4');
    expect(await mid.text()).toBe('2345');

    const open = await get(mediaUrl(ID, 'media/screen.mp4'), { Range: 'bytes=15-' });
    expect(await open.text()).toBe('fghij');
    const suffix = await get(mediaUrl(ID, 'media/screen.mp4'), { Range: 'bytes=-3' });
    expect(suffix.headers.get('Content-Range')).toBe('bytes 17-19/20');
    expect(await suffix.text()).toBe('hij');
    const clamped = await get(mediaUrl(ID, 'media/screen.mp4'), { Range: 'bytes=18-99' });
    expect(await clamped.text()).toBe('ij');
  });

  it('answers 416 for unsatisfiable ranges', async () => {
    const res = await get(mediaUrl(ID, 'media/screen.mp4'), { Range: 'bytes=20-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */20');
  });

  it('supports HEAD, refuses other methods, serves empty files', async () => {
    const head = await get(mediaUrl(ID, 'media/screen.mp4'), {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('20');
    expect((await get(mediaUrl(ID, 'media/screen.mp4'), {}, 'POST')).status).toBe(405);
    const empty = await get(mediaUrl(ID, 'cache/empty.peaks'));
    expect(empty.status).toBe(200);
    expect(empty.headers.get('Content-Length')).toBe('0');
    expect(empty.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('allows CORS reads only from app origins', async () => {
    const app = await get(mediaUrl(ID, 'media/screen.mp4'), { Origin: 'http://localhost:5173' });
    expect(app.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    const other = await get(mediaUrl(ID, 'media/screen.mp4'), { Origin: 'https://evil.example' });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('stops serving a project once it is unregistered', () => {
    const other = new ProjectRootRegistry();
    other.register('prj_x', root);
    other.unregister('PRJ_X');
    expect(other.resolve('prj_x')).toBeNull();
  });
});

describe('parseRange', () => {
  it.each([
    [null, null],
    ['items=0-1', null],
    ['bytes=0-1,4-5', null],
    ['bytes=-', null],
    ['bytes=0-0', { start: 0, end: 0 }],
    ['bytes = 3 - 4', { start: 3, end: 4 }],
    ['bytes=5-2', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=-50', { start: 0, end: 9 }],
  ])('%j → %j (size 10)', (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected);
  });

  it('maps extensions to MIME types', () => {
    expect(mimeTypeFor('a/b.MP4')).toBe('video/mp4');
    expect(mimeTypeFor('x.thumbs.0.jpg')).toBe('image/jpeg');
    expect(mimeTypeFor('x.json')).toBe('application/json');
    expect(mimeTypeFor('x.exe')).toBe('application/octet-stream');
  });
});
