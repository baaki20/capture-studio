import { describe, expect, it } from 'vitest';
import type { RecordingState } from '../../src/main/recording/state-machine';
import {
  controlsWindowAction,
  shouldMinimizeOnStart,
} from '../../src/main/windows/controls-policy';

function walk(states: RecordingState[], minimize: boolean): string[] {
  let previous: RecordingState | null = null;
  return states.map((state) => {
    const action = controlsWindowAction(previous, state, minimize);
    previous = state;
    return action;
  });
}

describe('controls window policy (R1.11, R1.12)', () => {
  it('minimizes on start by default where the window cannot be excluded from capture', () => {
    expect(shouldMinimizeOnStart('auto', false)).toBe(true);
    expect(shouldMinimizeOnStart('auto', true)).toBe(false);
    expect(shouldMinimizeOnStart('on', true)).toBe(true);
    expect(shouldMinimizeOnStart('off', false)).toBe(false);
  });

  it('shows the window while acquiring and counting down, minimizes at start, hides after finalize', () => {
    expect(
      walk(
        [
          'configuring',
          'acquiring',
          'countdown',
          'recording',
          'paused',
          'recording',
          'finalizing',
          'completed',
        ],
        true,
      ),
    ).toEqual(['hide', 'show', 'show', 'minimize', 'none', 'none', 'show', 'hide']);
  });

  it('stays out of the way of the region picker', () => {
    expect(walk(['acquiring', 'picking-region', 'countdown'], true)).toEqual([
      'show',
      'hide',
      'show',
    ]);
  });

  it('shows the countdown again on restart and keeps it visible when not minimizing', () => {
    expect(walk(['countdown', 'recording', 'countdown', 'recording'], false)).toEqual([
      'show',
      'show',
      'show',
      'show',
    ]);
    expect(walk(['recording', 'aborted'], true)).toEqual(['show', 'hide']);
  });
});
