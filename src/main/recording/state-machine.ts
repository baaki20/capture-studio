/**
 * The recording state machine (§4.3.1). Pure: `transition(state, event)` returns the next state
 * and the side effects the session manager must perform, or null when the event is not allowed
 * in that state. The session manager runs the effects; this module only decides.
 *
 * idle → configuring → acquiring → (picking-region) → countdown → recording ⇄ paused →
 * finalizing → completed, with the failure branches → aborted and → failed.
 */
import type { RECORDING_STATES } from '../../shared/ipc/contract';

export type RecordingState = (typeof RECORDING_STATES)[number];

/** Why a recording went to finalizing (§4.3.1; `duration` arrives in P2). */
export type StopReason = 'stop' | 'screen-ended' | 'disk-low';

export type RecordingEvent =
  | { type: 'configure' }
  /** Close the setup panel without recording. */
  | { type: 'dismiss' }
  | { type: 'record' }
  | { type: 'portal-cancelled' }
  | { type: 'tracks-ready'; region: boolean }
  | { type: 'region-picked' }
  | { type: 'cancel' }
  | { type: 'countdown-elapsed' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop'; reason: StopReason }
  | { type: 'restart' }
  | { type: 'abort' }
  | { type: 'finalized' }
  | { type: 'error'; reason: string };

export type RecordingEventType = RecordingEvent['type'];

export type SideEffect =
  /** The engine acquires screen, then camera, mic and system (§4.3.2). */
  | 'acquire-tracks'
  /** Release acquired tracks; nothing is on disk. */
  | 'release-tracks'
  /** Send the frozen frame to the region picker. */
  | 'open-picker'
  | 'start-countdown'
  | 'stop-countdown'
  /** Folder, `project.json(state:recording)`, lock; streams opened; encoders started; t0 set. */
  | 'start-recording'
  /** Pause interval recorded; silence feeding. */
  | 'pause-encoders'
  | 'resume-encoders'
  /** Flush encoders, remux, drift fit, `project.json(complete)`. */
  | 'finalize'
  /** Media files deleted, folder kept. */
  | 'discard-media'
  /** Folder deleted. */
  | 'delete-project'
  /** Partial streams finalized if possible; project marked failed with the reason. */
  | 'mark-failed';

export interface Transition {
  to: RecordingState;
  effects: SideEffect[];
}

/** States in which a recording session holds tracks, files or encoders. */
export const ACTIVE_STATES: readonly RecordingState[] = [
  'acquiring',
  'picking-region',
  'countdown',
  'recording',
  'paused',
  'finalizing',
];

/** States from which a new session may be configured. */
const RESTING_STATES: readonly RecordingState[] = [
  'idle',
  'configuring',
  'completed',
  'aborted',
  'failed',
];

const CAPTURING: readonly RecordingState[] = ['recording', 'paused'];

export function isActive(state: RecordingState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function isCapturing(state: RecordingState): boolean {
  return CAPTURING.includes(state);
}

export function transition(state: RecordingState, event: RecordingEvent): Transition | null {
  switch (event.type) {
    case 'configure':
      return RESTING_STATES.includes(state) ? { to: 'configuring', effects: [] } : null;

    case 'dismiss':
      return RESTING_STATES.includes(state) ? { to: 'idle', effects: [] } : null;

    case 'record':
      return state === 'configuring' ? { to: 'acquiring', effects: ['acquire-tracks'] } : null;

    case 'portal-cancelled':
      return state === 'acquiring' ? { to: 'configuring', effects: ['release-tracks'] } : null;

    case 'tracks-ready':
      if (state !== 'acquiring') return null;
      return event.region
        ? { to: 'picking-region', effects: ['open-picker'] }
        : { to: 'countdown', effects: ['start-countdown'] };

    case 'region-picked':
      return state === 'picking-region' ? { to: 'countdown', effects: ['start-countdown'] } : null;

    case 'cancel':
      if (state === 'acquiring' || state === 'picking-region') {
        return { to: 'configuring', effects: ['release-tracks'] };
      }
      if (state === 'countdown') {
        return { to: 'configuring', effects: ['stop-countdown', 'release-tracks'] };
      }
      return null;

    case 'countdown-elapsed':
      return state === 'countdown' ? { to: 'recording', effects: ['start-recording'] } : null;

    case 'pause':
      return state === 'recording' ? { to: 'paused', effects: ['pause-encoders'] } : null;

    case 'resume':
      return state === 'paused' ? { to: 'recording', effects: ['resume-encoders'] } : null;

    case 'stop':
      return isCapturing(state) ? { to: 'finalizing', effects: ['finalize'] } : null;

    case 'restart':
      return isCapturing(state)
        ? { to: 'countdown', effects: ['discard-media', 'start-countdown'] }
        : null;

    case 'abort':
      if (state === 'acquiring' || state === 'picking-region') {
        return { to: 'aborted', effects: ['release-tracks'] };
      }
      if (state === 'countdown') {
        return { to: 'aborted', effects: ['stop-countdown', 'release-tracks', 'delete-project'] };
      }
      return isCapturing(state) ? { to: 'aborted', effects: ['delete-project'] } : null;

    case 'finalized':
      return state === 'finalizing' ? { to: 'completed', effects: [] } : null;

    case 'error':
      return isActive(state) ? { to: 'failed', effects: ['mark-failed'] } : null;
  }
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly state: RecordingState,
    readonly event: RecordingEventType,
  ) {
    super(`recording: "${event}" is not allowed in state "${state}"`);
    this.name = 'IllegalTransitionError';
  }
}
