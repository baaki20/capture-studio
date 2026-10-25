/**
 * Editor-side media services (§4.3.11 `media.peaks`, `media.thumbs`, `project.relink`; R1.29,
 * R1.44):
 *
 * - **Waveform peaks and thumbnails.** Finalize writes `cache/<mediaId>.peaks` and
 *   `cache/<mediaId>.thumbs.json` (+ sheets). `asset()` answers `ready` with the `cs-media://` URL
 *   (of the peaks file, or of the thumbnail index), `pending` while it (re)generates a missing
 *   cache file in the media utility, and `unavailable` when it cannot (wrong kind, missing media,
 *   failed job). The editor polls while pending, so the timeline stays usable meanwhile.
 * - **Offline media.** `markMediaPresence` sets `status: 'missing'` on media whose file is gone
 *   (and back to `ok` when a missing file reappears) in the document `project.open` returns.
 * - **Relink.** `relink()` lets the user choose a replacement file, copies it to the media's
 *   path inside the project (media always live inside the bundle) and marks it `ok`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JobResult, JobSpec } from '../../shared/ipc/media-utility';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import type { Media, ProjectV1 } from '../../shared/project/schema';
import { mediaUrl } from './media-protocol';
import { ProjectStoreError, type ProjectStore } from './project-store';

export type AssetKind = 'peaks' | 'thumbs';

export interface AssetResult {
  status: 'ready' | 'pending' | 'unavailable';
  url: string | null;
}

export interface EditorMediaOptions {
  store: ProjectStore;
  /** The project's folder (scanning the library if needed), or null. */
  findRoot: (projectId: string) => Promise<string | null>;
  /** The media utility's job runner. */
  runJob: <K extends 'peaks' | 'thumbnails'>(
    job: Extract<JobSpec, { kind: K }>,
  ) => Promise<JobResult<K>>;
  /** Shows an open-file dialog for a replacement; null when cancelled. */
  chooseFile?: (media: Media, senderId: number) => Promise<string | null>;
  logger?: Logger;
}

export const CACHE_DIR_NAME = 'cache';

export function assetRelativePath(kind: AssetKind, mediaId: string): string {
  return `${CACHE_DIR_NAME}/${mediaId}.${kind === 'peaks' ? 'peaks' : 'thumbs.json'}`;
}

async function isFile(fullPath: string): Promise<boolean> {
  const stat = await fs.stat(fullPath).catch(() => null);
  return stat?.isFile() ?? false;
}

/**
 * The document with `status` updated from the files on disk: `ok` media whose file is missing
 * become `missing`, `missing` media whose file is back become `ok`. Returns the input when
 * nothing changed.
 */
export async function markMediaPresence(root: string, doc: ProjectV1): Promise<ProjectV1> {
  const media = await Promise.all(
    doc.media.map(async (m) => {
      if (m.status !== 'ok' && m.status !== 'missing') return m;
      const present = await isFile(path.join(root, ...m.path.split('/')));
      const status = present ? 'ok' : 'missing';
      return status === m.status ? m : ({ ...m, status } satisfies Media);
    }),
  );
  return media.some((m, i) => m !== doc.media[i]) ? { ...doc, media } : doc;
}

export class EditorMedia {
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly failed = new Set<string>();
  private readonly logger: Logger;

  constructor(private readonly options: EditorMediaOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /** `media.peaks` / `media.thumbs`. */
  async asset(kind: AssetKind, projectId: string, mediaId: string): Promise<AssetResult> {
    const unavailable: AssetResult = { status: 'unavailable', url: null };
    const root = await this.options.findRoot(projectId);
    if (!root) return unavailable;
    const loaded = await this.options.store.read(root);
    const media = loaded?.doc.media.find((m) => m.id === mediaId);
    if (!loaded || !media) return unavailable;
    if (media.kind !== (kind === 'peaks' ? 'audio' : 'video')) return unavailable;

    const relative = assetRelativePath(kind, mediaId);
    if (await isFile(path.join(root, ...relative.split('/')))) {
      return { status: 'ready', url: mediaUrl(loaded.doc.id, relative) };
    }
    const key = `${loaded.doc.id}:${mediaId}:${kind}`;
    if (this.jobs.has(key)) return { status: 'pending', url: null };
    if (this.failed.has(key)) return unavailable;
    const input = path.join(root, ...media.path.split('/'));
    if (!(await isFile(input))) return unavailable;

    const cacheDir = path.join(root, CACHE_DIR_NAME);
    const job =
      kind === 'peaks'
        ? fs.mkdir(cacheDir, { recursive: true }).then(() =>
            this.options.runJob({
              kind: 'peaks',
              input,
              output: path.join(root, ...relative.split('/')),
            }),
          )
        : this.options.runJob({ kind: 'thumbnails', input, outDir: cacheDir, mediaId });
    this.jobs.set(key, job);
    job.then(
      () => this.jobs.delete(key),
      (error: unknown) => {
        this.jobs.delete(key);
        this.failed.add(key);
        this.logger.warn(`editor: ${kind} for ${mediaId} failed`, error);
      },
    );
    return { status: 'pending', url: null };
  }

  /** `project.relink`: replaces an offline media file with one the user picks. */
  async relink(projectId: string, mediaId: string, senderId: number): Promise<boolean> {
    const root = await this.options.findRoot(projectId);
    if (!root) throw new ProjectStoreError('unknown-project', `unknown project ${projectId}`);
    const loaded = await this.options.store.read(root);
    const media = loaded?.doc.media.find((m) => m.id === mediaId);
    if (!media) throw new ProjectStoreError('mismatch', `unknown media ${mediaId}`);
    const chosen = await this.options.chooseFile?.(media, senderId);
    if (!chosen) return false;

    const target = path.join(root, ...media.path.split('/'));
    if (path.resolve(chosen) !== path.resolve(target)) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(chosen, target);
    }
    await this.options.store.update(projectId, (doc) => ({
      ...doc,
      media: doc.media.map((m) => (m.id === mediaId ? { ...m, status: 'ok' } : m)),
    }));
    this.failed.clear();
    this.logger.info(`editor: relinked ${mediaId} of ${projectId} from ${chosen}`);
    return true;
  }
}
