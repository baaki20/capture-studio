/**
 * The page side of the preview (§4.3.8): creates the canvas and the preview worker, transfers
 * the canvas to it as an `OffscreenCanvas`, forwards the document and render requests.
 *
 * Render requests are coalesced: while the worker is drawing, only the newest request waits, so
 * a slow frame never builds a queue (late frames are dropped, not shown late). Playing requests
 * are timed until drawn; `leadUs` is how far ahead `Playback` renders (`render-latency.ts`).
 */
import type { ProjectV1 } from '../../../shared/project/schema';
import type { LumaProbe, PixelCapture } from './compositor-webgl';
import { PlaybackCounters, type PreviewCounterValues } from './playback-counters';
import { RenderLatency } from './render-latency';
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
  /** When the playing request being drawn was made (null for a paused one). */
  private inFlightPlayingAt: number | null = null;
  private pending: { tUs: number; playing: boolean; at: number } | null = null;
  private readonly latency = new RenderLatency();
  private nextProbe = 1;
  private readonly probes = new Map<number, (result: LumaProbe & { exact: boolean }) => void>();
  private readonly captures = new Map<
    number,
    (result: (PixelCapture & { exact: boolean }) | null) => void
  >();
  /** Late-frame instrumentation (§4.6.4). */
  private readonly playbackCounters = new PlaybackCounters();
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

  render(tUs: number, playing: boolean, at = performance.now()): void {
    if (this.inFlight) {
      this.playbackCounters.request(playing, this.pending?.playing === true);
      this.pending = { tUs, playing, at };
      return;
    }
    this.playbackCounters.request(playing, false);
    this.inFlight = true;
    this.inFlightPlayingAt = playing ? at : null;
    this.post({ type: 'render', tUs, playing });
  }

  /** How far ahead of the heard time to render while playing, in µs. */
  leadUs(): number {
    return this.latency.leadUs();
  }

  /** Renders `tUs` and reports the picture's mean luma (e2e "not black" check). */
  probe(tUs: number): Promise<LumaProbe & { exact: boolean }> {
    const id = this.nextProbe++;
    return new Promise((resolve) => {
      this.probes.set(id, resolve);
      this.post({ type: 'probe', id, tUs });
    });
  }

  /** Renders `tUs` and returns the composited picture (preview/export parity, R1.48). */
  capture(tUs: number): Promise<(PixelCapture & { exact: boolean }) | null> {
    const id = this.nextProbe++;
    return new Promise((resolve) => {
      this.captures.set(id, resolve);
      this.post({ type: 'capture', id, tUs });
    });
  }

  /** Late-frame counters since the last reset. */
  counters(): PreviewCounterValues {
    return this.playbackCounters.snapshot();
  }

  resetCounters(): void {
    this.playbackCounters.reset();
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
        if (event.playing && this.inFlightPlayingAt !== null) {
          this.latency.sample(performance.now() - this.inFlightPlayingAt);
        }
        this.inFlightPlayingAt = null;
        this.playbackCounters.drawn(event.playing, event.exact);
        for (const l of this.listeners) l(event);
        const next = this.pending;
        this.pending = null;
        if (next) this.render(next.tUs, next.playing, next.at);
        return;
      }
      case 'probe':
        this.probes.get(event.id)?.(event.result);
        this.probes.delete(event.id);
        return;
      case 'capture':
        this.captures.get(event.id)?.(event.result);
        this.captures.delete(event.id);
        return;
      case 'media-error':
        for (const l of this.errorListeners) l(`${event.mediaId}: ${event.message}`);
        return;
      case 'error':
        this.inFlight = false;
        this.inFlightPlayingAt = null;
        for (const l of this.errorListeners) l(event.message);
        return;
      case 'ready':
        return;
    }
  }
}
