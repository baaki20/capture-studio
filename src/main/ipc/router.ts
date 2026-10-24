/**
 * The main-process IPC router (§1.3, §4.3.11, R1.52).
 *
 * - Only channels in the contract can be registered.
 * - Every call must come from the top frame of a registered window, loaded from the app itself,
 *   and that window's kind must be allowed on the channel. Anything else is rejected and logged.
 * - Payloads are validated with the contract's zod schemas before a handler runs; responses and
 *   outgoing events are validated too, so a bug in main cannot leak an off-contract shape.
 */
import type { z } from 'zod';
import {
  ENGINE_EVENTS,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  isInvokeChannel,
  type EngineEventChannel,
  type EngineEventPayload,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokePayload,
  type InvokeResponse,
  type WindowKind,
} from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';

/** The parts of an IPC event the router looks at (Electron's events satisfy this). */
export interface IpcSenderEvent {
  sender: { id: number };
  senderFrame: { url: string; parent: unknown } | null;
}

/** The parts of `ipcMain` the router uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcSenderEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: IpcSenderEvent, ...args: unknown[]) => void): unknown;
  removeAllListeners(channel?: string): unknown;
}

/** The parts of `WebContents` the router uses to send events. */
export interface WebContentsLike {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

export interface CallContext {
  kind: WindowKind;
  senderId: number;
}

export class IpcRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcRejection';
  }
}

export interface IpcRouterOptions {
  ipcMain: IpcMainLike;
  logger: Logger;
  /** True for URLs the app itself serves (see `security/web-security.ts` `isAppUrl`). */
  isAppUrl: (url: string) => boolean;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export class IpcRouter {
  private readonly windows = new Map<number, { kind: WindowKind; contents: WebContentsLike }>();
  private readonly invokeChannels = new Set<InvokeChannel>();
  private readonly engineChannels = new Set<EngineEventChannel>();

  constructor(private readonly options: IpcRouterOptions) {}

  /** Makes a window's webContents a trusted sender of `kind`. Returns an unregister function. */
  registerWindow(contents: WebContentsLike, kind: WindowKind): () => void {
    this.windows.set(contents.id, { kind, contents });
    return () => {
      if (this.windows.get(contents.id)?.contents === contents) this.windows.delete(contents.id);
    };
  }

  windowKind(webContentsId: number): WindowKind | null {
    return this.windows.get(webContentsId)?.kind ?? null;
  }

  /**
   * Identifies the sender, or returns why it is rejected: unknown webContents, a subframe, a
   * destroyed frame, a non-app URL, or a window kind not allowed on the channel.
   */
  authorize(
    event: IpcSenderEvent,
    channel: string,
    allowed: readonly WindowKind[],
  ): { ok: true; context: CallContext } | { ok: false; reason: string } {
    const entry = this.windows.get(event.sender.id);
    if (!entry) return { ok: false, reason: `unknown sender ${String(event.sender.id)}` };
    const frame = event.senderFrame;
    if (!frame) return { ok: false, reason: 'sender frame is gone' };
    if (frame.parent) return { ok: false, reason: 'sender is a subframe' };
    if (!this.options.isAppUrl(frame.url)) {
      return { ok: false, reason: `sender URL is not the app (${frame.url})` };
    }
    if (!allowed.includes(entry.kind)) {
      return { ok: false, reason: `${entry.kind} window may not use ${channel}` };
    }
    return { ok: true, context: { kind: entry.kind, senderId: event.sender.id } };
  }

  /** Registers the handler of an invoke channel from the contract. */
  handle<C extends InvokeChannel>(
    channel: C,
    handler: (
      payload: InvokePayload<C>,
      context: CallContext,
    ) => InvokeResponse<C> | Promise<InvokeResponse<C>>,
  ): void {
    if (!isInvokeChannel(channel))
      throw new Error(`IPC: "${String(channel)}" is not in the contract`);
    if (this.invokeChannels.has(channel)) throw new Error(`IPC: ${channel} already has a handler`);
    const spec = INVOKE_CHANNELS[channel];
    this.invokeChannels.add(channel);

    this.options.ipcMain.handle(channel, async (event, ...args) => {
      const auth = this.authorize(event, channel, spec.windows);
      if (!auth.ok) {
        this.options.logger.warn(`ipc: rejected ${channel}: ${auth.reason}`);
        throw new IpcRejection(`${channel}: not allowed`);
      }
      if (args.length > 1) {
        this.options.logger.warn(`ipc: rejected ${channel}: ${String(args.length)} arguments`);
        throw new IpcRejection(`${channel}: invalid payload`);
      }
      const parsed = spec.request.safeParse(args[0]);
      if (!parsed.success) {
        this.options.logger.warn(
          `ipc: rejected malformed ${channel} payload from ${auth.context.kind}: ${describeIssues(parsed.error)}`,
        );
        throw new IpcRejection(`${channel}: invalid payload`);
      }

      const result = await handler(parsed.data as InvokePayload<C>, auth.context);
      const checked = spec.response.safeParse(result);
      if (!checked.success) {
        this.options.logger.error(
          `ipc: ${channel} handler returned an off-contract response: ${describeIssues(checked.error)}`,
        );
        throw new Error(`${channel}: internal error`);
      }
      return checked.data;
    });
  }

  /** Registers a listener for an engine → main message (`ipcRenderer.send`). */
  onEngine<C extends EngineEventChannel>(
    channel: C,
    listener: (payload: EngineEventPayload<C>, context: CallContext) => void,
  ): void {
    if (!Object.hasOwn(ENGINE_EVENTS, channel)) {
      throw new Error(`IPC: "${channel}" is not an engine channel`);
    }
    if (this.engineChannels.has(channel)) throw new Error(`IPC: ${channel} already has a listener`);
    this.engineChannels.add(channel);
    const schema = ENGINE_EVENTS[channel];

    this.options.ipcMain.on(channel, (event, ...args) => {
      const auth = this.authorize(event, channel, ['engine']);
      if (!auth.ok) {
        this.options.logger.warn(`ipc: rejected ${channel}: ${auth.reason}`);
        return;
      }
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success || args.length > 1) {
        this.options.logger.warn(
          `ipc: rejected malformed ${channel} message: ${parsed.success ? 'extra arguments' : describeIssues(parsed.error)}`,
        );
        return;
      }
      try {
        listener(parsed.data as EngineEventPayload<C>, auth.context);
      } catch (error) {
        this.options.logger.error(`ipc: ${channel} listener failed`, error);
      }
    });
  }

  /** Sends an event to one window, if its kind may receive it. Returns whether it was sent. */
  send<C extends EventChannel>(
    target: WebContentsLike,
    channel: C,
    payload: EventPayload<C>,
  ): boolean {
    const spec = EVENT_CHANNELS[channel];
    const kind = this.windowKind(target.id);
    if (!kind || !(spec.windows as readonly WindowKind[]).includes(kind) || target.isDestroyed()) {
      return false;
    }
    const checked = spec.payload.safeParse(payload);
    if (!checked.success) {
      this.options.logger.error(
        `ipc: off-contract ${channel} event: ${describeIssues(checked.error)}`,
      );
      return false;
    }
    target.send(channel, checked.data);
    return true;
  }

  /** Sends an event to every registered window allowed to receive it. Returns how many got it. */
  broadcast<C extends EventChannel>(channel: C, payload: EventPayload<C>): number {
    let sent = 0;
    for (const { contents } of [...this.windows.values()]) {
      if (this.send(contents, channel, payload)) sent += 1;
    }
    return sent;
  }

  /** Removes every handler and listener this router registered. */
  dispose(): void {
    for (const channel of this.invokeChannels) this.options.ipcMain.removeHandler(channel);
    for (const channel of this.engineChannels) this.options.ipcMain.removeAllListeners(channel);
    this.invokeChannels.clear();
    this.engineChannels.clear();
    this.windows.clear();
  }
}
