import { describe, expect, it } from 'vitest';
import { RECORDING_STATES } from '../../src/shared/ipc/contract';
import {
  isActive,
  transition,
  type RecordingEvent,
  type RecordingState,
  type SideEffect,
} from '../../src/main/recording/state-machine';

type Row = [RecordingState, RecordingEvent, RecordingState, SideEffect[]];

/** The §4.3.1 table, one row per allowed transition. */
const TABLE: Row[] = [
  ['idle', { type: 'configure' }, 'configuring', []],
  ['completed', { type: 'configure' }, 'configuring', []],
  ['aborted', { type: 'configure' }, 'configuring', []],
  ['failed', { type: 'configure' }, 'configuring', []],
  ['configuring', { type: 'dismiss' }, 'idle', []],
  ['configuring', { type: 'record' }, 'acquiring', ['acquire-tracks']],
  ['acquiring', { type: 'portal-cancelled' }, 'configuring', ['release-tracks']],
  ['acquiring', { type: 'tracks-ready', region: true }, 'picking-region', ['open-picker']],
  ['acquiring', { type: 'tracks-ready', region: false }, 'countdown', ['start-countdown']],
  ['picking-region', { type: 'region-picked' }, 'countdown', ['start-countdown']],
  ['picking-region', { type: 'cancel' }, 'configuring', ['release-tracks']],
  ['countdown', { type: 'cancel' }, 'configuring', ['stop-countdown', 'release-tracks']],
  ['countdown', { type: 'countdown-elapsed' }, 'recording', ['start-recording']],
  ['recording', { type: 'pause' }, 'paused', ['pause-encoders']],
  ['paused', { type: 'resume' }, 'recording', ['resume-encoders']],
  ['recording', { type: 'stop', reason: 'stop' }, 'finalizing', ['finalize']],
  ['paused', { type: 'stop', reason: 'stop' }, 'finalizing', ['finalize']],
  ['recording', { type: 'stop', reason: 'screen-ended' }, 'finalizing', ['finalize']],
  ['paused', { type: 'stop', reason: 'disk-low' }, 'finalizing', ['finalize']],
  ['recording', { type: 'restart' }, 'countdown', ['discard-media', 'start-countdown']],
  ['paused', { type: 'restart' }, 'countdown', ['discard-media', 'start-countdown']],
  ['acquiring', { type: 'abort' }, 'aborted', ['release-tracks']],
  ['picking-region', { type: 'abort' }, 'aborted', ['release-tracks']],
  [
    'countdown',
    { type: 'abort' },
    'aborted',
    ['stop-countdown', 'release-tracks', 'delete-project'],
  ],
  ['recording', { type: 'abort' }, 'aborted', ['delete-project']],
  ['paused', { type: 'abort' }, 'aborted', ['delete-project']],
  ['finalizing', { type: 'finalized' }, 'completed', []],
  ['acquiring', { type: 'error', reason: 'x' }, 'failed', ['mark-failed']],
  ['recording', { type: 'error', reason: 'x' }, 'failed', ['mark-failed']],
  ['paused', { type: 'error', reason: 'x' }, 'failed', ['mark-failed']],
  ['finalizing', { type: 'error', reason: 'x' }, 'failed', ['mark-failed']],
];

const EVENTS: RecordingEvent[] = [
  { type: 'configure' },
  { type: 'dismiss' },
  { type: 'record' },
  { type: 'portal-cancelled' },
  { type: 'tracks-ready', region: false },
  { type: 'tracks-ready', region: true },
  { type: 'region-picked' },
  { type: 'cancel' },
  { type: 'countdown-elapsed' },
  { type: 'pause' },
  { type: 'resume' },
  { type: 'stop', reason: 'stop' },
  { type: 'restart' },
  { type: 'abort' },
  { type: 'finalized' },
  { type: 'error', reason: 'x' },
];

describe('recording state machine', () => {
  it.each(TABLE)('%s + %j → %s', (from, event, to, effects) => {
    expect(transition(from, event)).toEqual({ to, effects });
  });

  it('rejects every pair that is not allowed', () => {
    const allowed = (state: RecordingState, event: RecordingEvent) =>
      TABLE.some(([s, e]) => s === state && e.type === event.type) ||
      // States the table lists for one example only, but that are allowed in full:
      (event.type === 'configure' && ['idle', 'configuring'].includes(state)) ||
      (event.type === 'dismiss' && ['idle', 'completed', 'aborted', 'failed'].includes(state)) ||
      (event.type === 'cancel' && state === 'acquiring') ||
      (event.type === 'error' && ['countdown', 'picking-region'].includes(state));
    for (const state of RECORDING_STATES) {
      for (const event of EVENTS) {
        const result = transition(state, event);
        if (allowed(state, event)) expect(result, `${state} + ${event.type}`).not.toBeNull();
        else expect(result, `${state} + ${event.type}`).toBeNull();
      }
    }
  });

  it('never fails or aborts a finished session', () => {
    for (const state of ['idle', 'completed', 'aborted', 'failed'] as const) {
      expect(transition(state, { type: 'error', reason: 'x' })).toBeNull();
      expect(transition(state, { type: 'abort' })).toBeNull();
    }
    expect(transition('finalizing', { type: 'abort' })).toBeNull();
  });

  it('classifies active states', () => {
    expect(RECORDING_STATES.filter(isActive)).toEqual([
      'acquiring',
      'picking-region',
      'countdown',
      'recording',
      'paused',
      'finalizing',
    ]);
  });
});
