/**
 * Crash-safe stream writer (§1.5, §9.6). The capture engine's muxer sends `{position, data}`
 * chunks over a MessagePort; each is written at its position with `pwrite` as soon as it
 * arrives (no buffering here), and the file is fsynced every second and on close.
 *
 * Two kinds of crash, two guarantees (R1.21):
 * - The app is killed (SIGKILL, a crash): every `pwrite` that returned is already in the kernel's
 *   page cache and survives the process, so the file holds every fragment the muxer finished
 *   and this process received. What is lost is upstream of here: the fragment being built
 *   (≤ 1 s, §1.5) and messages still queued on the port.
 * - The machine loses power: only fsynced bytes survive, so the fsync cadence (1 s, one
 *   fragment) bounds the loss. fsync blocks this process's event loop, which also stamps the
 *   arrival of system audio, so it runs on a timer rather than after every write.
 *
 * One file per stream: `<dir>/<kind>.rec.mp4`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  StreamPortMessageSchema,
  type StreamPortReply,
  type StreamStats,
} from '../../shared/ipc/media-utility';
import type { StreamKind } from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';

/** At most one fragment (≤ 1 s, §1.5) of written data is ever un-fsynced. */
export const DEFAULT_FSYNC_INTERVAL_MS = 1000;

export function recordingFileName(kind: StreamKind): string {
  return `${kind}.rec.mp4`;
}

/** The synchronous file calls the writer makes (injectable for tests). */
export interface WriterFs {
  openSync(file: string, flags: string): number;
  writeSync(fd: number, data: Uint8Array, offset: number, length: number, position: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

const nodeFs: WriterFs = {
  openSync: (file, flags) => fs.openSync(file, flags),
  writeSync: (fd, data, offset, length, position) =>
    fs.writeSync(fd, data, offset, length, position),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
};

export interface StreamWriterOptions {
  dir: string;
  kind: StreamKind;
  fsyncIntervalMs?: number;
  fs?: WriterFs;
  now?: () => number;
  logger?: Logger;
}

export class StreamWriter {
  readonly path: string;
  private fd: number | null;
  private readonly fs: WriterFs;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private dirty = false;
  private lastEnd = 0;
  private readonly counters: StreamStats = {
    bytesWritten: 0,
    writes: 0,
    outOfOrder: 0,
    size: 0,
    fsyncs: 0,
    lastFsyncAt: null,
  };

  constructor(options: StreamWriterOptions) {
    this.fs = options.fs ?? nodeFs;
    this.now = options.now ?? Date.now;
    this.path = path.join(options.dir, recordingFileName(options.kind));
    // 'w': a restart replaces the previous take's file (§4.3.1 restart).
    this.fd = this.fs.openSync(this.path, 'w');
    const interval = options.fsyncIntervalMs ?? DEFAULT_FSYNC_INTERVAL_MS;
    this.timer = setInterval(() => {
      try {
        this.sync();
      } catch (error) {
        (options.logger ?? silentLogger).error(`stream-writer: fsync ${this.path} failed`, error);
      }
    }, interval);
    this.timer.unref();
  }

  get closed(): boolean {
    return this.fd === null;
  }

  /** Writes `data` at byte `position`. Positions may go backwards (muxer header patches). */
  write(position: number, data: Uint8Array): void {
    if (this.fd === null) throw new Error(`stream-writer: ${this.path} is closed`);
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new Error(`stream-writer: invalid position ${String(position)}`);
    }
    let written = 0;
    while (written < data.byteLength) {
      written += this.fs.writeSync(
        this.fd,
        data,
        written,
        data.byteLength - written,
        position + written,
      );
    }
    if (position < this.lastEnd) this.counters.outOfOrder += 1;
    this.lastEnd = position + data.byteLength;
    this.counters.writes += 1;
    this.counters.bytesWritten += data.byteLength;
    this.counters.size = Math.max(this.counters.size, this.lastEnd);
    this.dirty = this.dirty || data.byteLength > 0;
  }

  /** fsyncs if anything was written since the last fsync. */
  sync(): void {
    if (this.fd === null || !this.dirty) return;
    this.fs.fsyncSync(this.fd);
    this.dirty = false;
    this.counters.fsyncs += 1;
    this.counters.lastFsyncAt = this.now();
  }

  stats(): StreamStats {
    return { ...this.counters };
  }

  /** fsyncs and closes. Safe to call twice. */
  close(): StreamStats {
    clearInterval(this.timer);
    if (this.fd !== null) {
      this.dirty = true;
      try {
        this.sync();
      } finally {
        this.fs.closeSync(this.fd);
        this.fd = null;
      }
    }
    return this.stats();
  }
}

/** The MessagePort surface used here; Electron's `MessagePortMain` satisfies it. */
export interface PortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

export interface AttachedStream {
  writer: StreamWriter;
  /** Closes the writer (fsync) and the port; used for aborts and engine crashes. */
  close(): StreamStats;
}

export interface AttachOptions {
  /** Called once, after the final fsync and close. */
  onClosed?: (stats: StreamStats) => void;
  onError?: (message: string) => void;
  /** Answers `clock.ping` (see `estimateClockOffset`). */
  nowUs?: () => number;
  logger?: Logger;
}

/** Utility clock in µs: the same formula the engine uses for its session clock (§1.5). */
export function utilityNowUs(): number {
  return (performance.timeOrigin + performance.now()) * 1000;
}

/**
 * Connects a writer to the engine's port. Chunks are written in arrival order (MessagePorts keep
 * order); malformed messages and write failures are reported on the port and to `onError`.
 */
export function attachStreamPort(
  port: PortLike,
  writer: StreamWriter,
  options: AttachOptions = {},
): AttachedStream {
  const logger = options.logger ?? silentLogger;
  const nowUs = options.nowUs ?? utilityNowUs;
  let finished = false;

  const reply = (message: StreamPortReply): void => {
    try {
      port.postMessage(message);
    } catch {
      // The engine end is gone; nothing to tell.
    }
  };

  const finish = (): StreamStats => {
    if (finished) return writer.stats();
    finished = true;
    let stats: StreamStats;
    try {
      stats = writer.close();
    } catch (error) {
      const message = `close failed: ${String(error)}`;
      options.onError?.(message);
      stats = writer.stats();
    }
    options.onClosed?.(stats);
    return stats;
  };

  const fail = (message: string): void => {
    logger.error(`stream-writer ${writer.path}: ${message}`);
    reply({ type: 'error', message });
    options.onError?.(message);
  };

  port.on('message', (event) => {
    const parsed = StreamPortMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      fail('malformed port message');
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'chunk': {
        if (finished) {
          fail('chunk after close');
          return;
        }
        const data =
          message.data instanceof Uint8Array ? message.data : new Uint8Array(message.data);
        try {
          writer.write(message.position, data);
        } catch (error) {
          fail(`write failed: ${String(error)}`);
        }
        break;
      }
      case 'close': {
        const stats = finish();
        reply({ type: 'closed', stats });
        port.close();
        break;
      }
      case 'clock.ping':
        reply({ type: 'clock.pong', id: message.id, sentUs: message.sentUs, utilityUs: nowUs() });
        break;
    }
  });
  // A vanished engine (crash) still gets its data flushed to disk.
  port.on('close', () => {
    finish();
  });
  port.start();

  return {
    writer,
    close: () => {
      const stats = finish();
      port.close();
      return stats;
    },
  };
}

/** Answers `clock.ping` on a dedicated port (no file attached). */
export function attachClockPort(port: PortLike, nowUs: () => number = utilityNowUs): void {
  port.on('message', (event) => {
    const parsed = StreamPortMessageSchema.safeParse(event.data);
    if (parsed.success && parsed.data.type === 'clock.ping') {
      port.postMessage({
        type: 'clock.pong',
        id: parsed.data.id,
        sentUs: parsed.data.sentUs,
        utilityUs: nowUs(),
      } satisfies StreamPortReply);
    }
  });
  port.start();
}
