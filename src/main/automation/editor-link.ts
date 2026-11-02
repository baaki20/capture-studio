/**
 * Main's side of the editor automation commands (`shared/ipc/editor-automation.ts`):
 * request/response over `automation.request` events and `automation.reply` invokes, like
 * `EngineLink` does for the capture engine.
 *
 * `EditorLinks` keeps one `EditorLink` per editor window. An editor announces itself with
 * `automation.ready` once its project is loaded, whoever opened it; `ensure(projectId)` opens the
 * project's editor when needed and waits for that announcement, so assistant edits always land in
 * a window the user can see.
 */
import {
  EDITOR_AUTOMATION_COMMANDS,
  type EditorAutomationCommand,
  type EditorAutomationError,
  type EditorAutomationPayload,
  type EditorAutomationReply,
  type EditorAutomationRequest,
  type EditorAutomationResponse,
} from '../../shared/ipc/editor-automation';

/** The parts of `WebContents` used here. */
export interface EditorContentsLike {
  id: number;
  isDestroyed(): boolean;
}

export type EditorLinkErrorCode = EditorAutomationError['code'] | 'editor-unavailable';

export class EditorLinkError extends Error {
  constructor(
    readonly code: EditorLinkErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EditorLinkError';
  }
}

interface Pending {
  command: EditorAutomationCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EditorLink {
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    readonly contents: EditorContentsLike,
    private readonly send: (
      contents: EditorContentsLike,
      request: EditorAutomationRequest,
    ) => boolean,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  /** Sends a command and resolves with the editor's validated response. */
  command<C extends EditorAutomationCommand>(
    command: C,
    payload: EditorAutomationPayload<C>,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<EditorAutomationResponse<C>> {
    if (this.contents.isDestroyed()) {
      return Promise.reject(new EditorLinkError('editor-unavailable', 'the editor window closed'));
    }
    const requestId = this.nextRequestId++;
    return new Promise<EditorAutomationResponse<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new EditorLinkError(
            'editor-unavailable',
            `the editor did not answer ${command} within ${String(timeoutMs)} ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(requestId, {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      if (!this.send(this.contents, { requestId, command, payload })) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new EditorLinkError('editor-unavailable', 'the editor window cannot be reached'));
      }
    });
  }

  /** Feed `automation.reply` invokes from this window here. */
  handleReply(reply: EditorAutomationReply): void {
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    this.pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    if (!reply.ok) {
      pending.reject(
        new EditorLinkError(reply.error.code, reply.error.message, reply.error.details),
      );
      return;
    }
    const parsed = EDITOR_AUTOMATION_COMMANDS[pending.command].response.safeParse(reply.value);
    if (parsed.success) pending.resolve(parsed.data);
    else {
      pending.reject(
        new EditorLinkError(
          'internal',
          `off-contract ${pending.command} reply: ${parsed.error.message}`,
        ),
      );
    }
  }

  /** Rejects everything outstanding (window closed or reloaded). */
  dispose(reason = 'the editor window closed'): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new EditorLinkError('editor-unavailable', reason));
      this.pending.delete(id);
    }
  }
}

export interface EditorLinksDeps {
  /** Opens (or focuses) the project's editor window; returns its webContents. */
  open(projectId: string): EditorContentsLike;
  /** The project's open editor window's webContents, or null. */
  contentsOf(projectId: string): EditorContentsLike | null;
  send(contents: EditorContentsLike, request: EditorAutomationRequest): boolean;
  /** How long a newly opened editor may take to load its project. */
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
}

interface Entry {
  link: EditorLink;
  ready: boolean;
  waiters: { resolve: (link: EditorLink) => void; reject: (error: Error) => void }[];
}

export class EditorLinks {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: EditorLinksDeps) {}

  /** The link to the project's editor if it is open and loaded, else null. */
  live(projectId: string): EditorLink | null {
    const entry = this.current(projectId);
    return entry?.ready ? entry.link : null;
  }

  /** The project's editor link, opening the editor and waiting for it to load when needed. */
  ensure(projectId: string): Promise<EditorLink> {
    let entry = this.current(projectId);
    if (entry?.ready) return Promise.resolve(entry.link);
    if (!entry) {
      const contents = this.deps.contentsOf(projectId) ?? this.deps.open(projectId);
      entry = this.entryFor(projectId, contents);
    }
    const waiting = entry;
    return new Promise<EditorLink>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.waiters = waiting.waiters.filter((w) => w.resolve !== done);
        reject(
          new EditorLinkError(
            'editor-unavailable',
            'the editor did not finish opening the project',
          ),
        );
      }, this.deps.readyTimeoutMs ?? 30_000);
      const done = (link: EditorLink) => {
        clearTimeout(timer);
        resolve(link);
      };
      waiting.waiters.push({
        resolve: done,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /**
   * `automation.ready` from an editor: its project is loaded. Only the window that main opened
   * for that project may claim it. Returns whether the claim was accepted.
   */
  markReady(projectId: string, senderId: number): boolean {
    const contents = this.deps.contentsOf(projectId);
    if (contents?.id !== senderId) return false;
    let entry = this.current(projectId);
    if (entry?.link.contents.id !== senderId) entry = this.entryFor(projectId, contents);
    entry.ready = true;
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const waiter of waiters) waiter.resolve(entry.link);
    return true;
  }

  /** `automation.reply` from a window. */
  handleReply(senderId: number, reply: EditorAutomationReply): void {
    for (const entry of this.entries.values()) {
      if (entry.link.contents.id === senderId) entry.link.handleReply(reply);
    }
  }

  /** The project's editor window closed. */
  closed(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    this.entries.delete(projectId);
    this.drop(entry, 'the editor window closed');
  }

  dispose(): void {
    for (const projectId of [...this.entries.keys()]) this.closed(projectId);
  }

  private current(projectId: string): Entry | null {
    const entry = this.entries.get(projectId);
    if (!entry) return null;
    if (entry.link.contents.isDestroyed()) {
      this.closed(projectId);
      return null;
    }
    return entry;
  }

  /** A fresh entry for a window (replacing one for an older window of the same project). */
  private entryFor(projectId: string, contents: EditorContentsLike): Entry {
    const old = this.entries.get(projectId);
    const entry: Entry = {
      link: new EditorLink(
        contents,
        (target, request) => this.deps.send(target, request),
        this.deps.commandTimeoutMs,
      ),
      ready: false,
      waiters: old?.waiters ?? [],
    };
    if (old) {
      old.waiters = [];
      this.drop(old, 'the editor window was replaced');
    }
    this.entries.set(projectId, entry);
    return entry;
  }

  private drop(entry: Entry, reason: string): void {
    entry.link.dispose(reason);
    for (const waiter of entry.waiters)
      waiter.reject(new EditorLinkError('editor-unavailable', reason));
    entry.waiters = [];
  }
}
