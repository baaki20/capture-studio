import { describe, expect, it, vi } from 'vitest';
import { ActionBus } from '../../src/main/action-bus';
import { confirmWhenRequired, trayMenuTemplate } from '../../src/main/tray-menu';
import type { AppAction } from '../../src/shared/ipc/actions';

describe('ActionBus', () => {
  it('delivers synchronously to every subscriber and unsubscribes', () => {
    const bus = new ActionBus();
    const seen: AppAction[] = [];
    const off = bus.subscribe((a) => seen.push(a));
    expect(bus.dispatch({ type: 'toggle-recording', source: 'cli' })).toBe(1);
    expect(seen).toEqual([{ type: 'toggle-recording', source: 'cli' }]);
    off();
    expect(bus.dispatch({ type: 'stop-recording', source: 'cli' })).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('filters by type with on()', () => {
    const bus = new ActionBus();
    const handler = vi.fn();
    bus.on(['quit'], handler);
    bus.dispatch({ type: 'new-recording', source: 'tray' });
    bus.dispatch({ type: 'quit', source: 'tray' });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ type: 'quit', source: 'tray' });
  });

  it('keeps going when a handler throws, and logs it', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bus = new ActionBus(logger);
    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(after);
    expect(bus.dispatch({ type: 'abort-recording', source: 'ui' })).toBe(1);
    expect(after).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('action: abort-recording (from ui)');
  });
});

describe('tray menu (R1.3)', () => {
  function clickAll(state: Parameters<typeof trayMenuTemplate>[0]) {
    const bus = new ActionBus();
    const seen: string[] = [];
    bus.subscribe((a) => seen.push(`${a.type}/${a.source}`));
    const items = trayMenuTemplate(state, bus).filter((i) => i.type !== 'separator');
    const click = (label: string): void => {
      const item = items.find((i) => i.label === label);
      (item?.click as (() => void) | undefined)?.();
    };
    return { items, seen, click };
  }

  it('offers New recording when idle and Stop/Pause while recording', () => {
    const idle = clickAll('idle').items.map((i) => [i.label, i.enabled ?? true]);
    expect(idle).toEqual([
      ['New recording', true],
      ['Stop', false],
      ['Pause', false],
      ['Restart…', false],
      ['Abort…', false],
      ['Open library', true],
      ['Quit', true],
    ]);
    const paused = clickAll('paused').items.map((i) => [i.label, i.enabled ?? true]);
    expect(paused).toContainEqual(['Resume', true]);
    expect(paused).toContainEqual(['New recording', false]);
  });

  it('dispatches each item on the bus', () => {
    const menu = clickAll('recording');
    for (const label of ['New recording', 'Stop', 'Pause', 'Open library', 'Quit'])
      menu.click(label);
    expect(menu.seen).toEqual([
      'new-recording/tray',
      'stop-recording/tray',
      'toggle-pause/tray',
      'open-library/tray',
      'quit/tray',
    ]);
  });

  it('asks before Restart and Abort, and dispatches only when confirmed (R1.12)', async () => {
    const bus = new ActionBus();
    const seen: string[] = [];
    bus.subscribe((a) => seen.push(`${a.type}/${a.source}`));
    const asked: string[] = [];
    const answers = { restart: false, abort: true };
    const items = trayMenuTemplate('recording', bus, (kind) => {
      asked.push(kind);
      return Promise.resolve(answers[kind]);
    });
    for (const label of ['Restart…', 'Abort…']) {
      const item = items.find((i) => i.label === label);
      expect(item?.enabled).toBe(true);
      (item?.click as () => void)();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual(['restart', 'abort']);
    expect(seen).toEqual(['abort-recording/tray']);
  });
});

describe('tray confirmations (R1.12)', () => {
  it('skips the Abort confirmation when the setting turns it off; Restart still asks', async () => {
    const ask = vi.fn(() => Promise.resolve(false));
    let confirmAbort = false;
    const confirm = confirmWhenRequired(ask, (kind) => kind === 'restart' || confirmAbort);
    expect(await confirm('abort')).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(await confirm('restart')).toBe(false);
    expect(ask).toHaveBeenCalledWith('restart');
    confirmAbort = true;
    expect(await confirm('abort')).toBe(false);
  });

  it('dispatches Abort straight away from the tray when no confirmation is needed', async () => {
    const bus = new ActionBus();
    const seen: AppAction[] = [];
    bus.subscribe((a) => seen.push(a));
    const items = trayMenuTemplate(
      'recording',
      bus,
      confirmWhenRequired(
        () => Promise.resolve(false),
        () => false,
      ),
    );
    const abort = items.find((i) => i.label === 'Abort…');
    (abort?.click as () => void)();
    await vi.waitFor(() => expect(seen).toEqual([{ type: 'abort-recording', source: 'tray' }]));
  });
});
