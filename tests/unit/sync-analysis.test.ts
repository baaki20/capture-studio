/**
 * The pure parts of the sync analyzer (`tests/sync/analysis.ts`): onsets, event matching,
 * summaries with residual drift, per-window offsets over long runs and the visual clap instant.
 */
import { describe, expect, it } from 'vitest';
import {
  matchOffsets,
  offsetNear,
  onsets,
  summarize,
  visualClapNear,
  windowedOffsets,
} from '../sync/analysis';

describe('onsets', () => {
  it('finds rising edges at least the minimum gap apart, ignoring a start mid-event', () => {
    const times = [0, 1, 2, 3, 4, 5, 6, 7];
    const values = [9, 0, 9, 9, 0, 9, 0, 9];
    expect(onsets(times, values, 5, 1.5)).toEqual([2, 5, 7]);
    expect(onsets(times, values, 5, 2.5)).toEqual([2, 5]);
  });
});

describe('offsets', () => {
  // A 30-minute run: one flash every 2 s; the other stream drifts from +10 ms to +40 ms.
  const flashes = Array.from({ length: 900 }, (_, i) => 2 + i * 2);
  const drift = (t: number) => 0.01 + (0.03 * t) / 1800;
  const events = flashes.map((t) => t + drift(t));

  it('pairs nearest events and summarizes the drift', () => {
    const pairs = matchOffsets(flashes, [...events, 5000]);
    expect(pairs).toHaveLength(900);
    const s = summarize(pairs);
    expect(s?.firstMs).toBeCloseTo(15, 0);
    expect(s?.lastMs).toBeCloseTo(35, 0);
    expect(s?.trendPpm).toBeCloseTo((0.03 / 1800) * 1e6, 3);
    expect(summarize(pairs.slice(0, 2))).toBeNull();
  });

  it('reports the offset per window and near any instant', () => {
    const pairs = matchOffsets(flashes, events);
    const windows = windowedOffsets(pairs, 60);
    expect(windows).toHaveLength(31);
    expect(windows[0]).toMatchObject({ startS: 0, endS: 60, pairs: 29 });
    expect(windows[29]?.medianMs).toBeCloseTo(10 + (30 * 1770) / 1800, 0);
    expect(offsetNear(pairs, 1800, 30)?.medianMs).toBeCloseTo(40, 0);
    expect(offsetNear(pairs, 99_999)).toBeNull();
  });

  it('leaves out events too far away', () => {
    expect(matchOffsets([10, 20], [10.5, 20.1])).toEqual([
      { t: 20, offsetMs: expect.closeTo(100, 6) as number },
    ]);
  });
});

describe('visualClapNear', () => {
  const frame = 1 / 30;
  const times = Array.from({ length: 60 }, (_, i) => i * frame);
  // Hands move until frame 30 (contact), still afterwards.
  const values = times.map((_, i) => (i > 15 && i <= 30 ? 8 : 0.1));

  it('returns the last frame before the motion stopped', () => {
    expect(visualClapNear({ times, values }, 1.0)).toBeCloseTo(30 * frame, 6);
  });

  it('returns null without a clear stop nearby', () => {
    expect(visualClapNear({ times, values }, 1.6)).toBeNull();
    expect(visualClapNear({ times, values: times.map(() => 1) }, 1.0)).toBeNull();
  });
});
