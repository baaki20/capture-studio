/**
 * App settings in `<userData>/settings.json` (§1.8, R1.50): atomic saves with `.bak`, weekly
 * copies in `Backup/`, migrations before validation, and a user-visible notice whenever a
 * fallback copy or the defaults had to be used.
 */
import path from 'node:path';
import { migrate } from '../../shared/migrate';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import {
  createDefaultSettings,
  settingsMigrations,
  SettingsV1Schema,
  type Settings,
  type SettingsPathDefaults,
} from '../../shared/settings/schema';
import {
  quarantineFile,
  readFileWithFallback,
  rotateWeeklyBackup,
  writeFileAtomic,
  type LoadSource,
} from './atomic-file';

export const SETTINGS_FILE_NAME = 'settings.json';
export const BACKUP_DIR_NAME = 'Backup';

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type SettingsPatch = DeepPartial<Omit<Settings, 'schemaVersion'>>;

export interface SettingsLoadNotice {
  kind: 'recovered-from-backup' | 'reset-to-defaults';
  /** Where the settings came from when recovered. */
  source?: Exclude<LoadSource, 'file'>;
  /** Where the unreadable file was moved, if it existed. */
  quarantinedPath?: string | null;
  message: string;
}

export interface SettingsStoreOptions {
  /** Usually `app.getPath('userData')`. */
  dir: string;
  defaults: SettingsPathDefaults;
  now?: () => Date;
  logger?: Logger;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merges `patch` into `base`. Objects merge recursively; arrays, null and scalars replace. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}

function parseSettingsText(text: string): { settings: Settings; migrated: boolean } {
  const outcome = migrate(JSON.parse(text) as unknown, settingsMigrations);
  if (outcome.status === 'invalid') throw new Error(outcome.reason);
  if (outcome.status === 'newer') {
    throw new Error(
      `settings schemaVersion ${String(outcome.version)} is newer than this app supports`,
    );
  }
  return { settings: SettingsV1Schema.parse(outcome.doc), migrated: outcome.status === 'migrated' };
}

export class SettingsStore {
  readonly filePath: string;
  readonly backupDir: string;
  /** Set when loading needed a fallback; the UI shows it once (R1.50). */
  readonly loadNotice: SettingsLoadNotice | null;

  private current: Settings;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: SettingsStoreOptions,
    settings: Settings,
    notice: SettingsLoadNotice | null,
  ) {
    this.filePath = path.join(options.dir, SETTINGS_FILE_NAME);
    this.backupDir = path.join(options.dir, BACKUP_DIR_NAME);
    this.current = settings;
    this.loadNotice = notice;
  }

  static async open(options: SettingsStoreOptions): Promise<SettingsStore> {
    const logger = options.logger ?? silentLogger;
    const now = options.now ?? (() => new Date());
    const filePath = path.join(options.dir, SETTINGS_FILE_NAME);
    const result = await readFileWithFallback(filePath, parseSettingsText, {
      weeklyDir: path.join(options.dir, BACKUP_DIR_NAME),
    });

    let settings: Settings;
    let notice: SettingsLoadNotice | null = null;
    let needsSave = false;

    switch (result.status) {
      case 'missing':
        settings = createDefaultSettings(options.defaults);
        needsSave = true;
        break;

      case 'unreadable': {
        logger.error('settings: no readable copy, using defaults', result.failures);
        const quarantinedPath = await quarantineFile(filePath, now());
        settings = createDefaultSettings(options.defaults);
        needsSave = true;
        notice = {
          kind: 'reset-to-defaults',
          quarantinedPath,
          message:
            'Your settings could not be read and no backup was usable, so the defaults were restored.' +
            (quarantinedPath
              ? ` The damaged file was kept as ${path.basename(quarantinedPath)}.`
              : ''),
        };
        break;
      }

      case 'loaded': {
        settings = result.value.settings;
        needsSave = result.value.migrated;
        if (result.source !== 'file') {
          logger.warn(`settings: loaded from ${result.source} (${result.path})`, result.failures);
          const quarantinedPath = await quarantineFile(filePath, now());
          needsSave = true;
          notice = {
            kind: 'recovered-from-backup',
            source: result.source,
            quarantinedPath,
            message: 'Your settings file was damaged, so the most recent backup was restored.',
          };
        }
        break;
      }
    }

    const store = new SettingsStore(options, settings, notice);
    if (needsSave) await store.save();
    return store;
  }

  /** A deep copy of the current settings. */
  get(): Settings {
    return structuredClone(this.current);
  }

  /**
   * Applies a partial update. The merged result is validated first; an invalid patch throws a
   * ZodError and changes nothing.
   */
  async patch(patch: SettingsPatch): Promise<Settings> {
    const next = SettingsV1Schema.parse(deepMerge(this.current, patch));
    this.current = next;
    await this.save();
    return this.get();
  }

  /** Writes the current settings. Saves are serialized so they land in call order. */
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.current, null, 2) + '\n';
    const run = async (): Promise<void> => {
      await writeFileAtomic(this.filePath, snapshot);
      try {
        await rotateWeeklyBackup(this.filePath, {
          dir: this.backupDir,
          ...(this.options.now ? { now: this.options.now } : {}),
        });
      } catch (error) {
        (this.options.logger ?? silentLogger).warn('settings: weekly backup failed', error);
      }
    };
    this.saving = this.saving.then(run, run);
    return this.saving;
  }
}
