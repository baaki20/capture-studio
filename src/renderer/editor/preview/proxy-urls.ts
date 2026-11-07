/**
 * Preview proxies of large videos (acceptance g): asks main for the 720p proxy of every video
 * media larger than 1080p (`media.proxy`), retries while it is being made, and reports the
 * ready ones (media ID → URL). The preview decodes proxies instead of the originals; the export
 * never does. Kept free of DOM types so it is testable from Node.
 */
import type { EditorPreloadApi } from '../../../shared/ipc/preload-api';
import { needsProxy } from '../../../shared/project/media-import';
import type { Project } from '../../../shared/project/schema';
import { PendingLoads } from '../Timeline/pending-loads';

export const PROXY_POLL_MS = 1000;

export class ProxyUrls {
  private readonly ready: Record<string, string> = {};
  private readonly requested = new Set<string>();
  private readonly pending = new PendingLoads(PROXY_POLL_MS);
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly api: EditorPreloadApi['media'],
    private readonly projectId: string,
  ) {}

  /** Ready proxies: media ID → URL. */
  get urls(): Readonly<Record<string, string>> {
    return this.ready;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Requests the proxies the document's large videos need (idempotent). */
  load(doc: Project): void {
    if (!this.api.proxy) return;
    for (const m of doc.media) {
      if (m.kind !== 'video' || !m.video || !needsProxy(m.video) || m.status !== 'ok') continue;
      if (this.requested.has(m.id)) continue;
      this.requested.add(m.id);
      void this.request(m.id);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending.dispose();
    this.listeners.clear();
  }

  private async request(mediaId: string): Promise<void> {
    try {
      const result = await this.api.proxy?.(this.projectId, mediaId);
      if (!result || this.isDisposed()) return;
      if (result.status === 'pending') {
        this.pending.retry(mediaId, () => void this.request(mediaId));
      } else if (result.status === 'ready' && result.url) {
        this.ready[mediaId] = result.url;
        for (const listener of this.listeners) listener();
      }
    } catch (error) {
      console.warn(`editor: proxy of ${mediaId} failed`, error);
    }
  }

  private isDisposed(): boolean {
    return this.disposed;
  }
}
