/**
 * Project-file migrations and loading. Each format appends one step here (see
 * `shared/migrate.ts`).
 */
import type { z } from 'zod';
import { defineMigrations, migrate, type Migration } from '../migrate';
import { PROJECT_FORMAT, PROJECT_FORMAT_VERSION, ProjectSchema, type Project } from './schema';

export const PROJECT_MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    description: 'v1 → v2: teaching-editor fields are optional, so nothing else changes',
    up: (doc) => doc,
  },
];

export const projectMigrations = defineMigrations({
  versionKey: 'formatVersion',
  currentVersion: PROJECT_FORMAT_VERSION,
  migrations: PROJECT_MIGRATIONS,
});

export type ProjectParseResult =
  | {
      ok: true;
      project: Project;
      /** True when the file's major version is newer than this app (R1.30): never save it. */
      readOnly: boolean;
      fileFormatVersion: number;
      migrationsApplied: string[];
    }
  | {
      ok: false;
      reason: 'not-a-project' | 'invalid' | 'newer-incompatible';
      message: string;
      issues: z.core.$ZodIssue[];
    };

/**
 * Migrates and validates a parsed `project.json`.
 *
 * A file with a newer major `formatVersion` is validated as the current format. If that succeeds it
 * opens read-only (R1.30); otherwise it is reported as `newer-incompatible`.
 */
export function parseProject(raw: unknown): ProjectParseResult {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { format?: unknown }).format !== PROJECT_FORMAT
  ) {
    return {
      ok: false,
      reason: 'not-a-project',
      message: `not a ${PROJECT_FORMAT} file`,
      issues: [],
    };
  }

  const outcome = migrate(raw, projectMigrations);
  switch (outcome.status) {
    case 'invalid':
      return { ok: false, reason: 'invalid', message: outcome.reason, issues: [] };

    case 'newer': {
      const parsed = ProjectSchema.safeParse({
        ...outcome.doc,
        formatVersion: PROJECT_FORMAT_VERSION,
      });
      if (!parsed.success) {
        return {
          ok: false,
          reason: 'newer-incompatible',
          message: `project format ${String(outcome.version)} is newer than this app supports (${String(PROJECT_FORMAT_VERSION)})`,
          issues: parsed.error.issues,
        };
      }
      return {
        ok: true,
        project: parsed.data,
        readOnly: true,
        fileFormatVersion: outcome.version,
        migrationsApplied: [],
      };
    }

    case 'current':
    case 'migrated': {
      const parsed = ProjectSchema.safeParse(outcome.doc);
      if (!parsed.success) {
        return {
          ok: false,
          reason: 'invalid',
          message: `project.json does not match schema v${String(PROJECT_FORMAT_VERSION)}`,
          issues: parsed.error.issues,
        };
      }
      return {
        ok: true,
        project: parsed.data,
        readOnly: false,
        fileFormatVersion: outcome.status === 'migrated' ? outcome.fromVersion : outcome.version,
        migrationsApplied: outcome.status === 'migrated' ? outcome.applied : [],
      };
    }
  }
}
