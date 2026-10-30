/**
 * Test-only control channel (§4.6.5): lets the Wayland scenario harness (`tests/wayland/`) and
 * e2e tests ask the running app for its state, dispatch actions, patch settings, inject a free
 * disk space value (R1.17) and receive recording events, without clicking in its windows.
 *
 * It exists only in unpackaged builds and only when `CS_HARNESS_SOCKET` names a socket path;
 * `index.ts` decides that. The protocol is JSON lines over a Unix socket (mode 0600):
 *
 * - request  `{"id": 1, "cmd": "status", "args": …}`
 * - response `{"id": 1, "ok": true, "result": …}` or `{"id": 1, "ok": false, "error": "…"}`
 * - event    `{"event": "state", "payload": …}` (sent to every connected client)
 *
 * A malformed line is answered with an error and never closes the connection.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';

export const HARNESS_SOCKET_ENV = 'CS_HARNESS_SOCKET';

export type HarnessHandler = (args: unknown) => unknown;

export interface HarnessChannelOptions {
  socketPath: string;
  handlers: Readonly<Record<string, HarnessHandler>>;
  logger?: Logger;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HarnessChannel {
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();
  private readonly logger: Logger;

  constructor(private readonly options: HarnessChannelOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    const { socketPath } = this.options;
    await fs.rm(socketPath, { force: true });
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await fs.chmod(socketPath, 0o600);
    this.server = server;
    this.logger.info(`harness: control channel on ${socketPath}`);
  }

  /** Sends an event to every connected client. */
  broadcast(event: string, payload: unknown): void {
    const line = `${JSON.stringify({ event, payload })}\n`;
    for (const socket of this.clients) socket.write(line);
  }

  async close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(this.options.socketPath, { force: true }).catch(() => undefined);
  }

  private accept(socket: net.Socket): void {
    this.clients.add(socket);
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) void this.handleLine(socket, line);
        newline = buffered.indexOf('\n');
      }
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let id: unknown = null;
    const reply = (body: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...body })}\n`);
    };
    try {
      const request = JSON.parse(line) as { id?: unknown; cmd?: unknown; args?: unknown };
      id = request.id ?? null;
      const handler =
        typeof request.cmd === 'string' && Object.hasOwn(this.options.handlers, request.cmd)
          ? this.options.handlers[request.cmd]
          : undefined;
      if (!handler) {
        reply({ ok: false, error: `unknown command ${JSON.stringify(request.cmd)}` });
        return;
      }
      const result: unknown = await handler(request.args);
      reply({ ok: true, result: result ?? null });
    } catch (error) {
      this.logger.warn(`harness: command failed: ${errorText(error)}`);
      reply({ ok: false, error: errorText(error) });
    }
  }
}

/**
 * The disk monitor's free-space probe with a test override (R1.17 without a tmpfs): while an
 * override is set it is returned instead of the real value.
 */
export class FreeSpaceOverride {
  private value: number | null = null;

  constructor(private readonly real: (dir: string) => Promise<number>) {}

  set(bytes: number | null): void {
    if (bytes !== null && !(Number.isFinite(bytes) && bytes >= 0)) {
      throw new Error('free bytes must be a non-negative number or null');
    }
    this.value = bytes;
  }

  get current(): number | null {
    return this.value;
  }

  readonly probe = (dir: string): Promise<number> =>
    this.value === null ? this.real(dir) : Promise.resolve(this.value);
}
