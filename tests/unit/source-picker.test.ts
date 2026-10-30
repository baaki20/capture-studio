/**
 * The in-app screen-source picker (R1.53, D-6): which source is used or asked for, the picker
 * options per platform path, the host window's IPC, and the page's keyboard handling.
 */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  decideScreenSource,
  pickScreenSource,
  PICKER_THUMBNAIL_SIZE,
  screenPickerOptions,
  type DesktopSourceLike,
} from '../../src/main/display-media';
import type { IpcSenderEvent } from '../../src/main/ipc/router';
import { SOURCE_PICKER_CHANNELS } from '../../src/shared/ipc/source-picker';
import { gridColumns, initialIndex, pickerKey } from '../../src/renderer/source-picker/selection';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: false },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
const { SourcePickerHost, initialSourceId, toPickerItem } =
  await import('../../src/main/windows/source-picker');

const A = { id: 'screen:0:0', name: 'Built-in Display' };
const B = { id: 'screen:1:0', name: 'ACME Q27' };
const C = { id: 'screen:2:0', name: 'Projector' };

describe('decideScreenSource (R1.53)', () => {
  it('asks when several sources are listed and a picker exists, starting on the preferred one', () => {
    expect(decideScreenSource([A, B], { canAsk: true })).toEqual({
      kind: 'ask',
      initialId: A.id,
    });
    expect(decideScreenSource([A, B], { canAsk: true, preferredSourceId: B.id })).toEqual({
      kind: 'ask',
      initialId: B.id,
    });
    expect(decideScreenSource([A, B], { canAsk: true, preferredSourceId: 'gone' })).toEqual({
      kind: 'ask',
      initialId: A.id,
    });
  });

  it('never asks for a single source, or without a picker (the portal path)', () => {
    expect(decideScreenSource([B], { canAsk: true })).toEqual({ kind: 'use', source: B });
    expect(decideScreenSource([A, B], { canAsk: false })).toEqual({ kind: 'use', source: A });
    expect(decideScreenSource([A, B], { canAsk: false, preferredSourceId: B.id })).toEqual({
      kind: 'use',
      source: B,
    });
    expect(decideScreenSource([], { canAsk: true })).toEqual({ kind: 'none' });
  });

  it('uses the auto-select name without asking (CI)', () => {
    const all = [A, B, C];
    expect(decideScreenSource(all, { canAsk: true, autoSelectName: 'Projector' })).toEqual({
      kind: 'use',
      source: C,
    });
    expect(decideScreenSource(all, { canAsk: true, autoSelectName: 'acme' })).toEqual({
      kind: 'use',
      source: B,
    });
    // Unknown or empty names still never block: preferred, else first.
    expect(decideScreenSource(all, { canAsk: true, autoSelectName: 'nope' })).toEqual({
      kind: 'use',
      source: A,
    });
    expect(
      decideScreenSource(all, { canAsk: true, autoSelectName: '', preferredSourceId: C.id }),
    ).toEqual({ kind: 'use', source: C });
  });
});

describe('screenPickerOptions', () => {
  const choose = vi.fn();
  const commandLine = (switches: Record<string, string>) => ({
    hasSwitch: (name: string) => name in switches,
    getSwitchValue: (name: string) => switches[name] ?? '',
  });

  it('gives the in-app picker only where no portal picks', () => {
    expect(screenPickerOptions({ portal: false, commandLine: commandLine({}), choose })).toEqual({
      chooseSource: choose,
    });
    // Wayland: the portal path is unchanged.
    expect(screenPickerOptions({ portal: true, commandLine: commandLine({}), choose })).toEqual({});
  });

  it('skips the picker under --auto-select-desktop-capture-source', () => {
    const cl = commandLine({ 'auto-select-desktop-capture-source': 'Entire screen' });
    expect(screenPickerOptions({ portal: false, commandLine: cl, choose })).toEqual({
      autoSelectName: 'Entire screen',
    });
  });
});

describe('pickScreenSource with the in-app picker', () => {
  const thumb = (url: string) => ({ isEmpty: () => false, toDataURL: () => url });

  it('asks for thumbnails and records the chosen source', async () => {
    const sources: DesktopSourceLike[] = [
      { ...A, thumbnail: thumb('data:image/png;base64,QQ==') },
      { ...B, thumbnail: thumb('data:image/png;base64,Qg==') },
    ];
    const getSources = vi.fn(() => Promise.resolve(sources));
    const chooseSource = vi.fn(() => Promise.resolve(B.id));
    const pick = await pickScreenSource(getSources, {
      fps: 30,
      preferredSourceId: A.id,
      chooseSource,
    });
    expect(getSources).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnailSize: { ...PICKER_THUMBNAIL_SIZE } }),
    );
    expect(chooseSource).toHaveBeenCalledWith(sources, A.id);
    expect(pick).toMatchObject({
      status: 'selected',
      source: { id: B.id, name: B.name },
      screen: { sourceId: B.id },
    });
  });

  it('treats a cancelled picker as cancelled and an unknown id as a failure', async () => {
    const getSources = () => Promise.resolve([A, B]);
    await expect(
      pickScreenSource(getSources, { fps: 30, chooseSource: () => Promise.resolve(null) }),
    ).resolves.toEqual({ status: 'cancelled' });
    await expect(
      pickScreenSource(getSources, { fps: 30, chooseSource: () => Promise.resolve('x') }),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('does not open the picker for one monitor, or under auto-select', async () => {
    const chooseSource = vi.fn(() => Promise.resolve(B.id));
    const one = await pickScreenSource(() => Promise.resolve([A]), { fps: 30, chooseSource });
    expect(one.status === 'selected' && one.source.id).toBe(A.id);
    const getSources = vi.fn(() => Promise.resolve([A, B, C]));
    const auto = await pickScreenSource(getSources, {
      fps: 30,
      chooseSource,
      autoSelectName: 'Projector',
    });
    expect(auto.status === 'selected' && auto.source.id).toBe(C.id);
    expect(chooseSource).not.toHaveBeenCalled();
    // No thumbnails when nothing will show them.
    expect(getSources).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnailSize: { width: 0, height: 0 } }),
    );
  });
});

class FakeWindow extends EventEmitter {
  destroyed = false;
  shown = false;
  focused = false;
  constructor(readonly webContents: { id: number }) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  show() {
    this.shown = true;
  }
  focus() {
    this.focused = true;
  }
  close() {
    this.destroyed = true;
    this.emit('closed');
  }
}

type Handler = (event: IpcSenderEvent, ...args: unknown[]) => unknown;

function harness(stateFile?: string) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  };
  const windows: FakeWindow[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const host = new SourcePickerHost({
    renderer: { rendererDir: '/r', preloadDir: '/p' },
    logger,
    ipcMain,
    ...(stateFile ? { stateFile } : {}),
    createWindow: () => {
      const window = new FakeWindow({ id: 40 + windows.length });
      windows.push(window);
      return window;
    },
  });
  const call = (channel: string, senderId: number, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ sender: { id: senderId }, senderFrame: null }, payload);
  };
  return { host, call, windows, handlers };
}

describe('SourcePickerHost', () => {
  it('shows the sources, accepts a listed choice from its window and remembers it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-source-picker-'));
    const stateFile = path.join(dir, 'source-picker.json');
    try {
      const { host, call, windows } = harness(stateFile);
      const pending = host.choose([A, B], A.id);
      const [window] = windows;
      window!.emit('ready-to-show');
      expect(window!.shown && window!.focused).toBe(true);
      expect(call(SOURCE_PICKER_CHANNELS.load, 40)).toEqual({
        sources: [
          { id: A.id, name: A.name, thumbnail: null },
          { id: B.id, name: B.name, thumbnail: null },
        ],
        initialId: A.id,
      });
      // Another window cannot answer; an unlisted id is refused.
      expect(() => call(SOURCE_PICKER_CHANNELS.load, 99)).toThrow('no source');
      expect(() => call(SOURCE_PICKER_CHANNELS.choose, 40, { id: 'x' })).toThrow('not one of');
      call(SOURCE_PICKER_CHANNELS.choose, 40, { id: B.id });
      await expect(pending).resolves.toBe(B.id);
      expect(window!.destroyed).toBe(true);
      expect(host.lastSourceId).toBe(B.id);

      // Next time (even after a restart) the last choice starts highlighted.
      await vi.waitFor(async () =>
        expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual({ lastSourceId: B.id }),
      );
      const restarted = harness(stateFile);
      void restarted.host.choose([A, B, C], A.id);
      expect(restarted.call(SOURCE_PICKER_CHANNELS.load, 40)).toMatchObject({ initialId: B.id });
      restarted.host.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves null on Esc/cancel, on closing the window, and when replaced', async () => {
    const { host, call, windows, handlers } = harness();
    const first = host.choose([A, B], null);
    const second = host.choose([A, B], null);
    await expect(first).resolves.toBeNull();
    expect(windows[0]!.destroyed).toBe(true);
    call(SOURCE_PICKER_CHANNELS.cancel, 41);
    await expect(second).resolves.toBeNull();

    const third = host.choose([A, B], null);
    windows[2]!.close();
    await expect(third).resolves.toBeNull();
    expect(host.isOpen).toBe(false);
    expect(host.lastSourceId).toBeNull();
    host.dispose();
    expect(handlers.size).toBe(0);
  });

  it('turns thumbnails into data URLs and picks the first highlight', () => {
    expect(
      toPickerItem({
        ...A,
        thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' },
      }).thumbnail,
    ).toBe('data:image/png;base64,AA==');
    expect(toPickerItem({ ...A, thumbnail: { isEmpty: () => true, toDataURL: () => '' } })).toEqual(
      { ...A, thumbnail: null },
    );
    expect(initialSourceId([A, B], B.id, A.id)).toBe(B.id);
    expect(initialSourceId([A, B], 'gone', B.id)).toBe(B.id);
    expect(initialSourceId([A, B], null, null)).toBe(A.id);
    expect(initialSourceId([], null, null)).toBeNull();
  });
});

describe('picker keyboard (Enter/Esc, arrows)', () => {
  it('moves through the grid, records with Enter and cancels with Escape', () => {
    // 5 sources in 3 columns: 0 1 2 / 3 4.
    expect(pickerKey('ArrowRight', 0, 5, 3)).toEqual({ kind: 'move', index: 1 });
    expect(pickerKey('ArrowRight', 4, 5, 3)).toEqual({ kind: 'move', index: 4 });
    expect(pickerKey('ArrowLeft', 0, 5, 3)).toEqual({ kind: 'move', index: 0 });
    expect(pickerKey('ArrowDown', 1, 5, 3)).toEqual({ kind: 'move', index: 4 });
    expect(pickerKey('ArrowDown', 2, 5, 3)).toEqual({ kind: 'move', index: 2 });
    expect(pickerKey('ArrowUp', 4, 5, 3)).toEqual({ kind: 'move', index: 1 });
    expect(pickerKey('Home', 3, 5, 3)).toEqual({ kind: 'move', index: 0 });
    expect(pickerKey('End', 0, 5, 3)).toEqual({ kind: 'move', index: 4 });
    expect(pickerKey('Enter', 3, 5, 3)).toEqual({ kind: 'choose', index: 3 });
    expect(pickerKey('Escape', 3, 5, 3)).toEqual({ kind: 'cancel' });
    expect(pickerKey('Escape', 0, 0, 1)).toEqual({ kind: 'cancel' });
    expect(pickerKey('Enter', 0, 0, 1)).toEqual({ kind: 'none' });
    expect(pickerKey('a', 0, 5, 3)).toEqual({ kind: 'none' });
  });

  it('starts on the remembered source and lays out a sensible grid', () => {
    expect(initialIndex([A, B, C], B.id)).toBe(1);
    expect(initialIndex([A, B, C], 'gone')).toBe(0);
    expect([1, 2, 3, 4, 5, 9].map(gridColumns)).toEqual([1, 2, 3, 2, 3, 3]);
  });
});
