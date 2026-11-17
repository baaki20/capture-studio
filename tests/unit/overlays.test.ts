import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, BrowserWindow: vi.fn() }));
const { cursorInDisplay, frameRect, HIGHLIGHTER_HZ, RecordingOverlays } =
  await import('../../src/main/windows/overlays');

const DISPLAY = { x: 1920, y: 0, width: 1280, height: 720 };
const SOURCE = { width: 2560, height: 1440 };

class FakeWindow extends EventEmitter {
  destroyed = false;
  shown = false;
  clickThrough = false;
  protectedFromCapture = false;
  onTop: string | undefined;
  readonly sent: unknown[] = [];
  readonly webContents = {
    id: Math.random(),
    isDestroyed: () => this.destroyed,
    send: (_channel: string, payload: unknown) => this.sent.push(payload),
  };
  setIgnoreMouseEvents(ignore: boolean) {
    this.clickThrough = ignore;
  }
  setContentProtection(enable: boolean) {
    this.protectedFromCapture = enable;
  }
  setAlwaysOnTop(_flag: boolean, level?: string) {
    this.onTop = level;
  }
  showInactive() {
    this.shown = true;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}

function overlays(excludeFromCapture = true) {
  const windows: FakeWindow[] = [];
  const bounds: unknown[] = [];
  const sent: { channel: string; payload: unknown }[] = [];
  let tick: (() => void) | null = null;
  let intervalMs = 0;
  const cursor = { x: 2000, y: 100 };
  const host = new RecordingOverlays({
    router: {
      registerWindow: () => () => undefined,
      send: (target: unknown, channel: string, payload: unknown) => {
        (target as { send: (c: string, p: unknown) => void }).send(channel, payload);
        sent.push({ channel, payload });
        return true;
      },
    } as never,
    renderer: { rendererDir: '/r', preloadDir: '/p' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    excludeFromCapture: () => excludeFromCapture,
    cursorPoint: () => cursor,
    createWindow: (_location, b) => {
      const w = new FakeWindow();
      windows.push(w);
      bounds.push(b);
      return w;
    },
    setInterval: (fn, ms) => {
      tick = fn;
      intervalMs = ms;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  });
  return {
    host,
    windows,
    bounds,
    sent,
    cursor,
    tick: () => tick?.(),
    ticking: () => tick !== null,
    intervalMs: () => intervalMs,
  };
}

describe('overlay geometry (P3 step 6)', () => {
  it('maps the region from source pixels into the display’s CSS pixels', () => {
    const region = { x: 256, y: 144, width: 1280, height: 720 };
    expect(frameRect({ display: DISPLAY, source: SOURCE, region })).toEqual({
      x: 128,
      y: 72,
      width: 640,
      height: 360,
    });
    expect(frameRect({ display: DISPLAY, source: SOURCE, region: null })).toBeNull();
  });

  it('places the pointer relative to the display, and nowhere when it is on another one', () => {
    expect(cursorInDisplay({ x: 2000, y: 100 }, DISPLAY)).toEqual({ x: 80, y: 100 });
    expect(cursorInDisplay({ x: 100, y: 100 }, DISPLAY)).toBeNull();
    expect(cursorInDisplay({ x: 1920 + 1280, y: 0 }, DISPLAY)).toBeNull();
  });
});

describe('RecordingOverlays', () => {
  const region = { x: 256, y: 144, width: 1280, height: 720 };

  it('shows a click-through frame around the region, kept out of the capture', () => {
    const o = overlays();
    o.host.update({ display: DISPLAY, source: SOURCE, region, highlighter: false });
    expect(o.windows).toHaveLength(1);
    expect(o.bounds).toEqual([DISPLAY]);
    const [frame] = o.windows;
    expect(frame).toMatchObject({
      clickThrough: true,
      protectedFromCapture: true,
      onTop: 'screen-saver',
    });
    frame!.emit('ready-to-show');
    expect(frame!.shown).toBe(true);
    expect(frame!.sent).toEqual([
      { frame: { x: 128, y: 72, width: 640, height: 360 }, cursor: null },
    ]);
    // The same capture again changes nothing; null hides.
    o.host.update({ display: DISPLAY, source: SOURCE, region, highlighter: false });
    expect(o.windows).toHaveLength(1);
    o.host.update(null);
    expect(frame!.destroyed).toBe(true);
  });

  it('draws no frame for the full frame, and cannot protect it where the OS cannot', () => {
    const none = overlays();
    none.host.update({ display: DISPLAY, source: SOURCE, region: null, highlighter: false });
    expect(none.windows).toHaveLength(0);
    const unprotected = overlays(false);
    unprotected.host.update({ display: DISPLAY, source: SOURCE, region, highlighter: false });
    expect(unprotected.windows[0]?.protectedFromCapture).toBe(false);
  });

  it('follows the pointer with a highlighter that is recorded (never protected)', () => {
    const o = overlays();
    o.host.update({ display: DISPLAY, source: SOURCE, region: null, highlighter: true });
    expect(o.windows).toHaveLength(1);
    const [highlighter] = o.windows;
    expect(highlighter!.protectedFromCapture).toBe(false);
    expect(highlighter!.clickThrough).toBe(true);
    expect(o.intervalMs()).toBeCloseTo(1000 / HIGHLIGHTER_HZ);
    highlighter!.emit('ready-to-show');
    o.tick();
    expect(highlighter!.sent.at(-1)).toEqual({ frame: null, cursor: { x: 80, y: 100 } });
    // Unchanged positions are not sent again.
    const count = highlighter!.sent.length;
    o.tick();
    expect(highlighter!.sent).toHaveLength(count);
    // Off the display: hidden.
    o.cursor.x = 10;
    o.tick();
    expect(highlighter!.sent.at(-1)).toEqual({ frame: null, cursor: null });
    o.host.dispose();
    expect(o.ticking()).toBe(false);
    expect(highlighter!.destroyed).toBe(true);
  });
});
