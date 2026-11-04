import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CheckpointLog,
  SyncCheckpointFileSchema,
  VIDEO_SYNC_RATE,
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

function readFixture(name: string) {
  return SyncCheckpointFileSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, `../fixtures/sync/${name}.sync.json`), 'utf8')),
  );
}

/**
 * Audio delivered the way PipeWire does it: one `quantum` of frames per graph tick of the
 * session clock, whenever the device (running `ratio` slower) has produced it, so the device's
 * deficit builds up in the buffer and shows as a skipped tick every `quantum / ppm` seconds.
 * Chunks of `chunk` frames reach the log on the tick that completes them, with a little jitter.
 */
function quantisedDelivery(opts: {
  seconds: number;
  ratio: number;
  quantum: number;
  chunk: number;
  seed?: number;
}): Checkpoint[] {
  const random = rng(opts.seed ?? 5);
  const log = new CheckpointLog(RATE);
  const tickUs = (opts.quantum * 1e6) / RATE;
  const phaseUs = random() * tickUs;
  let delivered = 0;
  let emitted = 0;
  for (let t = 0; t < opts.seconds * 1e6; t += tickUs) {
    // Frames the device has produced by session time t (its clock is `ratio` slower).
    const produced = Math.floor(((t + phaseUs) / opts.ratio) * (RATE / 1e6));
    if (produced - delivered < opts.quantum) continue; // nothing ready: the tick is skipped
    delivered += opts.quantum;
    while (emitted + opts.chunk <= delivered) {
      emitted += opts.chunk;
      log.offer(Math.round(BASE + t + random() * 300), emitted);
    }
  }
  log.flush();
  return [...log.checkpoints];
}

/**
 * One checkpoint per second whose latency drains at the drift rate (delivery on the session
 * clock) and steps up by `stepUs` when the buffer runs dry; `phase` is where in that cycle the
 * recording starts. This is the shape of the live system-audio checkpoints.
 */
function sawtooth(ppm: number, stepUs: number, phase: number, seconds = 300): Checkpoint[] {
  const ratio = 1 + ppm / 1e6;
  const cycleUs = stepUs / (ppm * 1e-6);
  const out: Checkpoint[] = [];
  for (let s = 0; s <= seconds; s++) {
    const mediaUs = s * 1_000_000;
    const latencyUs = stepUs * (1 - ((mediaUs + phase * cycleUs) % cycleUs) / cycleUs);
    out.push([Math.round(BASE + mediaUs * ratio + latencyUs), s * RATE]);
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

  it('ignores deviations under 20 ppm that move the track less than 10 ms', () => {
    // 10 ppm over 10 minutes: 6 ms.
    const fit = fitClockRatio(checkpoints({ seconds: 600, ratio: 1.00001, jitterUs: 0 }), RATE);
    expect(fit.decision).toBe('below-threshold');
    expect(fit.clockRatio).toBe(1);
    expect(fit.ppm).toBeCloseTo(10, 3);
  });

  it('applies a deviation under 20 ppm that adds up over a long recording (the soak mic)', () => {
    // The 60-minute soak's mic: 18 ppm, 65 ms over the hour, with jittery arrivals.
    const fit = fitClockRatio(
      checkpoints({ seconds: 3600, ratio: 1.000018, jitterUs: 12_000, seed: 7 }),
      RATE,
    );
    expect(fit.decision).toBe('applied');
    expect(Math.abs(fit.ppm - 18)).toBeLessThan(1);
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
    const mic = fitSyncFile(readFixture('live-wayland-mic'));
    const system = fitSyncFile(readFixture('live-wayland-system'));
    // Late arrivals near the end made the old least-squares fit apply 189 ppm here. The envelope
    // fit's estimate is not significant at 133 s, so nothing is applied; the true drift of this
    // mic (~160 ppm, see below) costs at most ~20 ms over this length.
    expect(fitSyncFile(readFixture('live-wayland-mic'), { envelope: false }).decision).toBe(
      'applied',
    );
    expect(mic.clockRatio).toBe(1);
    expect(system.clockRatio).toBe(1);
  });

  it('matches the drift measured by the flash-and-beep sync test (3 minutes)', () => {
    // 3-minute recording of tests/sync/pattern: without correction the mic's beeps drifted
    // −160.8 ppm against the screen's flashes (tests/sync/analyze.ts). The fit applies ~129 ppm;
    // the rest is the mic's buffer level wandering (see the 5-minute case). Plain least squares
    // found only 43 ppm.
    const file = readFixture('live-wayland-pattern-mic');
    const fit = fitSyncFile(file);
    expect(fit.decision).toBe('applied');
    expect(fit.ppm).toBeGreaterThan(100);
    expect(fit.ppm).toBeLessThan(180);
    expect(fitSyncFile(file, { envelope: false }).ppm).toBeLessThan(60);
  });

  it('matches the flash-and-beep sync test on system audio (5 minutes)', () => {
    // 5-minute recording of tests/sync/pattern. Truth (applied ratio + the analyzer's residual
    // trend against the screen): system audio 257.3 ppm. Its checkpoints are a sawtooth: 22–32 ms
    // steps every ~120 s of a 1024-frame quantum. The windowed envelope read 231.1 ppm.
    const fit = fitSyncFile(readFixture('live-wayland-pattern5m-system'));
    expect(fit.decision).toBe('applied');
    expect(Math.abs(fit.ppm - 257.3)).toBeLessThan(8);
    // The screen and the camera follow the session clock: nothing to apply.
    for (const name of ['live-wayland-pattern5m-screen', 'live-wayland-pattern5m-camera']) {
      const video = fitSyncFile(readFixture(name));
      expect(video.decision).toBe('below-threshold');
      expect(Math.abs(video.ppm)).toBeLessThan(5);
    }
  });

  it('applies the mic of the 5-minute sync test, within the limit of its arrival timing', () => {
    // Truth 128.2 ppm (analyzer). The mic's 256-frame ticks show 5.3 ms steps, but its buffer
    // drained 12 ms over the recording against only 5.5 quanta of steps, so its arrivals carry
    // ~106 ppm; no line through them reaches the device clock (every window size, quantile and
    // least squares reads 100–110 ppm). Pinned so a change in the fit shows up here.
    const fit = fitSyncFile(readFixture('live-wayland-pattern5m-mic'));
    expect(fit.decision).toBe('applied');
    expect(fit.ppm).toBeGreaterThan(100);
    expect(fit.ppm).toBeLessThan(135);
  });

  it('follows the steps of a sawtooth instead of its draining side', () => {
    // 257 ppm in 30 ms steps every ~117 s, as on the live system audio. The windowed envelope
    // was off by −8 to +19 ppm here depending on where the recording started in the cycle.
    for (const phase of [0.2, 0.4, 0.6, 0.8]) {
      const fit = fitClockRatio(sawtooth(257, 30_000, phase), RATE);
      expect(fit.decision).toBe('applied');
      expect(Math.abs(fit.ppm - 257)).toBeLessThan(3);
    }
  });

  it.each([
    { ppm: 257, quantum: 1024, chunk: 1024 },
    { ppm: 128, quantum: 256, chunk: 480 },
    { ppm: 160, quantum: 256, chunk: 480 },
    { ppm: 60, quantum: 256, chunk: 480 },
  ])(
    'recovers $ppm ppm from quantised delivery ($quantum-frame ticks, $chunk-frame chunks)',
    ({ ppm, quantum, chunk }) => {
      for (const seed of [1, 2, 3]) {
        const ratio = 1 + ppm / 1e6;
        const points = quantisedDelivery({ seconds: 300, ratio, quantum, chunk, seed });
        const fit = fitClockRatio(points, RATE);
        expect(fit.decision).toBe('applied');
        expect(Math.abs(fit.ppm - ppm)).toBeLessThan(3);
      }
    },
  );

  it('fits video tracks, whose checkpoint "samples" are file microseconds', () => {
    // Screen timestamps 116 ppm off the session clock (live sync test), frames arriving
    // 0–30 ms late, one checkpoint per second for 5 minutes.
    const random = rng(11);
    const points: Checkpoint[] = [];
    for (let s = 0; s <= 300; s++) {
      const fileUs = s * 1_000_000 + Math.round(random() * 33_000);
      points.push([Math.round(BASE + fileUs * 1.000116 + random() * 30_000), fileUs]);
    }
    const fit = fitClockRatio(points, VIDEO_SYNC_RATE);
    expect(fit.decision).toBe('applied');
    expect(Math.abs(fit.ppm - 116)).toBeLessThan(10);
  });

  it('gives the same slope and a shifted intercept when the session clock is shifted', () => {
    // A counterexample of the earlier fit, which centred the least-squares guess on raw µs
    // sums: most points exact, a few early, shifted by −1.4e11 µs (it read 0.013 ppm apart).
    const jitter = [
      ...Array<number>(13).fill(0),
      -785,
      ...Array<number>(13).fill(0),
      -1635,
      ...Array<number>(11).fill(0),
      -1570,
      0,
      -2474,
      0,
      0,
      0,
      0,
      -578,
      0,
    ];
    const points: Checkpoint[] = jitter.map((j, i) => [i * 1_000_000 + j, i * RATE]);
    const shift = -137_462_453_326;
    for (const offset of [shift, 2 ** 45, BASE]) {
      const a = fitClockRatio(points, RATE);
      const b = fitClockRatio(
        points.map(([t, n]) => [t + offset, n]),
        RATE,
      );
      expect(b.fittedRatio).toBe(a.fittedRatio);
      expect(b.interceptUs - a.interceptUs).toBeCloseTo(offset, 0);
    }
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
    const log = new CheckpointLog(RATE);
    for (let ms = 0; ms <= 120_000; ms += 20) {
      const samples = (ms * RATE) / 1000;
      log.offer(BASE + Math.round(ms * 1000 * 1.0001), samples);
    }
    log.flush();
    expect(log.checkpoints).toHaveLength(121);
    const file = SyncCheckpointFileSchema.parse(JSON.parse(JSON.stringify(log.toFile())));
    const fit = fitSyncFile(file);
    expect(fit.decision).toBe('applied');
    expect(fit.ppm).toBeCloseTo(100, 1);
    expect(SyncCheckpointFileSchema.safeParse({ ...file, version: 2 }).success).toBe(false);
  });

  it('keeps one checkpoint per second: the earliest arrival relative to its samples', () => {
    const log = new CheckpointLog(RATE);
    // Second 0: the chunk ending at 0.5 s arrived 2 ms late, the one ending at 0.75 s 1 ms late.
    expect(log.offer(502_000, 24_000)).toBeNull();
    expect(log.offer(751_000, 36_000)).toBeNull();
    expect(log.offer(990_000, 47_000)).toBeNull(); // 0.979 s of samples, 11 ms late
    // Intervals start at the first offer (0.502 s); the first offer after 1.502 s closes it.
    expect(log.offer(1_504_000, 72_000)).toEqual([751_000, 36_000]);
    expect(log.offer(2_100_000, 100_000)).toBeNull();
    expect(log.offer(2_600_000, 124_800)).toEqual([1_504_000, 72_000]);
    expect(log.flush()).toEqual([2_600_000, 124_800]);
    expect(log.flush()).toBeNull();
    expect(log.checkpoints).toEqual([
      [751_000, 36_000],
      [1_504_000, 72_000],
      [2_600_000, 124_800],
    ]);
  });

  it('keeps the interval grid across gaps in the input', () => {
    const log = new CheckpointLog(VIDEO_SYNC_RATE);
    log.offer(0, 0);
    expect(log.offer(3_400_000, 3_400_000)).toEqual([0, 0]);
    // 3.4 s fell in the interval starting at 3 s, so 4.0 s closes it.
    expect(log.offer(3_900_000, 3_900_000)).toBeNull();
    expect(log.offer(4_000_000, 4_000_000)).toEqual([3_400_000, 3_400_000]);
  });
});
