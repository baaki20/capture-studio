/**
 * The automation socket (`shared/automation/protocol.ts`): JSON lines over a Unix socket that
 * the Capture Studio MCP server connects to. Main runs it only while Settings → Assistants →
 * Automation is on.
 *
 * Unlike the test harness channel it ships in packaged builds, so it is strict: only the methods
 * in `AUTOMATION_METHODS`, with params and results validated against their schemas; no events,
 * no code, no paths. The socket lives in a folder only the user can enter (0700) and is itself
 * 0600, so other users on the machine cannot connect. Lines longer than
 * `AUTOMATION_MAX_LINE_BYTES` close the connection.
 */
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  AUTOMATION_MAX_LINE_BYTES,
  AUTOMATION_METHODS,
  AutomationRequestSchema,
  isAutomationMethod,
  type AutomationError,
  type AutomationErrorCode,
  type AutomationMethod,
  type AutomationParams,
  type AutomationResult,
} from '../../shared/automation/protocol';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';

/** A refusal with a protocol error code (anything else becomes `internal`). */
export class AutomationFailure extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AutomationFailure';
  }
}

export type AutomationHandlers = {
  [M in AutomationMethod]: (params: AutomationParams<M>) => Promise<AutomationResult<M>>;
};

export interface AutomationServerOptions {
  socketPath: string;
  handlers: AutomationHandlers;
  logger?: Logger;
  maxLineBytes?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AutomationServer {
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();
  private readonly logger: Logger;

  constructor(private readonly options: AutomationServerOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  get listening(): boolean {
    return this.server !== null;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const { socketPath } = this.options;
    const dir = path.dirname(socketPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
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
    this.logger.info(`automation: listening on ${socketPath}`);
  }

  async stop(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.logger.info('automation: stopped');
    }
    await fs.rm(this.options.socketPath, { force: true }).catch(() => undefined);
  }

  private accept(socket: net.Socket): void {
    this.clients.add(socket);
    socket.setEncoding('utf8');
    const limit = this.options.maxLineBytes ?? AUTOMATION_MAX_LINE_BYTES;
    let buffered = '';
    const tooLong = () => {
      this.write(socket, null, {
        ok: false,
        error: { code: 'bad-request', message: 'request line too long' },
      });
      socket.end();
      buffered = '';
    };
    socket.on('data', (chunk: string) => {
      if (socket.writableEnded) return;
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > limit) {
          tooLong();
          return;
        }
        if (line) void this.handleLine(socket, line);
        newline = buffered.indexOf('\n');
      }
      if (Buffer.byteLength(buffered) > limit) tooLong();
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  private write(socket: net.Socket, id: number | null, body: Record<string, unknown>): void {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify({ id, ...body })}\n`);
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    const fail = (id: number | null, error: AutomationError) =>
      this.write(socket, id, { ok: false, error });

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      fail(null, { code: 'bad-request', message: 'not valid JSON' });
      return;
    }
    const request = AutomationRequestSchema.safeParse(raw);
    if (!request.success) {
      const id = (raw as { id?: unknown } | null)?.id;
      fail(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null, {
        code: 'bad-request',
        message: 'expected {"id", "method", "params"}',
      });
      return;
    }
    const { id, method } = request.data;
    if (!isAutomationMethod(method)) {
      fail(id, { code: 'unknown-method', message: `unknown method ${JSON.stringify(method)}` });
      return;
    }
    const spec = AUTOMATION_METHODS[method];
    const params = spec.params.safeParse(request.data.params ?? {});
    if (!params.success) {
      fail(id, { code: 'invalid-params', message: params.error.message });
      return;
    }

    try {
      const handler = this.options.handlers[method] as (params: unknown) => Promise<unknown>;
      const result = spec.result.safeParse(await handler(params.data));
      if (!result.success) {
        this.logger.error(`automation: off-contract ${method} result`, result.error.message);
        fail(id, { code: 'internal', message: `${method} produced an invalid result` });
        return;
      }
      if (method !== 'export.status' && method !== 'hello') {
        this.logger.info(`automation: ${method}`);
      }
      this.write(socket, id, { ok: true, result: result.data });
    } catch (error) {
      if (error instanceof AutomationFailure) {
        this.logger.info(`automation: ${method} refused (${error.code}): ${error.message}`);
        fail(id, {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
        return;
      }
      this.logger.warn(`automation: ${method} failed`, error);
      fail(id, { code: 'internal', message: errorText(error) });
    }
  }
}
