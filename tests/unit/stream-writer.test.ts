import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachClockPort,
  attachStreamPort,
  DEFAULT_FSYNC_INTERVAL_MS,
  recordingFileName,
  StreamWriter,
  type PortLike,
  type WriterFs,
} from '../../src/utility/media/stream-writer';

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cs-writer-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await fsp.rm(dir, { recursive: true, force: true });
});

/** Real file calls, with fsyncs counted. */
function countingFs() {
  const counts = { fsync: 0, close: 0 };
  const wrapped: WriterFs = {
    openSync: (f, flags) => fs.openSync(f, flags),
    writeSync: (fd, data, offset, length, position) =>
      fs.writeSync(fd, data, offset, length, position),
    fsyncSync: (fd) => {
      counts.fsync += 1;
      fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      counts.close += 1;
      fs.closeSync(fd);
    },
  };
  return { fs: wrapped, counts };
}

/** A MessagePort stand-in: `deliver` plays the engine side. */
function fakePort() {
  const handlers: { message?: (e: { data: unknown }) => void; close?: () => void } = {};
  const replies: unknown[] = [];
  const port = {
    started: false,
    closed: false,
    on(event: 'message' | 'close', listener: never) {
      handlers[event] = listener;
      return port;
    },
    postMessage: (m: unknown) => replies.push(m),
    start() {
      port.started = true;
    },
    close() {
      port.closed = true;
    },
  };
  return {
    port: port as unknown as PortLike & { started: boolean; closed: boolean },
    replies,
    deliver: (data: unknown) => handlers.message?.({ data }),
    hangUp: () => handlers.close?.(),
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('StreamWriter (§1.5, §9.6)', () => {
  it('names files <kind>.rec.mp4', () => {
    expect(recordingFileName('screen')).toBe('screen.rec.mp4');
    expect(recordingFileName('system')).toBe('system.rec.mp4');
  });

  it('writes at positions, including out of order, and counts bytes', () => {
    const writer = new StreamWriter({ dir, kind: 'camera' });
    writer.write(0, bytes('HEAD'));
    writer.write(4, bytes('-body-1'));
    writer.write(11, bytes('-body-2'));
    writer.write(0, bytes('MOOV')); // header patch after the fact
    writer.write(30, bytes('tail')); // past the end: a hole
    const stats = writer.close();
    const content = fs.readFileSync(path.join(dir, 'camera.rec.mp4'));
    expect(content.subarray(0, 18).toString()).toBe('MOOV-body-1-body-2');
    expect(content.subarray(18, 30)).toEqual(Buffer.alloc(12));
    expect(content.subarray(30).toString()).toBe('tail');
    expect(stats).toMatchObject({ bytesWritten: 26, writes: 5, outOfOrder: 1, size: 34 });
    expect(writer.closed).toBe(true);
    expect(() => writer.write(0, bytes('x'))).toThrow('is closed');
    expect(() => new StreamWriter({ dir, kind: 'mic' }).write(-1, bytes('x'))).toThrow(
      'invalid position',
    );
  });

  it('fsyncs every second while data arrives, and on close', () => {
    vi.useFakeTimers();
    let now = 0;
    const { fs: wfs, counts } = countingFs();
    const writer = new StreamWriter({ dir, kind: 'screen', fs: wfs, now: () => now });
    expect(DEFAULT_FSYNC_INTERVAL_MS).toBeLessThanOrEqual(1000);

    writer.write(0, bytes('a'));
    vi.advanceTimersByTime(999);
    expect(counts.fsync).toBe(0);
    now = 1000;
    vi.advanceTimersByTime(1);
    expect(counts.fsync).toBe(1);
    expect(writer.stats().lastFsyncAt).toBe(1000);

    // Nothing new: no extra fsync.
    vi.advanceTimersByTime(4000);
    expect(counts.fsync).toBe(1);

    // Continuous writes (one fragment every 500 ms): one fsync per 1 s tick.
    for (let t = 0; t < 10; t += 1) {
      writer.write(1 + t, bytes('b'));
      vi.advanceTimersByTime(500);
    }
    expect(counts.fsync).toBe(6);

    writer.close();
    expect(counts.fsync).toBe(7);
    expect(counts.close).toBe(1);
    writer.close();
    expect(counts.close).toBe(1);
    // The interval is gone after close.
    vi.advanceTimersByTime(10_000);
    expect(counts.fsync).toBe(7);
  });

  it('honours a custom fsync interval', () => {
    vi.useFakeTimers();
    const { fs: wfs, counts } = countingFs();
    const writer = new StreamWriter({ dir, kind: 'mic', fs: wfs, fsyncIntervalMs: 500 });
    writer.write(0, bytes('a'));
    vi.advanceTimersByTime(500);
    expect(counts.fsync).toBe(1);
    writer.close();
  });
});

describe('attachStreamPort', () => {
  it('writes chunks from the port, then closes, fsyncs and replies on close', () => {
    const { fs: wfs, counts } = countingFs();
    const writer = new StreamWriter({ dir, kind: 'screen', fs: wfs });
    const { port, replies, deliver } = fakePort();
    const onClosed = vi.fn();
    attachStreamPort(port, writer, { onClosed });
    expect(port.started).toBe(true);

    deliver({ type: 'chunk', position: 4, data: bytes('5678') });
    deliver({ type: 'chunk', position: 0, data: bytes('1234').buffer });
    deliver({ type: 'close' });

    expect(fs.readFileSync(writer.path, 'utf8')).toBe('12345678');
    expect(counts.fsync).toBe(1);
    expect(onClosed).toHaveBeenCalledOnce();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: 'closed',
      stats: { bytesWritten: 8, writes: 2, outOfOrder: 1 },
    });
    expect(port.closed).toBe(true);
  });

  it('reports malformed messages and chunks after close without writing them', () => {
    const writer = new StreamWriter({ dir, kind: 'screen' });
    const { port, replies, deliver } = fakePort();
    const onError = vi.fn();
    attachStreamPort(port, writer, { onError });
    deliver({ type: 'chunk', position: 'zero', data: bytes('x') });
    deliver({ type: 'rm', path: '/' });
    deliver({ type: 'close' });
    deliver({ type: 'chunk', position: 0, data: bytes('late') });
    expect(onError.mock.calls.map((c) => String(c[0]))).toEqual([
      'malformed port message',
      'malformed port message',
      'chunk after close',
    ]);
    expect(replies.filter((r) => (r as { type: string }).type === 'error')).toHaveLength(3);
    expect(fs.readFileSync(writer.path, 'utf8')).toBe('');
  });

  it('flushes and closes the file when the engine end disappears', () => {
    const { fs: wfs, counts } = countingFs();
    const writer = new StreamWriter({ dir, kind: 'mic', fs: wfs });
    const { port, deliver, hangUp } = fakePort();
    const onClosed = vi.fn();
    attachStreamPort(port, writer, { onClosed });
    deliver({ type: 'chunk', position: 0, data: bytes('partial') });
    hangUp();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(counts.fsync).toBe(1);
    expect(writer.closed).toBe(true);
  });

  it('can be force-closed by main', () => {
    const writer = new StreamWriter({ dir, kind: 'camera' });
    const { port, deliver } = fakePort();
    const attached = attachStreamPort(port, writer);
    deliver({ type: 'chunk', position: 0, data: bytes('abc') });
    expect(attached.close().bytesWritten).toBe(3);
    expect(port.closed).toBe(true);
  });

  it('answers clock pings on stream and clock ports', () => {
    const writer = new StreamWriter({ dir, kind: 'screen' });
    const stream = fakePort();
    attachStreamPort(stream.port, writer, { nowUs: () => 1_000_500 });
    stream.deliver({ type: 'clock.ping', id: 7, sentUs: 1_000_000 });
    expect(stream.replies).toEqual([
      { type: 'clock.pong', id: 7, sentUs: 1_000_000, utilityUs: 1_000_500 },
    ]);
    writer.close();

    const clock = fakePort();
    attachClockPort(clock.port, () => 42);
    clock.deliver({ type: 'clock.ping', id: 1, sentUs: 40 });
    clock.deliver({ type: 'chunk', position: 0, data: bytes('ignored') });
    expect(clock.replies).toEqual([{ type: 'clock.pong', id: 1, sentUs: 40, utilityUs: 42 }]);
  });
});
