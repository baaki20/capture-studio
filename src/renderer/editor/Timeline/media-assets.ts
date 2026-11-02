/**
 * Loads waveform peaks and thumbnail sheets for the timeline (R1.44) through `media.peaks` and
 * `media.thumbs`. Both are optional decorations: the timeline draws plain clips until they
 * arrive, asks again when main announces `media.cachesReady` for the project, and gives up
 * quietly when unavailable. A slow poll stays as a safety net (and is the only path for API
 * doubles without the event).
 */
import type { EditorPreloadApi } from '../../../shared/ipc/preload-api';
import type { ThumbnailIndex } from '../../../shared/ipc/media-utility';
import type { ProjectV1 } from '../../../shared/project/schema';
import { PendingLoads } from './pending-loads';
import { parsePeaks } from './waveform';

/** Poll interval when the API has no `onCachesReady` event. */
export const ASSET_POLL_MS = 2_000;
/** Safety-net poll when the event is available (main announces when caches are ready). */
export const ASSET_FALLBACK_POLL_MS = 10_000;

export interface Thumbs {
  index: ThumbnailIndex;
  /** Sheet images, in index order (an entry is null until it has loaded). */
  sheets: (HTMLImageElement | null)[];
}

type MediaApi = EditorPreloadApi['media'];

export class MediaAssets {
  readonly peaks = new Map<string, Int16Array>();
  readonly thumbs = new Map<string, Thumbs>();
  private readonly requested = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** Loads still waiting for main; run again on `media.cachesReady`. */
  private readonly pending: PendingLoads;
  private readonly unsubscribe: (() => void) | null;
  private disposed = false;

  constructor(
    private readonly api: MediaApi,
    private readonly projectId: string,
  ) {
    this.pending = new PendingLoads(api.onCachesReady ? ASSET_FALLBACK_POLL_MS : ASSET_POLL_MS);
    this.unsubscribe =
      api.onCachesReady?.((payload) => {
        if (payload.projectId === this.projectId) this.pending.retryNow();
      }) ?? null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts loading what the document's media need (idempotent). */
  load(doc: ProjectV1): void {
    for (const media of doc.media) {
      if (media.status === 'missing' || media.status === 'failed') continue;
      const key = `${media.kind}:${media.id}`;
      if (this.requested.has(key)) continue;
      this.requested.add(key);
      if (media.kind === 'audio') void this.loadPeaks(media.id);
      else void this.loadThumbs(media.id);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.pending.dispose();
    this.listeners.clear();
  }

  private changed(): void {
    if (!this.disposed) for (const l of this.listeners) l();
  }

  private async loadPeaks(mediaId: string): Promise<void> {
    try {
      const result = await this.api.peaks(this.projectId, mediaId);
      if (result.status === 'pending') {
        this.pending.retry(`peaks:${mediaId}`, () => void this.loadPeaks(mediaId));
        return;
      }
      if (result.status !== 'ready' || !result.url) return;
      const response = await fetch(result.url);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      this.peaks.set(mediaId, parsePeaks(await response.arrayBuffer()));
      this.changed();
    } catch (error) {
      console.warn(`editor: peaks for ${mediaId} failed`, error);
    }
  }

  private async loadThumbs(mediaId: string): Promise<void> {
    try {
      const result = await this.api.thumbs(this.projectId, mediaId);
      if (result.status === 'pending') {
        this.pending.retry(`thumbs:${mediaId}`, () => void this.loadThumbs(mediaId));
        return;
      }
      if (result.status !== 'ready' || !result.url) return;
      const response = await fetch(result.url);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const index = (await response.json()) as ThumbnailIndex;
      const entry: Thumbs = { index, sheets: index.sheets.map(() => null) };
      this.thumbs.set(mediaId, entry);
      index.sheets.forEach((name, i) => {
        if (name.includes('/')) return;
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => {
          entry.sheets[i] = image;
          this.changed();
        };
        image.src = new URL(encodeURIComponent(name), result.url ?? '').toString();
      });
    } catch (error) {
      console.warn(`editor: thumbnails for ${mediaId} failed`, error);
    }
  }
}
