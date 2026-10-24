import { describe, expect, it } from 'vitest';
import { unwrap } from '../../src/shared/result';
import {
  CalibrationWindow,
  calibrate,
  offsetStats,
  percentile,
  toReferenceUs,
  type CalibrationSample,
  type CalibrationTrackInput,
} from '../../src/shared/recording/sync-calibrator';

/** Deterministic PRNG (mulberry32) so jitter is reproducible. */
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

/** Session time when capture starts (performance.timeOrigin + now, in µs). */
const BASE = 1_761_300_000_000_000;

/**
 * A track whose samples are captured at `rate` per second in a domain where
 * `timestamp = capture − domainOffsetUs`, and arrive `latencyUs + jitter` after capture.
 */
function track(
  id: string,
  kind: 'video' | 'audio',
  opts: {
    rate: number;
    domainOffsetUs: number;
    latencyUs: number;
    jitterUs: number;
    seconds?: number;
    seed?: number;
  },
): CalibrationTrackInput {
  const random = rng(opts.seed ?? 1);
  const samples: CalibrationSample[] = [];
  const n = Math.round(opts.rate * (opts.seconds ?? 3));
  for (let i = 0; i < n; i++) {
    const capture = BASE + Math.round((i * 1_000_000) / opts.rate);
    samples.push({
      timestampUs: capture - opts.domainOffsetUs,
      arrivalUs: capture + opts.latencyUs + Math.round(random() * opts.jitterUs),
    });
  }
  return { id, kind, samples };
}

/** The measured S2 set: screen 29.5 fps, camera 16.7 fps (+1.1 ms), mic chunks at 46.9/s. */
function s2Tracks(): CalibrationTrackInput[] {
  const domain = BASE - 5_000_000; // Chromium's capture clock started 5 s before
  return [
    {
      ...track('screen', 'video', {
        rate: 29.5,
        domainOffsetUs: domain,
        latencyUs: 8_000,
        jitterUs: 2_000,
      }),
      reference: true,
    },
    track('camera', 'video', {
      rate: 16.7,
      domainOffsetUs: domain,
      latencyUs: 9_100,
      jitterUs: 3_500,
      seed: 2,
    }),
    // Audio timestamps start near 0 in their own domain: +20.5 s away from video.
    track('mic', 'audio', {
      rate: 46.9,
      domainOffsetUs: domain + 20_500_000,
      latencyUs: 25_000,
      jitterUs: 17_000,
      seed: 3,
    }),
  ];
}

describe('sync calibrator', () => {
  it('uses hybrid mode for the measured S2 tracks: shared video, arrival-calibrated mic', () => {
    const result = unwrap(calibrate(s2Tracks()));
    const [screen, camera, mic] = result.tracks;
    expect(result.policy).toBe('hybrid');
    expect(screen?.mode).toBe('shared');
    expect(camera?.mode).toBe('shared');
    expect(mic?.mode).toBe('arrival-calibrated');
    expect(mic?.reason).toBe('policy hybrid');
    expect(result.clockMode).toBe('arrival-calibrated');
    expect(screen?.offsetUs).toBe(result.sharedOffsetUs);
    expect(camera?.offsetUs).toBe(result.sharedOffsetUs);
    // Audio spread (17 ms of jitter) is inside the 30 ms bound.
    expect(mic?.stats.stable).toBe(true);
    expect(mic?.stats.spreadUs).toBeLessThan(30_000);
  });

  it('maps shared video timestamps to capture time plus the lowest observed latency', () => {
    const result = unwrap(calibrate(s2Tracks()));
    const screen = result.tracks[0]!;
    const camera = result.tracks[1]!;
    // A frame captured at BASE + 1 s on either camera or screen maps to the same session instant.
    const ts = BASE + 1_000_000 - (BASE - 5_000_000);
    const t0 = BASE;
    const screenRef = toReferenceUs(screen, ts, t0);
    expect(toReferenceUs(camera, ts, t0)).toBe(screenRef);
    // ...which is the capture time plus about the minimum latency (8 ms).
    expect(screenRef - 1_000_000).toBeGreaterThanOrEqual(8_000);
    expect(screenRef - 1_000_000).toBeLessThan(9_500);
  });

  it('places arrival-calibrated audio at its arrival time minus jitter', () => {
    const result = unwrap(calibrate(s2Tracks()));
    const mic = result.tracks[2]!;
    const ts = BASE + 1_000_000 - (BASE - 5_000_000 + 20_500_000);
    const ref = toReferenceUs(mic, ts, BASE);
    // Captured at 1 s; arrives 25–42 ms later; the low percentile sits near the fast end.
    expect(ref - 1_000_000).toBeGreaterThanOrEqual(25_000);
    expect(ref - 1_000_000).toBeLessThan(28_000);
  });

  it('falls back to arrival calibration for a video track in a disjoint domain', () => {
    const tracks = s2Tracks();
    tracks[1] = track('camera', 'video', {
      rate: 16.7,
      domainOffsetUs: BASE - 5_000_000 + 900_000,
      latencyUs: 9_000,
      jitterUs: 3_000,
    });
    const result = unwrap(calibrate(tracks));
    expect(result.tracks[0]?.mode).toBe('shared');
    expect(result.tracks[1]?.mode).toBe('arrival-calibrated');
    expect(result.tracks[1]?.reason).toMatch(/disagrees/);
  });

  it('accepts video agreement within 250 ms, not beyond', () => {
    const near = s2Tracks();
    near[1] = track('camera', 'video', {
      rate: 16.7,
      domainOffsetUs: BASE - 5_000_000,
      latencyUs: 200_000,
      jitterUs: 3_000,
    });
    expect(unwrap(calibrate(near)).tracks[1]?.mode).toBe('shared');
    const far = s2Tracks();
    far[1] = track('camera', 'video', {
      rate: 16.7,
      domainOffsetUs: BASE - 5_000_000,
      latencyUs: 300_000,
      jitterUs: 3_000,
    });
    expect(unwrap(calibrate(far)).tracks[1]?.mode).toBe('arrival-calibrated');
  });

  it('shares video even when arrival jitter is high (queueing delays arrival, not capture)', () => {
    const tracks = s2Tracks();
    tracks[0] = {
      ...track('screen', 'video', {
        rate: 29.5,
        domainOffsetUs: BASE - 5_000_000,
        latencyUs: 8_000,
        jitterUs: 60_000,
      }),
      reference: true,
    };
    const result = unwrap(calibrate(tracks));
    expect(result.sharedOffsetUs).not.toBeNull();
    expect(result.tracks.map((t) => t.mode)).toEqual(['shared', 'shared', 'arrival-calibrated']);
    expect(result.tracks[0]?.stats.stable).toBe(false);
    expect(result.tracks[1]?.reason).toBe('agrees with the reference');
  });

  it('shares every track under the §1.5 policy when all domains agree', () => {
    const domain = BASE - 5_000_000;
    const tracks = [
      track('screen', 'video', {
        rate: 30,
        domainOffsetUs: domain,
        latencyUs: 8_000,
        jitterUs: 2_000,
      }),
      track('mic', 'audio', {
        rate: 47,
        domainOffsetUs: domain,
        latencyUs: 20_000,
        jitterUs: 15_000,
      }),
    ];
    const result = unwrap(calibrate(tracks, { policy: 'shared-preferred' }));
    expect(result.tracks.map((t) => t.mode)).toEqual(['shared', 'shared']);
    expect(result.clockMode).toBe('shared-capture');
    // Under hybrid the mic is arrival-calibrated even though it agrees.
    expect(unwrap(calibrate(tracks)).tracks[1]?.mode).toBe('arrival-calibrated');
    // arrival-only calibrates every track on its own.
    expect(unwrap(calibrate(tracks, { policy: 'arrival-only' })).tracks.map((t) => t.mode)).toEqual(
      ['arrival-calibrated', 'arrival-calibrated'],
    );
  });

  it('applies the clock handshake to externally timestamped sources (pw-record)', () => {
    // The utility stamps PCM chunks with sample-count time and arrival in its own clock.
    const utilityClockAhead = 1_200;
    const sys = track('system', 'audio', {
      rate: 50,
      domainOffsetUs: BASE - utilityClockAhead,
      latencyUs: 10_000 + utilityClockAhead,
      jitterUs: 4_000,
    });
    const result = unwrap(
      calibrate([...s2Tracks(), { ...sys, externalClockOffsetUs: -utilityClockAhead }]),
    );
    const system = result.tracks[3]!;
    expect(system.mode).toBe('arrival-calibrated');
    expect(system.clockHandshakeUs).toBe(-utilityClockAhead);
    expect(system.offsetUs).toBe(system.stats.lowUs - utilityClockAhead);
    expect(system.reason).toMatch(/external/);
    // Captured at 1 s (session clock); mapped close to 1 s + the 10 ms pipeline latency.
    const ts = BASE + 1_000_000 - (BASE - utilityClockAhead);
    expect(toReferenceUs(system, ts, BASE) - 1_000_000).toBeGreaterThanOrEqual(10_000);
    expect(toReferenceUs(system, ts, BASE) - 1_000_000).toBeLessThan(11_000);
  });

  it('only uses samples from the first 2 s of each track', () => {
    const t = track('screen', 'video', {
      rate: 30,
      domainOffsetUs: 0,
      latencyUs: 5_000,
      jitterUs: 1_000,
      seconds: 2,
    });
    const late: CalibrationSample[] = Array.from({ length: 30 }, (_, i) => ({
      timestampUs: BASE + 3_000_000 + i * 33_333,
      arrivalUs: BASE + 3_000_000 + i * 33_333 + 900_000,
    }));
    const stats = offsetStats([...t.samples, ...late]);
    expect(stats?.samples).toBe(60);
    expect(stats?.maxUs).toBeLessThan(10_000);
  });

  it('a single outlier does not move the offset (low percentile, not the minimum)', () => {
    const t = track('mic', 'audio', {
      rate: 47,
      domainOffsetUs: 0,
      latencyUs: 20_000,
      jitterUs: 15_000,
    });
    const withOutlier = { ...t, samples: [...t.samples] };
    const s0 = withOutlier.samples[5]!;
    withOutlier.samples[5] = { ...s0, arrivalUs: s0.timestampUs - 400_000 };
    const clean = unwrap(calibrate([t])).tracks[0]!.offsetUs;
    const dirty = unwrap(calibrate([withOutlier])).tracks[0]!.offsetUs;
    expect(Math.abs(dirty - clean)).toBeLessThan(2_000);
    // The strict §1.5 minimum is available with arrivalPercentile 0.
    expect(unwrap(calibrate([withOutlier], { arrivalPercentile: 0 })).tracks[0]!.offsetUs).toBe(
      -400_000,
    );
  });

  it('marks tracks with too few samples unstable but still calibrates them', () => {
    const t = track('mic', 'audio', {
      rate: 1.5,
      domainOffsetUs: 0,
      latencyUs: 20_000,
      jitterUs: 0,
    });
    const result = unwrap(calibrate([t]));
    expect(result.tracks[0]?.stats.samples).toBeLessThan(5);
    expect(result.tracks[0]?.stats.stable).toBe(false);
    expect(result.tracks[0]?.offsetUs).toBe(20_000);
  });

  it('reports missing input', () => {
    expect(calibrate([])).toEqual({ ok: false, error: { code: 'no-tracks' } });
    expect(calibrate([{ id: 'a', kind: 'video', samples: [] }])).toEqual({
      ok: false,
      error: { code: 'no-samples', trackId: 'a' },
    });
    const t = track('a', 'video', { rate: 30, domainOffsetUs: 0, latencyUs: 0, jitterUs: 0 });
    expect(calibrate([t, t])).toEqual({
      ok: false,
      error: { code: 'duplicate-track', trackId: 'a' },
    });
  });

  it('computes interpolated percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 10], 0.25)).toBe(2.5);
    expect(percentile([7], 0.9)).toBe(7);
    expect(() => percentile([], 0.5)).toThrow(RangeError);
  });

  it('collects a warm-up window in a worker and reports completion', () => {
    const w = new CalibrationWindow(2_000_000);
    expect(w.isComplete(BASE)).toBe(false);
    expect(w.add({ arrivalUs: BASE, timestampUs: 0 })).toBe(true);
    expect(w.add({ arrivalUs: BASE + 1_999_000, timestampUs: 1_990_000 })).toBe(true);
    expect(w.add({ arrivalUs: BASE + 2_100_000, timestampUs: 2_090_000 })).toBe(false);
    expect(w.samples).toHaveLength(2);
    expect(w.isComplete(BASE + 2_000_001)).toBe(true);
  });
});
