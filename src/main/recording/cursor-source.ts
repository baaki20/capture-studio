/**
 * Where cursor samples come from while recording (R3.7–R3.9, plan D7):
 *
 * - **native**: the helper's cursor loop (positions at the rate, presses and releases), stamped
 *   on the helper's monotonic clock;
 * - **poll**: Electron's `screen.getCursorScreenPoint()` sampled on a timer in main, stamped on
 *   main's clock; no clicks. The fallback where the helper is missing or refuses to start.
 *
 * Positions are global desktop coordinates; `coordinateSpace` says whether they are device pixels
 * or DIPs (Electron's screen coordinates, macOS points), which the recorder's mapping needs.
 */
import type { NativeHelper } from '../native/cs-native';

export type CursorAction = 'move' | 'down' | 'up';
export type CursorSourceButton = 'left' | 'middle' | 'right';

export interface RawCursorSample {
  /** On the source's clock (`nowUs`). */
  tUs: number;
  x: number;
  y: number;
  action: CursorAction;
  button?: CursorSourceButton;
}

export interface CursorSource {
  readonly kind: 'native' | 'poll';
  readonly coordinateSpace: 'physical' | 'dip';
  /** The source's clock now, in µs. */
  nowUs(): number;
  /** Starts sampling; throws when the source cannot start. */
  start(onSamples: (samples: readonly RawCursorSample[]) => void): { clicks: boolean };
  /** Stops; resolves after the last samples were delivered. */
  stop(): Promise<void>;
}

const ACTIONS: readonly CursorAction[] = ['move', 'down', 'up'];
const BUTTONS: readonly (CursorSourceButton | undefined)[] = [undefined, 'left', 'middle', 'right'];

/** Decodes a helper batch (`[tUs, x, y, action, button]` per sample). */
export function decodeBatch(batch: readonly number[]): RawCursorSample[] {
  const out: RawCursorSample[] = [];
  for (let i = 0; i + 4 < batch.length; i += 5) {
    const action = ACTIONS[batch[i + 3] ?? 0] ?? 'move';
    const button = BUTTONS[batch[i + 4] ?? 0];
    out.push({
      tUs: batch[i] ?? 0,
      x: batch[i + 1] ?? 0,
      y: batch[i + 2] ?? 0,
      action,
      ...(action !== 'move' && button ? { button } : {}),
    });
  }
  return out;
}

/** How long `stop` waits for the helper's end-of-loop batch. */
const END_TIMEOUT_MS = 1_000;

export function nativeCursorSource(helper: NativeHelper, rateHz: number): CursorSource {
  let ended: (() => void) | null = null;
  return {
    kind: 'native',
    coordinateSpace: helper.coordinateSpace(),
    nowUs: () => helper.monotonicUs(),
    start(onSamples) {
      return helper.startCursor(rateHz, (batch) => {
        if (batch.length === 0) {
          ended?.();
          return;
        }
        onSamples(decodeBatch(batch));
      });
    },
    stop() {
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, END_TIMEOUT_MS);
        ended = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      // Joins the helper's thread; its last batches arrive on the event loop afterwards.
      helper.stopCursor();
      return done;
    },
  };
}

export interface PollingDeps {
  /** `screen.getCursorScreenPoint()`, in DIPs. */
  point(): { x: number; y: number };
  /** Main's clock in µs. */
  nowUs(): number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function pollingCursorSource(deps: PollingDeps, rateHz: number): CursorSource {
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear =
    deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  let timer: unknown = null;
  return {
    kind: 'poll',
    coordinateSpace: 'dip',
    nowUs: () => deps.nowUs(),
    start(onSamples) {
      let last: { x: number; y: number } | null = null;
      const sample = () => {
        const p = deps.point();
        if (last?.x === p.x && last.y === p.y) return;
        last = p;
        onSamples([{ tUs: deps.nowUs(), x: p.x, y: p.y, action: 'move' }]);
      };
      sample();
      timer = every(sample, Math.max(1, Math.round(1000 / rateHz)));
      return { clicks: false };
    },
    stop() {
      if (timer !== null) clear(timer);
      timer = null;
      return Promise.resolve();
    },
  };
}
