/**
 * Automation wiring: the socket follows the setting, editors announce themselves, and replies
 * reach the right link.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationSocketPath, registerAutomation } from '../../src/main/ipc/automation-handlers';
import { silentLogger } from '../../src/shared/logger';
import { createDefaultSettings, type Settings } from '../../src/shared/settings/schema';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-automation-wiring-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function setup(enabled: boolean) {
  let settings: Settings = {
    ...createDefaultSettings({ projectsDir: '/p', exportsDir: '/e' }),
    automation: { enabled },
  };
  const listeners = new Set<(s: Settings) => void>();
  const handlers = new Map<string, (payload: unknown, context: { senderId: number }) => unknown>();
  const closed = new Set<(projectId: string) => void>();
  const editorContents = { id: 21, isDestroyed: () => false };
  const send = vi.fn(() => true);
  const handle = registerAutomation({
    router: {
      handle: ((
        channel: string,
        fn: (payload: unknown, context: { senderId: number }) => unknown,
      ) => handlers.set(channel, fn)) as never,
      send,
    },
    editorHost: {
      open: () => ({ webContents: editorContents }),
      contentsOf: (projectId) => (projectId === 'prj_A' ? editorContents : null),
      openProjects: ['prj_A'],
      onWindowClosed: (listener) => {
        closed.add(listener);
        return () => closed.delete(listener);
      },
    },
    settings: {
      get: () => settings,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    socketPath: automationSocketPath(dir),
    appVersion: '0.1.0',
    listProjects: () => Promise.resolve([]),
    readProject: () => Promise.resolve(null),
    peaksFile: () => Promise.resolve({ status: 'unavailable', path: null }),
    exports: {
      start: () => Promise.reject(new Error('unused')),
      cancel: () => undefined,
      onJobEvent: () => () => undefined,
    },
    logger: silentLogger,
  });
  const flip = (on: boolean) => {
    settings = { ...settings, automation: { enabled: on } };
    for (const l of listeners) l(settings);
  };
  return { handle, handlers, flip, send };
}

describe('registerAutomation', () => {
  it('listens only while automation is on', async () => {
    const { handle, flip } = setup(false);
    const socketPath = automationSocketPath(dir);
    expect(socketPath).toBe(path.join(dir, 'automation', 'automation.sock'));
    await vi.waitFor(() => expect(handle.listening).toBe(false));
    expect(await canConnect(socketPath)).toBe(false);

    flip(true);
    await vi.waitFor(() => expect(handle.listening).toBe(true));
    expect(await canConnect(socketPath)).toBe(true);

    flip(false);
    await vi.waitFor(() => expect(handle.listening).toBe(false));
    expect(await canConnect(socketPath)).toBe(false);
    await handle.dispose();
  });

  it('routes editor readiness and replies to the editor links', async () => {
    const { handle, handlers, send } = setup(true);
    await vi.waitFor(() => expect(handle.listening).toBe(true));
    // A ready claim from the project's own window is accepted; the link then sends commands.
    await handlers.get('automation.ready')?.({ projectId: 'prj_A' }, { senderId: 21 });
    const socket = net.createConnection(automationSocketPath(dir));
    await new Promise((r) => socket.once('connect', r));
    const reply = new Promise<string>((resolve) =>
      socket.once('data', (d) => resolve(d.toString())),
    );
    socket.write(
      `${JSON.stringify({ id: 1, method: 'project.undo', params: { projectId: 'prj_A' } })}\n`,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const request = (send.mock.calls[0] as unknown[])[2] as { requestId: number; command: string };
    expect(request.command).toBe('undo');
    await handlers.get('automation.reply')?.(
      { requestId: request.requestId, ok: false, error: { code: 'busy', message: 'dragging' } },
      { senderId: 21 },
    );
    expect(JSON.parse(await reply)).toEqual({
      id: 1,
      ok: false,
      error: { code: 'busy', message: 'dragging' },
    });
    socket.destroy();
    await handle.dispose();
  });
});
