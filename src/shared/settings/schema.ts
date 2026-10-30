/**
 * `settings.json` schema v1, Phase 1 subset (§4.4.3). Paths that depend on the OS (projects and
 * exports folders) are supplied by main through `createDefaultSettings`.
 *
 * Fields added after the first release have defaults in the schema (`.default`), so files written
 * before them still validate and older builds simply ignore them: additive changes need no
 * version bump. A change that renames or reshapes a field bumps `SETTINGS_SCHEMA_VERSION` and adds
 * a migration step below.
 */
import { z } from 'zod';
import { defineMigrations, type Migration } from '../migrate';
import { DEFAULT_PROJECT_NAME_PATTERN } from '../naming/name-pattern';
import { NRectSchema } from '../project/schema';

export const SETTINGS_SCHEMA_VERSION = 1;

/** 2 GB warn / 500 MB stop (R1.17), decimal units as the requirement states them. */
export const DEFAULT_DISK_WARN_BYTES = 2_000_000_000;
export const DEFAULT_DISK_STOP_BYTES = 500_000_000;
/** Imported project folders remembered outside the projects folder. */
export const MAX_IMPORTED_PROJECTS = 1000;

export const SettingsV1Schema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  projectsDir: z.string().min(1),
  exportsDir: z.string().min(1),
  namePattern: z.string().min(1),
  /** The persisted `%i` counter for name patterns. */
  nameIncrement: z.int().nonnegative(),
  recorder: z.object({
    captureMode: z.enum(['fullscreen', 'region']),
    cameraId: z.string().nullable(),
    micId: z.string().nullable(),
    systemAudio: z.boolean(),
    micProcessing: z.object({ ec: z.boolean(), ns: z.boolean(), agc: z.boolean() }),
    fps: z.literal([30, 60]),
    quality: z.enum(['standard', 'high']),
    countdownSec: z.literal([0, 3, 5]),
    /** `auto`: minimize when `ui.excludeFromCapture` is unavailable (R1.11). */
    minimizeControlsOnStart: z.enum(['auto', 'on', 'off']),
    afterRecording: z.enum(['open-editor', 'show-in-library']),
    /** Abort asks for confirmation in the controls window and the tray (R1.12; added later). */
    confirmAbort: z.boolean().default(true),
    lastRegion: z
      .object({
        sourceWidth: z.int().positive(),
        sourceHeight: z.int().positive(),
        rect: NRectSchema,
      })
      .nullable(),
  }),
  export: z.object({
    preset: z.enum(['draft', 'standard', 'high']),
    encoder: z.enum(['auto', 'software']),
  }),
  disk: z.object({
    warnBytes: z.int().nonnegative(),
    stopBytes: z.int().nonnegative(),
  }),
  theme: z.enum(['system', 'light', 'dark']),
  language: z.string().min(1),
  /**
   * Projects imported from outside the projects folder (R1.27; added later). They stay where they
   * are; the library lists them from here. Only main changes it (folder dialog).
   */
  library: z
    .object({ importedRoots: z.array(z.string().min(1)).max(MAX_IMPORTED_PROJECTS) })
    .default({ importedRoots: [] }),
});

export type Settings = z.infer<typeof SettingsV1Schema>;

export interface SettingsPathDefaults {
  /** Default `~/Videos/Capture Studio`. */
  projectsDir: string;
  /** Default `~/Videos/Capture Studio/Exports`. */
  exportsDir: string;
}

export function createDefaultSettings(paths: SettingsPathDefaults): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    projectsDir: paths.projectsDir,
    exportsDir: paths.exportsDir,
    namePattern: DEFAULT_PROJECT_NAME_PATTERN,
    nameIncrement: 0,
    recorder: {
      captureMode: 'fullscreen',
      cameraId: null,
      micId: null,
      systemAudio: true,
      micProcessing: { ec: false, ns: false, agc: false },
      fps: 30,
      quality: 'standard',
      countdownSec: 3,
      minimizeControlsOnStart: 'auto',
      afterRecording: 'open-editor',
      confirmAbort: true,
      lastRegion: null,
    },
    export: { preset: 'standard', encoder: 'auto' },
    disk: { warnBytes: DEFAULT_DISK_WARN_BYTES, stopBytes: DEFAULT_DISK_STOP_BYTES },
    theme: 'system',
    language: 'en',
    library: { importedRoots: [] },
  };
}

/** v1 is the first settings format; later versions append steps here. */
export const SETTINGS_MIGRATIONS: readonly Migration[] = [];

export const settingsMigrations = defineMigrations({
  versionKey: 'schemaVersion',
  currentVersion: SETTINGS_SCHEMA_VERSION,
  migrations: SETTINGS_MIGRATIONS,
});
