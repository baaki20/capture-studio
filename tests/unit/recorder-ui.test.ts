import { describe, expect, it } from 'vitest';
import {
  formatDb,
  formatElapsed,
  formatFps,
  formatPercent,
  liveElapsedUs,
  meterFraction,
  peakToDb,
} from '../../src/renderer/common/recorder-format';
import {
  controlsReducer,
  controlsView,
  dropIndicator,
  elapsedNow,
  initialControlsState,
  MAX_NOTICES,
  type ControlsState,
} from '../../src/renderer/controls/state';
import { dropLevelFor, worstDropLevel } from '../../src/shared/recording/drop-level';
import type { EventPayload } from '../../src/shared/ipc/contract';

const S = 1_000_000;

function recState(
  state: EventPayload<'rec.state'>['state'],
  extra: Partial<EventPayload<'rec.state'>> = {},
): EventPayload<'rec.state'> {
  return {
    state,
    sessionId: 'ses_1',
    elapsedUs: 0,
    countdownRemainingSec: null,
    failureReason: null,
    ...extra,
  };
}

function stats(extra: Partial<EventPayload<'rec.stats'>> = {}): EventPayload<'rec.stats'> {
  return {
    elapsedUs: 0,
    levels: { mic: 0, system: 0 },
    dropped: { screen: 0, camera: 0 },
    bytesWritten: 0,
    ...extra,
  };
}

describe('recorder formatting', () => {
  it('formats the elapsed timer as MM:SS, then H:MM:SS', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(5.9 * S)).toBe('00:05');
    expect(formatElapsed(754 * S)).toBe('12:34');
    expect(formatElapsed(3723 * S)).toBe('1:02:03');
    expect(formatElapsed(-5)).toBe('00:00');
  });

  it('runs the timer only while recording', () => {
    expect(liveElapsedUs(10 * S, 1000, true, 3500)).toBe(12.5 * S);
    expect(liveElapsedUs(10 * S, 1000, false, 3500)).toBe(10 * S);
    expect(liveElapsedUs(10 * S, 1000, true, 900)).toBe(10 * S);
  });

  it('maps peaks to dBFS and to a −60…0 dB meter', () => {
    expect(peakToDb(1)).toBe(0);
    expect(peakToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(peakToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(meterFraction(1)).toBe(1);
    expect(meterFraction(0.001)).toBeCloseTo(0, 6); // −60 dB
    expect(meterFraction(0.0316)).toBeCloseTo(0.5, 2); // −30 dB
    expect(meterFraction(0)).toBe(0);
    expect(meterFraction(2)).toBe(1);
    expect(formatDb(0.5)).toBe('-6 dB');
    expect(formatDb(0)).toBe('-∞ dB');
  });

  it('formats delivered frame rates and drop percentages', () => {
    expect(formatFps(16.666)).toBe('16.7 fps');
    expect(formatFps(null)).toBe('measuring…');
    expect(formatPercent(0.0123)).toBe('1.2 %');
  });

  it('colours dropped frames amber above 1 % and red above 5 % (R1.12)', () => {
    expect(dropLevelFor(0.01)).toBe('ok');
    expect(dropLevelFor(0.011)).toBe('amber');
    expect(dropLevelFor(0.05)).toBe('amber');
    expect(dropLevelFor(0.051)).toBe('red');
    expect(worstDropLevel(['ok', 'amber'])).toBe('amber');
    expect(worstDropLevel(['amber', 'red', 'ok'])).toBe('red');
    expect(worstDropLevel([])).toBe('ok');
  });
});

describe('controls window state (R1.10–R1.12)', () => {
  const run = (...actions: Parameters<typeof controlsReducer>[1][]): ControlsState =>
    actions.reduce(controlsReducer, initialControlsState());

  it('picks the view from the recorder state', () => {
    expect(controlsView(run())).toBe('idle');
    expect(controlsView(run({ type: 'state', payload: recState('acquiring'), atMs: 0 }))).toBe(
      'preparing',
    );
    const countdown = run({
      type: 'state',
      payload: recState('countdown', { countdownRemainingSec: 3 }),
      atMs: 0,
    });
    expect(controlsView(countdown)).toBe('countdown');
    expect(countdown.rec.countdownRemainingSec).toBe(3);
    expect(controlsView(run({ type: 'state', payload: recState('paused'), atMs: 0 }))).toBe(
      'recording',
    );
    expect(controlsView(run({ type: 'state', payload: recState('finalizing'), atMs: 0 }))).toBe(
      'finalizing',
    );
  });

  it('keeps the timer running between updates and frozen while paused', () => {
    let state = run({
      type: 'state',
      payload: recState('recording', { elapsedUs: 0 }),
      atMs: 1000,
    });
    expect(elapsedNow(state, 3000)).toBe(2 * S);
    state = controlsReducer(state, {
      type: 'stats',
      payload: stats({ elapsedUs: 5 * S }),
      atMs: 6000,
    });
    expect(elapsedNow(state, 6500)).toBe(5.5 * S);
    state = controlsReducer(state, {
      type: 'state',
      payload: recState('paused', { elapsedUs: 7 * S }),
      atMs: 8000,
    });
    expect(elapsedNow(state, 60_000)).toBe(7 * S);
  });

  it('merges fast levels and learns from stats which sources are off', () => {
    let state = run({ type: 'state', payload: recState('recording'), atMs: 0 });
    state = controlsReducer(state, { type: 'levels', payload: { mic: 0.4 } });
    state = controlsReducer(state, { type: 'levels', payload: { system: 0.2 } });
    expect(state.levels).toEqual({ mic: 0.4, system: 0.2 });
    state = controlsReducer(state, {
      type: 'stats',
      payload: stats({ levels: { mic: 0.1, system: null } }),
      atMs: 0,
    });
    // The 15 Hz value wins over the 2 Hz one; a null source is off.
    expect(state.levels).toEqual({ mic: 0.4, system: null });
  });

  it('shows the worse of screen and camera drops', () => {
    const state = run(
      { type: 'state', payload: recState('recording'), atMs: 0 },
      { type: 'stats', payload: stats({ dropped: { screen: 0.002, camera: 0.08 } }), atMs: 0 },
    );
    expect(dropIndicator(state)).toEqual({ level: 'red', ratio: 0.08 });
    const noCamera = controlsReducer(state, {
      type: 'stats',
      payload: stats({ dropped: { screen: 0.02, camera: null } }),
      atMs: 0,
    });
    expect(dropIndicator(noCamera)).toEqual({ level: 'amber', ratio: 0.02 });
  });

  it('keeps the last few notices and clears them for a new session', () => {
    let state = run({ type: 'state', payload: recState('recording'), atMs: 0 });
    for (let i = 0; i < 5; i += 1) {
      state = controlsReducer(state, {
        type: 'notice',
        payload: { id: `n${String(i)}`, level: 'warning', message: `m${String(i)}`, stream: null },
      });
    }
    expect(state.notices.map((n) => n.id)).toEqual(['n2', 'n3', 'n4']);
    expect(state.notices).toHaveLength(MAX_NOTICES);
    state = controlsReducer(state, { type: 'dismiss-notice', id: 'n3' });
    expect(state.notices.map((n) => n.id)).toEqual(['n2', 'n4']);
    state = controlsReducer(state, {
      type: 'state',
      payload: recState('acquiring', { sessionId: 'ses_2' }),
      atMs: 0,
    });
    expect(state.notices).toEqual([]);
  });

  it('asks for confirmation only while capturing, and drops it when capturing ends', () => {
    expect(run({ type: 'ask', confirm: 'abort' }).confirm).toBeNull();
    let state = run(
      { type: 'state', payload: recState('recording'), atMs: 0 },
      { type: 'ask', confirm: 'restart' },
    );
    expect(state.confirm).toBe('restart');
    state = controlsReducer(state, { type: 'state', payload: recState('paused'), atMs: 0 });
    expect(state.confirm).toBe('restart');
    state = controlsReducer(state, { type: 'cancel-confirm' });
    expect(state.confirm).toBeNull();
    state = controlsReducer(state, { type: 'ask', confirm: 'abort' });
    state = controlsReducer(state, { type: 'state', payload: recState('finalizing'), atMs: 0 });
    expect(state.confirm).toBeNull();
  });

  it('resets the meters and drops when a restart goes back to the countdown', () => {
    let state = run(
      { type: 'state', payload: recState('recording'), atMs: 0 },
      { type: 'levels', payload: { mic: 0.5 } },
      { type: 'stats', payload: stats({ dropped: { screen: 0.1, camera: null } }), atMs: 0 },
    );
    state = controlsReducer(state, { type: 'state', payload: recState('countdown'), atMs: 0 });
    expect(state.levels).toEqual({ mic: null, system: null });
    expect(dropIndicator(state).level).toBe('ok');
  });
});
