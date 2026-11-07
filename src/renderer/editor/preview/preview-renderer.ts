/**
 * The preview worker's core (§4.3.8): turns "show timeline time t" into decode requests and a
 * composited frame, using the scene at t (`sceneAt`, which is the render plan's `layersAt` for a
 * Phase 1 project): the same scene both export paths show (R1.48).
 *
 * - Every visible layer asks its media's decoder for the layer's file time; while playing, the
 *   layers one second ahead are requested too, so the next clip is decoded before it is needed.
 * - Offline media (R1.29) and media whose decoder failed draw as placeholders.
 * - When a render had to use a stand-in frame, the next decoded frame of that media triggers a
 *   re-render (`onInvalidate`), so a paused preview settles on the exact frame.
 * - Objects (text, callouts, blur and pixelate) are drawn from their draw plans; until the
 *   bundled fonts load, text is left out and the render is not exact.
 */
import { decoderKey, decoderSources, type VideoLayer } from '../../../shared/project/render-plan';
import { sceneObjectPlans } from '../../../shared/project/objects';
import { sceneAt } from '../../../shared/project/scene';
import type { Media, Project } from '../../../shared/project/schema';
import type {
  CompositeItem,
  CompositeObject,
  LumaProbe,
  PixelCapture,
  SceneBackground,
  Size,
} from './compositor-webgl';
import type { DecoderPool } from './decoder-pool';
import { ObjectRasterizer } from './object-raster';
import type { CacheableFrame } from './frame-cache';
import type { PreviewStats } from './protocol';

export const PREROLL_US = 1_000_000;

export interface CompositorLike {
  resize(size: Size): void;
  draw(
    background: SceneBackground,
    items: readonly CompositeItem[],
    objects?: readonly CompositeObject[],
  ): void;
  probe(): LumaProbe;
  /** Reads the frame just drawn (parity test); optional for test doubles. */
  capture?(): PixelCapture;
}

export class PreviewRenderer<F extends CacheableFrame & TexImageSource> {
  private doc: Project | null = null;
  private media = new Map<string, Media>();
  private lastT: number | null = null;
  private waitingFor = new Set<string>();
  private inexact = 0;

  constructor(
    private readonly pool: DecoderPool<F>,
    private readonly compositor: CompositorLike,
    private readonly onInvalidate: () => void,
    private readonly rasterizer = new ObjectRasterizer(),
  ) {
    pool.onFrame((mediaId) => {
      if (this.waitingFor.has(mediaId)) this.onInvalidate();
    });
  }

  get lastTimeUs(): number | null {
    return this.lastT;
  }

  setDoc(doc: Project, mediaUrls: Record<string, string>): void {
    this.doc = doc;
    this.media = new Map(doc.media.map((m) => [m.id, m]));
    this.pool.setSources(
      decoderSources(
        doc.media.filter((m) => m.status !== 'missing' && m.status !== 'failed'),
        (id) => mediaUrls[id] ?? null,
      ),
    );
    this.compositor.resize(doc.timeline.canvas);
  }

  /** Draws timeline time `tUs`; returns whether every layer showed its exact frame. */
  render(tUs: number, playing: boolean): boolean {
    const doc = this.doc;
    if (!doc) return false;
    this.lastT = tUs;
    const scene = sceneAt(doc, tUs);
    const { layers } = scene;
    this.waitingFor.clear();
    const items: CompositeItem[] = [];
    let exact = true;
    for (const layer of layers) {
      const answer = this.frameFor(layer);
      exact &&= answer.exact;
      items.push({ layer, frame: answer.frame, mediaSize: this.mediaSize(layer.mediaId) });
    }
    if (playing) {
      const shown = new Set(layers.map(decoderKey));
      for (const next of sceneAt(doc, tUs + PREROLL_US).layers) {
        if (!next.offline && !shown.has(decoderKey(next))) {
          this.pool.request(decoderKey(next), next.fileTimeUs);
        }
      }
    }
    // Text waits for the bundled fonts; the worker draws again when they are loaded.
    const { objects, complete } =
      scene.objects.length > 0
        ? this.rasterizer.objects(sceneObjectPlans(scene))
        : { objects: [], complete: true };
    exact &&= complete;
    this.compositor.draw(scene.background, items, objects);
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
    const key = decoderKey(layer);
    if (layer.offline || this.pool.failed(key)) return { frame: null, exact: true };
    this.pool.request(key, layer.fileTimeUs);
    const answer = this.pool.frameFor(key, layer.fileTimeUs);
    if (!answer.exact) this.waitingFor.add(key);
    return answer;
  }

  private mediaSize(mediaId: string): Size {
    const video = this.media.get(mediaId)?.video;
    return video ? { width: video.width, height: video.height } : { width: 1, height: 1 };
  }
}
