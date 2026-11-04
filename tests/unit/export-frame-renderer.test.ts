/**
 * The frame-render export loop (`renderer/render/frame-renderer.ts`) with a fake decoder pool
 * and compositor: frame times, the nearest-frame pick, waiting for exact frames, the idle
 * fallback, and failures.
 */
import { describe, expect, it } from 'vitest';
import { frameTimeUs, pickTimeUs, type FrameSpec } from '../../src/shared/export/frame-render';
import { sceneAt } from '../../src/shared/project/scene';
import type { Project } from '../../src/shared/project/schema';
import type { CompositeItemOf, Size } from '../../src/renderer/editor/preview/compositor-math';
import type { DecoderPool } from '../../src/renderer/editor/preview/decoder-pool';
import {
  ExportFrameRenderer,
  type OffscreenCompositor,
} from '../../src/renderer/render/frame-renderer';
import { recordedProject } from '../fixtures/editor-project';

interface FakeFrame {
  timestamp: number;
  mediaId: string;
  allocationSize(): number;
  close(): void;
}
type CompositeItem = CompositeItemOf<FakeFrame>;

/** A pool whose frames become exact `delayMs` after they are requested. */
class FakePool {
  readonly requests: { mediaId: string; tUs: number }[] = [];
  private readonly ready = new Map<string, number>();
  private readonly frameListeners = new Set<(id: string) => void>();
  private readonly errorListeners = new Set<(id: string, e: Error) => void>();
  errors = new Map<string, Error>();
  busy = true;
  /** Media whose exact frame never arrives (only a stand-in). */
  never = new Set<string>();

  constructor(private readonly delayMs = 0) {}

  request(mediaId: string, tUs: number): void {
    this.requests.push({ mediaId, tUs });
    const key = `${mediaId}@${String(tUs)}`;
    if (this.ready.has(key) || this.never.has(mediaId)) return;
    this.ready.set(key, Number.POSITIVE_INFINITY);
    setTimeout(() => {
      this.ready.set(key, 0);
      for (const l of this.frameListeners) l(mediaId);
    }, this.delayMs);
  }
  frameFor(mediaId: string, tUs: number) {
    const exact = this.ready.get(`${mediaId}@${String(tUs)}`) === 0;
    const frame: FakeFrame = {
      timestamp: tUs,
      mediaId,
      allocationSize: () => 0,
      close: () => undefined,
    };
    return { frame, exact };
  }
  failed(mediaId: string): Error | null {
    return this.errors.get(mediaId) ?? null;
  }
  decoder() {
    return { busy: this.busy };
  }
  onFrame(listener: (id: string) => void) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onError(listener: (id: string, e: Error) => void) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
}

class FakeCompositor implements OffscreenCompositor<FakeFrame> {
  readonly draws: { background: string; items: CompositeItem[] }[] = [];
  size: Size | null = null;
  resize(size: Size): void {
    this.size = size;
  }
  drawOffscreen(background: string, items: readonly CompositeItem[]): void {
    this.draws.push({ background, items: [...items] });
  }
  readYuv420(out: Size): Uint8Array {
    return new Uint8Array((out.width * out.height * 3) / 2).fill(this.draws.length);
  }
}

function project(): Project {
  return recordedProject({
    durationUs: 1_000_000,
    mic: false,
    system: false,
    screenSize: { width: 1280, height: 720 },
    offsets: { screen: 0, camera: 0 },
  });
}

const SPEC: FrameSpec = { width: 640, height: 360, fps: 30, frames: 5 };

function setup(pool: FakePool, options = {}) {
  const doc = project();
  const compositor = new FakeCompositor();
  const renderer = new ExportFrameRenderer(
    doc,
    pool as unknown as DecoderPool<FakeFrame>,
    compositor,
    options,
  );
  const written: { index: number; frame: Uint8Array }[] = [];
  const sink = {
    write: (index: number, frame: Uint8Array) => {
      written.push({ index, frame });
      return Promise.resolve();
    },
  };
  return { doc, compositor, renderer, written, sink };
}

describe('ExportFrameRenderer', () => {
  it('draws each frame’s scene with every layer’s exact frame, in order', async () => {
    const pool = new FakePool(1);
    const { doc, compositor, renderer, written, sink } = setup(pool);
    const stats = await renderer.render(SPEC, sink);
    expect(stats).toEqual({ frames: 5, inexact: 0 });
    // The compositor draws at canvas size; `readYuv420` scales to the export size.
    expect(compositor.size).toMatchObject({ width: 1280, height: 720 });
    expect(written.map((w) => w.index)).toEqual([0, 1, 2, 3, 4]);
    expect(written[0]?.frame.length).toBe(640 * 360 * 1.5);
    for (const [k, draw] of compositor.draws.entries()) {
      const scene = sceneAt(doc, frameTimeUs(k, 30));
      expect(draw.background).toBe(doc.timeline.canvas.background.color);
      expect(draw.items.map((i) => i.layer)).toEqual(scene.layers);
      // Each layer shows the frame picked nearest to its file time.
      for (const item of draw.items) {
        expect(item.frame?.timestamp).toBe(pickTimeUs(item.layer.fileTimeUs, 30));
      }
    }
  });

  it('uses the nearest frame when an idle decoder never delivers the exact one', async () => {
    const pool = new FakePool(0);
    pool.busy = false;
    const doc = project();
    pool.never.add(doc.media[1]?.id ?? '');
    const { renderer, written, sink } = setup(pool, { settleMs: 5, stallMs: 1000 });
    const stats = await renderer.render({ ...SPEC, frames: 2 }, sink);
    expect(written).toHaveLength(2);
    expect(stats.inexact).toBe(2);
  });

  it('fails when frames stop arriving while the decoder is busy', async () => {
    const pool = new FakePool(0);
    const doc = project();
    pool.never.add(doc.media[0]?.id ?? '');
    const { renderer, sink } = setup(pool, { settleMs: 5, stallMs: 30 });
    await expect(renderer.render(SPEC, sink)).rejects.toThrow(/Decoding stalled/);
  });

  it('fails with the media path when a decoder failed', async () => {
    const pool = new FakePool(0);
    const doc = project();
    const media = doc.media[0];
    if (!media) throw new Error('no media');
    pool.errors.set(media.id, new Error('unsupported codec'));
    const { renderer, sink } = setup(pool);
    await expect(renderer.render(SPEC, sink)).rejects.toThrow(
      `Cannot decode ${media.path}: unsupported codec`,
    );
  });

  it('stops when aborted', async () => {
    const pool = new FakePool(1);
    const { renderer, sink } = setup(pool);
    const controller = new AbortController();
    controller.abort();
    await expect(renderer.render(SPEC, sink, controller.signal)).rejects.toThrow('cancelled');
  });
});
