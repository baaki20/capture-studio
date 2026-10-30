/**
 * Quitting while a recording is in progress (finding F-7). Tray Quit, Ctrl+Q, closing the last
 * window without a tray and SIGTERM all reach Electron's `before-quit`; without this guard the
 * session would be left in `recording` and offered for recovery on the next launch.
 *
 * - **Preparing** (acquiring, region picker, countdown): nothing is recorded yet, so the session
 *   is cancelled and the app quits.
 * - **Recording or paused:** interactively the user chooses Stop & save, Discard or Cancel (keep
 *   recording); non-interactively (SIGTERM, SIGINT, the test harness) it stops and saves.
 *
 * Electron answers SIGTERM and SIGINT itself, by quitting (`before-quit` fires; Node's
 * `process.on('SIGTERM')` handlers are never called), so a quit cannot tell where it came from.
 * Hence a quit is non-interactive unless the app's own UI started it with `quitInteractively`
 * (tray Quit, the File → Quit menu item and Ctrl+Q, closing the last window without a tray).
 * - **Finalizing:** the app waits for the project to be written, then quits.
 *
 * Saving is bounded by `timeoutMs`: if finalize hangs the app quits anyway, and the session is
 * then recovered on the next launch (R1.21) rather than blocking a logout forever.
 */
import type { Logger } from '../shared/logger';
import { silentLogger } from '../shared/logger';
import { isCapturing, type RecordingState } from './recording/state-machine';

export type QuitChoice = 'save' | 'discard' | 'cancel';

export interface RecorderLike {
  readonly state: RecordingState;
  stop(): Promise<void>;
  abort(): Promise<void>;
  cancel(): Promise<void>;
  /** Resolves when a running finalize or failure handling is done. */
  settled(): Promise<void>;
}

export interface QuitGuardDeps {
  recorder: () => RecorderLike | null;
  /** Asks the user what to do with the recording (a dialog). */
  ask: () => Promise<QuitChoice>;
  /** Quits again once the session is handled (`app.quit`). */
  quit: () => void;
  logger?: Logger;
  /** Upper bound for saving before quitting anyway (default 30 s). */
  timeoutMs?: number;
}

export const QUIT_SAVE_TIMEOUT_MS = 30_000;

const PREPARING: readonly RecordingState[] = ['acquiring', 'picking-region', 'countdown'];

export class QuitGuard {
  private allowed = false;
  private handling: Promise<void> | null = null;
  /** Set by `quitInteractively` for the quit it starts; every other quit saves without asking. */
  private interactiveNext = false;
  private readonly logger: Logger;

  constructor(private readonly deps: QuitGuardDeps) {
    this.logger = deps.logger ?? silentLogger;
  }

  /** True once the guard let the quit go ahead. */
  get isAllowed(): boolean {
    return this.allowed;
  }

  /** True once a quit was requested and is being handled or allowed. */
  get isQuitting(): boolean {
    return this.allowed || this.handling !== null;
  }

  /** True when quitting now would interrupt a session. */
  needsHandling(): boolean {
    const state = this.deps.recorder()?.state ?? 'idle';
    return isCapturing(state) || PREPARING.includes(state) || state === 'finalizing';
  }

  /**
   * For `before-quit`. Returns true when the quit may proceed now; otherwise it called
   * `preventDefault`, handles the session and quits again afterwards (unless the user cancels).
   */
  beforeQuit(event: { preventDefault(): void }): boolean {
    if (this.allowed || !this.needsHandling()) return true;
    event.preventDefault();
    const interactive = this.interactiveNext;
    this.interactiveNext = false;
    this.handling ??= this.handle(interactive).finally(() => {
      this.handling = null;
    });
    return false;
  }

  /** A quit the user asked for in the app's UI: a recording in progress is asked about. */
  quitInteractively(): void {
    this.interactiveNext = true;
    this.deps.quit();
  }

  /** A quit that saves without asking (the test harness); then call `quit`. */
  quitWithoutAsking(): void {
    this.interactiveNext = false;
    this.deps.quit();
  }

  private async handle(interactive: boolean): Promise<void> {
    const recorder = this.deps.recorder();
    if (!recorder) {
      this.proceed();
      return;
    }
    const state = recorder.state;
    let task: Promise<void>;
    if (PREPARING.includes(state)) {
      this.logger.info(`quit: cancelling the recording being prepared (${state})`);
      task = recorder.cancel();
    } else if (isCapturing(state)) {
      const choice = interactive ? await this.deps.ask().catch(() => 'cancel' as const) : 'save';
      if (choice === 'cancel') {
        this.logger.info('quit: cancelled; the recording continues');
        return;
      }
      // The state may have moved on while the dialog was open.
      if (!isCapturing(recorder.state)) {
        task = recorder.settled();
      } else {
        this.logger.info(
          `quit: ${choice === 'save' ? 'stopping and saving' : 'discarding'} the recording`,
        );
        task = choice === 'save' ? recorder.stop() : recorder.abort();
      }
    } else {
      this.logger.info('quit: waiting for the recording to be saved');
      task = recorder.settled();
    }
    const timeoutMs = this.deps.timeoutMs ?? QUIT_SAVE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      task.then(
        () => 'done' as const,
        (error: unknown) => {
          this.logger.error('quit: handling the recording failed', error);
          return 'done' as const;
        },
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.logger.warn(
        `quit: saving took longer than ${String(timeoutMs)} ms; quitting (the recording can be recovered on the next launch)`,
      );
    }
    this.proceed();
  }

  private proceed(): void {
    this.allowed = true;
    this.deps.quit();
  }
}
