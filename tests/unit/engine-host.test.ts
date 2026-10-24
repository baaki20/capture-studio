import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { IpcRouter, type IpcMainLike, type IpcSenderEvent } from '../../src/main/ipc/router';
import { pickScreenSource, SCREEN_CAPTURE_MAX } from '../../src/main/display-media';

vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn(), getVersion: () => '0.1.0' },
  BrowserWindow: vi.fn(),
  session: {},
  shell: {},
}));
const { EngineHost } = await import('../../src/main/windows/engine');
const { allowMediaCapture, isMediaCaptureAllowed } =
  await import('../../src/main/security/web-security');

type Listener = (event: IpcSenderEvent, ...args: unknown[]) => unknown;

const RENDERER = { rendererDir: '/app/out/renderer', preloadDir: '/app/out/preload' };
const ENGINE_URL = 'file:///app/out/renderer/engine/index.html';

function harness() {
  const listeners = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: (channel, listener) => listeners.set(channel, listener),
    removeAllListeners: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const router = new IpcRouter({
    ipcMain,
    logger,
    isAppUrl: (url) => url.startsWith('file:///app/out/renderer/'),
  });
  const windows: FakeWindow[] = [];
  const host = new EngineHost({
    router,
    renderer: RENDERER,
    logger,
    readyTimeoutMs: 1_000,
    createWindow: () => {
      const w = fakeWindow(10 + windows.length);
      windows.push(w);
      return w as unknown as BrowserWindow;
    },
  });
  /** An engine → main message from window `id`. */
  const fromEngine = (id: number, channel: string, payload?: unknown) =>
    listeners.get(channel)?.(
      { sender: { id }, senderFrame: { url: ENGINE_URL, parent: null } },
      payload,
    );
  return { host, windows, fromEngine, logger };
}

type FakeWindow = ReturnType<typeof fakeWindow>;

function fakeWindow(id: number) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const contentsHandlers = new Map<string, (...args: unknown[]) => void>();
  const sent: unknown[][] = [];
  const state = { destroyed: false };
  return {
    sent,
    state,
    handlers,
    contentsHandlers,
    webContents: {
      id,
      send: (...args: unknown[]) => sent.push(args),
      postMessage: (...args: unknown[]) => sent.push(['postMessage', ...args]),
      isDestroyed: () => state.destroyed,
      on: (event: string, handler: (...args: unknown[]) => void) =>
        contentsHandlers.set(event, handler),
    },
    on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    isDestroyed: () => state.destroyed,
    destroy: () => {
      state.destroyed = true;
    },
  };
}

describe('EngineHost', () => {
  it('creates the engine window on demand and resolves once it is ready', async () => {
    const { host, windows, fromEngine } = harness();
    const ready = host.ensure();
    expect(windows).toHaveLength(1);
    expect(host.ensure()).toBe(ready); // one window at a time
    fromEngine(10, 'engine.ready');
    const link = await ready;
    expect(host.link).toBe(link);
    // The engine window may capture media; other windows may not.
    expect(isMediaCaptureAllowed(10, 'media', ENGINE_URL, RENDERER)).toBe(true);
    expect(isMediaCaptureAllowed(11, 'media', ENGINE_URL, RENDERER)).toBe(false);
  });

  it('routes replies from its own window and forwards stats and ended tracks', async () => {
    const { host, windows, fromEngine } = harness();
    const ready = host.ensure();
    fromEngine(10, 'engine.ready');
    const link = await ready;
    const stats = vi.fn();
    const ended = vi.fn();
    host.onStats(stats);
    host.onTrackEnded(ended);

    const pause = link.command('engine.pause', {});
    expect(windows[0]?.sent[0]).toEqual(['engine.pause', { requestId: 1, payload: {} }]);
    fromEngine(10, 'engine.reply', { requestId: 1, ok: true, value: { atUs: 5 } });
    await expect(pause).resolves.toEqual({ atUs: 5 });

    fromEngine(10, 'engine.stats', { atUs: 1, streams: [] });
    fromEngine(10, 'engine.trackEnded', { kind: 'screen', reason: 'ended', atUs: 2 });
    fromEngine(99, 'engine.trackEnded', { kind: 'mic', reason: 'ended', atUs: 2 }); // unknown sender
    expect(stats).toHaveBeenCalledWith({ atUs: 1, streams: [] });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ kind: 'screen', reason: 'ended', atUs: 2 });
  });

  it('fails outstanding commands on a crash and starts a fresh window next time', async () => {
    const { host, windows, fromEngine } = harness();
    const gone = vi.fn();
    host.onGone(gone);
    const ready = host.ensure();
    fromEngine(10, 'engine.ready');
    const link = await ready;
    const stop = link.command('engine.stop', { reason: 'stop' });
    windows[0]?.contentsHandlers.get('render-process-gone')?.({}, { reason: 'crashed' });
    await expect(stop).rejects.toThrow('capture engine crashed (crashed)');
    expect(gone).toHaveBeenCalledWith('crashed (crashed)');
    expect(windows[0]?.state.destroyed).toBe(true);
    expect(isMediaCaptureAllowed(10, 'media', ENGINE_URL, RENDERER)).toBe(false);
    expect(host.link).toBeNull();

    const again = host.ensure();
    expect(windows).toHaveLength(2);
    fromEngine(11, 'engine.ready');
    await expect(again).resolves.not.toBe(link);
    host.dispose();
    expect(windows[1]?.state.destroyed).toBe(true);
  });

  it('rejects when the page never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const { host } = harness();
      const ready = host.ensure();
      const assertion = expect(ready).rejects.toThrow('did not become ready');
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('media capture permission', () => {
  it('allows media (and display capture for the engine only) on app pages', () => {
    const revokePreview = allowMediaCapture({ id: 43 }, { display: false });
    expect(isMediaCaptureAllowed(43, 'media', ENGINE_URL, RENDERER)).toBe(true);
    expect(isMediaCaptureAllowed(43, 'display-capture', ENGINE_URL, RENDERER)).toBe(false);
    revokePreview();
    const revoke = allowMediaCapture({ id: 42 });
    expect(isMediaCaptureAllowed(42, 'media', ENGINE_URL, RENDERER)).toBe(true);
    expect(isMediaCaptureAllowed(42, 'media', 'file:///', RENDERER)).toBe(true); // check origin
    expect(isMediaCaptureAllowed(42, 'notifications', ENGINE_URL, RENDERER)).toBe(false);
    // getUserMedia with a desktop source id asks for display-capture (engine only).
    expect(isMediaCaptureAllowed(42, 'display-capture', ENGINE_URL, RENDERER)).toBe(true);
    expect(isMediaCaptureAllowed(42, 'media', 'https://evil.example/', RENDERER)).toBe(false);
    expect(
      isMediaCaptureAllowed(42, 'media', 'file:///', {
        ...RENDERER,
        devServerUrl: 'http://localhost:5173',
      }),
    ).toBe(false);
    revoke();
    expect(isMediaCaptureAllowed(42, 'media', ENGINE_URL, RENDERER)).toBe(false);
  });
});

describe('pickScreenSource (§9.1 path a)', () => {
  const sources = [
    { id: 'screen:1:0', name: 'Screen 1' },
    { id: 'screen:2:0', name: 'Screen 2' },
  ];

  it('returns the portal choice with the capture cap', async () => {
    const getSources = vi.fn(() => Promise.resolve(sources.slice(0, 1)));
    await expect(pickScreenSource(getSources, { fps: 60 })).resolves.toEqual({
      status: 'selected',
      source: sources[0],
      screen: {
        sourceId: 'screen:1:0',
        maxWidth: SCREEN_CAPTURE_MAX.width,
        maxHeight: SCREEN_CAPTURE_MAX.height,
        fps: 60,
      },
    });
    expect(getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  });

  it('treats an empty list as a cancelled portal (R1.8)', async () => {
    await expect(pickScreenSource(() => Promise.resolve([]), { fps: 30 })).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('keeps the preferred monitor on X11 and reports failures', async () => {
    const picked = await pickScreenSource(() => Promise.resolve(sources), {
      fps: 30,
      preferredSourceId: 'screen:2:0',
    });
    expect(picked.status === 'selected' && picked.source.id).toBe('screen:2:0');
    const fallback = await pickScreenSource(() => Promise.resolve(sources), {
      fps: 30,
      preferredSourceId: 'gone',
    });
    expect(fallback.status === 'selected' && fallback.source.id).toBe('screen:1:0');
    await expect(
      pickScreenSource(() => Promise.reject(new Error('portal unavailable')), { fps: 30 }),
    ).resolves.toEqual({ status: 'failed', message: 'portal unavailable' });
  });
});
