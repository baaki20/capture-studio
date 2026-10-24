/**
 * Forwards the muxer's positional writes to the media utility (§1.3, §9.6). mediabunny's
 * `StreamTarget` hands over `{type: 'write', data, position}` chunks; each becomes one
 * `{type: 'chunk', position, data}` message on the stream's MessagePort. Nothing is buffered
 * here: with `chunked: false` the muxer flushes at
 * every finished fragment (≤ 1 s), and each flush reaches the port at once.
 *
 * `close()` sends `{type: 'close'}` and resolves with the writer's counters from the utility's
 * `closed` reply (or null on `error`, timeout, or a port that is already gone).
 */
import type {
  StreamPortMessage,
  StreamPortReply,
  StreamStats,
} from '../../../shared/ipc/media-utility';

/** The MessagePort surface used here (a DOM `MessagePort` satisfies it). */
export interface StreamPortLike {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

export interface MuxerChunk {
  data: Uint8Array;
  position: number;
}

export const CLOSE_TIMEOUT_MS = 10_000;

export class PortWriteForwarder {
  private sentBytes = 0;
  private writes = 0;
  private closed = false;
  private failure: string | null = null;

  constructor(
    private readonly port: StreamPortLike,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    port.addEventListener('message', this.onReply);
    port.start();
  }

  get bytes(): number {
    return this.sentBytes;
  }

  get writeCount(): number {
    return this.writes;
  }

  /** The utility's last reported error, if any. */
  get error(): string | null {
    return this.failure;
  }

  /**
   * Sends one positional write. The bytes are structured-cloned rather than transferred: the port
   * crosses into another process anyway, and a cloned `Uint8Array` is what the utility's writer
   * is known to accept (a few MB/s of copying is negligible).
   */
  write(chunk: MuxerChunk): void {
    if (this.closed) throw new Error('stream port is closed');
    const message: StreamPortMessage = {
      type: 'chunk',
      position: chunk.position,
      data: chunk.data,
    };
    this.port.postMessage(message, []);
    this.sentBytes += chunk.data.byteLength;
    this.writes += 1;
  }

  /** Asks the utility to fsync and close; resolves with its counters, or null. */
  close(timeoutMs = CLOSE_TIMEOUT_MS): Promise<StreamStats | null> {
    if (this.closed) return Promise.resolve(null);
    this.closed = true;
    return new Promise<StreamStats | null>((resolve) => {
      const finish = (stats: StreamStats | null): void => {
        clearTimeout(timer);
        this.port.removeEventListener('message', listener);
        this.port.removeEventListener('message', this.onReply);
        try {
          this.port.close();
        } catch {
          // Already closed by the other side.
        }
        resolve(stats);
      };
      const listener = (event: { data: unknown }): void => {
        const reply = event.data as StreamPortReply | null;
        if (reply?.type === 'closed') finish(reply.stats);
        else if (reply?.type === 'error') finish(null);
      };
      const timer = setTimeout(() => {
        this.recordError(`no closed reply within ${String(timeoutMs)} ms`);
        finish(null);
      }, timeoutMs);
      this.port.addEventListener('message', listener);
      try {
        this.port.postMessage({ type: 'close' } satisfies StreamPortMessage, []);
      } catch (error) {
        this.recordError(`close failed: ${String(error)}`);
        finish(null);
      }
    });
  }

  private readonly onReply = (event: { data: unknown }): void => {
    const reply = event.data as StreamPortReply | null;
    if (reply?.type === 'error') this.recordError(reply.message);
  };

  private recordError(message: string): void {
    this.failure ??= message;
    this.onError(message);
  }
}
