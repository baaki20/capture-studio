/**
 * The core of the frame-render export (§1.7, D4): for each output frame, the scene at its time
 * (`sceneAt`), the exact decoded frame of every layer (the same decoder pool and frame cache as
 * the preview), one draw of the shared WebGL compositor into its offscreen picture, and the
 * picture as yuv420p bytes for FFmpeg.
 *
 * - Frame k shows timeline time `frameTimeUs(k)`; each layer shows the source frame nearest to its
 *   file time (`pickTimeUs`), as the filter graph's `fps` filter does.
 * - A frame is drawn only when every layer's frame is exact; the check and the draw happen in the
 *   same task, so the cache cannot close a frame in between.
 * - A layer whose frame does not arrive within `settleMs` while its decoder is idle (a time before
 *   the file's first frame) is drawn with the nearest decoded frame and counted in `inexact`.
 *   Nothing for `stallMs`, or a decoder error, fails the export.
 *
 * Platform objects are behind small interfaces, so the loop is unit-tested with fakes.
 */
import { frameTimeUs, pickTimeUs, type FrameSpec } from '../../shared/export/frame-render';
import type { Media, Project } from '../../shared/project/schema';
import { sceneAt, type SceneLayer } from '../../shared/project/scene';
import type { SceneBackground } from '../editor/preview/compositor-math';
import type { CompositeItemOf, Size } from '../editor/preview/compositor-math';
import type { DecoderPool } from '../editor/preview/decoder-pool';
import type { CacheableFrame } from '../editor/preview/frame-cache';

export interface OffscreenCompositor<F> {
  resize(size: Size): void;
  drawOffscreen(background: SceneBackground, items: readonly CompositeItemOf<F>[]): void;
  readYuv420(out: Size, into?: Uint8Array): Uint8Array;
}

/** Where frames go (the port to the media utility); resolves when another frame may be sent. */
export interface FrameSink {
  write(index: number, frame: Uint8Array): Promise<void>;
}

export interface FrameRendererOptions {
  /** Waiting this long with an idle decoder accepts the nearest frame. Default 2 s. */
  settleMs?: number;
  /** Waiting this long for any frame fails the export. Default 30 s. */
  stallMs?: number;
}

export interface RenderStats {
  frames: number;
  /** Layer frames drawn with the nearest decoded frame instead of the exact one. */
  inexact: number;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export class ExportFrameRenderer<F extends CacheableFrame> {
  private readonly media: Map<string, Media>;
  private readonly settleMs: number;
  private readonly stallMs: number;
  private inexact = 0;

  constructor(
    private readonly doc: Project,
    private readonly pool: DecoderPool<F>,
    private readonly compositor: OffscreenCompositor<F>,
    options: FrameRendererOptions = {},
  ) {
    this.media = new Map(doc.media.map((m) => [m.id, m]));
    this.settleMs = options.settleMs ?? 2000;
    this.stallMs = options.stallMs ?? 30_000;
    compositor.resize(doc.timeline.canvas);
  }

  /** Renders frames `0 … spec.frames − 1` into `sink`, in order. */
  async render(spec: FrameSpec, sink: FrameSink, signal?: AbortSignal): Promise<RenderStats> {
    const out = { width: spec.width, height: spec.height };
    this.inexact = 0;
    for (let k = 0; k < spec.frames; k++) {
      if (signal?.aborted) throw new RenderError('cancelled');
      const scene = sceneAt(this.doc, frameTimeUs(k, spec.fps));
      const items = await this.settle(scene.layers, spec.fps, signal);
      this.compositor.drawOffscreen(scene.background, items);
      await sink.write(k, this.compositor.readYuv420(out));
    }
    return { frames: spec.frames, inexact: this.inexact };
  }

  /**
   * Waits until every layer's frame is decoded and returns the items to draw. Synchronous from
   * the last check to the caller's draw.
   */
  private async settle(
    layers: readonly SceneLayer[],
    fps: number,
    signal?: AbortSignal,
  ): Promise<CompositeItemOf<F>[]> {
    const started = performance.now();
    let lastEvent = started;
    for (;;) {
      if (signal?.aborted) throw new RenderError('cancelled');
      const now = performance.now();
      const items: CompositeItemOf<F>[] = [];
      let waiting = false;
      for (const layer of layers) {
        const mediaSize = this.mediaSize(layer.mediaId);
        if (layer.offline) {
          throw new RenderError(`Media is offline: ${this.mediaPath(layer.mediaId)}.`);
        }
        const failed = this.pool.failed(layer.mediaId);
        if (failed) {
          throw new RenderError(
            `Cannot decode ${this.mediaPath(layer.mediaId)}: ${failed.message}`,
          );
        }
        const pick = pickTimeUs(layer.fileTimeUs, fps);
        this.pool.request(layer.mediaId, pick);
        const answer = this.pool.frameFor(layer.mediaId, pick);
        const idle = !this.pool.decoder(layer.mediaId)?.busy;
        if (!answer.exact && !(answer.frame && idle && now - lastEvent >= this.settleMs)) {
          waiting = true;
        } else if (!answer.exact) {
          this.inexact += 1;
        }
        items.push({ layer, frame: answer.frame, mediaSize });
      }
      if (!waiting) return items;
      if (now - lastEvent >= this.stallMs) {
        throw new RenderError(
          `Decoding stalled for ${String(Math.round(this.stallMs / 1000))} s at ${String(
            Math.round(layers[0]?.fileTimeUs ?? 0),
          )} µs.`,
        );
      }
      if (await this.nextEvent(Math.min(this.settleMs, this.stallMs))) {
        lastEvent = performance.now();
      }
    }
  }

  /** Resolves true on the next decoded frame or decoder error, false after `timeoutMs`. */
  private nextEvent(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer);
        offFrame();
        offError();
        resolve(value);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const offFrame = this.pool.onFrame(() => done(true));
      const offError = this.pool.onError(() => done(true));
    });
  }

  private mediaSize(mediaId: string): Size {
    const video = this.media.get(mediaId)?.video;
    return video ? { width: video.width, height: video.height } : { width: 1, height: 1 };
  }

  private mediaPath(mediaId: string): string {
    return this.media.get(mediaId)?.path ?? mediaId;
  }
}
