/**
 * Client of the app's test-only control channel (`src/main/diagnostics/harness-channel.ts`):
 * JSON-line requests with ids, responses matched by id, and events delivered to listeners.
 */
import net from 'node:net';

export interface ChannelEvent {
  event: string;
  payload: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class ChannelClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: ChannelEvent) => void>();
  private buffered = '';
  private closed = false;

  private constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('control channel closed'));
      this.pending.clear();
    });
    socket.on('error', () => undefined);
  }

  /** Connects, retrying until `timeoutMs` (the app creates the socket during startup). */
  static async connect(socketPath: string, timeoutMs = 30_000): Promise<ChannelClient> {
    const end = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < end) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(socketPath, () => {
            s.off('error', reject);
            resolve(s);
          });
          s.once('error', reject);
        });
        return new ChannelClient(socket);
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`could not connect to ${socketPath}: ${String(last)}`);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  call<T = unknown>(cmd: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('control channel closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd}: no answer within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  onEvent(listener: (event: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the first event matching `predicate`, or rejects after `timeoutMs`. */
  waitFor<T = unknown>(
    event: string,
    predicate: (payload: T) => boolean = () => true,
    timeoutMs = 60_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`no ${event} event within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      const off = this.onEvent((e) => {
        if (e.event !== event || !predicate(e.payload as T)) return;
        clearTimeout(timer);
        off();
        resolve(e.payload as T);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffered += chunk;
    let newline = this.buffered.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      newline = this.buffered.indexOf('\n');
      let message: { id?: number; ok?: boolean; result?: unknown; error?: string } & {
        event?: string;
        payload?: unknown;
      };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (typeof message.event === 'string') {
        for (const l of [...this.listeners]) l({ event: message.event, payload: message.payload });
        continue;
      }
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending || typeof message.id !== 'number') continue;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? 'command failed'));
    }
  }
}
