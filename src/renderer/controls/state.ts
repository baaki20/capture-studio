/**
 * State of the recording controls window (R1.10–R1.12), as a pure reducer over the recorder's
 * events. The window renders from it; the timer runs locally between updates (`elapsedNow`).
 */
import type { EventPayload } from '../../shared/ipc/contract';
import { dropLevelFor, worstDropLevel, type DropLevel } from '../../shared/recording/drop-level';
import { liveElapsedUs } from '../common/recorder-format';

type RecState = EventPayload<'rec.state'>;
type RecStats = EventPayload<'rec.stats'>;
type RecLevels = EventPayload<'rec.levels'>;
type RecNotice = EventPayload<'rec.notice'>;

/** How many notices stay on screen. */
export const MAX_NOTICES = 3;

export type ControlsView = 'idle' | 'preparing' | 'countdown' | 'recording' | 'finalizing';

export interface ControlsState {
  rec: RecState;
  /** Elapsed time without pauses, true at `receivedAtMs`. */
  elapsedUs: number;
  receivedAtMs: number;
  /** Linear peaks 0–1; null when the source is off or not heard from yet. */
  levels: { mic: number | null; system: number | null };
  dropped: { screen: number; camera: number | null };
  notices: RecNotice[];
  /** A destructive action waiting for confirmation. */
  confirm: 'restart' | 'abort' | null;
}

export type ControlsAction =
  | { type: 'state'; payload: RecState; atMs: number }
  | { type: 'stats'; payload: RecStats; atMs: number }
  | { type: 'levels'; payload: RecLevels }
  | { type: 'notice'; payload: RecNotice }
  | { type: 'dismiss-notice'; id: string }
  | { type: 'ask'; confirm: 'restart' | 'abort' }
  | { type: 'cancel-confirm' };

const IDLE: RecState = {
  state: 'idle',
  sessionId: null,
  elapsedUs: 0,
  countdownRemainingSec: null,
  failureReason: null,
};

export function initialControlsState(): ControlsState {
  return {
    rec: IDLE,
    elapsedUs: 0,
    receivedAtMs: 0,
    levels: { mic: null, system: null },
    dropped: { screen: 0, camera: null },
    notices: [],
    confirm: null,
  };
}

const CAPTURING = new Set<RecState['state']>(['recording', 'paused']);

export function controlsReducer(state: ControlsState, action: ControlsAction): ControlsState {
  switch (action.type) {
    case 'state': {
      const next = action.payload;
      const newSession = next.sessionId !== null && next.sessionId !== state.rec.sessionId;
      const restarted = CAPTURING.has(state.rec.state) && next.state === 'countdown';
      const base =
        newSession || restarted
          ? {
              ...state,
              levels: { mic: null, system: null },
              dropped: { screen: 0, camera: null },
              ...(newSession ? { notices: [] } : {}),
            }
          : state;
      return {
        ...base,
        rec: next,
        elapsedUs: next.elapsedUs,
        receivedAtMs: action.atMs,
        // Confirmation only makes sense while capturing.
        confirm: CAPTURING.has(next.state) ? state.confirm : null,
      };
    }
    case 'stats': {
      const { payload } = action;
      return {
        ...state,
        elapsedUs: payload.elapsedUs,
        receivedAtMs: action.atMs,
        dropped: { ...payload.dropped },
        // Stats say which sources are off (null); live values come from `levels`.
        levels: {
          mic: payload.levels.mic === null ? null : (state.levels.mic ?? payload.levels.mic),
          system:
            payload.levels.system === null ? null : (state.levels.system ?? payload.levels.system),
        },
      };
    }
    case 'levels':
      return {
        ...state,
        levels: {
          mic: action.payload.mic ?? state.levels.mic,
          system: action.payload.system ?? state.levels.system,
        },
      };
    case 'notice':
      return { ...state, notices: [...state.notices, action.payload].slice(-MAX_NOTICES) };
    case 'dismiss-notice':
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
    case 'ask':
      return CAPTURING.has(state.rec.state) ? { ...state, confirm: action.confirm } : state;
    case 'cancel-confirm':
      return { ...state, confirm: null };
  }
}

/** Which layout the window shows. */
export function controlsView(state: ControlsState): ControlsView {
  switch (state.rec.state) {
    case 'acquiring':
    case 'picking-region':
      return 'preparing';
    case 'countdown':
      return 'countdown';
    case 'recording':
    case 'paused':
      return 'recording';
    case 'finalizing':
      return 'finalizing';
    default:
      return 'idle';
  }
}

/** The timer at `nowMs`: it runs while recording and stands still while paused (R1.12). */
export function elapsedNow(state: ControlsState, nowMs: number): number {
  return liveElapsedUs(state.elapsedUs, state.receivedAtMs, state.rec.state === 'recording', nowMs);
}

/** The dropped-frame indicator: the worse of screen and camera (amber > 1 %, red > 5 %). */
export function dropIndicator(state: ControlsState): { level: DropLevel; ratio: number } {
  const ratio = Math.max(state.dropped.screen, state.dropped.camera ?? 0);
  const level = worstDropLevel([
    dropLevelFor(state.dropped.screen),
    dropLevelFor(state.dropped.camera ?? 0),
  ]);
  return { level, ratio };
}
