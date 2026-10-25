/**
 * Loads waveform peaks and thumbnail sheets for the timeline (R1.44) through `media.peaks` and
 * `media.thumbs`. Both are optional decorations: the timeline draws plain clips until they
 * arrive, polls while main is still generating them, and gives up quietly when unavailable.
 */
import type { EditorPreloadApi } from '../../../shared/ipc/preload-api';
import type { ThumbnailIndex } from '../../../shared/ipc/media-utility';
import type { ProjectV1 } from '../../../shared/project/schema';
import { parsePeaks } from './waveform';

export const ASSET_POLL_MS = 2_000;

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
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly api: MediaApi,
    private readonly projectId: string,
  ) {}

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
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }

  private changed(): void {
    if (!this.disposed) for (const l of this.listeners) l();
  }

  private retry(fn: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) void fn();
    }, ASSET_POLL_MS);
    this.timers.add(timer);
  }

  private async loadPeaks(mediaId: string): Promise<void> {
    try {
      const result = await this.api.peaks(this.projectId, mediaId);
      if (result.status === 'pending') {
        this.retry(() => this.loadPeaks(mediaId));
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
        this.retry(() => this.loadThumbs(mediaId));
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
