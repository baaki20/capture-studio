/**
 * App updates (P3 step 9, plan D4, spec §2.13): electron-updater against GitHub Releases. Stable
 * releases are the "release" channel; the "pre-release" channel also takes GitHub pre-releases.
 *
 * - **Where it works** (`updateSupport`): the Windows NSIS install, the Linux AppImage and a
 *   signed macOS app (Squirrel.Mac refuses unsigned ones). deb installs update through the
 *   package manager; development builds never update. Elsewhere the state is `unsupported` with
 *   the reason, and nothing is ever downloaded.
 * - **Checks**: shortly after start and every `CHECK_EVERY_MS` while `autoCheck` is on, and
 *   whenever the user asks. An update found is downloaded in the background; once `ready`, the
 *   user chooses when to restart (`install`), or it installs when the app quits.
 * - Changing the channel takes effect on the next check.
 */
import type { Logger } from '../../shared/logger';

export type UpdateChannel = 'release' | 'pre-release';

export type UpdateState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'idle'; checkedAt: string | null }
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'up-to-date'; checkedAt: string }
  | { kind: 'error'; message: string };

/** The parts of electron-updater's `autoUpdater` this service uses (tests pass a fake). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(
    event: 'update-available' | 'update-not-available' | 'update-downloaded',
    listener: (info: { version: string }) => void,
  ): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateSupportInput {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** `process.env.APPIMAGE`: set when running from an AppImage. */
  appImage: string | undefined;
  /** macOS: the app is signed with a Developer ID (Squirrel.Mac needs it). */
  macSigned: boolean;
}

/** Whether this build can update itself; the reason when it cannot. */
export function updateSupport(input: UpdateSupportInput): { supported: boolean; reason: string } {
  if (!input.isPackaged) {
    return { supported: false, reason: 'Development builds do not update themselves.' };
  }
  switch (input.platform) {
    case 'win32':
      return { supported: true, reason: '' };
    case 'darwin':
      return input.macSigned
        ? { supported: true, reason: '' }
        : {
            supported: false,
            reason:
              'This build is not signed, and macOS only installs signed updates. Download new versions from the Releases page.',
          };
    case 'linux':
      return input.appImage
        ? { supported: true, reason: '' }
        : {
            supported: false,
            reason: 'Installed from a .deb package: update it with your package manager.',
          };
    default:
      return { supported: false, reason: 'Updates are not available on this system.' };
  }
}

/** Checks while `autoCheck` is on: this long after start, then this often. */
export const FIRST_CHECK_MS = 30_000;
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export interface UpdateServiceDeps {
  /** Null where updates are not supported (electron-updater is never loaded there). */
  updater: UpdaterLike | null;
  support: { supported: boolean; reason: string };
  settings: () => { channel: UpdateChannel; autoCheck: boolean };
  logger: Logger;
  now?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class UpdateService {
  private stateValue: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private timer: unknown = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.stateValue =
      deps.support.supported && deps.updater
        ? { kind: 'idle', checkedAt: null }
        : { kind: 'unsupported', reason: deps.support.reason || 'Updates are not available.' };
    const updater = deps.updater;
    if (!updater || this.stateValue.kind === 'unsupported') return;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => this.set({ kind: 'checking' }));
    updater.on('update-available', (info) =>
      this.set({ kind: 'downloading', version: info.version, percent: 0 }),
    );
    updater.on('download-progress', (progress) => {
      if (this.stateValue.kind !== 'downloading') return;
      this.set({ ...this.stateValue, percent: Math.round(progress.percent) });
    });
    updater.on('update-not-available', () =>
      this.set({ kind: 'up-to-date', checkedAt: this.iso() }),
    );
    updater.on('update-downloaded', (info) => this.set({ kind: 'ready', version: info.version }));
    updater.on('error', (error) => {
      this.deps.logger.warn('updates: check or download failed', error);
      this.set({ kind: 'error', message: error.message });
    });
  }

  get state(): UpdateState {
    return this.stateValue;
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Schedules the automatic checks (when on). */
  start(): void {
    this.schedule(FIRST_CHECK_MS);
  }

  /** Re-reads the settings: turning `autoCheck` off stops the timer, on starts it. */
  settingsChanged(): void {
    this.cancelTimer();
    this.schedule(FIRST_CHECK_MS);
  }

  /** Checks now (the Settings button); resolves when the check (not the download) is done. */
  check(): Promise<void> {
    const updater = this.deps.updater;
    if (!updater || this.stateValue.kind === 'unsupported') return Promise.resolve();
    // Never interrupt a download or drop a downloaded update.
    if (this.stateValue.kind === 'downloading' || this.stateValue.kind === 'ready') {
      return Promise.resolve();
    }
    this.checking ??= (async () => {
      updater.allowPrerelease = this.deps.settings().channel === 'pre-release';
      try {
        await updater.checkForUpdates();
      } catch (error) {
        // The `error` event reports it too; this keeps a rejected promise from going unhandled.
        if (this.stateValue.kind !== 'error') {
          this.set({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** Restarts into the downloaded update (only once it is `ready`). */
  install(): boolean {
    if (this.stateValue.kind !== 'ready' || !this.deps.updater) return false;
    this.deps.logger.info(`updates: restarting into ${this.stateValue.version}`);
    this.deps.updater.quitAndInstall();
    return true;
  }

  dispose(): void {
    this.cancelTimer();
    this.listeners.clear();
  }

  private schedule(ms: number): void {
    if (this.stateValue.kind === 'unsupported' || !this.deps.settings().autoCheck) return;
    const set = this.deps.setTimeout ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
    this.timer = set(() => {
      this.timer = null;
      void this.check().finally(() => this.schedule(CHECK_EVERY_MS));
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    const clear =
      this.deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
    clear(this.timer);
    this.timer = null;
  }

  private iso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  private set(state: UpdateState): void {
    this.stateValue = state;
    for (const listener of this.listeners) listener(state);
  }
}
