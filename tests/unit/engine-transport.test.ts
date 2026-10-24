import { EncodedPacket } from 'mediabunny';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamPortReply, StreamStats } from '../../src/shared/ipc/media-utility';
import { measureClockOffset } from '../../src/renderer/engine/pipeline/clock-handshake';
import { FragmentedMp4Writer } from '../../src/renderer/engine/pipeline/fmp4';
import {
  PortWriteForwarder,
  type StreamPortLike,
} from '../../src/renderer/engine/pipeline/port-sink';

afterEach(() => {
  vi.useRealTimers();
});

/** A MessagePort stand-in; `answer` plays the media utility. */
function fakePort(answer?: (message: unknown, reply: (r: StreamPortReply) => void) => void) {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const sent: unknown[] = [];
  const state = { started: false, closed: false };
  const reply = (data: StreamPortReply) => {
    for (const l of [...listeners]) l({ data });
  };
  const port: StreamPortLike = {
    postMessage(message) {
      sent.push(message);
      answer?.(message, reply);
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    start() {
      state.started = true;
    },
    close() {
      state.closed = true;
    },
  };
  return { port, sent, state, reply, listeners };
}

const STATS: StreamStats = {
  bytesWritten: 7,
  writes: 2,
  outOfOrder: 0,
  size: 7,
  fsyncs: 1,
  lastFsyncAt: 1,
};

describe('PortWriteForwarder', () => {
  it('forwards positional writes as chunk messages and counts bytes', () => {
    const { port, sent, state } = fakePort();
    const f = new PortWriteForwarder(port);
    expect(state.started).toBe(true);
    f.write({ position: 0, data: new Uint8Array([1, 2, 3]) });
    f.write({ position: 3, data: new Uint8Array([4]) });
    expect(sent).toEqual([
      { type: 'chunk', position: 0, data: new Uint8Array([1, 2, 3]) },
      { type: 'chunk', position: 3, data: new Uint8Array([4]) },
    ]);
    expect(f.bytes).toBe(4);
    expect(f.writeCount).toBe(2);
  });

  it('closes with the writer counters from the utility, then refuses writes', async () => {
    const { port, sent, state, listeners } = fakePort((message, reply) => {
      if ((message as { type: string }).type === 'close') reply({ type: 'closed', stats: STATS });
    });
    const f = new PortWriteForwarder(port);
    await expect(f.close()).resolves.toEqual(STATS);
    expect(sent.at(-1)).toEqual({ type: 'close' });
    expect(state.closed).toBe(true);
    expect(listeners.size).toBe(0);
    expect(() => f.write({ position: 0, data: new Uint8Array(1) })).toThrow('closed');
    await expect(f.close()).resolves.toBeNull();
  });

  it('reports writer errors and resolves null when the utility fails or never answers', async () => {
    const errors: string[] = [];
    const failing = fakePort((message, reply) => {
      if ((message as { type: string }).type === 'close')
        reply({ type: 'error', message: 'disk full' });
    });
    const f = new PortWriteForwarder(failing.port, (m) => errors.push(m));
    failing.reply({ type: 'error', message: 'write failed: ENOSPC' });
    expect(f.error).toBe('write failed: ENOSPC');
    await expect(f.close()).resolves.toBeNull();

    vi.useFakeTimers();
    const silent = fakePort();
    const g = new PortWriteForwarder(silent.port, (m) => errors.push(m));
    const closing = g.close(1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(closing).resolves.toBeNull();
    expect(g.error).toContain('no closed reply');
    expect(errors).toEqual(['write failed: ENOSPC', 'disk full', 'no closed reply within 1000 ms']);
  });
});

describe('measureClockOffset', () => {
  it('estimates utility − engine from the fastest round trip', async () => {
    let now = 1_000_000;
    const utilityAhead = 2_500;
    const { port, sent } = fakePort((message, reply) => {
      const ping = message as { type: string; id: number; sentUs: number };
      if (ping.type !== 'clock.ping') return;
      // Round trips of 400 µs, except the 3rd ping (fast, 100 µs, symmetric).
      const half = ping.id === 3 ? 50 : 200;
      now += half;
      const utilityUs = now + utilityAhead;
      now += half;
      reply({ type: 'clock.pong', id: ping.id, sentUs: ping.sentUs, utilityUs });
    });
    const clock = await measureClockOffset(port, { nowUs: () => now });
    expect(sent).toHaveLength(8);
    expect(clock).toEqual({
      offsetUs: utilityAhead,
      externalClockOffsetUs: -utilityAhead,
      rttUs: 100,
      samples: 8,
    });
  });

  it('returns null when the utility never answers', async () => {
    vi.useFakeTimers();
    const { port, listeners } = fakePort();
    const pending = measureClockOffset(port, { nowUs: () => 0, pings: 3, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBeNull();
    expect(listeners.size).toBe(0);
  });
});

/** Top-level ISO BMFF boxes of a file. */
function boxes(file: Uint8Array): string[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const names: string[] = [];
  let pos = 0;
  while (pos + 8 <= file.byteLength) {
    const size = view.getUint32(pos);
    names.push(String.fromCharCode(...file.subarray(pos + 4, pos + 8)));
    if (size < 8) break;
    pos += size;
  }
  return names;
}

/** Collects the forwarded chunks into a file, checking that writes are positional and in order. */
function collectingPort() {
  const chunks: { position: number; data: Uint8Array }[] = [];
  const { port } = fakePort((message, reply) => {
    const m = message as { type: string; position: number; data: Uint8Array };
    if (m.type === 'chunk') chunks.push({ position: m.position, data: m.data });
    if (m.type === 'close') reply({ type: 'closed', stats: STATS });
  });
  const file = () => {
    const size = chunks.reduce((n, c) => Math.max(n, c.position + c.data.byteLength), 0);
    const out = new Uint8Array(size);
    for (const c of chunks) out.set(c.data, c.position);
    return out;
  };
  return { port, chunks, file };
}

describe('fragmented MP4 over the stream port (§9.6)', () => {
  it('flushes each ≤ 1 s audio fragment to the port while recording', async () => {
    const { port, chunks, file } = collectingPort();
    const forwarder = new PortWriteForwarder(port);
    const writer = new FragmentedMp4Writer((c) => forwarder.write(c), { media: 'audio' });
    await writer.start();
    const meta = { decoderConfig: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 } };
    const packet = (i: number) =>
      new EncodedPacket(new Uint8Array([0xfc, i & 0xff, 1, 2]), 'key', i * 0.02, 0.02);
    for (let i = 0; i < 125; i += 1) writer.addPacket(packet(i), i === 0 ? meta : undefined); // 2.5 s
    await vi.waitFor(() => expect(boxes(file()).filter((b) => b === 'moof').length).toBe(2));
    const writesBeforeFinalize = chunks.length;
    for (let i = 125; i < 150; i += 1) writer.addPacket(packet(i));
    await writer.finalize();
    await expect(forwarder.close()).resolves.toEqual(STATS);

    expect(writesBeforeFinalize).toBeGreaterThanOrEqual(3); // header + 2 fragments, no buffering
    // Strictly append-only, no gaps.
    let end = 0;
    for (const c of chunks) {
      expect(c.position).toBe(end);
      end += c.data.byteLength;
    }
    const names = boxes(file());
    expect(names[0]).toBe('ftyp');
    expect(names).toContain('moov');
    expect(names.filter((b) => b === 'moof').length).toBe(4); // 3 s in fragments of 0.98 s
    expect(forwarder.bytes).toBe(end);
  });

  it('cuts video fragments on keyframes and reports muxer errors', async () => {
    const { port, file } = collectingPort();
    const forwarder = new PortWriteForwarder(port);
    const writer = new FragmentedMp4Writer((c) => forwarder.write(c), {
      media: 'video',
      family: 'vp8',
    });
    await writer.start();
    const meta = { decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 } };
    for (let i = 0; i < 90; i += 1) {
      const key = i % 30 === 0; // 1 s keyframe cadence at 30 fps
      writer.addPacket(
        new EncodedPacket(new Uint8Array(16).fill(i), key ? 'key' : 'delta', i / 30, 1 / 30),
        i === 0 ? meta : undefined,
      );
    }
    await writer.finalize();
    expect(boxes(file()).filter((b) => b === 'moof').length).toBe(3);
    expect(writer.packetCount).toBe(90);

    const broken = new FragmentedMp4Writer(() => undefined, { media: 'video', family: 'vp8' });
    await broken.start();
    // A delta packet first, without a decoder config: mediabunny refuses it.
    broken.addPacket(new EncodedPacket(new Uint8Array(4), 'delta', 0, 1 / 30));
    await expect(broken.finalize()).rejects.toThrow();
    expect(broken.error).not.toBeNull();
    await broken.cancel();
  });

  it('cancels an output that received no packets', async () => {
    const writer = new FragmentedMp4Writer(() => undefined, { media: 'audio' });
    await writer.start();
    await expect(writer.finalize()).resolves.toBeUndefined();
    await expect(writer.cancel()).resolves.toBeUndefined();
  });
});
