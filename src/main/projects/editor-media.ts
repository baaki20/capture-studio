/**
 * Editor-side media services (§4.3.11 `media.peaks`, `media.thumbs`, `project.relink`; R1.29,
 * R1.44):
 *
 * - **Waveform peaks and thumbnails.** Finalize queues `cache/<mediaId>.peaks` and
 *   `cache/<mediaId>.thumbs.json` (+ sheets) in the background (`CacheJobs`). `asset()` answers
 *   `ready` with the `cs-media://` URL (of the peaks file, or of the thumbnail index), `pending`
 *   while the shared queue generates it (a missing cache is queued here, never twice), and
 *   `unavailable` when it cannot (wrong kind, missing media, failed job). The editor polls while
 *   pending, so the timeline stays usable meanwhile.
 * - **Offline media.** `checkMediaPresence` sets `status: 'missing'` on media whose file is gone,
 *   unreadable or damaged (`media-check.ts`), and back to `ok` when a usable file is there again,
 *   in the document `project.open` returns; it also says why each one is offline.
 * - **Relink.** `relink()` lets the user choose a replacement file, copies it to the media's
 *   path inside the project (media always live inside the bundle) and marks it `ok`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OfflineMedia } from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import type { Media, ProjectV1 } from '../../shared/project/schema';
import {
  assetRelativePath,
  CACHE_DIR_NAME,
  CacheJobs,
  type CacheJobRunner,
  type CacheKind,
} from './cache-jobs';
import { MediaHealthCache, type MediaHealth } from './media-check';
import { mediaUrl } from './media-protocol';
import { ProjectStoreError, type ProjectStore } from './project-store';

export { assetRelativePath, CACHE_DIR_NAME };
export type AssetKind = CacheKind;

export interface AssetResult {
  status: 'ready' | 'pending' | 'unavailable';
  url: string | null;
}

export interface EditorMediaOptions {
  store: ProjectStore;
  /** The project's folder (scanning the library if needed), or null. */
  findRoot: (projectId: string) => Promise<string | null>;
  /** The shared cache queue (finalize fills it in the background). */
  caches?: CacheJobs;
  /** The media utility's job runner (used when no `caches` queue is given). */
  runJob?: CacheJobRunner;
  /** Shows an open-file dialog for a replacement; null when cancelled. */
  chooseFile?: (media: Media, senderId: number) => Promise<string | null>;
  logger?: Logger;
}

async function isFile(fullPath: string): Promise<boolean> {
  const stat = await fs.stat(fullPath).catch(() => null);
  return stat?.isFile() ?? false;
}

const defaultHealth = new MediaHealthCache();

/**
 * The document with `status` updated from the files on disk: `ok` media whose file is missing,
 * unreadable or damaged become `missing` (offline), offline media whose file is usable again
 * become `ok`. `offline` says why each offline media is offline. Returns the input document when
 * nothing changed.
 */
export async function checkMediaPresence(
  root: string,
  doc: ProjectV1,
  health: MediaHealthCache = defaultHealth,
): Promise<{ doc: ProjectV1; offline: Record<string, OfflineMedia> }> {
  const offline: Record<string, OfflineMedia> = {};
  const media = await Promise.all(
    doc.media.map(async (m) => {
      if (m.status !== 'ok' && m.status !== 'missing') return m;
      const result: MediaHealth = await health.check(path.join(root, ...m.path.split('/')));
      if (result.state === 'missing') offline[m.id] = { reason: 'missing', detail: null };
      else if (result.state === 'unreadable') {
        offline[m.id] = { reason: 'unreadable', detail: result.reason };
      }
      const status = result.state === 'ok' ? 'ok' : 'missing';
      return status === m.status ? m : ({ ...m, status } satisfies Media);
    }),
  );
  const changed = media.some((m, i) => m !== doc.media[i]);
  return { doc: changed ? { ...doc, media } : doc, offline };
}

/** `checkMediaPresence` without the reasons. */
export async function markMediaPresence(
  root: string,
  doc: ProjectV1,
  health?: MediaHealthCache,
): Promise<ProjectV1> {
  return (await checkMediaPresence(root, doc, health)).doc;
}

export class EditorMedia {
  private readonly caches: CacheJobs;
  private readonly logger: Logger;

  constructor(private readonly options: EditorMediaOptions) {
    this.logger = options.logger ?? silentLogger;
    if (options.caches) this.caches = options.caches;
    else if (options.runJob) {
      this.caches = new CacheJobs({ runJob: options.runJob, logger: this.logger });
    } else throw new Error('EditorMedia needs a cache queue or a job runner');
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
    const projectKey = loaded.doc.id;
    // A background job may be writing the file right now: wait for it to finish.
    if (this.caches.isPending(projectKey, mediaId, kind)) return { status: 'pending', url: null };
    if (await isFile(path.join(root, ...relative.split('/')))) {
      return { status: 'ready', url: mediaUrl(loaded.doc.id, relative) };
    }
    if (this.caches.hasFailed(projectKey, mediaId, kind)) return unavailable;
    if (!(await isFile(path.join(root, ...media.path.split('/'))))) return unavailable;

    // The editor asks for what it shows first: ahead of the background pass.
    void this.caches.ensure({ projectId: projectKey, root, media }, 0);
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
    this.caches.clearFailures(projectId);
    this.logger.info(`editor: relinked ${mediaId} of ${projectId} from ${chosen}`);
    return true;
  }
}
