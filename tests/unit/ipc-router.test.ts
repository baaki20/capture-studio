import { describe, expect, it, vi } from 'vitest';
import {
  IpcRejection,
  IpcRouter,
  type IpcMainLike,
  type IpcSenderEvent,
  type WebContentsLike,
} from '../../src/main/ipc/router';
import { EngineLink } from '../../src/main/ipc/engine-link';
import { decodeIpcError, ipcErrorCode, ipcErrorMessage } from '../../src/shared/ipc/errors';

type Listener = (event: IpcSenderEvent, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
    on: (channel, listener) => listeners.set(channel, listener),
    removeAllListeners: (channel) => (channel ? listeners.delete(channel) : listeners.clear()),
  };
  return { ipcMain, handlers, listeners };
}

const APP_URL = 'file:///app/out/renderer/shell/index.html';

function event(senderId: number, url = APP_URL, parent: unknown = null): IpcSenderEvent {
  return { sender: { id: senderId }, senderFrame: { url, parent } };
}

function contents(id: number): WebContentsLike & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return { id, sent, send: (...args) => sent.push(args), isDestroyed: () => false };
}

function setup() {
  const fake = fakeIpcMain();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const router = new IpcRouter({
    ipcMain: fake.ipcMain,
    logger,
    isAppUrl: (url) => url.startsWith('file:///app/out/renderer/'),
  });
  const shell = contents(1);
  const controls = contents(2);
  const engine = contents(3);
  router.registerWindow(shell, 'shell');
  router.registerWindow(controls, 'controls');
  router.registerWindow(engine, 'engine');
  return { ...fake, logger, router, shell, controls, engine };
}

const invoke = (
  handlers: Map<string, Listener>,
  channel: string,
  e: IpcSenderEvent,
  ...args: unknown[]
) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for '${channel}'`);
  return Promise.resolve(handler(e, ...args));
};

describe('IpcRouter (R1.52)', () => {
  it('runs the handler with the validated payload and caller context', async () => {
    const { router, handlers } = setup();
    const handler = vi.fn(() => ({
      id: 'prj_1',
      name: 'x',
      createdAt: 't',
      durationUs: 1,
      components: ['screen' as const],
      thumbUrl: null,
      state: 'complete' as const,
    }));
    router.handle('library.rename', handler);
    await expect(
      invoke(handlers, 'library.rename', event(1), { id: 'prj_1', name: 'x' }),
    ).resolves.toMatchObject({ id: 'prj_1' });
    expect(handler).toHaveBeenCalledWith(
      { id: 'prj_1', name: 'x' },
      { kind: 'shell', senderId: 1 },
    );
  });

  it('rejects malformed payloads and logs them', async () => {
    const { router, handlers, logger } = setup();
    const handler = vi.fn();
    router.handle('library.trash', handler);
    for (const payload of [undefined, { id: 5 }, { id: 'a', extra: true }, 'prj_1']) {
      await expect(invoke(handlers, 'library.trash', event(1), payload)).rejects.toBeInstanceOf(
        IpcRejection,
      );
    }
    await expect(
      invoke(handlers, 'library.trash', event(1), { id: 'a' }, { id: 'b' }),
    ).rejects.toThrow('invalid payload');
    expect(handler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('rejected malformed library.trash payload'),
    );
  });

  it('rejects unknown senders, subframes, foreign URLs and disallowed windows', async () => {
    const { router, handlers, logger } = setup();
    const handler = vi.fn(() => undefined);
    router.handle('rec.configure', handler);
    const config = {
      captureMode: 'fullscreen',
      cameraId: null,
      micId: null,
      systemAudio: false,
      micProcessing: { ec: false, ns: false, agc: false },
      fps: 30,
      quality: 'standard',
      countdownSec: 0,
    };
    await expect(invoke(handlers, 'rec.configure', event(99), config)).rejects.toThrow(
      'not allowed',
    );
    await expect(invoke(handlers, 'rec.configure', event(1, APP_URL, {}), config)).rejects.toThrow(
      'not allowed',
    );
    await expect(
      invoke(handlers, 'rec.configure', event(1, 'https://evil.example/'), config),
    ).rejects.toThrow('not allowed');
    await expect(
      invoke(handlers, 'rec.configure', { sender: { id: 1 }, senderFrame: null }, config),
    ).rejects.toThrow('not allowed');
    await expect(invoke(handlers, 'rec.configure', event(2), config)).rejects.toThrow(
      'not allowed',
    );
    await expect(invoke(handlers, 'rec.configure', event(3), config)).rejects.toThrow(
      'not allowed',
    );
    expect(handler).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls.map((c) => String(c[0]))).toEqual([
      'ipc: rejected rec.configure: unknown sender 99',
      'ipc: rejected rec.configure: sender is a subframe',
      'ipc: rejected rec.configure: sender URL is not the app (https://evil.example/)',
      'ipc: rejected rec.configure: sender frame is gone',
      'ipc: rejected rec.configure: controls window may not use rec.configure',
      'ipc: rejected rec.configure: engine window may not use rec.configure',
    ]);
    await expect(invoke(handlers, 'rec.configure', event(1), config)).resolves.toBeUndefined();
  });

  it('stops trusting a window once it is unregistered', async () => {
    const { router, handlers } = setup();
    const unregister = router.registerWindow(contents(7), 'shell');
    router.handle('rec.stop', () => undefined);
    await expect(invoke(handlers, 'rec.stop', event(7))).resolves.toBeUndefined();
    unregister();
    await expect(invoke(handlers, 'rec.stop', event(7))).rejects.toThrow('not allowed');
  });

  it('refuses channels outside the contract and double registration', () => {
    const { router, handlers } = setup();
    expect(() => router.handle('shell.exec' as 'rec.stop', () => undefined)).toThrow(
      'not in the contract',
    );
    router.handle('rec.stop', () => undefined);
    expect(() => router.handle('rec.stop', () => undefined)).toThrow('already has a handler');
    // Nothing is registered for unknown channels, so Electron rejects them itself.
    expect(handlers.has('shell.exec')).toBe(false);
    expect(() => router.onEngine('engine.evil' as 'engine.stats', () => undefined)).toThrow(
      'not an engine channel',
    );
  });

  it('carries a coded handler error across as a structured envelope (decision 2)', async () => {
    const { router, handlers } = setup();
    router.handle('library.trash', () => {
      throw Object.assign(new Error('project prj_1 is busy'), { code: 'read-only' });
    });
    router.handle('library.reveal', () => {
      throw new Error('plain failure');
    });
    const coded = await invoke(handlers, 'library.trash', event(1), { id: 'prj_1' }).catch(
      (e: unknown) => e,
    );
    expect(decodeIpcError(coded)).toEqual({ code: 'read-only', message: 'project prj_1 is busy' });
    expect(
      ipcErrorCode(
        new Error(`Error invoking remote method 'x': Error: ${(coded as Error).message}`),
      ),
    ).toBe('read-only');
    const plain = await invoke(handlers, 'library.reveal', event(1), { id: 'prj_1' }).catch(
      (e: unknown) => e,
    );
    expect((plain as Error).message).toBe('plain failure');
    expect(decodeIpcError(plain)).toBeNull();
    expect(ipcErrorMessage(new Error("Error invoking remote method 'x': Error: nope"))).toBe(
      'nope',
    );
  });

  it('refuses off-contract responses', async () => {
    const { router, handlers, logger } = setup();
    router.handle('library.trash', () => ({ trashed: 'yes' }) as unknown as { trashed: boolean });
    await expect(invoke(handlers, 'library.trash', event(1), { id: 'a' })).rejects.toThrow(
      'internal error',
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('accepts engine messages only from the engine window, validated', () => {
    const { router, listeners, logger } = setup();
    const listener = vi.fn();
    router.onEngine('engine.trackEnded', listener);
    const send = listeners.get('engine.trackEnded')!;
    const payload = { kind: 'camera', reason: 'ended', atUs: 12 };
    send(event(1), payload);
    send(event(3), { kind: 'camera', reason: 'whatever', atUs: 12 });
    send(event(3), payload, 'extra');
    expect(listener).not.toHaveBeenCalled();
    send(event(3), payload);
    expect(listener).toHaveBeenCalledExactlyOnceWith(payload, { kind: 'engine', senderId: 3 });
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('sends events only to windows allowed to receive them, validated', () => {
    const { router, shell, controls, engine, logger } = setup();
    const state = {
      state: 'recording',
      sessionId: 'ses_1',
      elapsedUs: 5,
      countdownRemainingSec: null,
      failureReason: null,
    } as const;
    expect(router.broadcast('rec.state', state)).toBe(2);
    expect(shell.sent).toEqual([['rec.state', state]]);
    expect(controls.sent).toEqual([['rec.state', state]]);
    expect(engine.sent).toEqual([]);
    expect(router.send(engine, 'rec.state', state)).toBe(false);
    expect(
      router.broadcast('rec.state', { ...state, state: 'dancing' } as unknown as typeof state),
    ).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('dispose removes everything it registered', () => {
    const { router, handlers, listeners } = setup();
    router.handle('rec.stop', () => undefined);
    router.onEngine('engine.stats', () => undefined);
    router.dispose();
    expect(handlers.size).toBe(0);
    expect(listeners.size).toBe(0);
  });
});

describe('EngineLink', () => {
  function link() {
    const sent: unknown[][] = [];
    const posted: unknown[][] = [];
    const engine = {
      id: 3,
      send: (...args: unknown[]) => sent.push(args),
      postMessage: (...args: unknown[]) => posted.push(args),
      isDestroyed: () => false,
    };
    return { link: new EngineLink(engine, 1000), sent, posted };
  }

  it('sends commands with request ids and resolves validated replies', async () => {
    const { link: l, sent } = link();
    const pending = l.command('engine.pause', {});
    expect(sent).toEqual([['engine.pause', { requestId: 1, payload: {} }]]);
    l.handleReply({ requestId: 1, ok: true, value: { atUs: 42 } });
    await expect(pending).resolves.toEqual({ atUs: 42 });
  });

  it('rejects on engine errors, off-contract replies, bad payloads and timeouts', async () => {
    vi.useFakeTimers();
    try {
      const { link: l } = link();
      const failed = l.command('engine.resume', {});
      l.handleReply({ requestId: 1, ok: false, error: { message: 'no tracks' } });
      await expect(failed).rejects.toThrow('engine.resume: no tracks');

      const weird = l.command('engine.pause', {});
      l.handleReply({ requestId: 2, ok: true, value: { at: 'now' } });
      await expect(weird).rejects.toThrow('off-contract reply');

      await expect(l.command('engine.stop', { reason: 'explode' } as never)).rejects.toThrow(
        'invalid payload',
      );

      const slow = l.command('engine.pause', {});
      const assertion = expect(slow).rejects.toThrow('no reply within 1000 ms');
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;

      const orphan = l.command('engine.pause', {});
      l.dispose('engine crashed');
      await expect(orphan).rejects.toThrow('engine crashed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('transfers ports in contract order and checks the count', () => {
    const { link: l, posted } = link();
    const payload = {
      sessionId: 'ses_1',
      streams: [{ streamId: 's1', kind: 'screen' as const }],
      clockPort: true,
    };
    expect(() => l.sendPorts(payload, ['p1'])).toThrow('expected 2 ports');
    l.sendPorts(payload, ['p1', 'clock']);
    expect(posted).toEqual([['engine.ports', payload, ['p1', 'clock']]]);
  });
});
