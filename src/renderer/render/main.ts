/**
 * Entry of the hidden render window (frame-render export, §1.7, D4). Main creates one window per
 * export and sends the snapshot, the frame spec and the frame port; this page decodes with the
 * preview's decoder pool, draws with the preview's WebGL compositor, and streams yuv420p frames
 * to the media utility (`render-session.ts`). Main closes the window when the export ends.
 */
import { RenderStartSchema } from '../../shared/ipc/render-port';
import {
  RENDER_START_MESSAGE,
  type RenderStartWindowMessage,
} from '../../shared/ipc/render-window';
import { WebGlCompositor } from '../editor/preview/compositor-webgl';
import { DecoderPool } from '../editor/preview/decoder-pool';
import { FrameCache } from '../editor/preview/frame-cache';
import { webCodecsBackend } from '../editor/preview/media-backend';
import { ExportFrameRenderer } from './frame-renderer';
import { RenderSession } from './render-session';

let session: RenderSession | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  // Only the preload's re-post: same window, our message type, once.
  if (event.source !== window || session) return;
  const data = event.data as Partial<RenderStartWindowMessage> | null;
  if (data?.type !== RENDER_START_MESSAGE) return;
  const port = event.ports[0];
  if (!port) return;
  const parsed = RenderStartSchema.safeParse(data.payload);
  if (!parsed.success) {
    port.postMessage({ type: 'error', attempt: 0, message: 'Invalid render start message.' });
    port.close();
    return;
  }
  const { mediaUrls, spec } = parsed.data;
  const { doc } = parsed.data;
  const { canvas } = doc.timeline;
  const compositor = new WebGlCompositor(new OffscreenCanvas(canvas.width, canvas.height));
  const pool = new DecoderPool<VideoFrame>(webCodecsBackend, new FrameCache<VideoFrame>());
  pool.setSources(
    doc.media.flatMap((m) => {
      const url = mediaUrls[m.id];
      return m.kind === 'video' && url ? [{ mediaId: m.id, url }] : [];
    }),
  );
  const renderer = new ExportFrameRenderer<VideoFrame>(doc, pool, compositor);
  session = new RenderSession(
    port,
    renderer,
    spec,
    () => {
      pool.dispose();
      compositor.dispose();
    },
    (message) => console.info(message),
  );
});
