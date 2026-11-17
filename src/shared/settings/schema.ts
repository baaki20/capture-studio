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

/**
 * Assistants (MCP) driving the app through the automation socket (added later). Off until the
 * user turns it on; main listens on the socket only while `enabled` is true.
 */
export const AutomationSettingsSchema = z.object({ enabled: z.boolean() });

/**
 * Updates (P3 step 9, plan D4): the channel is the GitHub release kind the updater follows
 * (`pre-release` also takes pre-releases); `autoCheck` checks at start and every few hours.
 */
export const UpdateSettingsSchema = z.object({
  channel: z.enum(['release', 'pre-release']),
  autoCheck: z.boolean(),
});
export const DEFAULT_UPDATE_SETTINGS = { channel: 'release', autoCheck: true } as const;

export const SettingsV1Schema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  projectsDir: z.string().min(1),
  exportsDir: z.string().min(1),
  namePattern: z.string().min(1),
  /** The persisted `%i` counter for name patterns. */
  nameIncrement: z.int().nonnegative(),
  recorder: z.object({
    /**
     * `window` records one window (the portal's window tab; letterboxed if it resizes) and
     * `audio-only` records no picture (P2, R2.29–R2.30).
     */
    captureMode: z.enum(['fullscreen', 'region', 'window', 'audio-only']),
    cameraId: z.string().nullable(),
    micId: z.string().nullable(),
    systemAudio: z.boolean(),
    micProcessing: z.object({ ec: z.boolean(), ns: z.boolean(), agc: z.boolean() }),
    fps: z.literal([30, 60]),
    quality: z.enum(['standard', 'high']),
    countdownSec: z.literal([0, 3, 5]),
    /** `auto`: minimize when `ui.excludeFromCapture` is unavailable (R1.11). */
    minimizeControlsOnStart: z.enum(['auto', 'on', 'off']),
    /** `export-gif`: the quick-GIF workflow (P2): export a Small GIF and show it. */
    afterRecording: z.enum(['open-editor', 'show-in-library', 'export-gif']),
    /** Abort asks for confirmation in the controls window and the tray (R1.12; added later). */
    confirmAbort: z.boolean().default(true),
    /** Stop after this many seconds of recording (pauses excluded); 0 = no limit (P2). */
    durationLimitSec: z.int().min(0).max(86_400).default(0),
    /** Region mode: record only the region (smaller files) instead of cropping later (P2). */
    cropAtRecord: z.boolean().default(false),
    /** Fail instead of recording with a software encoder when no hardware one works (P2). */
    requireHardware: z.boolean().default(false),
    /**
     * P3 step 6 (D11): a highlight around the pointer, drawn on screen and recorded into the
     * picture for good. Off by default: the editor's click effects can be changed later.
     */
    liveHighlighter: z.boolean().default(false),
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
  automation: AutomationSettingsSchema.default({ enabled: false }),
  updates: UpdateSettingsSchema.default(DEFAULT_UPDATE_SETTINGS),
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
      durationLimitSec: 0,
      cropAtRecord: false,
      requireHardware: false,
      liveHighlighter: false,
      lastRegion: null,
    },
    export: { preset: 'standard', encoder: 'auto' },
    disk: { warnBytes: DEFAULT_DISK_WARN_BYTES, stopBytes: DEFAULT_DISK_STOP_BYTES },
    theme: 'system',
    language: 'en',
    library: { importedRoots: [] },
    automation: { enabled: false },
    updates: { ...DEFAULT_UPDATE_SETTINGS },
  };
}

/** v1 is the first settings format; later versions append steps here. */
export const SETTINGS_MIGRATIONS: readonly Migration[] = [];

export const settingsMigrations = defineMigrations({
  versionKey: 'schemaVersion',
  currentVersion: SETTINGS_SCHEMA_VERSION,
  migrations: SETTINGS_MIGRATIONS,
});
