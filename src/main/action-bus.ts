/**
 * The app's action bus (R1.2–R1.4). The command line, the tray and windows dispatch actions here;
 * the recording session manager (step 10) subscribes to the recording actions. Dispatch is
 * synchronous, so a forwarded `--action` reaches its handler immediately.
 */
import type { Logger } from '../shared/logger';
import { silentLogger } from '../shared/logger';
import type { AppAction, AppActionType } from '../shared/ipc/actions';

export type ActionHandler = (action: AppAction) => void;

export class ActionBus {
  private readonly handlers = new Set<ActionHandler>();

  constructor(private readonly logger: Logger = silentLogger) {}

  /** Adds a handler for every action. Returns an unsubscribe function. */
  subscribe(handler: ActionHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Adds a handler for some action types only. */
  on(types: readonly AppActionType[], handler: ActionHandler): () => void {
    const wanted = new Set(types);
    return this.subscribe((action) => {
      if (wanted.has(action.type)) handler(action);
    });
  }

  /**
   * Delivers `action` to every handler. A throwing handler is logged and does not stop the
   * others. Returns the number of handlers that ran.
   */
  dispatch(action: AppAction): number {
    this.logger.info(`action: ${action.type} (from ${action.source})`);
    let delivered = 0;
    for (const handler of [...this.handlers]) {
      try {
        handler(action);
        delivered += 1;
      } catch (error) {
        this.logger.error(`action ${action.type}: handler failed`, error);
      }
    }
    return delivered;
  }
}
