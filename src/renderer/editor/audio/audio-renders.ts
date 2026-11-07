/**
 * Preview renders of sped-up audio (R2.18): asks main for the render of each sped-up segment
 * the document has (`media.audioRender`), retries while it is being made, and reports the ready
 * ones (key → URL) to the scheduler. Kept free of DOM types so it is testable from Node.
 */
import { audioRenderKey } from '../../../shared/project/audio-speed';
import { audioSegments } from '../../../shared/project/render-plan';
import type { Project } from '../../../shared/project/schema';
import type { EditorPreloadApi } from '../../../shared/ipc/preload-api';
import { PendingLoads } from '../Timeline/pending-loads';
import { wantedRenders } from './schedule-math';

/** How often a render that is still being made is asked for again. */
export const RENDER_POLL_MS = 500;

export class AudioRenders {
  private readonly ready = new Map<string, string>();
  private readonly requested = new Set<string>();
  private readonly pending = new PendingLoads(RENDER_POLL_MS);
  private readonly listeners = new Set<(renders: ReadonlyMap<string, string>) => void>();
  private disposed = false;

  constructor(
    private readonly api: EditorPreloadApi['media'],
    private readonly projectId: string,
  ) {}

  /** Ready renders, key → URL. */
  get urls(): ReadonlyMap<string, string> {
    return this.ready;
  }

  /** Renders still being made. */
  get waiting(): number {
    return this.pending.size;
  }

  onChange(listener: (renders: ReadonlyMap<string, string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Requests the renders the document's sped-up segments need (idempotent). */
  load(doc: Project): void {
    if (!this.api.audioRender) return;
    for (const spec of wantedRenders(audioSegments(doc, { includeInaudible: true }))) {
      const key = audioRenderKey(spec);
      if (this.requested.has(key)) continue;
      this.requested.add(key);
      void this.request(key, spec);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending.dispose();
    this.listeners.clear();
  }

  private async request(key: string, spec: Parameters<typeof audioRenderKey>[0]): Promise<void> {
    try {
      const result = await this.api.audioRender?.({ projectId: this.projectId, ...spec });
      if (!result || this.isDisposed()) return;
      if (result.status === 'pending') {
        this.pending.retry(key, () => void this.request(key, spec));
      } else if (result.status === 'ready' && result.url) {
        this.ready.set(key, result.url);
        for (const listener of this.listeners) listener(new Map(this.ready));
      }
    } catch (error) {
      console.warn(`editor: audio render ${key} failed`, error);
    }
  }

  /** Read through a method: `dispose` may run while a request awaits. */
  private isDisposed(): boolean {
    return this.disposed;
  }
}
