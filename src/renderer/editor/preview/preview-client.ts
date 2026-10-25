/**
 * The page side of the preview (§4.3.8): creates the canvas and the preview worker, transfers
 * the canvas to it as an `OffscreenCanvas`, forwards the document and render requests.
 *
 * Render requests are coalesced: while the worker is drawing, only the newest request waits, so
 * a slow frame never builds a queue (late frames are dropped, not shown late).
 */
import type { ProjectV1 } from '../../../shared/project/schema';
import type { LumaProbe } from './compositor-webgl';
import type { PreviewEvent, PreviewRequest, PreviewStats } from './protocol';

export interface RenderedInfo {
  tUs: number;
  exact: boolean;
  stats: PreviewStats;
}

export class PreviewClient {
  readonly canvas: HTMLCanvasElement;
  private readonly worker: Worker;
  private inFlight = false;
  private pending: { tUs: number; playing: boolean } | null = null;
  private nextProbe = 1;
  private readonly probes = new Map<number, (result: LumaProbe & { exact: boolean }) => void>();
  private readonly listeners = new Set<(info: RenderedInfo) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  private disposed = false;

  constructor(container: HTMLElement) {
    // A fresh canvas per client: a canvas can be transferred only once.
    this.canvas = document.createElement('canvas');
    this.canvas.dataset.testid = 'preview-canvas';
    container.appendChild(this.canvas);
    this.worker = new Worker(new URL('./preview.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<PreviewEvent>) => {
      this.handle(event.data);
    };
    this.worker.onerror = (event) => {
      for (const l of this.errorListeners) l(event.message || 'the preview worker failed');
    };
    const offscreen = this.canvas.transferControlToOffscreen();
    this.post({ type: 'init', canvas: offscreen }, [offscreen]);
  }

  setDoc(doc: ProjectV1, mediaUrls: Record<string, string>): void {
    this.post({ type: 'doc', doc, mediaUrls });
  }

  render(tUs: number, playing: boolean): void {
    if (this.inFlight) {
      this.pending = { tUs, playing };
      return;
    }
    this.inFlight = true;
    this.post({ type: 'render', tUs, playing });
  }

  /** Renders `tUs` and reports the picture's mean luma (e2e "not black" check). */
  probe(tUs: number): Promise<LumaProbe & { exact: boolean }> {
    const id = this.nextProbe++;
    return new Promise((resolve) => {
      this.probes.set(id, resolve);
      this.post({ type: 'probe', id, tUs });
    });
  }

  onRendered(listener: (info: RenderedInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.post({ type: 'dispose' });
    setTimeout(() => this.worker.terminate(), 1_000);
    this.canvas.remove();
  }

  private post(message: PreviewRequest, transfer: Transferable[] = []): void {
    if (this.disposed && message.type !== 'dispose') return;
    this.worker.postMessage(message, transfer);
  }

  private handle(event: PreviewEvent): void {
    switch (event.type) {
      case 'rendered': {
        this.inFlight = false;
        for (const l of this.listeners) l(event);
        const next = this.pending;
        this.pending = null;
        if (next) this.render(next.tUs, next.playing);
        return;
      }
      case 'probe':
        this.probes.get(event.id)?.(event.result);
        this.probes.delete(event.id);
        return;
      case 'media-error':
        for (const l of this.errorListeners) l(`${event.mediaId}: ${event.message}`);
        return;
      case 'error':
        this.inFlight = false;
        for (const l of this.errorListeners) l(event.message);
        return;
      case 'ready':
        return;
    }
  }
}
