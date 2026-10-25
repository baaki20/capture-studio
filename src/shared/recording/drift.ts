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
 * mic whose earliest arrivals were flat. The fit therefore:
 * - keeps only the lower envelope: the earliest-arriving checkpoint per window of media time;
 * - fits a least-squares line to it, refitted once without outliers (beyond 4 robust σ);
 * - is applied only when the deviation is at least 20 ppm **and** at least 3 standard errors of
 *   the slope, so short noisy recordings keep `clockRatio = 1` instead of being overcorrected;
 * - rejects implausible ratios (beyond 1000 ppm), which indicate a discontinuity, not drift.
 *
 * S2 also says audio drift correction stays mandatory, so a long recording with real drift is
 * always corrected: the standard error shrinks with duration (about 1 ppm at 10 minutes for
 * 5 ms jitter).
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
  /** Deviations smaller than this are ignored (§1.5). */
  minPpm: number;
  /** Deviations larger than this are treated as a fault, not drift. */
  maxPpm: number;
  /** The deviation must be at least this many standard errors of the slope. */
  minSignificance: number;
  /** Fewer checkpoints than this give `clockRatio = 1`. */
  minPoints: number;
  /** A shorter span of media time gives `clockRatio = 1`. */
  minSpanUs: Us;
  /** Residuals beyond this many robust σ are dropped before the second fit. */
  outlierSigma: number;
  /** Fit the lower envelope (earliest arrival per window) instead of every checkpoint. */
  envelope: boolean;
  /** The span is split into this many envelope windows, within the bounds below. */
  envelopeWindows: number;
  minEnvelopeWindowUs: Us;
  maxEnvelopeWindowUs: Us;
}

export const DEFAULT_DRIFT_OPTIONS: DriftOptions = {
  minPpm: 20,
  maxPpm: 1000,
  minSignificance: 3,
  minPoints: 5,
  minSpanUs: 10_000_000,
  outlierSigma: 4,
  envelope: true,
  envelopeWindows: 12,
  minEnvelopeWindowUs: 1_000_000,
  maxEnvelopeWindowUs: 10_000_000,
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

/**
 * The earliest-arriving point per window of media time, judged after removing `slope` (so real
 * drift does not favour one end of a window). Points are `[mediaUs, sessionUs]`.
 */
export function lowerEnvelope(
  xs: readonly number[],
  ys: readonly number[],
  windowUs: number,
  slope = 1,
): { xs: number[]; ys: number[] } {
  const best = new Map<number, number>();
  const x0 = xs.reduce((a, b) => Math.min(a, b), Infinity);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] ?? 0;
    const bin = Math.floor((x - x0) / windowUs);
    const current = best.get(bin);
    if (
      current === undefined ||
      (ys[i] ?? 0) - slope * x < (ys[current] ?? 0) - slope * (xs[current] ?? 0)
    ) {
      best.set(bin, i);
    }
  }
  const picked = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  return { xs: picked.map((i) => xs[i] ?? 0), ys: picked.map((i) => ys[i] ?? 0) };
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
  const rawXs = checkpoints.map(([, samples]) => samplesToUs(samples, nominalRate));
  const rawYs = checkpoints.map(([sessionUs]) => sessionUs);
  const rawSpanUs =
    rawXs.length > 0
      ? rawXs.reduce((a, b) => Math.max(a, b), -Infinity) -
        rawXs.reduce((a, b) => Math.min(a, b), Infinity)
      : 0;
  let xs = rawXs;
  let ys = rawYs;
  if (options.envelope && rawSpanUs > 0) {
    const windowUs = Math.min(
      options.maxEnvelopeWindowUs,
      Math.max(options.minEnvelopeWindowUs, rawSpanUs / options.envelopeWindows),
    );
    // Two passes: pick with slope 1, then re-pick with the slope fitted to the first envelope.
    const pass1 = lowerEnvelope(rawXs, rawYs, windowUs);
    const slope = fitLine(pass1.xs, pass1.ys)?.slope ?? 1;
    ({ xs, ys } = lowerEnvelope(rawXs, rawYs, windowUs, slope));
  }
  const spanUs = Math.round(rawSpanUs);

  const neutral = (decision: DriftDecision, line?: Line, dropped = 0): DriftFit => {
    const fittedRatio = line?.slope ?? 1;
    return {
      clockRatio: 1,
      fittedRatio,
      ppm: (fittedRatio - 1) * 1e6,
      standardErrorPpm: (line?.slopeStdErr ?? Infinity) * 1e6,
      decision,
      interceptUs: line?.intercept ?? (ys[0] ?? 0) - (xs[0] ?? 0),
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

  // Drop outliers (a stalled callback, a resumed device) and refit once.
  const centre = median(first.residuals);
  const mad = median(first.residuals.map((r) => Math.abs(r - centre)));
  const limit = options.outlierSigma * Math.max(1.4826 * mad, 1_000);
  const keep = first.residuals.map((r) => Math.abs(r - centre) <= limit);
  const dropped = keep.filter((k) => !k).length;
  let line = first;
  if (dropped > 0 && xs.length - dropped >= options.minPoints) {
    line =
      fitLine(
        xs.filter((_, i) => keep[i]),
        ys.filter((_, i) => keep[i]),
      ) ?? first;
  }
  const used = line === first ? 0 : dropped;

  const deviation = Math.abs(line.slope - 1);
  if (deviation * 1e6 > options.maxPpm) return neutral('implausible', line, used);
  if (deviation * 1e6 < options.minPpm) return neutral('below-threshold', line, used);
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
 * Throttles checkpoints to one per interval (1 s by default). Feed it after every written chunk
 * with the session time of the chunk's end and the cumulative sample count including the chunk.
 */
export class CheckpointLog {
  private readonly points: [Us, number][] = [];
  private lastUs: Us | null = null;

  constructor(private readonly intervalUs: Us = 1_000_000) {}

  /** Returns the checkpoint when one is due, so the caller can append it to the file. */
  offer(sessionUs: Us, cumulativeSamples: number): Checkpoint | null {
    if (this.lastUs !== null && sessionUs - this.lastUs < this.intervalUs) return null;
    this.lastUs = sessionUs;
    const point: [Us, number] = [Math.round(sessionUs), cumulativeSamples];
    this.points.push(point);
    return point;
  }

  get checkpoints(): readonly Checkpoint[] {
    return this.points;
  }

  toFile(nominalRate: number): SyncCheckpointFile {
    return {
      version: SYNC_FILE_VERSION,
      nominalRate,
      checkpoints: this.points.map(([a, b]) => [a, b]),
    };
  }
}
