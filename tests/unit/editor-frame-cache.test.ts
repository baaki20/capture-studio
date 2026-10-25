/**
 * Preview frame cache (§4.3.8, step 16): window, VFR anchor frame, LRU memory cap, and the
 * ownership rule that every frame is closed exactly once.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FrameCache } from '../../src/renderer/editor/preview/frame-cache';

class FakeFrame {
  closes = 0;
  constructor(
    readonly timestamp: number,
    readonly bytes = 100,
  ) {}
  allocationSize() {
    return this.bytes;
  }
  close() {
    this.closes += 1;
  }
}

const S = 1_000_000;

describe('FrameCache', () => {
  it('answers the latest frame at or before t, however old (VFR)', () => {
    const cache = new FrameCache<FakeFrame>();
    const a = new FakeFrame(0);
    const b = new FakeFrame(3 * S);
    cache.put('m', b);
    cache.put('m', a);
    expect(cache.timestamps('m')).toEqual([0, 3 * S]);
    expect(cache.frameAt('m', 2.9 * S)).toBe(a);
    expect(cache.frameAt('m', 3 * S)).toBe(b);
    expect(cache.frameAt('m', 60 * S)).toBe(b);
    expect(cache.frameAt('m', -1)).toBeNull();
    expect(cache.frameAt('other', 0)).toBeNull();
    expect(cache.nearest('m', 2 * S)).toBe(b);
    expect(cache.nearest('m', 1 * S)).toBe(a);
  });

  it('closes a duplicate timestamp instead of caching it', () => {
    const cache = new FrameCache<FakeFrame>();
    const first = new FakeFrame(10);
    const dup = new FakeFrame(10);
    expect(cache.put('m', first)).toBe(true);
    expect(cache.put('m', dup)).toBe(false);
    expect(dup.closes).toBe(1);
    expect(first.closes).toBe(0);
    expect(cache.stats.frames).toBe(1);
  });

  it('keeps 0.5 s behind and 1.5 s ahead, plus the frame showing at the window start', () => {
    const cache = new FrameCache<FakeFrame>();
    const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => new FakeFrame(s * S));
    for (const f of frames) cache.put('m', f);
    cache.retainWindow('m', 4.2 * S); // window [3.7 s, 5.7 s]
    expect(cache.timestamps('m')).toEqual([3 * S, 4 * S, 5 * S]);
    expect(frames.map((f) => f.closes)).toEqual([1, 1, 1, 0, 0, 0, 1, 1]);
    expect(cache.frameAt('m', 3.8 * S)?.timestamp).toBe(3 * S);
  });

  it('evicts least-recently-used frames across media to stay under the memory cap', () => {
    const cache = new FrameCache<FakeFrame>({ maxBytes: 300 });
    const a = new FakeFrame(0);
    const b = new FakeFrame(0);
    const c = new FakeFrame(1);
    cache.put('screen', a);
    cache.put('camera', b);
    cache.put('screen', c);
    cache.frameAt('screen', 0); // a is now the most recently used
    const d = new FakeFrame(2);
    cache.put('camera', d);
    expect(b.closes).toBe(1); // the oldest use
    expect(cache.stats.bytes).toBe(300);
    expect([a, c, d].map((f) => f.closes)).toEqual([0, 0, 0]);
  });

  it('closes every frame exactly once whatever happens (property)', () => {
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('put' as const),
        media: fc.constantFrom('a', 'b'),
        t: fc.nat(40),
      }),
      fc.record({
        kind: fc.constant('retain' as const),
        media: fc.constantFrom('a', 'b'),
        t: fc.nat(40),
      }),
      fc.record({
        kind: fc.constant('get' as const),
        media: fc.constantFrom('a', 'b'),
        t: fc.nat(40),
      }),
      fc.record({
        kind: fc.constant('drop' as const),
        media: fc.constantFrom('a', 'b'),
        t: fc.nat(40),
      }),
      fc.record({
        kind: fc.constant('clear' as const),
        media: fc.constantFrom('a', 'b'),
        t: fc.nat(40),
      }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 120 }), (ops) => {
        const cache = new FrameCache<FakeFrame>({ maxBytes: 1_000, aheadUs: 6, behindUs: 2 });
        const all: FakeFrame[] = [];
        for (const o of ops) {
          if (o.kind === 'put') {
            const f = new FakeFrame(o.t, 100);
            all.push(f);
            cache.put(o.media, f);
          } else if (o.kind === 'retain') cache.retainWindow(o.media, o.t);
          else if (o.kind === 'get') cache.frameAt(o.media, o.t);
          else if (o.kind === 'drop') cache.dropRange(o.media, o.t, o.t + 5);
          else cache.clearMedia(o.media);
          expect(cache.stats.bytes).toBeLessThanOrEqual(1_000);
        }
        expect(all.every((f) => f.closes <= 1)).toBe(true);
        cache.clear();
        expect(all.every((f) => f.closes === 1)).toBe(true);
        expect(cache.stats).toMatchObject({ frames: 0, bytes: 0 });
        expect(cache.stats.closed).toBe(all.length);
      }),
    );
  });
});
