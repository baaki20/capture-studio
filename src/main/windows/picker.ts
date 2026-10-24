/**
 * The region picker window (§4.3.7, R1.9). In Region mode, after the portal selection, the
 * session manager asks for a region (`SessionManagerDeps.pickRegion`): the engine takes a still
 * of the chosen stream (`engine.snapshot`), and a fullscreen window shows it with
 * `object-fit: contain` so the user can drag a region in **stream pixels**.
 *
 * - `picker.load` hands the page the still and the last region (only when the source size
 *   matches); `picker.submit` and `picker.cancel` answer the pending request.
 * - The submitted rect is normalised again here (clamped, even, at least 64 × 64); a rect that
 *   covers the whole frame means "no crop" (`{rect: null}`).
 * - Closing the window, or the recorder leaving `picking-region` (`cancel()`), cancels.
 */
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { InvokeResponse } from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';
import type { NRect } from '../../shared/project/schema';
import {
  finalizeRegion,
  isFullFrame,
  matchingLastRegion,
  type Size,
} from '../../shared/recording/region';
import type { Settings } from '../../shared/settings/schema';
import { IpcRejection, type IpcRouter } from '../ipc/router';
import type { RegionChoice } from '../recording/session-manager';
import { secureWebPreferences } from '../security/web-security';
import { loadRendererPage, type RendererLocation } from './shell';

export interface PickerSnapshot {
  width: number;
  height: number;
  png: Uint8Array;
}

export interface PickerHostOptions {
  router: IpcRouter;
  renderer: RendererLocation;
  logger: Logger;
  /** The still of the acquired screen (`engine.snapshot`). */
  snapshot: () => Promise<PickerSnapshot>;
  lastRegion: () => Settings['recorder']['lastRegion'];
  /** Tests inject a fake window. */
  createWindow?: (location: RendererLocation) => BrowserWindow;
}

interface PendingPick {
  source: Size;
  load: InvokeResponse<'picker.load'>;
  window: BrowserWindow;
  resolve: (choice: RegionChoice) => void;
}

export function createPickerWindow(location: RendererLocation): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    fullscreen: true,
    frame: false,
    resizable: false,
    title: 'Select a region – Capture Studio',
    backgroundColor: '#000000',
    webPreferences: {
      ...secureWebPreferences(path.join(location.preloadDir, 'picker.cjs')),
      additionalArguments: [`--cs-app-version=${app.getVersion()}`],
    },
  });
  loadRendererPage(window, location, 'picker');
  return window;
}

/** The region to record for a submitted rect: null (no crop) when it covers the whole frame. */
export function regionChoiceFor(rect: NRect, source: Size): RegionChoice {
  const region = finalizeRegion(rect, source);
  return { rect: isFullFrame(region, source) ? null : region };
}

export class RegionPickerHost {
  private pending: PendingPick | null = null;

  constructor(private readonly options: PickerHostOptions) {
    const { router } = options;
    router.handle('picker.load', () => {
      if (!this.pending) throw new IpcRejection('picker.load: no region is being picked');
      return this.pending.load;
    });
    router.handle('picker.submit', (selection) => {
      const pending = this.pending;
      if (!pending) return undefined;
      if (
        selection.sourceWidth !== pending.source.width ||
        selection.sourceHeight !== pending.source.height
      ) {
        throw new IpcRejection('picker.submit: the source size does not match');
      }
      this.finish(regionChoiceFor(selection.rect, pending.source));
      return undefined;
    });
    router.handle('picker.cancel', () => {
      this.finish('cancelled');
      return undefined;
    });
  }

  get isOpen(): boolean {
    return this.pending !== null;
  }

  /** Shows the picker for a stream of `source` size and resolves with the user's choice. */
  async pick(source: Size): Promise<RegionChoice> {
    this.finish('cancelled');
    const still = await this.options.snapshot();
    if (still.width !== source.width || still.height !== source.height) {
      this.options.logger.warn(
        `picker: still is ${String(still.width)}×${String(still.height)}, the stream ${String(source.width)}×${String(source.height)}`,
      );
    }
    const load: InvokeResponse<'picker.load'> = {
      sourceWidth: source.width,
      sourceHeight: source.height,
      imageUrl: `data:image/png;base64,${Buffer.from(still.png).toString('base64')}`,
      lastRegion: matchingLastRegion(this.options.lastRegion(), source),
    };
    const window = (this.options.createWindow ?? createPickerWindow)(this.options.renderer);
    const unregister = this.options.router.registerWindow(window.webContents, 'picker');
    return new Promise<RegionChoice>((resolve) => {
      this.pending = { source, load, window, resolve };
      window.once('ready-to-show', () => {
        window.show();
        window.focus();
      });
      window.on('closed', () => {
        unregister();
        if (this.pending?.window === window) this.finish('cancelled');
      });
    });
  }

  /** Cancels an open picker (the recorder left `picking-region`). */
  cancel(): void {
    this.finish('cancelled');
  }

  private finish(choice: RegionChoice): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.resolve(choice);
    if (!pending.window.isDestroyed()) pending.window.close();
  }
}
