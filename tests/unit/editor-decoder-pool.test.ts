/**
 * Preview decoder pool bookkeeping (§4.3.8, step 16) with a fake demuxer and decoder: runs from
 * key packets, continue versus seek, backpressure, end of file, eviction and frame ownership.
 */
import { describe, expect, it } from 'vitest';
import {
  DecodeRun,
  DecoderPool,
  type DecoderBackend,
  type DemuxedPacket,
  type VideoDecoderLike,
  type VideoDemuxer,
} from '../../src/renderer/editor/preview/decoder-pool';
import { FrameCache } from '../../src/renderer/editor/preview/frame-cache';

const S = 1_000_000;

class FakeFrame {
  closes = 0;
  constructor(readonly timestamp: number) {}
  allocationSize() {
    return 1_000;
  }
  close() {
    this.closes += 1;
  }
}

interface World {
  backend: DecoderBackend<FakeFrame>;
  frames: FakeFrame[];
  resets: number;
  flushes: number;
  maxQueue: number;
  fed: number[];
  opened: string[];
}

/** A file with a frame every `stepUs` and a key frame every `keyEveryUs`. */
function world(durationUs = 10 * S, stepUs = 100_000, keyEveryUs = 1 * S, failOpen = false): World {
  const timestamps: number[] = [];
  for (let t = 0; t < durationUs; t += stepUs) timestamps.push(t);
  const packet = (t: number): DemuxedPacket => ({
    timestampUs: t,
    key: t % keyEveryUs === 0,
    chunk: () => ({ timestamp: t }) as unknown as EncodedVideoChunk,
  });
  const w: World = {
    backend: null as never,
    frames: [],
    resets: 0,
    flushes: 0,
    maxQueue: 0,
    fed: [],
    opened: [],
  };
  const demuxer: VideoDemuxer = {
    config: { codec: 'fake' },
    keyPacketAtOrBefore: (t) => {
      const key = [...timestamps]
        .reverse()
        .find((x) => x <= Math.max(0, t) && x % keyEveryUs === 0);
      return Promise.resolve(packet(key ?? 0));
    },
    packetsFrom: (start) => {
      let i = timestamps.indexOf(start.timestampUs);
      return {
        next: () =>
          Promise.resolve(
            i < timestamps.length
              ? { done: false as const, value: packet(timestamps[i++]!) }
              : { done: true as const, value: undefined },
          ),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      };
    },
    dispose: () => undefined,
  };
  w.backend = {
    openDemuxer: (url) => {
      w.opened.push(url);
      return failOpen ? Promise.reject(new Error('cannot open')) : Promise.resolve(demuxer);
    },
    wait: () => new Promise((r) => setTimeout(r, 0)),
    createDecoder: (output) => {
      let queue: number[] = [];
      let state: VideoDecoderLike['state'] = 'unconfigured';
      const drainOne = () => {
        const t = queue.shift();
        if (t === undefined) return;
        const frame = new FakeFrame(t);
        w.frames.push(frame);
        output(frame);
      };
      const decoder: VideoDecoderLike = {
        get decodeQueueSize() {
          return queue.length;
        },
        get state() {
          return state;
        },
        configure: () => {
          state = 'configured';
        },
        decode: (chunk) => {
          queue.push((chunk as unknown as { timestamp: number }).timestamp);
          w.fed.push((chunk as unknown as { timestamp: number }).timestamp);
          w.maxQueue = Math.max(w.maxQueue, queue.length);
          setTimeout(drainOne, 0);
        },
        flush: () => {
          w.flushes += 1;
          while (queue.length) drainOne();
          return Promise.resolve();
        },
        reset: () => {
          w.resets += 1;
          queue = [];
          state = 'unconfigured';
        },
        close: () => {
          queue = [];
          state = 'closed';
        },
      };
      return decoder;
    },
  };
  return w;
}

async function settle(pool: DecoderPool<FakeFrame>, id = 'm'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (!pool.decoder(id)?.busy) {
      await new Promise((r) => setTimeout(r, 0));
      if (!pool.decoder(id)?.busy) return;
    }
  }
  throw new Error('decoder did not settle');
}

function setup(w: World, maxQueue = 4) {
  const cache = new FrameCache<FakeFrame>();
  const pool = new DecoderPool(w.backend, cache, { maxQueue });
  pool.setSources([{ mediaId: 'm', url: 'cs-media://p/media/screen.mp4' }]);
  return { pool, cache };
}

describe('DecodeRun', () => {
  it('knows which frame shows at t once a later frame (or the end) is decoded', () => {
    const run = new DecodeRun(1 * S);
    run.recordFed(1.4 * S);
    run.recordOutput(1 * S);
    run.recordOutput(1.2 * S);
    expect(run.resolves(1.1 * S)).toBe(true);
    expect(run.frameTimestampAt(1.1 * S)).toBe(1 * S);
    expect(run.resolves(1.3 * S)).toBe(false);
    run.ended = true;
    expect(run.resolves(9 * S)).toBe(true);
    expect(run.frameTimestampAt(9 * S)).toBe(1.2 * S);
    expect(run.resolves(0.5 * S)).toBe(false);
  });

  it('continues a little ahead and seeks otherwise', () => {
    const run = new DecodeRun(2 * S);
    run.recordFed(3 * S);
    expect(run.reach(2.5 * S)).toBe('inside');
    expect(run.reach(4 * S)).toBe('ahead');
    expect(run.reach(9 * S)).toBe('seek');
    expect(run.reach(1 * S)).toBe('seek');
  });
});

describe('DecoderPool', () => {
  it('decodes from the key frame before t, about 1.5 s ahead, and answers the exact frame', async () => {
    const w = world();
    const { pool } = setup(w);
    expect(pool.frameFor('m', 2.35 * S)).toEqual({ frame: null, exact: false });
    pool.request('m', 2.35 * S);
    await settle(pool);
    expect(w.fed[0]).toBe(2 * S);
    expect(Math.max(...w.fed)).toBeGreaterThanOrEqual(2.35 * S + 1.5 * S);
    expect(Math.max(...w.fed)).toBeLessThan(2.35 * S + 1.5 * S + 200_000);
    const answer = pool.frameFor('m', 2.35 * S);
    expect(answer.exact).toBe(true);
    expect(answer.frame?.timestamp).toBe(2.3 * S);
  });

  it('continues the run when playing forward and resets it for a backwards or far seek', async () => {
    const w = world();
    const { pool } = setup(w);
    pool.request('m', 1 * S);
    await settle(pool);
    const resets = w.resets;
    pool.request('m', 3 * S); // within the continue window
    await settle(pool);
    expect(w.resets).toBe(resets);
    expect(pool.frameFor('m', 3 * S)).toMatchObject({ exact: true });
    pool.request('m', 0.5 * S); // backwards
    await settle(pool);
    expect(w.resets).toBe(resets + 1);
    pool.request('m', 9 * S); // far ahead
    await settle(pool);
    expect(w.resets).toBe(resets + 2);
    expect(pool.frameFor('m', 9.05 * S).frame?.timestamp).toBe(9 * S);
  });

  it('respects the decode-queue limit (backpressure)', async () => {
    const w = world();
    const { pool } = setup(w, 3);
    pool.request('m', 0);
    await settle(pool);
    expect(w.maxQueue).toBeLessThanOrEqual(3);
  });

  it('flushes at the end of the file and then resolves times past the last frame', async () => {
    const w = world(2 * S);
    const { pool } = setup(w);
    pool.request('m', 1.95 * S);
    await settle(pool);
    expect(w.flushes).toBe(1);
    expect(pool.frameFor('m', 5 * S)).toMatchObject({ exact: true, frame: { timestamp: 1.9 * S } });
  });

  it('decodes an evicted frame again', async () => {
    const w = world();
    const { pool, cache } = setup(w);
    pool.request('m', 4 * S);
    await settle(pool);
    cache.dropRange('m', 3.9 * S, 4.1 * S);
    const resets = w.resets;
    expect(pool.frameFor('m', 4 * S).exact).toBe(false);
    await settle(pool);
    expect(w.resets).toBe(resets + 1);
    expect(pool.frameFor('m', 4 * S)).toMatchObject({ exact: true, frame: { timestamp: 4 * S } });
  });

  it('closes every decoded frame exactly once and stops decoding removed media', async () => {
    const w = world();
    const { pool, cache } = setup(w);
    pool.request('m', 0);
    pool.request('m', 6 * S);
    pool.request('m', 2 * S);
    await settle(pool);
    pool.setSources([{ mediaId: 'm', url: 'cs-media://p/media/other.mp4' }]); // re-pointed
    expect(pool.openMediaIds).toEqual([]);
    expect(cache.stats.frames).toBe(0);
    pool.request('m', 1 * S);
    await settle(pool);
    expect(w.opened).toEqual(['cs-media://p/media/screen.mp4', 'cs-media://p/media/other.mp4']);
    pool.dispose();
    await new Promise((r) => setTimeout(r, 10)); // late outputs after dispose
    expect(w.frames.length).toBeGreaterThan(0);
    expect(w.frames.every((f) => f.closes === 1)).toBe(true);
  });

  it('reports a media that cannot be opened and answers no frame', async () => {
    const w = world(10 * S, 100_000, S, true);
    const { pool } = setup(w);
    const errors: string[] = [];
    pool.onError((id, e) => errors.push(`${id}: ${e.message}`));
    pool.request('m', 0);
    await settle(pool);
    expect(errors).toEqual(['m: cannot open']);
    expect(pool.failed('m')?.message).toBe('cannot open');
    expect(pool.frameFor('m', 0)).toEqual({ frame: null, exact: false });
    pool.request('unknown', 0); // no source: ignored
  });
});
