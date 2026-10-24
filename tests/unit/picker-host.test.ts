import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IpcRouter } from '../../src/main/ipc/router';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, BrowserWindow: vi.fn() }));
const { RegionPickerHost, regionChoiceFor } = await import('../../src/main/windows/picker');

type Handler = (payload: unknown) => unknown;

function fakeRouter() {
  const handlers = new Map<string, Handler>();
  const registered: string[] = [];
  const router = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    registerWindow: (_contents: unknown, kind: string) => {
      registered.push(kind);
      return () => undefined;
    },
  } as unknown as IpcRouter;
  const call = (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(payload);
  };
  return { router, call, registered };
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  shown = false;
  webContents = { id: 7 };
  isDestroyed() {
    return this.destroyed;
  }
  show() {
    this.shown = true;
  }
  focused = false;
  focus() {
    this.focused = true;
  }
  close() {
    this.destroyed = true;
    this.emit('closed');
  }
}

const HD = { width: 1920, height: 1080 };
const PNG = new Uint8Array([137, 80, 78, 71]);

function host(lastRegion: unknown = null) {
  const { router, call, registered } = fakeRouter();
  const windows: FakeWindow[] = [];
  const picker = new RegionPickerHost({
    router,
    renderer: { rendererDir: '/r', preloadDir: '/p' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    snapshot: () => Promise.resolve({ ...HD, png: PNG }),
    lastRegion: () => lastRegion as never,
    createWindow: () => {
      const w = new FakeWindow();
      windows.push(w);
      return w as never;
    },
  });
  return { picker, call, registered, windows };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('region picker host (§4.3.7, R1.9)', () => {
  it('serves the still and the matching last region, and resolves with the submitted region', async () => {
    const h = host({
      sourceWidth: 1920,
      sourceHeight: 1080,
      rect: { x: 2, y: 2, width: 100, height: 100 },
    });
    const choice = h.picker.pick(HD);
    await flush();
    expect(h.registered).toEqual(['picker']);
    const load = h.call('picker.load') as { imageUrl: string; lastRegion: unknown };
    expect(load).toMatchObject({ sourceWidth: 1920, sourceHeight: 1080 });
    expect(load.imageUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    expect(load.lastRegion).toEqual({ x: 2, y: 2, width: 100, height: 100 });
    h.call('picker.submit', {
      sourceWidth: 1920,
      sourceHeight: 1080,
      rect: { x: 11, y: 21, width: 301, height: 199 },
    });
    // Normalised again in main: even, at least 64 × 64.
    await expect(choice).resolves.toEqual({ rect: { x: 10, y: 20, width: 302, height: 200 } });
    expect(h.windows[0]?.destroyed).toBe(true);
    expect(h.picker.isOpen).toBe(false);
  });

  it('turns a full-frame selection into "no crop"', () => {
    expect(regionChoiceFor({ x: 0, y: 0, width: 1920, height: 1080 }, HD)).toEqual({ rect: null });
    expect(regionChoiceFor({ x: 0, y: 0, width: 1918, height: 1080 }, HD)).toEqual({
      rect: { x: 0, y: 0, width: 1918, height: 1080 },
    });
  });

  it('refuses a selection made for another source size', async () => {
    const h = host();
    void h.picker.pick(HD);
    await flush();
    expect(() =>
      h.call('picker.submit', {
        sourceWidth: 1280,
        sourceHeight: 720,
        rect: { x: 0, y: 0, width: 64, height: 64 },
      }),
    ).toThrow(/source size/);
    expect(h.picker.isOpen).toBe(true);
    h.picker.cancel();
  });

  it('cancels on Esc (picker.cancel), on window close and when the recorder moves on', async () => {
    const h = host();
    const viaCancel = h.picker.pick(HD);
    await flush();
    h.call('picker.cancel');
    await expect(viaCancel).resolves.toBe('cancelled');

    const viaClose = h.picker.pick(HD);
    await flush();
    h.windows[1]?.close();
    await expect(viaClose).resolves.toBe('cancelled');

    const viaState = h.picker.pick(HD);
    await flush();
    h.picker.cancel();
    await expect(viaState).resolves.toBe('cancelled');
    expect(() => h.call('picker.load')).toThrow(/no region/);
  });
});
