/**
 * The media utility's end of the frame port (`shared/ipc/render-port.ts`): it writes the render
 * window's yuv420p frames into FFmpeg's stdin, in order, and acknowledges each one once written,
 * which keeps the renderer at most `FRAME_WINDOW` frames ahead.
 *
 * `attempt(stdin)` starts one FFmpeg run: it tells the renderer to start from frame 0, and settles
 * when every frame is written and stdin is ended, or with the reason it cannot be (the renderer
 * failed, its window closed, or a frame was out of order or of the wrong size). Messages of an
 * earlier attempt are ignored.
 */
import type { Writable } from 'node:stream';
import { yuvFrameBytes, type FrameSpec } from '../../../shared/export/frame-render';
import {
  RendererToUtilitySchema,
  type RendererToUtility,
  type UtilityToRenderer,
} from '../../../shared/ipc/render-port';
import type { Logger } from '../../../shared/logger';
import { silentLogger } from '../../../shared/logger';
import type { PortLike } from '../stream-writer';

/**
 * Why an attempt ended early. `renderer`: the render window failed, closed or broke the protocol
 * (the export fails with this message); `ffmpeg`: writing to FFmpeg failed (FFmpeg's own error
 * says why); `stopped`: the export or attempt ended first.
 */
export class FrameFeedError extends Error {
  constructor(
    message: string,
    readonly source: 'renderer' | 'ffmpeg' | 'stopped' = 'renderer',
  ) {
    super(message);
    this.name = 'FrameFeedError';
  }
}

interface Attempt {
  id: number;
  stdin: Writable;
  next: number;
  /** Writes not yet flushed. */
  pending: number;
  ended: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** What a rejected message looked like, for the error (no contents). */
function describe(data: unknown): string {
  if (data === null || typeof data !== 'object') return typeof data;
  return Object.entries(data)
    .map(([key, value]) => {
      const kind =
        value === null || typeof value !== 'object'
          ? typeof value
          : ((Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)
              ?.constructor?.name ?? 'object');
      return `${key}: ${kind}`;
    })
    .join(', ');
}

export class FrameFeed {
  private current: Attempt | null = null;
  private attempts = 0;
  private closed = false;
  private readonly frameBytes: number;
  private readonly logger: Logger;

  constructor(
    private readonly port: PortLike,
    private readonly spec: FrameSpec,
    logger?: Logger,
  ) {
    this.logger = logger ?? silentLogger;
    this.frameBytes = yuvFrameBytes(spec.width, spec.height);
    port.on('message', (event) => this.onMessage(event.data));
    port.on('close', () => {
      this.closed = true;
      this.fail(new FrameFeedError('The render window closed.'));
    });
    port.start();
  }

  /** Starts an attempt that feeds `stdin`; see the header. */
  attempt(stdin: Writable): Promise<void> {
    this.fail(new FrameFeedError('superseded', 'stopped'));
    if (this.closed) return Promise.reject(new FrameFeedError('The render window closed.'));
    const id = this.attempts++;
    return new Promise<void>((resolve, reject) => {
      this.current = { id, stdin, next: 0, pending: 0, ended: false, resolve, reject };
      stdin.on('error', (error) =>
        this.fail(new FrameFeedError(`FFmpeg input: ${error.message}`, 'ffmpeg')),
      );
      this.send({ type: 'start', attempt: id });
    });
  }

  /** Tells the renderer the export is over and closes the port. */
  stop(): void {
    this.fail(new FrameFeedError('stopped', 'stopped'));
    if (this.closed) return;
    this.send({ type: 'stop' });
    this.closed = true;
    this.port.close();
  }

  private send(message: UtilityToRenderer): void {
    try {
      this.port.postMessage(message);
    } catch {
      // The renderer is gone; its port's close event fails the attempt.
    }
  }

  private fail(error: Error): void {
    const attempt = this.current;
    if (!attempt) return;
    this.current = null;
    attempt.reject(error);
  }

  private onMessage(data: unknown): void {
    const parsed = RendererToUtilitySchema.safeParse(data);
    if (!parsed.success) {
      this.logger.error('export: malformed frame-port message', parsed.error.issues);
      const issue = parsed.error.issues[0];
      this.fail(
        new FrameFeedError(
          `The renderer sent a malformed message (${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown'}; ${describe(data)}).`,
        ),
      );
      return;
    }
    const message = parsed.data;
    const attempt = this.current;
    if (attempt?.id !== message.attempt) return;
    this.handle(attempt, message);
  }

  private handle(attempt: Attempt, message: RendererToUtility): void {
    switch (message.type) {
      case 'error':
        this.fail(new FrameFeedError(message.message));
        return;
      case 'frame': {
        if (attempt.ended || message.index !== attempt.next) {
          this.fail(
            new FrameFeedError(
              `Frame ${String(message.index)} arrived when ${String(attempt.next)} was expected.`,
            ),
          );
          return;
        }
        if (message.data.byteLength !== this.frameBytes) {
          this.fail(
            new FrameFeedError(
              `Frame ${String(message.index)} has ${String(message.data.byteLength)} bytes, not ${String(this.frameBytes)}.`,
            ),
          );
          return;
        }
        attempt.next += 1;
        attempt.pending += 1;
        const { index } = message;
        attempt.stdin.write(message.data, (error) => {
          attempt.pending -= 1;
          if (this.current !== attempt) return;
          if (error) {
            this.fail(new FrameFeedError(`FFmpeg input: ${error.message}`, 'ffmpeg'));
            return;
          }
          this.send({ type: 'ack', attempt: attempt.id, index });
          this.finishIfDone(attempt);
        });
        return;
      }
      case 'end':
        if (message.frames !== this.spec.frames || attempt.next !== this.spec.frames) {
          this.fail(
            new FrameFeedError(
              `The renderer ended after ${String(attempt.next)} of ${String(this.spec.frames)} frames.`,
            ),
          );
          return;
        }
        attempt.ended = true;
        this.finishIfDone(attempt);
        return;
    }
  }

  private finishIfDone(attempt: Attempt): void {
    if (!attempt.ended || attempt.pending > 0 || this.current !== attempt) return;
    this.current = null;
    attempt.stdin.end(() => attempt.resolve());
  }
}
