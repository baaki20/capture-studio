/**
 * The project library (R1.25, R1.27): every `*.cstudio` folder directly inside the projects
 * folder. The list is rebuilt from the folders on each request, so it never goes stale; each
 * project found is registered with the project store (and so with `cs-media://`).
 *
 * Actions: rename (folder and name), move to the OS trash, reveal in the file manager, and open
 * the projects folder. Folders that belong to a running recording are left alone.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type { COMPONENT_BADGES, LibraryEntrySchema } from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import { sanitizeFileName, uniqueName } from '../../shared/naming/name-pattern';
import { PROJECT_EXTENSION, type ProjectV1 } from '../../shared/project/schema';
import { mediaUrl } from './media-protocol';
import {
  isProjectFolderName,
  projectFilePath,
  ProjectStoreError,
  type ProjectStore,
} from './project-store';

export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;
type Badge = (typeof COMPONENT_BADGES)[number];

export interface LibraryOptions {
  store: ProjectStore;
  /** The configured projects folder (read on every call, so a settings change applies). */
  projectsDir: () => string;
  /** `shell.trashItem`. */
  trashItem: (fullPath: string) => Promise<void>;
  /** `shell.showItemInFolder`. */
  showItemInFolder: (fullPath: string) => void;
  /** `shell.openPath`; resolves with an error message, or '' on success. */
  openPath: (fullPath: string) => Promise<string>;
  /** Folders of recordings in progress (never renamed or trashed). */
  busyRoots?: () => readonly string[];
  logger?: Logger;
}

/** Timeline length: the end of the last clip, or the recorded length without pauses. */
export function projectDurationUs(doc: ProjectV1): number {
  let end = 0;
  for (const track of doc.timeline.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.timelineStartUs + (clip.sourceEndUs - clip.sourceStartUs));
    }
  }
  if (end > 0 || !doc.recording) return end;
  const paused = doc.recording.pauses.reduce((sum, p) => sum + (p.endUs - p.startUs), 0);
  return Math.max(0, doc.recording.durationUs - paused);
}

/** Component badges (Screen, Face, Voice, System) for the media a project has. */
export function componentBadges(doc: ProjectV1): Badge[] {
  const roles = new Set(doc.media.map((m) => m.role));
  const badges: Badge[] = [];
  if (roles.has('screen')) badges.push('screen');
  if (roles.has('camera')) badges.push('face');
  if (roles.has('microphone')) badges.push('voice');
  if (roles.has('system-audio')) badges.push('system');
  return badges;
}

export class Library {
  private readonly logger: Logger;

  constructor(private readonly options: LibraryOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /** All readable projects, newest first. */
  async list(): Promise<LibraryEntry[]> {
    const dir = this.options.projectsDir();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: LibraryEntry[] = [];
    for (const name of names.filter(isProjectFolderName)) {
      const root = path.join(dir, name);
      const stat = await fs.stat(root).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const loaded = await this.options.store.read(root);
      if (!loaded) continue;
      this.options.store.register(loaded.doc.id, root);
      entries.push(await this.entry(loaded.doc, root));
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Renames the project and its folder (with a unique-name suffix if the name is taken). */
  async rename(id: string, name: string): Promise<LibraryEntry> {
    const root = await this.requireRoot(id);
    this.assertNotBusy(root);
    const displayName = name.trim();
    if (!displayName) throw new ProjectStoreError('mismatch', 'the name is empty');

    const parent = path.dirname(root);
    const wanted = sanitizeFileName(displayName);
    let target = root;
    if (path.basename(root) !== wanted + PROJECT_EXTENSION) {
      const taken = new Set((await fs.readdir(parent)).map((n) => n.toLowerCase()));
      const folder = uniqueName(wanted, PROJECT_EXTENSION, (c) => taken.has(c.toLowerCase()));
      target = path.join(parent, folder);
      await fs.rename(root, target);
      this.options.store.register(id, target);
    }
    const doc = await this.options.store.update(id, (d) => ({ ...d, name: displayName }));
    return this.entry(doc, target);
  }

  /** Moves the project folder to the OS trash (the UI confirms first). */
  async trash(id: string): Promise<{ trashed: boolean }> {
    const root = await this.requireRoot(id);
    this.assertNotBusy(root);
    try {
      await this.options.trashItem(root);
    } catch (error) {
      this.logger.error(`library: could not trash ${root}`, error);
      return { trashed: false };
    }
    this.options.store.unregister(id);
    return { trashed: true };
  }

  /** Shows the project folder in the file manager. */
  async reveal(id: string): Promise<void> {
    const root = await this.requireRoot(id);
    this.options.showItemInFolder(root);
  }

  /** Opens the projects folder itself. */
  async openFolder(): Promise<void> {
    const dir = this.options.projectsDir();
    await fs.mkdir(dir, { recursive: true });
    const error = await this.options.openPath(dir);
    if (error) this.logger.warn(`library: could not open ${dir}: ${error}`);
  }

  /** The folder of a project, scanning the projects folder if the id is not known yet. */
  async findRoot(id: string): Promise<string | null> {
    const known = this.options.store.rootOf(id);
    if (known) {
      const stat = await fs.stat(projectFilePath(known)).catch(() => null);
      if (stat) return known;
      this.options.store.unregister(id);
    }
    await this.list();
    return this.options.store.rootOf(id);
  }

  private async requireRoot(id: string): Promise<string> {
    const root = await this.findRoot(id);
    if (!root) throw new ProjectStoreError('unknown-project', `unknown project ${id}`);
    return root;
  }

  private assertNotBusy(root: string): void {
    const busy = (this.options.busyRoots?.() ?? []).map((r) => path.resolve(r));
    if (busy.includes(path.resolve(root))) {
      throw new ProjectStoreError('read-only', 'this project is being recorded');
    }
  }

  private async entry(doc: ProjectV1, root: string): Promise<LibraryEntry> {
    return {
      id: doc.id,
      name: doc.name,
      createdAt: doc.createdAt,
      durationUs: projectDurationUs(doc),
      components: componentBadges(doc),
      thumbUrl: await this.thumbUrl(doc, root),
      state: doc.recording?.state ?? 'complete',
    };
  }

  /** The first thumbnail sheet of the screen (or camera) media, if it exists. */
  private async thumbUrl(doc: ProjectV1, root: string): Promise<string | null> {
    const media =
      doc.media.find((m) => m.role === 'screen') ?? doc.media.find((m) => m.kind === 'video');
    if (!media) return null;
    try {
      const index = JSON.parse(
        await fs.readFile(path.join(root, 'cache', `${media.id}.thumbs.json`), 'utf8'),
      ) as { sheets?: unknown };
      const first = Array.isArray(index.sheets) ? (index.sheets[0] as unknown) : undefined;
      return typeof first === 'string' && !first.includes('/')
        ? mediaUrl(doc.id, `cache/${first}`)
        : null;
    } catch {
      return null;
    }
  }
}
