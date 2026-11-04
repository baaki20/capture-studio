/**
 * The render window's end of the frame port (`shared/ipc/render-port.ts`). Each `start` from the
 * utility (re)starts rendering from frame 0 under that attempt, aborting any earlier attempt.
 * Frames go out in order, at most `FRAME_WINDOW` unacknowledged. They are copied, not transferred:
 * a port whose other end is in a main-process `MessageChannelMain` delivers a message with a
 * transferred `ArrayBuffer` as `null`.
 * `stop`, or the port closing, aborts rendering and releases the window's resources once.
 */
import type { FrameSpec } from '../../shared/export/frame-render';
import {
  FRAME_WINDOW,
  UtilityToRendererSchema,
  type RendererToUtility,
} from '../../shared/ipc/render-port';
import type { FrameSink, RenderStats } from './frame-renderer';

/** The parts of a DOM `MessagePort` the session uses. */
export interface FramePort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface Renderer {
  render(spec: FrameSpec, sink: FrameSink, signal: AbortSignal): Promise<RenderStats>;
}

export class RenderSession {
  private controller: AbortController | null = null;
  private inFlight = 0;
  private wake: (() => void) | null = null;
  private attempt = -1;
  private stopped = false;

  constructor(
    private readonly port: FramePort,
    private readonly renderer: Renderer,
    private readonly spec: FrameSpec,
    /** Releases decoders, the compositor and the window. */
    private readonly release: () => void,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    port.onmessage = (event) => this.onMessage(event.data);
  }

  /** The attempt rendering now (tests). */
  get currentAttempt(): number {
    return this.attempt;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    this.wake?.();
    this.port.onmessage = null;
    this.port.close();
    this.release();
  }

  private onMessage(data: unknown): void {
    const parsed = UtilityToRendererSchema.safeParse(data);
    if (!parsed.success || this.stopped) return;
    const message = parsed.data;
    switch (message.type) {
      case 'start':
        void this.run(message.attempt);
        return;
      case 'ack':
        if (message.attempt !== this.attempt) return;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.wake?.();
        return;
      case 'stop':
        this.stop();
        return;
    }
  }

  private post(message: RendererToUtility): void {
    if (!this.stopped) this.port.postMessage(message);
  }

  private async run(attempt: number): Promise<void> {
    this.controller?.abort();
    this.wake?.();
    const controller = new AbortController();
    this.controller = controller;
    this.attempt = attempt;
    this.inFlight = 0;
    const sink: FrameSink = {
      write: async (index, frame) => {
        while (this.inFlight >= FRAME_WINDOW && !controller.signal.aborted) {
          await new Promise<void>((resolve) => (this.wake = resolve));
        }
        if (controller.signal.aborted) return;
        this.inFlight += 1;
        this.post({ type: 'frame', attempt, index, data: frame });
      },
    };
    const started = performance.now();
    try {
      const stats = await this.renderer.render(this.spec, sink, controller.signal);
      if (controller.signal.aborted) return;
      this.post({ type: 'end', attempt, frames: stats.frames });
      const seconds = (performance.now() - started) / 1000;
      this.log(
        `render: ${String(stats.frames)} frames in ${seconds.toFixed(1)} s, ${String(stats.inexact)} inexact`,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      this.post({
        type: 'error',
        attempt,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      });
    }
  }
}
