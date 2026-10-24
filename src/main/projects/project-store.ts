/**
 * Reads and writes `project.json` inside project folders (§1.6, R1.28, R1.30).
 *
 * - Every write is atomic with `.bak` (`settings/atomic-file.ts`); a load falls back to `.tmp`,
 *   then `.bak`, so a kill during a save never leaves an unreadable project.
 * - Editor saves use optimistic concurrency (§4.3.11 `project.save`): each project has an
 *   in-memory revision that every write bumps; a save that names an older revision is rejected.
 *   Main's own writes (finalize, rename) bump it too, so an editor holding a stale copy cannot
 *   overwrite them.
 * - Editor saves also keep a rolling copy of the replaced version in `backups/` (last 20).
 * - Projects are addressed by id; the store maps ids to folders and registers each folder with
 *   the `cs-media://` protocol.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import { parseProject } from '../../shared/project/migrations';
import {
  PROJECT_EXTENSION,
  PROJECT_FILE_NAME,
  ProjectV1Schema,
  type ProjectV1,
} from '../../shared/project/schema';
import { readFileWithFallback, writeFileAtomic, type LoadSource } from '../settings/atomic-file';
import { mediaUrl, type ProjectRootRegistry } from './media-protocol';

export const BACKUPS_DIR_NAME = 'backups';
export const MAX_PROJECT_BACKUPS = 20;

export class ProjectStoreError extends Error {
  constructor(
    readonly code: 'unknown-project' | 'unreadable' | 'stale-revision' | 'read-only' | 'mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

export interface LoadedProject {
  doc: ProjectV1;
  readOnly: boolean;
  source: LoadSource;
  root: string;
}

export interface ProjectOpenResult {
  doc: ProjectV1;
  revision: number;
  mediaUrls: Record<string, string>;
  readOnly: boolean;
}

export interface ProjectStoreOptions {
  registry: ProjectRootRegistry;
  logger?: Logger;
  now?: () => Date;
}

export function projectFilePath(root: string): string {
  return path.join(root, PROJECT_FILE_NAME);
}

export function isProjectFolderName(name: string): boolean {
  return name.endsWith(PROJECT_EXTENSION) && name.length > PROJECT_EXTENSION.length;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '-');
}

function parseProjectText(text: string): { doc: ProjectV1; readOnly: boolean } {
  const parsed = parseProject(JSON.parse(text) as unknown);
  if (!parsed.ok) throw new Error(parsed.message);
  return { doc: parsed.project, readOnly: parsed.readOnly };
}

export class ProjectStore {
  private readonly roots = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  /** Serializes writes per project. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly logger: Logger;

  constructor(private readonly options: ProjectStoreOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /** Associates a project id with its folder (and the media protocol). */
  register(id: string, root: string): void {
    const resolved = path.resolve(root);
    this.roots.set(id, resolved);
    this.options.registry.register(id, resolved);
  }

  unregister(id: string): void {
    this.roots.delete(id);
    this.options.registry.unregister(id);
  }

  rootOf(id: string): string | null {
    return this.roots.get(id) ?? null;
  }

  /** The project's current revision (0 until something is written in this run). */
  revision(id: string): number {
    return this.revisions.get(id) ?? 0;
  }

  /** Reads a project folder's `project.json` (with fallbacks); null when none is readable. */
  async read(root: string): Promise<LoadedProject | null> {
    const result = await readFileWithFallback(projectFilePath(root), parseProjectText);
    if (result.status !== 'loaded') {
      if (result.status === 'unreadable') {
        this.logger.warn(`project: unreadable ${projectFilePath(root)}`, result.failures);
      }
      return null;
    }
    if (result.source !== 'file') {
      this.logger.warn(`project: loaded ${root} from ${result.source}`, result.failures);
    }
    return { ...result.value, source: result.source, root };
  }

  /** `project.open`: the document, its revision and a media URL per media id. */
  async open(id: string): Promise<ProjectOpenResult> {
    const root = this.requireRoot(id);
    const loaded = await this.read(root);
    if (!loaded) throw new ProjectStoreError('unreadable', `project ${id} cannot be read`);
    if (loaded.doc.id !== id) {
      throw new ProjectStoreError('mismatch', `folder ${root} holds project ${loaded.doc.id}`);
    }
    const mediaUrls: Record<string, string> = {};
    for (const media of loaded.doc.media) mediaUrls[media.id] = mediaUrl(id, media.path);
    return {
      doc: loaded.doc,
      revision: this.revision(id),
      mediaUrls,
      readOnly: loaded.readOnly,
    };
  }

  /**
   * `project.save`: writes `doc` if `revision` is the current one and returns the new revision.
   * Rejects a stale revision, a read-only (newer-format) project and a doc for another project.
   */
  async save(id: string, revision: number, doc: ProjectV1): Promise<{ revision: number }> {
    const root = this.requireRoot(id);
    return this.serialize(id, async () => {
      const current = this.revision(id);
      if (revision !== current) {
        throw new ProjectStoreError(
          'stale-revision',
          `project ${id}: revision ${String(revision)} is stale (current ${String(current)})`,
        );
      }
      if (doc.id !== id) throw new ProjectStoreError('mismatch', `doc is project ${doc.id}`);
      const existing = await this.read(root);
      if (existing?.readOnly) {
        throw new ProjectStoreError('read-only', `project ${id} has a newer format; not saved`);
      }
      await this.backup(root);
      return { revision: await this.writeUnlocked(id, root, doc) };
    });
  }

  /**
   * Main's own writes (recording, finalize, recovery, rename). Validates, stamps `modifiedAt`,
   * writes atomically and bumps the revision.
   */
  async write(root: string, doc: ProjectV1): Promise<number> {
    this.register(doc.id, root);
    return this.serialize(doc.id, () => this.writeUnlocked(doc.id, root, doc));
  }

  /** Reads, changes and writes a project in one serialized step. */
  async update(id: string, change: (doc: ProjectV1) => ProjectV1): Promise<ProjectV1> {
    const root = this.requireRoot(id);
    return this.serialize(id, async () => {
      const loaded = await this.read(root);
      if (!loaded) throw new ProjectStoreError('unreadable', `project ${id} cannot be read`);
      if (loaded.readOnly) {
        throw new ProjectStoreError('read-only', `project ${id} has a newer format; not changed`);
      }
      const next = change(loaded.doc);
      await this.writeUnlocked(id, root, next);
      return next;
    });
  }

  private async writeUnlocked(id: string, root: string, doc: ProjectV1): Promise<number> {
    const stamped = ProjectV1Schema.parse({
      ...doc,
      modifiedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
    await writeFileAtomic(projectFilePath(root), `${JSON.stringify(stamped, null, 2)}\n`);
    const next = this.revision(id) + 1;
    this.revisions.set(id, next);
    return next;
  }

  /** Copies the current `project.json` into `backups/` and keeps the newest 20. */
  private async backup(root: string): Promise<void> {
    const dir = path.join(root, BACKUPS_DIR_NAME);
    try {
      const current = await fs.readFile(projectFilePath(root));
      await fs.mkdir(dir, { recursive: true });
      const now = (this.options.now ?? (() => new Date()))();
      await fs.writeFile(path.join(dir, `project-${stamp(now)}.json`), current);
      const names = (await fs.readdir(dir))
        .filter((n) => n.startsWith('project-') && n.endsWith('.json'))
        .sort();
      await Promise.all(
        names
          .slice(0, Math.max(0, names.length - MAX_PROJECT_BACKUPS))
          .map((n) => fs.rm(path.join(dir, n), { force: true })),
      );
    } catch (error) {
      this.logger.warn(`project: backup in ${dir} failed`, error);
    }
  }

  private requireRoot(id: string): string {
    const root = this.roots.get(id);
    if (!root) throw new ProjectStoreError('unknown-project', `unknown project ${id}`);
    return root;
  }

  private serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }
}
