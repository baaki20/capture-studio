/**
 * The preview worker's core (§4.3.8): turns "show timeline time t" into decode requests and a
 * composited frame, using the render plan's `layersAt` (the same plan the export uses, R1.48).
 *
 * - Every visible layer asks its media's decoder for the layer's file time; while playing, the
 *   layers one second ahead are requested too, so the next clip is decoded before it is needed.
 * - Offline media (R1.29) and media whose decoder failed draw as placeholders.
 * - When a render had to use a stand-in frame, the next decoded frame of that media triggers a
 *   re-render (`onInvalidate`), so a paused preview settles on the exact frame.
 */
import { layersAt, type VideoLayer } from '../../../shared/project/render-plan';
import type { Media, ProjectV1 } from '../../../shared/project/schema';
import type { CompositeItem, LumaProbe, PixelCapture, Size } from './compositor-webgl';
import type { DecoderPool } from './decoder-pool';
import type { CacheableFrame } from './frame-cache';
import type { PreviewStats } from './protocol';

export const PREROLL_US = 1_000_000;

export interface CompositorLike {
  resize(size: Size): void;
  draw(background: string, items: readonly CompositeItem[]): void;
  probe(): LumaProbe;
  /** Reads the frame just drawn (parity test); optional for test doubles. */
  capture?(): PixelCapture;
}

export class PreviewRenderer<F extends CacheableFrame & TexImageSource> {
  private doc: ProjectV1 | null = null;
  private media = new Map<string, Media>();
  private lastT: number | null = null;
  private waitingFor = new Set<string>();
  private inexact = 0;

  constructor(
    private readonly pool: DecoderPool<F>,
    private readonly compositor: CompositorLike,
    private readonly onInvalidate: () => void,
  ) {
    pool.onFrame((mediaId) => {
      if (this.waitingFor.has(mediaId)) this.onInvalidate();
    });
  }

  get lastTimeUs(): number | null {
    return this.lastT;
  }

  setDoc(doc: ProjectV1, mediaUrls: Record<string, string>): void {
    this.doc = doc;
    this.media = new Map(doc.media.map((m) => [m.id, m]));
    this.pool.setSources(
      doc.media
        .filter((m) => m.kind === 'video' && m.status !== 'missing' && m.status !== 'failed')
        .flatMap((m) => {
          const url = mediaUrls[m.id];
          return url ? [{ mediaId: m.id, url }] : [];
        }),
    );
    this.compositor.resize(doc.timeline.canvas);
  }

  /** Draws timeline time `tUs`; returns whether every layer showed its exact frame. */
  render(tUs: number, playing: boolean): boolean {
    const doc = this.doc;
    if (!doc) return false;
    this.lastT = tUs;
    const layers = layersAt(doc, tUs);
    this.waitingFor.clear();
    const items: CompositeItem[] = [];
    let exact = true;
    for (const layer of layers) {
      const answer = this.frameFor(layer);
      exact &&= answer.exact;
      items.push({ layer, frame: answer.frame, mediaSize: this.mediaSize(layer.mediaId) });
    }
    if (playing) {
      const shown = new Set(layers.map((l) => l.mediaId));
      for (const next of layersAt(doc, tUs + PREROLL_US)) {
        if (!next.offline && !shown.has(next.mediaId)) {
          this.pool.request(next.mediaId, next.fileTimeUs);
        }
      }
    }
    this.compositor.draw(doc.timeline.canvas.background.color, items);
    if (!exact) this.inexact += 1;
    return exact;
  }

  probe(tUs: number): LumaProbe & { exact: boolean } {
    const exact = this.render(tUs, false);
    return { ...this.compositor.probe(), exact };
  }

  /** Draws `tUs` and returns the picture, or null when the compositor cannot read back. */
  capture(tUs: number): (PixelCapture & { exact: boolean }) | null {
    const exact = this.render(tUs, false);
    const picture = this.compositor.capture?.();
    return picture ? { ...picture, exact } : null;
  }

  stats(): PreviewStats {
    const cache = this.pool.cache.stats;
    return {
      frames: cache.frames,
      bytes: cache.bytes,
      inserted: cache.inserted,
      closed: cache.closed,
      decoders: this.pool.openMediaIds.length,
      inexact: this.inexact,
    };
  }

  private frameFor(layer: VideoLayer): { frame: F | null; exact: boolean } {
    if (layer.offline || this.pool.failed(layer.mediaId)) return { frame: null, exact: true };
    this.pool.request(layer.mediaId, layer.fileTimeUs);
    const answer = this.pool.frameFor(layer.mediaId, layer.fileTimeUs);
    if (!answer.exact) this.waitingFor.add(layer.mediaId);
    return answer;
  }

  private mediaSize(mediaId: string): Size {
    const video = this.media.get(mediaId)?.video;
    return video ? { width: video.width, height: video.height } : { width: 1, height: 1 };
  }
}
