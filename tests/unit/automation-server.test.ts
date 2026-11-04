/**
 * The automation socket: a private folder and 0600 socket, only listed methods, validated params
 * and results, coded errors, and a line-length cap.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AutomationFailure,
  AutomationServer,
  type AutomationHandlers,
} from '../../src/main/automation/automation-server';

let dir: string;
let server: AutomationServer | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-automation-'));
});

afterEach(async () => {
  await server?.stop();
  server = null;
  await fs.rm(dir, { recursive: true, force: true });
});

const unused = () => Promise.reject(new Error('unused'));

function handlers(overrides: Partial<AutomationHandlers> = {}): AutomationHandlers {
  return {
    hello: () =>
      Promise.resolve({ app: 'capture-studio', appVersion: '0.1.0', protocolVersion: 1 }),
    'projects.list': () => Promise.resolve({ projects: [] }),
    'project.get': unused,
    'project.edit': unused,
    'project.undo': unused,
    'project.redo': unused,
    'audio.silences': unused,
    'preview.frame': unused,
    'export.start': unused,
    'export.status': unused,
    'export.cancel': unused,
    ...overrides,
  };
}

async function start(overrides: Partial<AutomationHandlers> = {}, maxLineBytes?: number) {
  const socketPath = path.join(dir, 'automation', 'automation.sock');
  server = new AutomationServer({
    socketPath,
    handlers: handlers(overrides),
    ...(maxLineBytes ? { maxLineBytes } : {}),
  });
  await server.start();
  return socketPath;
}

/** Sends raw lines and collects one parsed reply per line (or until the socket closes). */
async function exchange(socketPath: string, lines: string[]): Promise<unknown[]> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const replies: unknown[] = [];
  let buffered = '';
  const done = new Promise<void>((resolve) => {
    socket.on('data', (chunk) => {
      buffered += chunk.toString();
      let i = buffered.indexOf('\n');
      while (i >= 0) {
        replies.push(JSON.parse(buffered.slice(0, i)));
        buffered = buffered.slice(i + 1);
        i = buffered.indexOf('\n');
      }
      if (replies.length >= lines.length) resolve();
    });
    socket.on('close', () => resolve());
  });
  for (const line of lines) socket.write(`${line}\n`);
  await done;
  socket.destroy();
  return replies;
}

describe('AutomationServer', () => {
  it('creates a private folder and a 0600 socket, and removes it on stop', async () => {
    const socketPath = await start();
    expect((await fs.stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
    await server?.stop();
    await expect(fs.stat(socketPath)).rejects.toThrow();
  });

  it('answers listed methods and refuses everything else with a code', async () => {
    const socketPath = await start();
    const replies = await exchange(socketPath, [
      JSON.stringify({ id: 1, method: 'hello', params: { client: 'test', protocolVersion: 1 } }),
      JSON.stringify({ id: 2, method: 'eval', params: { code: '1' } }),
      JSON.stringify({ id: 3, method: 'toString' }),
      JSON.stringify({ id: 4, method: 'project.get', params: { projectId: '../etc' } }),
      'not json',
      JSON.stringify({ id: 5 }),
      JSON.stringify({ id: 6, method: 'projects.list' }),
    ]);
    // Replies come back as each request finishes, so compare them as a set.
    expect(replies).toHaveLength(7);
    expect(replies).toEqual(
      expect.arrayContaining([
        {
          id: 1,
          ok: true,
          result: { app: 'capture-studio', appVersion: '0.1.0', protocolVersion: 1 },
        },
        { id: 2, ok: false, error: expect.objectContaining({ code: 'unknown-method' }) as unknown },
        { id: 3, ok: false, error: expect.objectContaining({ code: 'unknown-method' }) as unknown },
        { id: 4, ok: false, error: expect.objectContaining({ code: 'invalid-params' }) as unknown },
        { id: null, ok: false, error: { code: 'bad-request', message: 'not valid JSON' } },
        { id: 5, ok: false, error: expect.objectContaining({ code: 'bad-request' }) as unknown },
        { id: 6, ok: true, result: { projects: [] } },
      ]),
    );
  });

  it('passes on coded refusals and hides other failures behind internal', async () => {
    const socketPath = await start({
      'project.undo': () =>
        Promise.reject(new AutomationFailure('busy', 'dragging', { retryAfterMs: 500 })),
      'project.redo': () => Promise.reject(new Error('kaboom')),
      'export.status': () => Promise.resolve({ nonsense: true } as never),
    });
    const ref = { projectId: 'prj_A' };
    const replies = await exchange(socketPath, [
      JSON.stringify({ id: 1, method: 'project.undo', params: ref }),
      JSON.stringify({ id: 2, method: 'project.redo', params: ref }),
      JSON.stringify({ id: 3, method: 'export.status', params: { jobId: 'job_A' } }),
    ]);
    const byId = new Map((replies as { id: number }[]).map((r) => [r.id, r]));
    expect(byId.get(1)).toEqual({
      id: 1,
      ok: false,
      error: { code: 'busy', message: 'dragging', details: { retryAfterMs: 500 } },
    });
    expect(byId.get(2)).toEqual({
      id: 2,
      ok: false,
      error: { code: 'internal', message: 'kaboom' },
    });
    expect(byId.get(3)).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('closes connections that send over-long lines', async () => {
    const socketPath = await start({}, 64);
    const replies = await exchange(socketPath, ['x'.repeat(200)]);
    expect(replies).toEqual([
      { id: null, ok: false, error: { code: 'bad-request', message: 'request line too long' } },
    ]);
  });
});
