/**
 * Main's side of the capture-engine channels (§4.3.11): request/response commands over
 * `engine.*` + `engine.reply`, and the `engine.ports` MessagePort hand-off. The session manager
 * (step 10) owns one link per engine window.
 */
import {
  ENGINE_COMMANDS,
  EnginePortsSchema,
  type EngineCommandChannel,
  type EngineCommandEnvelope,
  type EngineCommandPayload,
  type EngineCommandResponse,
  type EnginePorts,
  type EngineReply,
} from '../../shared/ipc/contract';

/** The parts of `WebContents` used here (`postMessage` transfers MessagePortMain objects). */
export interface EngineContentsLike {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  postMessage(channel: string, message: unknown, transfer?: unknown[]): void;
  isDestroyed(): boolean;
}

export class EngineCommandError extends Error {
  constructor(
    readonly channel: EngineCommandChannel,
    message: string,
    readonly code?: string,
  ) {
    super(`${channel}: ${message}`);
    this.name = 'EngineCommandError';
  }
}

interface Pending {
  channel: EngineCommandChannel;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EngineLink {
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    readonly contents: EngineContentsLike,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  /** Sends a command and resolves with the engine's validated response. */
  command<C extends EngineCommandChannel>(
    channel: C,
    payload: EngineCommandPayload<C>,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<EngineCommandResponse<C>> {
    if (this.contents.isDestroyed()) {
      return Promise.reject(new EngineCommandError(channel, 'engine window is gone'));
    }
    const request = ENGINE_COMMANDS[channel].request.safeParse(payload);
    if (!request.success) {
      return Promise.reject(
        new EngineCommandError(channel, `invalid payload: ${request.error.message}`),
      );
    }
    const requestId = this.nextRequestId++;
    return new Promise<EngineCommandResponse<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new EngineCommandError(channel, `no reply within ${String(timeoutMs)} ms`, 'timeout'),
        );
      }, timeoutMs);
      this.pending.set(requestId, {
        channel,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      const envelope: EngineCommandEnvelope<C> = {
        requestId,
        payload: request.data as EngineCommandPayload<C>,
      };
      this.contents.send(channel, envelope);
    });
  }

  /** Feed `engine.reply` messages from the router here. */
  handleReply(reply: EngineReply): void {
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    this.pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    if (!reply.ok) {
      pending.reject(
        new EngineCommandError(pending.channel, reply.error.message, reply.error.code),
      );
      return;
    }
    const parsed = ENGINE_COMMANDS[pending.channel].response.safeParse(reply.value);
    if (parsed.success) pending.resolve(parsed.data);
    else
      pending.reject(
        new EngineCommandError(pending.channel, `off-contract reply: ${parsed.error.message}`),
      );
  }

  /** Transfers stream ports (in `payload.streams` order, then the clock port) to the engine. */
  sendPorts(payload: EnginePorts, ports: readonly unknown[]): void {
    const checked = EnginePortsSchema.parse(payload);
    const expected = checked.streams.length + (checked.clockPort ? 1 : 0);
    if (ports.length !== expected) {
      throw new Error(
        `engine.ports: expected ${String(expected)} ports, got ${String(ports.length)}`,
      );
    }
    this.contents.postMessage('engine.ports', checked, [...ports]);
  }

  /** Rejects everything outstanding (engine window closed or crashed). */
  dispose(reason = 'engine link closed'): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new EngineCommandError(pending.channel, reason));
      this.pending.delete(id);
    }
  }
}
