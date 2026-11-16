/**
 * Creates the update service for this build and its IPC (P3 step 9): decides support, loads
 * electron-updater only where it can work, and forwards state changes to the shell.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Logger } from '../../shared/logger';
import type { IpcRouter } from '../ipc/router';
import {
  UpdateService,
  updateSupport,
  type UpdaterLike,
  type UpdateChannel,
} from './update-service';

/** macOS: whether the running app carries a Developer ID signature (`codesign -dv`). */
export function macDeveloperIdSigned(execPath: string): Promise<boolean> {
  // …/Capture Studio.app/Contents/MacOS/Capture Studio → the .app bundle.
  const bundle = path.resolve(execPath, '..', '..', '..');
  return new Promise((resolve) => {
    execFile(
      'codesign',
      ['-dv', '--verbose=2', bundle],
      { timeout: 5_000 },
      (_error, _out, err) => {
        resolve(err.includes('Authority=Developer ID Application'));
      },
    );
  });
}

export interface RegisterUpdatesDeps {
  router: Pick<IpcRouter, 'handle' | 'broadcast'>;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env: Partial<Record<string, string>>;
  execPath: string;
  settings: () => { channel: UpdateChannel; autoCheck: boolean };
  logger: Logger;
  /** Loads electron-updater's `autoUpdater` (tests pass a fake). */
  loadUpdater?: () => Promise<UpdaterLike>;
}

async function loadElectronUpdater(logger: Logger): Promise<UpdaterLike> {
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: UpdaterLike & { logger: unknown };
    default?: { autoUpdater: UpdaterLike & { logger: unknown } };
  };
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!updater) throw new Error('electron-updater has no autoUpdater');
  updater.logger = logger;
  return updater;
}

export async function registerUpdates(deps: RegisterUpdatesDeps): Promise<UpdateService> {
  const macSigned =
    deps.platform === 'darwin' && deps.isPackaged
      ? await macDeveloperIdSigned(deps.execPath)
      : false;
  const support = updateSupport({
    isPackaged: deps.isPackaged,
    platform: deps.platform,
    appImage: deps.env.APPIMAGE,
    macSigned,
  });
  let updater: UpdaterLike | null = null;
  if (support.supported) {
    try {
      updater = await (deps.loadUpdater ?? (() => loadElectronUpdater(deps.logger)))();
    } catch (error) {
      deps.logger.warn('updates: the updater could not be loaded', error);
    }
  }
  const service = new UpdateService({
    updater,
    support: updater ? support : { supported: false, reason: support.reason },
    settings: deps.settings,
    logger: deps.logger,
  });
  deps.logger.info(
    `updates: ${service.state.kind === 'unsupported' ? `off (${service.state.reason})` : 'on'}`,
  );
  service.onChange((state) => deps.router.broadcast('updates.changed', state));
  deps.router.handle('updates.status', () => service.state);
  deps.router.handle('updates.check', async () => {
    await service.check();
    return service.state;
  });
  deps.router.handle('updates.install', () => ({ started: service.install() }));
  service.start();
  return service;
}
