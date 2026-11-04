/**
 * Both ends of the frame port (`shared/ipc/render-port.ts`): the media utility's `FrameFeed`
 * (ordered writes into FFmpeg's stdin, acks as backpressure, attempts, failures) and the render
 * window's `RenderSession` (at most `FRAME_WINDOW` frames in flight, restart per attempt, stop),
 * first separately with fakes, then wired to each other.
 */
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { yuvFrameBytes, type FrameSpec } from '../../src/shared/export/frame-render';
import { FRAME_WINDOW } from '../../src/shared/ipc/render-port';
import { FrameFeed, FrameFeedError } from '../../src/utility/media/export/frame-feed';
import type { FrameSink, RenderStats } from '../../src/renderer/render/frame-renderer';
import { RenderSession, type FramePort } from '../../src/renderer/render/render-session';
import type { PortLike } from '../../src/utility/media/stream-writer';

const SPEC: FrameSpec = { width: 4, height: 2, fps: 30, frames: 3 };
const BYTES = yuvFrameBytes(SPEC.width, SPEC.height);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The utility's end: records what it posts, delivers what the test sends. */
class FakeUtilityPort implements PortLike {
  readonly posted: unknown[] = [];
  closed = false;
  private onMessage: ((event: { data: unknown }) => void) | null = null;
  private onClose: (() => void) | null = null;
  on(event: 'message' | 'close', listener: (event: { data: unknown }) => void) {
    if (event === 'message') this.onMessage = listener;
    else this.onClose = () => listener({ data: undefined });
    return this;
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  start(): void {
    // Messages are delivered as soon as the test sends them.
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: unknown): void {
    this.onMessage?.({ data });
  }
  disconnect(): void {
    this.onClose?.();
  }
}

/** FFmpeg's stdin: keeps what was written; `hold` delays write callbacks. */
class FakeStdin extends Writable {
  readonly chunks: Buffer[] = [];
  held: (() => void)[] = [];
  hold = false;
  ended = false;
  override _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
    this.chunks.push(chunk);
    if (this.hold) this.held.push(() => callback());
    else callback();
  }
  override _final(callback: () => void) {
    this.ended = true;
    callback();
  }
}

const frame = (attempt: number, index: number, size = BYTES) => ({
  type: 'frame',
  attempt,
  index,
  data: new Uint8Array(size).fill(index + 1),
});

describe('FrameFeed (utility)', () => {
  it('writes frames in order, acks each, and ends stdin after the last', async () => {
    const port = new FakeUtilityPort();
    const feed = new FrameFeed(port, SPEC);
    const stdin = new FakeStdin();
    const done = feed.attempt(stdin);
    expect(port.posted).toEqual([{ type: 'start', attempt: 0 }]);
    for (let i = 0; i < 3; i++) port.deliver(frame(0, i));
    port.deliver({ type: 'end', attempt: 0, frames: 3 });
    await done;
    expect(stdin.ended).toBe(true);
    expect(stdin.chunks.map((c) => c[0])).toEqual([1, 2, 3]);
    expect(port.posted.slice(1)).toEqual(
      [0, 1, 2].map((index) => ({ type: 'ack', attempt: 0, index })),
    );
  });

  it('acks a frame only once FFmpeg took it (backpressure)', async () => {
    const port = new FakeUtilityPort();
    const feed = new FrameFeed(port, SPEC);
    const stdin = new FakeStdin();
    stdin.hold = true;
    void feed.attempt(stdin);
    port.deliver(frame(0, 0));
    await tick();
    expect(port.posted).toHaveLength(1);
    stdin.held.shift()?.();
    await tick();
    expect(port.posted[1]).toEqual({ type: 'ack', attempt: 0, index: 0 });
  });

  it.each([
    ['an out-of-order frame', [frame(0, 1)], /Frame 1 arrived when 0 was expected/],
    ['a frame of the wrong size', [frame(0, 0, BYTES - 1)], /bytes, not/],
    ['an early end', [frame(0, 0), { type: 'end', attempt: 0, frames: 3 }], /after 1 of 3 frames/],
    [
      'a renderer error',
      [{ type: 'error', attempt: 0, message: 'Cannot decode x' }],
      /Cannot decode x/,
    ],
    [
      'a malformed message',
      [{ type: 'frame', attempt: 0, index: 0, data: 'x' }],
      /malformed message \(data: expected bytes/,
    ],
  ])('fails the attempt on %s, blaming the renderer', async (_name, messages, error) => {
    const port = new FakeUtilityPort();
    const feed = new FrameFeed(port, SPEC);
    const done = feed.attempt(new FakeStdin());
    for (const message of messages) port.deliver(message);
    await expect(done).rejects.toThrow(error);
    await expect(done).rejects.toMatchObject({ source: 'renderer' });
  });

  it('fails when the render window closes, and refuses later attempts', async () => {
    const port = new FakeUtilityPort();
    const feed = new FrameFeed(port, SPEC);
    const done = feed.attempt(new FakeStdin());
    port.disconnect();
    await expect(done).rejects.toThrow('The render window closed.');
    await expect(feed.attempt(new FakeStdin())).rejects.toThrow('The render window closed.');
  });

  it('starts a second attempt from frame 0 and ignores the first one’s messages', async () => {
    const port = new FakeUtilityPort();
    const feed = new FrameFeed(port, SPEC);
    const first = feed.attempt(new FakeStdin());
    port.deliver(frame(0, 0));
    const stdin = new FakeStdin();
    const second = feed.attempt(stdin);
    await expect(first).rejects.toMatchObject({ source: 'stopped' });
    expect(port.posted).toContainEqual({ type: 'start', attempt: 1 });
    port.deliver(frame(0, 1)); // stale: ignored
    for (let i = 0; i < 3; i++) port.deliver(frame(1, i));
    port.deliver({ type: 'end', attempt: 1, frames: 3 });
    await second;
    expect(stdin.chunks).toHaveLength(3);
  });

  it('reports a failed write to FFmpeg as FFmpeg’s, not the renderer’s', async () => {
    const port = new FakeUtilityPort();
    const feed = new FrameFeed(port, SPEC);
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('EPIPE'));
      },
    });
    const done = feed.attempt(stdin);
    port.deliver(frame(0, 0));
    await expect(done).rejects.toMatchObject({ source: 'ffmpeg' });
    await expect(done).rejects.toBeInstanceOf(FrameFeedError);
  });

  it('tells the renderer to stop and closes the port once', () => {
    const port = new FakeUtilityPort();
    const feed = new FrameFeed(port, SPEC);
    feed.stop();
    feed.stop();
    expect(port.posted).toEqual([{ type: 'stop' }]);
    expect(port.closed).toBe(true);
  });
});

/** The render window's end. */
class FakeRendererPort implements FramePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly posted: { type: string; attempt?: number; index?: number }[] = [];
  closed = false;
  postMessage(message: unknown): void {
    this.posted.push(message as { type: string });
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

/** Renders `frames` frames as fast as the sink allows; can fail or hang at a frame. */
function fakeRenderer(options: { failAt?: number } = {}) {
  const calls: AbortSignal[] = [];
  return {
    calls,
    async render(spec: FrameSpec, sink: FrameSink, signal: AbortSignal): Promise<RenderStats> {
      calls.push(signal);
      for (let k = 0; k < spec.frames; k++) {
        if (signal.aborted) throw new Error('cancelled');
        if (k === options.failAt) throw new Error(`decoder failed at ${String(k)}`);
        await sink.write(k, new Uint8Array(BYTES).fill(k));
      }
      return { frames: spec.frames, inexact: 0 };
    },
  };
}

describe('RenderSession (render window)', () => {
  const spec: FrameSpec = { ...SPEC, frames: 8 };

  it('keeps at most FRAME_WINDOW frames unacknowledged, then ends', async () => {
    const port = new FakeRendererPort();
    new RenderSession(port, fakeRenderer(), spec, () => undefined);
    port.deliver({ type: 'start', attempt: 0 });
    await tick();
    const frames = () => port.posted.filter((m) => m.type === 'frame');
    expect(frames()).toHaveLength(FRAME_WINDOW);
    for (let i = 0; i < spec.frames; i++) {
      port.deliver({ type: 'ack', attempt: 0, index: i });
      await tick();
      expect(frames().length - (i + 1)).toBeLessThanOrEqual(FRAME_WINDOW);
    }
    expect(frames().map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(port.posted.at(-1)).toEqual({ type: 'end', attempt: 0, frames: 8 });
  });

  it('restarts from frame 0 on a new start, aborting the old attempt', async () => {
    const port = new FakeRendererPort();
    const renderer = fakeRenderer();
    const session = new RenderSession(port, renderer, spec, () => undefined);
    port.deliver({ type: 'start', attempt: 0 });
    await tick();
    port.deliver({ type: 'start', attempt: 1 });
    await tick();
    expect(renderer.calls[0]?.aborted).toBe(true);
    expect(session.currentAttempt).toBe(1);
    const second = port.posted.filter((m) => m.type === 'frame' && m.attempt === 1);
    expect(second.map((m) => m.index)).toEqual([0, 1, 2]);
    // Acks of the old attempt do not open the window.
    port.deliver({ type: 'ack', attempt: 0, index: 0 });
    await tick();
    expect(port.posted.filter((m) => m.attempt === 1 && m.type === 'frame')).toHaveLength(3);
  });

  it('reports a render failure for its attempt', async () => {
    const port = new FakeRendererPort();
    new RenderSession(port, fakeRenderer({ failAt: 0 }), spec, () => undefined);
    port.deliver({ type: 'start', attempt: 0 });
    await tick();
    expect(port.posted).toEqual([{ type: 'error', attempt: 0, message: 'decoder failed at 0' }]);
  });

  it('stops on stop: aborts, closes the port and releases once', async () => {
    const port = new FakeRendererPort();
    const release = vi.fn();
    const renderer = fakeRenderer();
    new RenderSession(port, renderer, spec, release);
    port.deliver({ type: 'start', attempt: 0 });
    await tick();
    port.deliver({ type: 'stop' });
    port.deliver({ type: 'stop' });
    await tick();
    expect(renderer.calls[0]?.aborted).toBe(true);
    expect(port.closed).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(port.posted.some((m) => m.type === 'end' || m.type === 'error')).toBe(false);
  });
});

describe('both ends wired together', () => {
  it('delivers every frame of each attempt into stdin', async () => {
    const utility = new FakeUtilityPort();
    const window = new FakeRendererPort();
    // Cross-wire: what one posts, the other receives (asynchronously, like a real port).
    utility.postMessage = (message) => setTimeout(() => window.deliver(message), 0);
    window.postMessage = (message) => setTimeout(() => utility.deliver(message), 0);
    const spec: FrameSpec = { ...SPEC, frames: 20 };
    const feed = new FrameFeed(utility, spec);
    new RenderSession(window, fakeRenderer(), spec, () => undefined);
    const first = new FakeStdin();
    await feed.attempt(first);
    expect(first.chunks.map((c) => c[0])).toEqual([...Array(20).keys()]);
    const second = new FakeStdin();
    await feed.attempt(second);
    expect(second.chunks).toHaveLength(20);
  });
});
