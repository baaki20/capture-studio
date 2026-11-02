/**
 * The MCP server's connection to the running app: JSON lines over the automation socket
 * (`shared/automation/protocol.ts`). Connects on first use and again after the app restarts,
 * says `hello` once per connection, validates every result against the protocol, and retries
 * `busy` (the user is mid-drag) a few times before giving up.
 */
import net from 'node:net';
import {
  AUTOMATION_METHODS,
  AUTOMATION_PROTOCOL_VERSION,
  AutomationResponseSchema,
  type AutomationErrorCode,
  type AutomationMethod,
  type AutomationParams,
  type AutomationResult,
} from '../shared/automation/protocol';

export type AppErrorCode = AutomationErrorCode | 'app-unavailable' | 'protocol';

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** What the tools need from the app; tests pass a fake. */
export interface AppApi {
  call<M extends AutomationMethod>(
    method: M,
    params: AutomationParams<M>,
  ): Promise<AutomationResult<M>>;
}

export interface AppClientOptions {
  socketPath: string;
  clientName?: string;
  timeoutMs?: number;
  /** Delays before each retry of a `busy` refusal. */
  busyRetryMs?: readonly number[];
}

const UNAVAILABLE =
  'Capture Studio is not running, or automation is off. Open Capture Studio and turn on ' +
  'Settings → Assistants → Allow assistants to edit and export projects.';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AppClient implements AppApi {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: AppClientOptions) {}

  async call<M extends AutomationMethod>(
    method: M,
    params: AutomationParams<M>,
  ): Promise<AutomationResult<M>> {
    const delays = this.options.busyRetryMs ?? [300, 800, 1500];
    for (let attempt = 0; ; attempt++) {
      try {
        const socket = await this.connection();
        const raw = await this.send(socket, method, params);
        const parsed = AUTOMATION_METHODS[method].result.safeParse(raw);
        if (!parsed.success) {
          throw new AppError('protocol', `unexpected ${method} result from the app`);
        }
        return parsed.data as AutomationResult<M>;
      } catch (error) {
        const delay = delays[attempt];
        if (error instanceof AppError && error.code === 'busy' && delay !== undefined) {
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private connection(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<net.Socket> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(this.options.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', () => reject(new AppError('app-unavailable', UNAVAILABLE)));
    });
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let i = buffered.indexOf('\n');
      while (i >= 0) {
        this.receive(buffered.slice(0, i));
        buffered = buffered.slice(i + 1);
        i = buffered.indexOf('\n');
      }
    });
    const lost = () => {
      if (this.socket === socket) this.socket = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(
          new AppError(
            'app-unavailable',
            `the connection to Capture Studio closed. ${UNAVAILABLE}`,
          ),
        );
        this.pending.delete(id);
      }
    };
    socket.on('close', lost);
    socket.on('error', lost);

    const hello = AUTOMATION_METHODS.hello.result.safeParse(
      await this.send(socket, 'hello', {
        client: this.options.clientName ?? 'capture-studio-mcp',
        protocolVersion: AUTOMATION_PROTOCOL_VERSION,
      }),
    );
    if (!hello.success || hello.data.protocolVersion !== AUTOMATION_PROTOCOL_VERSION) {
      socket.destroy();
      throw new AppError(
        'protocol',
        'This version of Capture Studio speaks a different automation protocol; update the app or the MCP server.',
      );
    }
    this.socket = socket;
    return socket;
  }

  private send(socket: net.Socket, method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError('editor-unavailable', `Capture Studio did not answer ${method} in time`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const reply = AutomationResponseSchema.safeParse(message);
    if (!reply.success || reply.data.id === null) return;
    const pending = this.pending.get(reply.data.id);
    if (!pending) return;
    this.pending.delete(reply.data.id);
    clearTimeout(pending.timer);
    if (reply.data.ok) pending.resolve(reply.data.result);
    else {
      const { code, message: text, details } = reply.data.error;
      pending.reject(new AppError(code, text, details));
    }
  }
}
