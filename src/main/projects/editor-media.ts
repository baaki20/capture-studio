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
 * - **Audio renders.** `audioRender()` answers the same way for a media's cleaned audio (noise
 *   reduction, R2.14) and for a sped-up clip's audio (R2.18), rendered on demand into
 *   `cache/audio/` for the preview.
 * - **Offline media.** `checkMediaPresence` sets `status: 'missing'` on media whose file is gone,
 *   unreadable or damaged (`media-check.ts`), and back to `ok` when a usable file is there again,
 *   in the document `project.open` returns; it also says why each one is offline.
 * - **Relink.** `relink()` lets the user choose a replacement file, copies it to the media's
 *   path inside the project (media always live inside the bundle) and marks it `ok`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddTakeResult, ImportMediaResult, OfflineMedia } from '../../shared/ipc/contract';
import { newId } from '../../shared/ids';
import { importedMediaEntry, needsProxy } from '../../shared/project/media-import';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import type { AudioRenderRequest } from '../../shared/ipc/contract';
import { cleanedAudioPath } from '../../shared/project/audio-cleanup';
import { audioRenderKey, audioRenderPath } from '../../shared/project/audio-speed';
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
  /** Shows an open-files dialog for pictures, videos and audio to import; empty when cancelled. */
  chooseImports?: (senderId: number) => Promise<string[]>;
  /** Shows a folder dialog for a recorded project to add as a take; null when cancelled. */
  chooseTake?: (senderId: number) => Promise<string | null>;
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

/** `name` made safe for a file name and unused in `dir` (any extension). */
async function uniqueBaseName(dir: string, name: string): Promise<string> {
  const safe =
    name
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 60) || 'media';
  const taken = new Set(
    (await fs.readdir(dir).catch(() => [] as string[])).map((f) => path.parse(f).name),
  );
  if (!taken.has(safe)) return safe;
  for (let n = 2; ; n++) if (!taken.has(`${safe}-${String(n)}`)) return `${safe}-${String(n)}`;
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
  async audioRender(projectId: string, request: AudioRenderRequest): Promise<AssetResult> {
    const unavailable = { status: 'unavailable', url: null } as const;
    const pending = { status: 'pending', url: null } as const;
    const root = await this.options.findRoot(projectId);
    if (!root) return unavailable;
    const loaded = await this.options.store.read(root);
    const media = loaded?.doc.media.find((m) => m.id === request.mediaId);
    if (!loaded || media?.kind !== 'audio') return unavailable;
    const projectKey = loaded.doc.id;
    const noise = request.noise ?? 'off';
    const original = path.join(root, ...media.path.split('/'));
    if (!(await isFile(original))) return unavailable;

    /** One cache file: ready, or queued (once) and pending. */
    const ensure = async (
      key: string,
      relative: string,
      job: (output: string) => Parameters<CacheJobs['ensureAudioRender']>[1],
    ): Promise<AssetResult> => {
      if (this.caches.isAudioRenderPending(projectKey, key)) return pending;
      const file = path.join(root, ...relative.split('/'));
      if (await isFile(file)) return { status: 'ready', url: mediaUrl(projectKey, relative) };
      if (this.caches.hasAudioRenderFailed(projectKey, key)) return unavailable;
      void this.caches.ensureAudioRender({ projectId: projectKey, key }, job(file));
      return pending;
    };

    // The cleaned audio first (a sped-up render of a cleaned track starts from it).
    let input = original;
    if (noise !== 'off') {
      const relative = cleanedAudioPath(media.id, noise);
      const cleaned = await ensure(`${media.id}-clean-${noise}`, relative, (output) => ({
        kind: 'cleanAudio',
        input: original,
        output,
        noise,
      }));
      if (cleaned.status !== 'ready' || !request.range) return cleaned;
      input = path.join(root, ...relative.split('/'));
    }
    const range = request.range;
    if (!range) return unavailable;
    if (range.fileStartUs < 0 || range.fileEndUs <= range.fileStartUs) return unavailable;
    const key = audioRenderKey({ mediaId: media.id, noise, ...range });
    return ensure(key, audioRenderPath(key), (output) => ({
      kind: 'audioRender',
      input,
      output,
      startSeconds: range.fileStartUs / 1_000_000,
      endSeconds: range.fileEndUs / 1_000_000,
      speed: range.speed,
    }));
  }

  /**
   * `project.importMedia` (R2.21): the user picks files; each is put into the project's `media/`
   * by the utility (`media-import.ts`) and comes back as media entries, per file, with URLs.
   * The editor adds them with `addMedia`. Null when the user cancelled.
   */
  async importMedia(projectId: string, senderId: number): Promise<ImportMediaResult | null> {
    const root = await this.requireRoot(projectId);
    const files = (await this.options.chooseImports?.(senderId)) ?? [];
    if (files.length === 0) return null;
    const result: ImportMediaResult = { files: [], urls: {} };
    const mediaDir = path.join(root, 'media');
    for (const input of files) {
      const baseName = await uniqueBaseName(mediaDir, path.parse(input).name);
      const imported = await this.caches.runNow({
        kind: 'importMedia',
        input,
        mediaDir,
        baseName,
      });
      const entry: ImportMediaResult['files'][number] = {
        name: path.parse(input).name,
        media: [],
        items: [],
      };
      for (const file of imported.files) {
        const id = newId('media');
        const relative = `media/${path.basename(file.path)}`;
        entry.media.push(importedMediaEntry(id, relative, file));
        entry.items.push({
          mediaId: id,
          kind: file.kind,
          still: file.still,
          durationUs: file.durationUs,
        });
        result.urls[id] = mediaUrl(projectId, relative);
      }
      result.files.push(entry);
      this.logger.info(
        `editor: imported ${input} into ${projectId} (${String(entry.media.length)} streams)`,
      );
    }
    return result;
  }

  /**
   * `project.addTake` (R2.22): the user picks another recorded project; its media are copied
   * into this one (new IDs and file names) and come back with its tracks (clips from 0, edits
   * kept), for `addMedia` at the playhead. Null when the user cancelled.
   */
  async addTake(projectId: string, senderId: number): Promise<AddTakeResult | null> {
    const root = await this.requireRoot(projectId);
    const takeRoot = await this.options.chooseTake?.(senderId);
    if (!takeRoot) return null;
    if (path.resolve(takeRoot) === path.resolve(root)) {
      throw new ProjectStoreError(
        'mismatch',
        'Choose another project: this is the one being edited.',
      );
    }
    const take = await this.options.store.read(takeRoot);
    if (!take) throw new ProjectStoreError('unknown-project', 'That folder is not a project.');
    const mediaDir = path.join(root, 'media');
    const ids = new Map<string, string>();
    const result: AddTakeResult = { media: [], tracks: [], urls: {} };
    for (const m of take.doc.media) {
      const source = path.join(takeRoot, ...m.path.split('/'));
      if (!(await isFile(source))) continue;
      const parsed = path.parse(m.path);
      const baseName = await uniqueBaseName(mediaDir, `take-${parsed.name}`);
      const relative = `media/${baseName}${parsed.ext}`;
      await fs.mkdir(mediaDir, { recursive: true });
      await fs.copyFile(source, path.join(root, ...relative.split('/')));
      const id = newId('media');
      ids.set(m.id, id);
      const { sync: _sync, ...rest } = m;
      result.media.push({ ...rest, id, path: relative, status: 'ok', syncAdjustUs: 0 });
      result.urls[id] = mediaUrl(projectId, relative);
    }
    for (const track of take.doc.timeline.tracks) {
      const clips = track.clips
        .filter((c) => ids.has(c.mediaId))
        .map((c) => ({ ...c, mediaId: ids.get(c.mediaId) ?? c.mediaId }));
      if (clips.length === 0) continue;
      result.tracks.push({ ...track, name: `${track.name} (take)`, clips });
    }
    this.logger.info(`editor: added the take ${takeRoot} to ${projectId}`);
    return result;
  }

  /**
   * `media.proxy` (acceptance g): a 720p preview proxy of a large video (`cache/<id>.proxy.mp4`),
   * queued on first request; `unavailable` for audio and videos up to 1080p.
   */
  async proxy(projectId: string, mediaId: string): Promise<AssetResult> {
    const unavailable = { status: 'unavailable', url: null } as const;
    const root = await this.options.findRoot(projectId);
    if (!root) return unavailable;
    const loaded = await this.options.store.read(root);
    const media = loaded?.doc.media.find((m) => m.id === mediaId);
    if (!loaded || media?.kind !== 'video' || !media.video || !needsProxy(media.video)) {
      return unavailable;
    }
    const projectKey = loaded.doc.id;
    const key = `${mediaId}-proxy`;
    const relative = `${CACHE_DIR_NAME}/${mediaId}.proxy.mp4`;
    if (this.caches.isAudioRenderPending(projectKey, key)) return { status: 'pending', url: null };
    const file = path.join(root, ...relative.split('/'));
    if (await isFile(file)) return { status: 'ready', url: mediaUrl(projectKey, relative) };
    if (this.caches.hasAudioRenderFailed(projectKey, key)) return unavailable;
    const input = path.join(root, ...media.path.split('/'));
    if (!(await isFile(input))) return unavailable;
    void this.caches.ensureAudioRender(
      { projectId: projectKey, key },
      { kind: 'proxy', input, output: file },
      3,
    );
    return { status: 'pending', url: null };
  }

  private async requireRoot(projectId: string): Promise<string> {
    const root = await this.options.findRoot(projectId);
    if (!root) throw new ProjectStoreError('unknown-project', `unknown project ${projectId}`);
    return root;
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
