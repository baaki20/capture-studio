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
 * - **Audio renders.** `audioRender()` answers the same way for a sped-up clip's audio, rendered
 *   on demand into `cache/audio/` for the preview (R2.18).
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
import {
  audioRenderKey,
  audioRenderPath,
  type AudioRenderSpec,
} from '../../shared/project/audio-speed';
import type { Media, Project } from '../../shared/project/schema';
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
  doc: Project,
  health: MediaHealthCache = defaultHealth,
): Promise<{ doc: Project; offline: Record<string, OfflineMedia> }> {
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
  doc: Project,
  health?: MediaHealthCache,
): Promise<Project> {
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
    const { status, url } = await this.locate(kind, projectId, mediaId);
    return { status, url };
  }

  /** Like `asset`, with the cache file's absolute path instead of its URL (main-side readers). */
  async assetFile(
    kind: AssetKind,
    projectId: string,
    mediaId: string,
  ): Promise<{ status: AssetResult['status']; path: string | null }> {
    const { status, path: file } = await this.locate(kind, projectId, mediaId);
    return { status, path: file };
  }

  private async locate(
    kind: AssetKind,
    projectId: string,
    mediaId: string,
  ): Promise<AssetResult & { path: string | null }> {
    const unavailable = { status: 'unavailable', url: null, path: null } as const;
    const root = await this.options.findRoot(projectId);
    if (!root) return unavailable;
    const loaded = await this.options.store.read(root);
    const media = loaded?.doc.media.find((m) => m.id === mediaId);
    if (!loaded || !media) return unavailable;
    if (media.kind !== (kind === 'peaks' ? 'audio' : 'video')) return unavailable;

    const relative = assetRelativePath(kind, mediaId);
    const projectKey = loaded.doc.id;
    // A background job may be writing the file right now: wait for it to finish.
    const pending = { status: 'pending', url: null, path: null } as const;
    if (this.caches.isPending(projectKey, mediaId, kind)) return pending;
    const file = path.join(root, ...relative.split('/'));
    if (await isFile(file)) {
      return { status: 'ready', url: mediaUrl(loaded.doc.id, relative), path: file };
    }
    if (this.caches.hasFailed(projectKey, mediaId, kind)) return unavailable;
    if (!(await isFile(path.join(root, ...media.path.split('/'))))) return unavailable;

    // The editor asks for what it shows first: ahead of the background pass.
    void this.caches.ensure({ projectId: projectKey, root, media }, 0);
    return pending;
  }

  /**
   * `media.audioRender` (R2.18): the preview's render of an audio media's file range at a clip's
   * speed (`cache/audio/<key>.wav`), queued on first request; `pending` until it is written.
   */
  async audioRender(projectId: string, spec: AudioRenderSpec): Promise<AssetResult> {
    const unavailable = { status: 'unavailable', url: null } as const;
    const root = await this.options.findRoot(projectId);
    if (!root) return unavailable;
    const loaded = await this.options.store.read(root);
    const media = loaded?.doc.media.find((m) => m.id === spec.mediaId);
    if (!loaded || media?.kind !== 'audio') return unavailable;
    if (spec.fileStartUs < 0 || spec.fileEndUs <= spec.fileStartUs) return unavailable;
    const key = audioRenderKey(spec);
    const relative = audioRenderPath(key);
    const projectKey = loaded.doc.id;
    if (this.caches.isAudioRenderPending(projectKey, key)) return { status: 'pending', url: null };
    const file = path.join(root, ...relative.split('/'));
    if (await isFile(file)) return { status: 'ready', url: mediaUrl(projectKey, relative) };
    if (this.caches.hasAudioRenderFailed(projectKey, key)) return unavailable;
    if (!(await isFile(path.join(root, ...media.path.split('/'))))) return unavailable;
    void this.caches.ensureAudioRender(
      { projectId: projectKey, root, mediaPath: media.path, key, output: file },
      {
        startSeconds: spec.fileStartUs / 1_000_000,
        endSeconds: spec.fileEndUs / 1_000_000,
        speed: spec.speed,
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
    this.caches.clearFailures(projectId);
    this.logger.info(`editor: relinked ${mediaId} of ${projectId} from ${chosen}`);
    return true;
  }
}
