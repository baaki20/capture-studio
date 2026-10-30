/**
 * The in-app screen-source picker (R1.53, D-6, §2.3). Where no portal picks the source (X11),
 * `desktopCapturer` lists every monitor; with more than one, `pickScreenSource` calls
 * `SourcePickerHost.choose` and this window shows a thumbnail and name per monitor. Enter
 * records the highlighted one, Esc cancels, and the last choice is highlighted next time (kept
 * in `stateFile`, so it survives restarts).
 *
 * - `sourcePicker.load` hands the page the sources; `sourcePicker.choose` / `.cancel` answer the
 *   pending request. Calls from any other webContents are refused, and payloads are validated.
 * - Closing the window, or `cancel()`, cancels. A new `choose` cancels an open one.
 * - On Wayland the portal stays the picker; under `--auto-select-desktop-capture-source` (CI)
 *   this window never opens (`display-media.ts` `screenPickerOptions`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain as electronIpcMain } from 'electron';
import { z } from 'zod';
import {
  SOURCE_PICKER_CHANNELS,
  type SourcePickerItem,
  type SourcePickerLoad,
} from '../../shared/ipc/source-picker';
import type { Logger } from '../../shared/logger';
import type { DesktopSourceLike } from '../display-media';
import type { IpcMainLike, IpcSenderEvent } from '../ipc/router';
import { secureWebPreferences } from '../security/web-security';
import { writeFileAtomic } from '../settings/atomic-file';
import type { RendererLocation } from './shell';

const ChooseSchema = z.object({ id: z.string().min(1).max(256) });
const StateSchema = z.object({ lastSourceId: z.string().min(1).max(256).nullable() });

/** The parts of a `BrowserWindow` the host uses (tests pass a fake). */
export interface PickerWindowLike {
  readonly webContents: { id: number };
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  close(): void;
  once(event: 'ready-to-show', listener: () => void): unknown;
  on(event: 'closed', listener: () => void): unknown;
}

export interface SourcePickerHostOptions {
  renderer: RendererLocation;
  logger: Logger;
  /** Where the last choice is kept, e.g. `<userData>/source-picker.json`. */
  stateFile?: string;
  ipcMain?: Pick<IpcMainLike, 'handle' | 'removeHandler'>;
  createWindow?: (location: RendererLocation) => PickerWindowLike;
}

interface PendingChoice {
  window: PickerWindowLike;
  load: SourcePickerLoad;
  resolve: (id: string | null) => void;
}

export function createSourcePickerWindow(location: RendererLocation): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 480,
    minHeight: 360,
    show: false,
    center: true,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Choose a screen – Capture Studio',
    webPreferences: {
      ...secureWebPreferences(path.join(location.preloadDir, 'source-picker.cjs')),
      additionalArguments: [`--cs-app-version=${app.getVersion()}`],
    },
  });
  window.setMenuBarVisibility(false);
  if (location.devServerUrl) {
    void window.loadURL(
      new URL('source-picker/index.html', `${location.devServerUrl}/`).toString(),
    );
  } else {
    void window.loadFile(path.join(location.rendererDir, 'source-picker', 'index.html'));
  }
  return window;
}

/** What the page shows for one source; an empty thumbnail becomes null (a placeholder). */
export function toPickerItem(source: DesktopSourceLike): SourcePickerItem {
  const thumbnail =
    source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null;
  return { id: source.id, name: source.name, thumbnail };
}

/**
 * The source highlighted first: the last choice when it is still listed, else the caller's
 * initial id when listed, else the first source.
 */
export function initialSourceId(
  sources: readonly { id: string }[],
  lastId: string | null,
  initialId: string | null,
): string | null {
  const listed = (id: string | null): id is string =>
    id !== null && sources.some((s) => s.id === id);
  if (listed(lastId)) return lastId;
  if (listed(initialId)) return initialId;
  return sources[0]?.id ?? null;
}

export class SourcePickerHost {
  private pending: PendingChoice | null = null;
  private lastId: string | null = null;
  private readonly ipcMain: Pick<IpcMainLike, 'handle' | 'removeHandler'>;

  constructor(private readonly options: SourcePickerHostOptions) {
    this.ipcMain = options.ipcMain ?? electronIpcMain;
    this.lastId = this.readState();
    this.ipcMain.handle(SOURCE_PICKER_CHANNELS.load, (event) => {
      const pending = this.from(event);
      if (!pending) throw new Error('sourcePicker.load: no source is being chosen');
      return pending.load;
    });
    this.ipcMain.handle(SOURCE_PICKER_CHANNELS.choose, (event, payload) => {
      const pending = this.from(event);
      if (!pending) return undefined;
      const parsed = ChooseSchema.safeParse(payload);
      if (!parsed.success || !pending.load.sources.some((s) => s.id === parsed.data.id)) {
        throw new Error('sourcePicker.choose: not one of the listed sources');
      }
      this.remember(parsed.data.id);
      this.finish(parsed.data.id);
      return undefined;
    });
    this.ipcMain.handle(SOURCE_PICKER_CHANNELS.cancel, (event) => {
      if (this.from(event)) this.finish(null);
      return undefined;
    });
  }

  get isOpen(): boolean {
    return this.pending !== null;
  }

  /** The last source the user chose (null before the first choice). */
  get lastSourceId(): string | null {
    return this.lastId;
  }

  /** Shows the picker; resolves with the chosen source id, or null when cancelled. */
  choose(sources: readonly DesktopSourceLike[], initialId: string | null): Promise<string | null> {
    this.finish(null);
    if (sources.length === 0) return Promise.resolve(null);
    const load: SourcePickerLoad = {
      sources: sources.map(toPickerItem),
      initialId: initialSourceId(sources, this.lastId, initialId),
    };
    const window = (this.options.createWindow ?? createSourcePickerWindow)(this.options.renderer);
    return new Promise<string | null>((resolve) => {
      this.pending = { window, load, resolve };
      window.once('ready-to-show', () => {
        window.show();
        window.focus();
      });
      window.on('closed', () => {
        if (this.pending?.window === window) this.finish(null);
      });
    });
  }

  /** Cancels an open picker. */
  cancel(): void {
    this.finish(null);
  }

  /** Removes the IPC handlers (tests, shutdown). */
  dispose(): void {
    this.finish(null);
    for (const channel of Object.values(SOURCE_PICKER_CHANNELS)) {
      this.ipcMain.removeHandler(channel);
    }
  }

  /** The pending request, when `event` comes from its window. */
  private from(event: IpcSenderEvent): PendingChoice | null {
    const pending = this.pending;
    if (!pending || pending.window.isDestroyed()) return null;
    return event.sender.id === pending.window.webContents.id ? pending : null;
  }

  private finish(id: string | null): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.resolve(id);
    if (!pending.window.isDestroyed()) pending.window.close();
  }

  private readState(): string | null {
    if (!this.options.stateFile) return null;
    try {
      const parsed = StateSchema.safeParse(
        JSON.parse(readFileSync(this.options.stateFile, 'utf8')),
      );
      return parsed.success ? parsed.data.lastSourceId : null;
    } catch {
      return null;
    }
  }

  private remember(id: string): void {
    this.lastId = id;
    const file = this.options.stateFile;
    if (!file) return;
    writeFileAtomic(file, `${JSON.stringify({ lastSourceId: id })}\n`).catch((error: unknown) => {
      this.options.logger.warn(`source picker: could not save the last choice: ${String(error)}`);
    });
  }
}
