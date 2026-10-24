import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CheckpointLog,
  SyncCheckpointFileSchema,
  fitClockRatio,
  fitSyncFile,
  type Checkpoint,
} from '../../src/shared/recording/drift';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATE = 48_000;
/** Absolute session clock values (performance.timeOrigin + now, in µs). */
const BASE = 1_761_300_000_000_000;

/**
 * One checkpoint per second for `seconds`. The device clock runs so that 1 media µs lasts
 * `ratio` session µs; arrivals are late by a one-sided jitter in `[0, jitterUs)`.
 */
function checkpoints(opts: {
  seconds: number;
  ratio: number;
  jitterUs: number;
  seed?: number;
  trendUs?: number;
}): Checkpoint[] {
  const random = rng(opts.seed ?? 7);
  const out: Checkpoint[] = [];
  for (let s = 0; s <= opts.seconds; s++) {
    const samples = s * RATE;
    const mediaUs = (samples * 1_000_000) / RATE;
    const trend = ((opts.trendUs ?? 0) * s) / opts.seconds;
    out.push([Math.round(BASE + mediaUs * opts.ratio + trend + random() * opts.jitterUs), samples]);
  }
  return out;
}

describe('drift fit', () => {
  it.each([50, -50, 35, -120])(
    'recovers %d ppm within 2 ppm from 30 minutes of jittery checkpoints',
    (ppm) => {
      const ratio = 1 + ppm / 1e6;
      const fit = fitClockRatio(checkpoints({ seconds: 1800, ratio, jitterUs: 18_000 }), RATE);
      expect(fit.decision).toBe('applied');
      expect(Math.abs(fit.clockRatio - ratio) * 1e6).toBeLessThan(2);
      expect(fit.standardErrorPpm).toBeLessThan(1);
    },
  );

  it('recovers 50 ppm within 2 ppm after 10 minutes', () => {
    const fit = fitClockRatio(
      checkpoints({ seconds: 600, ratio: 1.00005, jitterUs: 18_000, seed: 3 }),
      RATE,
    );
    expect(fit.decision).toBe('applied');
    expect(Math.abs(fit.clockRatio - 1.00005) * 1e6).toBeLessThan(2);
  });

  it('does not overcorrect the S2 case: about −5 ms over 20 s of jittery arrivals', () => {
    // 20 s of checkpoints, 15–18 ms arrival jitter, and an apparent −5 ms trend (≈ −250 ppm).
    for (const seed of [1, 2, 3, 4, 5]) {
      const fit = fitClockRatio(
        checkpoints({ seconds: 20, ratio: 1, jitterUs: 18_000, trendUs: -5_000, seed }),
        RATE,
      );
      expect(fit.clockRatio).toBe(1);
      expect(fit.decision).toBe('not-significant');
    }
  });

  it('applies real drift that is clean enough to be significant, even on a short recording', () => {
    const fit = fitClockRatio(checkpoints({ seconds: 20, ratio: 0.99975, jitterUs: 200 }), RATE);
    expect(fit.decision).toBe('applied');
    expect(Math.abs(fit.ppm + 250)).toBeLessThan(5);
  });

  it('ignores deviations under 20 ppm', () => {
    const fit = fitClockRatio(checkpoints({ seconds: 1800, ratio: 1.00001, jitterUs: 0 }), RATE);
    expect(fit.decision).toBe('below-threshold');
    expect(fit.clockRatio).toBe(1);
    expect(fit.ppm).toBeCloseTo(10, 3);
  });

  it('applies 30 ppm on clean data exactly', () => {
    const fit = fitClockRatio(checkpoints({ seconds: 600, ratio: 1.00003, jitterUs: 0 }), RATE);
    expect(fit.decision).toBe('applied');
    expect(fit.clockRatio).toBeCloseTo(1.00003, 9);
    // The envelope keeps the points whose rounding fell earliest, so allow a little more than 1 µs.
    expect(fit.residualRmsUs).toBeLessThanOrEqual(2);
  });

  it('drops outliers before fitting', () => {
    const points = checkpoints({ seconds: 1800, ratio: 1.00005, jitterUs: 5_000 }).map(
      ([t, s], i): Checkpoint => (i % 97 === 0 && i > 0 ? [t + 400_000, s] : [t, s]),
    );
    const fit = fitClockRatio(points, RATE, { envelope: false });
    expect(fit.pointsDropped).toBeGreaterThan(10);
    expect(fit.decision).toBe('applied');
    expect(Math.abs(fit.clockRatio - 1.00005) * 1e6).toBeLessThan(2);
  });

  it('ignores a late stretch of arrivals (one-sided jitter is not drift)', () => {
    // No real drift, 5 ms of jitter, and chunks arriving up to 60 ms late in the last 30 s.
    const points = checkpoints({ seconds: 130, ratio: 1, jitterUs: 5_000 }).map(
      ([t, s], i): Checkpoint =>
        i > 100 && i % 3 !== 0 ? [t + 20_000 + (i % 5) * 10_000, s] : [t, s],
    );
    expect(fitClockRatio(points, RATE, { envelope: false }).decision).toBe('applied');
    const fit = fitClockRatio(points, RATE);
    expect(fit.decision).not.toBe('applied');
    expect(fit.clockRatio).toBe(1);
  });

  it('does not apply an insignificant fit to a short live recording (133 s)', () => {
    const read = (name: string) =>
      SyncCheckpointFileSchema.parse(
        JSON.parse(readFileSync(resolve(__dirname, `../fixtures/sync/${name}.sync.json`), 'utf8')),
      );
    const mic = fitSyncFile(read('live-wayland-mic'));
    const system = fitSyncFile(read('live-wayland-system'));
    // Late arrivals near the end made the old least-squares fit apply 189 ppm here. The envelope
    // fit's estimate is not significant at 133 s, so nothing is applied; the true drift of this
    // mic (~160 ppm, see below) costs at most ~20 ms over this length.
    expect(fitSyncFile(read('live-wayland-mic'), { envelope: false }).decision).toBe('applied');
    expect(mic.clockRatio).toBe(1);
    expect(system.clockRatio).toBe(1);
  });

  it('matches the drift measured by the flash-and-beep sync test', () => {
    // 3-minute recording of tests/sync/pattern: without correction the mic's beeps drifted
    // −160.8 ppm against the screen's flashes (tests/sync/analyze.ts). The envelope fit applies
    // ~128 ppm, leaving −33 ppm; plain least squares found only 43 ppm.
    const file = SyncCheckpointFileSchema.parse(
      JSON.parse(
        readFileSync(
          resolve(__dirname, '../fixtures/sync/live-wayland-pattern-mic.sync.json'),
          'utf8',
        ),
      ),
    );
    const fit = fitSyncFile(file);
    expect(fit.decision).toBe('applied');
    expect(fit.ppm).toBeGreaterThan(100);
    expect(fit.ppm).toBeLessThan(180);
    expect(fitSyncFile(file, { envelope: false }).ppm).toBeLessThan(60);
  });

  it('rejects implausible ratios as faults', () => {
    const fit = fitClockRatio(checkpoints({ seconds: 600, ratio: 1.005, jitterUs: 0 }), RATE);
    expect(fit.decision).toBe('implausible');
    expect(fit.clockRatio).toBe(1);
  });

  it('needs enough points and span', () => {
    expect(
      fitClockRatio(checkpoints({ seconds: 3, ratio: 1.0001, jitterUs: 0 }), RATE).decision,
    ).toBe('too-few-points');
    expect(
      fitClockRatio(checkpoints({ seconds: 8, ratio: 1.0001, jitterUs: 0 }), RATE).decision,
    ).toBe('too-short');
    expect(fitClockRatio([], RATE).clockRatio).toBe(1);
  });

  it('reads and fits a sync.json file', () => {
    const log = new CheckpointLog();
    for (let ms = 0; ms <= 120_000; ms += 20) {
      const samples = (ms * RATE) / 1000;
      log.offer(BASE + Math.round(ms * 1000 * 1.0001), samples);
    }
    expect(log.checkpoints).toHaveLength(121);
    const file = SyncCheckpointFileSchema.parse(JSON.parse(JSON.stringify(log.toFile(RATE))));
    const fit = fitSyncFile(file);
    expect(fit.decision).toBe('applied');
    expect(fit.ppm).toBeCloseTo(100, 1);
    expect(SyncCheckpointFileSchema.safeParse({ ...file, version: 2 }).success).toBe(false);
  });

  it('throttles checkpoints to one per second', () => {
    const log = new CheckpointLog();
    expect(log.offer(0, 0)).toEqual([0, 0]);
    expect(log.offer(500_000, 24_000)).toBeNull();
    expect(log.offer(1_000_000, 48_000)).toEqual([1_000_000, 48_000]);
  });
});
