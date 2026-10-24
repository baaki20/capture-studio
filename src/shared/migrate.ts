/**
 * Versioned-document migrations (§1.8). Migrations are pure functions on plain JSON objects and
 * run before schema validation. Each step upgrades exactly one version.
 */

export type JsonObject = Record<string, unknown>;

export interface Migration {
  /** Version this step reads. It produces `from + 1`. */
  from: number;
  description: string;
  up(doc: JsonObject): JsonObject;
}

export interface MigrationRegistry {
  /** The key that holds the version number, e.g. `schemaVersion` or `formatVersion`. */
  versionKey: string;
  currentVersion: number;
  /** Ordered steps from the oldest supported version up to `currentVersion`. */
  migrations: readonly Migration[];
  /** Oldest version the registry can read. Defaults to the first migration's `from`. */
  oldestVersion: number;
}

export type MigrateOutcome =
  | { status: 'current'; doc: JsonObject; version: number }
  | { status: 'migrated'; doc: JsonObject; fromVersion: number; version: number; applied: string[] }
  /** The document is newer than this app understands. `doc` is returned untouched. */
  | { status: 'newer'; doc: JsonObject; version: number }
  | { status: 'invalid'; reason: string };

/** Builds a registry and checks that the steps form an unbroken chain to `currentVersion`. */
export function defineMigrations(options: {
  versionKey: string;
  currentVersion: number;
  migrations?: readonly Migration[];
}): MigrationRegistry {
  const migrations = [...(options.migrations ?? [])].sort((a, b) => a.from - b.from);
  const first = migrations[0];
  const oldestVersion = first ? first.from : options.currentVersion;
  migrations.forEach((m, i) => {
    if (m.from !== oldestVersion + i) {
      throw new Error(
        `migration chain for ${options.versionKey} has a gap or duplicate at ${String(m.from)}`,
      );
    }
  });
  if (oldestVersion + migrations.length !== options.currentVersion) {
    throw new Error(
      `migration chain for ${options.versionKey} ends at ${String(oldestVersion + migrations.length)}, expected ${String(options.currentVersion)}`,
    );
  }
  return {
    versionKey: options.versionKey,
    currentVersion: options.currentVersion,
    migrations,
    oldestVersion,
  };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep copy of a JSON value, so migrations can never mutate the caller's document. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function migrate(raw: unknown, registry: MigrationRegistry): MigrateOutcome {
  if (!isPlainObject(raw)) return { status: 'invalid', reason: 'document is not a JSON object' };
  const version = raw[registry.versionKey];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      status: 'invalid',
      reason: `${registry.versionKey} is missing or not a positive integer`,
    };
  }
  if (version > registry.currentVersion) return { status: 'newer', doc: raw, version };
  if (version === registry.currentVersion) return { status: 'current', doc: raw, version };
  if (version < registry.oldestVersion) {
    return {
      status: 'invalid',
      reason: `${registry.versionKey} ${String(version)} is too old to migrate`,
    };
  }

  let doc = cloneJson(raw);
  const applied: string[] = [];
  for (const step of registry.migrations) {
    if (step.from < version) continue;
    doc = step.up(doc);
    doc[registry.versionKey] = step.from + 1;
    applied.push(step.description);
  }
  return {
    status: 'migrated',
    doc,
    fromVersion: version,
    version: registry.currentVersion,
    applied,
  };
}
