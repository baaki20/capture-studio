/**
 * The preview worker (§1.7, §4.3.8): owns the decoder pool, the frame cache and the WebGL2
 * compositor on the `OffscreenCanvas` the editor transferred. The page drives it with `render`
 * messages at the audio clock's pace (`playback.ts`); see `protocol.ts`.
 */
import { WebGlCompositor } from './compositor-webgl';
import { DecoderPool } from './decoder-pool';
import { FrameCache } from './frame-cache';
import { webCodecsBackend } from './media-backend';
import { PreviewRenderer } from './preview-renderer';
import type { PreviewEvent, PreviewRequest } from './protocol';

/** The worker global, typed with what this file uses (the renderer lib is DOM). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<PreviewRequest>) => void) | null;
  postMessage(message: PreviewEvent, transfer?: Transferable[]): void;
  close(): void;
}
const scope = self as unknown as WorkerScope;

let renderer: PreviewRenderer<VideoFrame> | null = null;
let pool: DecoderPool<VideoFrame> | null = null;
let rerender: ReturnType<typeof setTimeout> | null = null;

function post(event: PreviewEvent): void {
  scope.postMessage(event);
}

function draw(tUs: number, playing: boolean): void {
  if (!renderer) return;
  const exact = renderer.render(tUs, playing);
  post({ type: 'rendered', tUs, exact, playing, stats: renderer.stats() });
}

/** A frame the last render waited for has arrived: draw the same time again, once per tick. */
function invalidate(): void {
  if (rerender !== null) return;
  rerender = setTimeout(() => {
    rerender = null;
    const t = renderer?.lastTimeUs;
    if (t !== null && t !== undefined) draw(t, false);
  }, 0);
}

scope.onmessage = (event) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init': {
        const compositor = new WebGlCompositor(message.canvas);
        pool = new DecoderPool(webCodecsBackend, new FrameCache<VideoFrame>());
        pool.onError((mediaId, error) => {
          post({ type: 'media-error', mediaId, message: error.message });
          invalidate();
        });
        renderer = new PreviewRenderer(pool, compositor, invalidate);
        post({ type: 'ready' });
        return;
      }
      case 'doc':
        renderer?.setDoc(message.doc, message.mediaUrls);
        return;
      case 'render':
        draw(message.tUs, message.playing);
        return;
      case 'probe':
        if (renderer) {
          post({ type: 'probe', id: message.id, result: renderer.probe(message.tUs) });
        }
        return;
      case 'capture': {
        const result = renderer?.capture(message.tUs) ?? null;
        scope.postMessage(
          { type: 'capture', id: message.id, result },
          result ? [result.rgba.buffer] : [],
        );
        return;
      }
      case 'dispose':
        pool?.dispose();
        pool = null;
        renderer = null;
        scope.close();
        return;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
