/**
 * Clock drift (§1.5, §4.3.5). Every second during recording a checkpoint
 * `(sessionUs, cumulativeSamples)` is appended to `media/<x>.sync.json`. At finalize a straight
 * line is fitted to session time against media time; its slope is `clockRatio`, the session µs per
 * media (file) µs, which preview and export apply.
 *
 * Arrival times are jittery (spike S2: 15–18 ms spread for mic chunks, and an apparent −5 ms over
 * 20 s that is most likely jitter). Arrival jitter is one-sided: a chunk can arrive late (a busy
 * worker, a scheduling stall) but never before it was captured. A plain least-squares line is
 * pulled up by late stretches; the first live Wayland recording read 189 ppm of "drift" from a
 * mic whose earliest arrivals were flat.
 *
 * Audio is also delivered on the session clock, not the device's. In the live sync files the
 * chunks arrive on fixed ticks (5.33 ms, a 256-frame quantum, for the mic; 1024-frame chunks
 * for the sink monitor) while the device runs slower, so the deficit builds up in a buffer and
 * the drift shows as steps of extra latency (a sawtooth: 5.3 ms steps on the mic and 22–32 ms
 * steps on system audio, 40–120 s apart, in the 5-minute flash-and-beep test). Between steps the
 * arrivals follow the session clock. The earliest arrival per window of media time (the previous
 * fit) followed that draining side wherever a window held no step, so its line leaned towards
 * the session clock: system audio read 231 ppm against 257 ppm measured by the sync test. The
 * fit therefore:
 * - fits the line *under* the checkpoints: a low-quantile regression (5 %) over the whole
 *   recording, which rests on the lowest-latency points just before each step, so the steps carry
 *   the drift; late stalls never reach it, and a few early points (a flush at stop, a quantum
 *   change in the audio graph) are ignored up to the quantile;
 * - is applied only when the deviation is at least 3 standard errors of the slope, so short noisy
 *   recordings keep `clockRatio = 1` instead of being overcorrected, **and** either at least
 *   20 ppm or enough to move the track 10 ms over the recording. A fixed ppm floor alone let the
 *   60-minute soak's mic (18.0 ± 0.1 ppm) drift 52 ms uncorrected;
 * - rejects implausible ratios (beyond 1000 ppm), which indicate a discontinuity, not drift.
 *
 * S2 also says audio drift correction stays mandatory, so a long recording with real drift is
 * always corrected: the standard error shrinks with duration (about 1 ppm at 10 minutes for
 * 5 ms jitter).
 *
 * Limit: arrival timing only sees the latency it measures. When the buffer level wanders without
 * returning to a floor, no line through the arrivals recovers the device clock better than that
 * wander divided by the duration. The mic in the 5-minute test drained 12 ms over the recording
 * against 5.5 quanta of steps, so every fit (quantile, windowed, least squares) reads it
 * 106–110 ppm against 128 ppm measured.
 */
import { z } from 'zod';
import type { Us } from '../time';

export const SYNC_FILE_VERSION = 1;

/**
 * `nominalRate` of a video track's sync file: its checkpoints are `[arrival session µs, frame
 * file µs]`, so one "sample" is one microsecond. The live sync test (tests/sync) showed screen
 * timestamps drifting ~116 ppm from the session clock, so video is drift-fitted like audio.
 */
export const VIDEO_SYNC_RATE = 1_000_000;

/** `media/<x>.sync.json` (§4.4.3). */
export const SyncCheckpointFileSchema = z.object({
  version: z.literal(SYNC_FILE_VERSION),
  nominalRate: z.int().positive(),
  // Early system-audio files stored fractional arrival times; round them on read.
  checkpoints: z.array(z.tuple([z.number().transform(Math.round), z.int().nonnegative()])),
});
export type SyncCheckpointFile = z.output<typeof SyncCheckpointFileSchema>;

/** `[sessionUs, cumulativeSamples]`. */
export type Checkpoint = readonly [sessionUs: Us, cumulativeSamples: number];

export interface DriftOptions {
  /** Deviations smaller than this are ignored (§1.5)… */
  minPpm: number;
  /** …unless they move the track at least this far over the recording's span. */
  minDriftUs: Us;
  /** Deviations larger than this are treated as a fault, not drift. */
  maxPpm: number;
  /** The deviation must be at least this many standard errors of the slope. */
  minSignificance: number;
  /** Fewer checkpoints than this give `clockRatio = 1`. */
  minPoints: number;
  /** A shorter span of media time gives `clockRatio = 1`. */
  minSpanUs: Us;
  /**
   * Residuals beyond this many robust σ are outliers: least squares drops them before its second
   * fit; the envelope fit leaves them out of the standard error.
   */
  outlierSigma: number;
  /**
   * Fit the line under the checkpoints (a low-quantile regression) instead of a least-squares
   * line through all of them.
   */
  envelope: boolean;
  /** The quantile of the envelope fit: this share of checkpoints may lie below the line. */
  envelopeQuantile: number;
}

export const DEFAULT_DRIFT_OPTIONS: DriftOptions = {
  minPpm: 20,
  minDriftUs: 10_000,
  maxPpm: 1000,
  minSignificance: 3,
  minPoints: 5,
  minSpanUs: 10_000_000,
  outlierSigma: 4,
  envelope: true,
  envelopeQuantile: 0.05,
};

export type DriftDecision =
  | 'applied'
  | 'below-threshold'
  | 'not-significant'
  | 'implausible'
  | 'too-few-points'
  | 'too-short';

export interface DriftFit {
  /** The ratio to store in `Media.clockRatio`: the fitted ratio, or 1 when not applied. */
  clockRatio: number;
  /** The fitted slope, even when it is not applied. */
  fittedRatio: number;
  /** `(fittedRatio − 1) × 1e6`. */
  ppm: number;
  /** Standard error of the slope, in ppm. */
  standardErrorPpm: number;
  decision: DriftDecision;
  /** Session µs at media time 0 according to the fit. */
  interceptUs: number;
  pointsUsed: number;
  pointsDropped: number;
  spanUs: Us;
  residualRmsUs: number;
}

interface Line {
  slope: number;
  intercept: number;
  slopeStdErr: number;
  residuals: number[];
}

/** Ordinary least squares on centred data (µs values reach 1e10, so raw sums lose precision). */
function fitLine(xs: readonly number[], ys: readonly number[]): Line | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i] ?? 0;
    my += ys[i] ?? 0;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    sxx += dx * dx;
    sxy += dx * ((ys[i] ?? 0) - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const residuals = xs.map((x, i) => (ys[i] ?? 0) - (intercept + slope * x));
  const sse = residuals.reduce((acc, r) => acc + r * r, 0);
  const slopeStdErr = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
  return { slope, intercept, slopeStdErr, residuals };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** The `q`-quantile of `values` (the ⌊q·n⌋-th smallest), by quickselect; reorders `values`. */
function quantileInPlace(values: Float64Array, q: number): number {
  const k = Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)));
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1] ?? 0;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while ((values[i] ?? 0) < pivot) i++;
      while ((values[j] ?? 0) > pivot) j--;
      if (i <= j) {
        const t = values[i] ?? 0;
        values[i] = values[j] ?? 0;
        values[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k] ?? 0;
}

/**
 * Linear quantile regression: the line minimising the pinball loss at quantile `q`, so about a
 * share `q` of the points lies below it. For a fixed slope the best intercept is the `q`-quantile
 * of `y − slope·x` and the loss is convex in the slope, so a golden-section search around `guess`
 * finds it. The slope's standard error is the least-squares one of the residuals about the line,
 * which is conservative for the sawtooth of a quantised delivery; residuals beyond `outlierSigma`
 * robust σ (a start-up backlog, a stall) are left out of it and counted in `dropped`.
 *
 * Expects data already shifted to start near 0 (see `fitClockRatio`); it centres on the means
 * again so `y − slope·x` stays small.
 */
function fitQuantileLine(
  xs: readonly number[],
  ys: readonly number[],
  q: number,
  guess: number,
  outlierSigma: number,
): (Line & { dropped: number }) | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i] ?? 0;
    my += ys[i] ?? 0;
  }
  mx /= n;
  my /= n;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    cx[i] = (xs[i] ?? 0) - mx;
    cy[i] = (ys[i] ?? 0) - my;
    sxx += (cx[i] ?? 0) ** 2;
  }
  if (sxx === 0) return null;
  const scratch = new Float64Array(n);
  /** Fills `scratch` with `cy − slope·cx` and returns its `q`-quantile (the best intercept). */
  const offsets = (slope: number): number => {
    for (let i = 0; i < n; i++) scratch[i] = (cy[i] ?? 0) - slope * (cx[i] ?? 0);
    return quantileInPlace(scratch, q);
  };
  const loss = (slope: number): number => {
    const at = offsets(slope);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const v = scratch[i] ?? 0;
      total += v >= at ? q * (v - at) : (1 - q) * (at - v);
    }
    return total;
  };
  // Golden-section search over ±1 % around the guess, which holds every plausible ratio (and
  // the implausible ones the caller rejects), down to a bracket of 1e-13 (0.0001 ppm).
  const phi = (Math.sqrt(5) - 1) / 2;
  let lo = guess - 0.01;
  let hi = guess + 0.01;
  let m1 = hi - phi * (hi - lo);
  let m2 = lo + phi * (hi - lo);
  let l1 = loss(m1);
  let l2 = loss(m2);
  while (hi - lo > 1e-13) {
    if (l1 <= l2) {
      hi = m2;
      m2 = m1;
      l2 = l1;
      m1 = hi - phi * (hi - lo);
      l1 = loss(m1);
    } else {
      lo = m1;
      m1 = m2;
      l1 = l2;
      m2 = lo + phi * (hi - lo);
      l2 = loss(m2);
    }
  }
  const slope = (lo + hi) / 2;
  const intercept = my + offsets(slope) - slope * mx;
  const residuals = xs.map((x, i) => (ys[i] ?? 0) - (intercept + slope * x));
  const centre = median(residuals);
  const mad = median(residuals.map((r) => Math.abs(r - centre)));
  const limit = outlierSigma * Math.max(1.4826 * mad, 1_000);
  let k = 0;
  let kmx = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs((residuals[i] ?? 0) - centre) > limit) continue;
    k++;
    kmx += cx[i] ?? 0;
    mean += residuals[i] ?? 0;
  }
  kmx /= Math.max(1, k);
  mean /= Math.max(1, k);
  let ksxx = 0;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs((residuals[i] ?? 0) - centre) > limit) continue;
    ksxx += ((cx[i] ?? 0) - kmx) ** 2;
    sse += ((residuals[i] ?? 0) - mean) ** 2;
  }
  const slopeStdErr = k > 2 && ksxx > 0 ? Math.sqrt(sse / (k - 2) / ksxx) : Infinity;
  return { slope, intercept, slopeStdErr, residuals, dropped: n - k };
}

/** Media (file) time of a checkpoint in µs. */
export function samplesToUs(cumulativeSamples: number, rate: number): number {
  return (cumulativeSamples * 1_000_000) / rate;
}

/** Fits `clockRatio` from checkpoints recorded at `nominalRate` samples per second. */
export function fitClockRatio(
  checkpoints: readonly Checkpoint[],
  nominalRate: number,
  overrides: Partial<DriftOptions> = {},
): DriftFit {
  const options: DriftOptions = { ...DEFAULT_DRIFT_OPTIONS, ...overrides };
  // Every fit runs on data shifted to start at the first checkpoint, and only the intercept is
  // shifted back. Session µs reach 1e15 (and cross-process offsets add to that), where sums and
  // `y − slope·x` lose whole microseconds; subtracting the first value is exact for integer µs,
  // so a constant shift of either clock leaves every later step bit-identical.
  const xs0 = checkpoints.length > 0 ? samplesToUs(checkpoints[0]?.[1] ?? 0, nominalRate) : 0;
  const ys0 = checkpoints[0]?.[0] ?? 0;
  const xs = checkpoints.map(([, samples]) => samplesToUs(samples, nominalRate) - xs0);
  const ys = checkpoints.map(([sessionUs]) => sessionUs - ys0);
  const spanUs =
    xs.length > 0
      ? Math.round(
          xs.reduce((a, b) => Math.max(a, b), -Infinity) -
            xs.reduce((a, b) => Math.min(a, b), Infinity),
        )
      : 0;

  const neutral = (decision: DriftDecision, line?: Line, dropped = 0): DriftFit => {
    const fittedRatio = line?.slope ?? 1;
    return {
      clockRatio: 1,
      fittedRatio,
      ppm: (fittedRatio - 1) * 1e6,
      standardErrorPpm: (line?.slopeStdErr ?? Infinity) * 1e6,
      decision,
      // Session µs at media time 0, back on the original clocks.
      interceptUs: ys0 + (line ? line.intercept - line.slope * xs0 : -xs0),
      pointsUsed: xs.length - dropped,
      pointsDropped: dropped,
      spanUs,
      residualRmsUs: line ? rms(line.residuals) : 0,
    };
  };

  if (xs.length < options.minPoints) return neutral('too-few-points');
  if (spanUs < options.minSpanUs) return neutral('too-short');

  const first = fitLine(xs, ys);
  if (!first) return neutral('too-short');

  let line = first;
  let used = 0;
  if (options.envelope) {
    const quantileLine = fitQuantileLine(
      xs,
      ys,
      options.envelopeQuantile,
      first.slope,
      options.outlierSigma,
    );
    if (quantileLine) {
      line = quantileLine;
      used = quantileLine.dropped;
    }
  } else {
    // Drop outliers (a stalled callback, a resumed device) and refit once.
    const centre = median(first.residuals);
    const mad = median(first.residuals.map((r) => Math.abs(r - centre)));
    const limit = options.outlierSigma * Math.max(1.4826 * mad, 1_000);
    const keep = first.residuals.map((r) => Math.abs(r - centre) <= limit);
    const dropped = keep.filter((k) => !k).length;
    if (dropped > 0 && xs.length - dropped >= options.minPoints) {
      line =
        fitLine(
          xs.filter((_, i) => keep[i]),
          ys.filter((_, i) => keep[i]),
        ) ?? first;
      used = dropped;
    }
  }

  const deviation = Math.abs(line.slope - 1);
  if (deviation * 1e6 > options.maxPpm) return neutral('implausible', line, used);
  if (deviation * 1e6 < options.minPpm && deviation * spanUs < options.minDriftUs) {
    return neutral('below-threshold', line, used);
  }
  if (deviation < options.minSignificance * line.slopeStdErr) {
    return neutral('not-significant', line, used);
  }
  return {
    ...neutral('applied', line, used),
    clockRatio: line.slope,
  };
}

/** Fits a parsed `*.sync.json`. */
export function fitSyncFile(file: SyncCheckpointFile, overrides?: Partial<DriftOptions>): DriftFit {
  return fitClockRatio(file.checkpoints, file.nominalRate, overrides);
}

function rms(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((acc, v) => acc + v * v, 0) / values.length);
}

/**
 * Keeps one checkpoint per interval (1 s by default): of the chunks offered in the interval, the
 * one that arrived earliest relative to its media time. Feed it after every written chunk with the
 * session time of the chunk's arrival and the cumulative sample count including the chunk.
 *
 * Taking the first chunk after each interval instead (as before) paired a tick-quantised arrival
 * with whatever chunk boundary happened to fall there: mic chunks of 480 frames reach the worker
 * on 256-frame PipeWire ticks, so the stored latency alternated by up to a tick (the 1.003 s /
 * 1.008 s steps in the live sync files). The earliest point of an interval is the one closest
 * to the line the fit rests on.
 *
 * A checkpoint is returned when its interval has closed (by the first offer after it), so call
 * `flush` at the end of the stream to get the last one.
 */
export class CheckpointLog {
  private readonly points: [Us, number][] = [];
  private intervalStartUs: Us | null = null;
  private best: [Us, number] | null = null;
  private bestLeadUs = Infinity;

  /**
   * @param rate samples per second of `cumulativeSamples` (`VIDEO_SYNC_RATE` for video).
   */
  constructor(
    private readonly rate: number,
    private readonly intervalUs: Us = 1_000_000,
  ) {}

  /** Returns a checkpoint when one is due, so the caller can append it to the file. */
  offer(sessionUs: Us, cumulativeSamples: number): Checkpoint | null {
    let due: Checkpoint | null = null;
    if (this.intervalStartUs === null) {
      this.intervalStartUs = sessionUs;
    } else if (sessionUs - this.intervalStartUs >= this.intervalUs) {
      due = this.flush();
      // Intervals stay on a fixed grid, so one checkpoint per interval on average.
      const elapsed = Math.floor((sessionUs - this.intervalStartUs) / this.intervalUs);
      this.intervalStartUs += elapsed * this.intervalUs;
    }
    // Session time ahead of media time: smallest for the chunk with the least delivery latency.
    const leadUs = sessionUs - samplesToUs(cumulativeSamples, this.rate);
    if (leadUs < this.bestLeadUs) {
      this.bestLeadUs = leadUs;
      this.best = [Math.round(sessionUs), cumulativeSamples];
    }
    return due;
  }

  /** Stores and returns the pending checkpoint of the current interval, if any. */
  flush(): Checkpoint | null {
    const point = this.best;
    this.best = null;
    this.bestLeadUs = Infinity;
    if (point) this.points.push(point);
    return point;
  }

  get checkpoints(): readonly Checkpoint[] {
    return this.points;
  }

  toFile(): SyncCheckpointFile {
    return {
      version: SYNC_FILE_VERSION,
      nominalRate: this.rate,
      checkpoints: this.points.map(([a, b]) => [a, b]),
    };
  }
}
