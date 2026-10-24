/**
 * Sync calibrator (§1.5, binding changes in §9.2). Maps each track's media timestamps onto the
 * session clock with one additive offset per track: `sessionUs = timestampUs + offsetUs`.
 *
 * Hybrid mode is the default. Spike S2 measured that Chromium's video tracks share one capture
 * time domain (offsets agree within ~1.3 ms) but audio timestamps live in a different domain.
 * So:
 * - **shared:** video tracks whose earliest arrival offsets (a low percentile) agree with the
 *   reference track (the screen) within 250 ms share one global offset. This keeps the capture
 *   times Chromium assigned, including device latency. Arrival jitter does not matter here: a
 *   busy worker delays arrival, not the capture timestamp. (The first live Wayland recording
 *   had screen and camera 2 ms apart, yet the screen's queueing during encoder warm-up failed
 *   the old stability test and both fell back to arrival calibration.) A different time domain
 *   shows up as seconds of disagreement (S2: 20.5 s for audio).
 * - **arrival-calibrated:** every audio track, and any video track that fails the shared test,
 *   gets its own offset from its arrival times (a low percentile of `arrivalUs − timestampUs`).
 *   This is lower confidence; the mode is recorded per media in the project.
 * - **External sources** (system audio from `pw-record` in the media utility) are
 *   arrival-calibrated in the utility's clock, then shifted by the measured cross-process clock
 *   handshake (`externalClockOffsetUs`: utility clock → engine session clock).
 *
 * "Stable" means the spread of `arrivalUs − timestampUs` over the warm-up window (the first 2 s
 * of a track, from its first sample) is under 30 ms, taken between the 5th and 95th percentiles
 * so one late arrival does not fail a track. It is reported for arrival-calibrated tracks, whose
 * offset quality depends on it; it does not decide sharing.
 *
 * Pure: workers collect samples with `CalibrationWindow`; the engine resolves all tracks with
 * `calibrate()`.
 */
import { err, ok, type Result } from '../result';
import type { Us } from '../time';

export type TrackKind = 'video' | 'audio';

/** How a track's offset was obtained. Recorded per media in `project.json`. */
export type TrackSyncMode = 'shared' | 'arrival-calibrated';

/** Which tracks may join the shared domain. */
export type CalibrationPolicy =
  /** §9.2 default: video tracks may share; audio tracks are always arrival-calibrated. */
  | 'hybrid'
  /** §1.5 original: every track may share if it agrees with the reference. */
  | 'shared-preferred'
  /** Every track is arrival-calibrated (diagnostics and tests). */
  | 'arrival-only';

/** One observation: when a sample arrived (session clock) and the timestamp it carried. */
export interface CalibrationSample {
  arrivalUs: Us;
  timestampUs: Us;
}

export interface CalibrationTrackInput {
  id: string;
  kind: TrackKind;
  /** The track the shared domain is anchored to (the screen). Defaults to the first video track. */
  reference?: boolean;
  /**
   * Set for tracks timestamped in another process: the offset that maps that process's clock to
   * the engine's session clock, from a clock handshake. Such tracks are always
   * arrival-calibrated; arrivals are in the other process's clock.
   */
  externalClockOffsetUs?: Us;
  samples: readonly CalibrationSample[];
}

export interface CalibrationOptions {
  policy: CalibrationPolicy;
  /** Samples later than this after a track's first arrival are ignored. */
  warmupUs: Us;
  /** Maximum spread of arrival offsets for a track to count as stable. */
  stabilityBoundUs: Us;
  /** Maximum distance between a track's low offset and the reference's to share its domain. */
  sharedAgreementUs: Us;
  /** Percentile (0–1) of arrival offsets used as an arrival-calibrated offset; 0 is the minimum. */
  arrivalPercentile: number;
  /** Lower and upper percentile used to measure spread. */
  spreadPercentiles: readonly [number, number];
  /** Fewer samples than this make a track unstable (its offset is still computed). */
  minSamples: number;
}

export const DEFAULT_CALIBRATION_OPTIONS: CalibrationOptions = {
  policy: 'hybrid',
  warmupUs: 2_000_000,
  stabilityBoundUs: 30_000,
  sharedAgreementUs: 250_000,
  arrivalPercentile: 0.05,
  spreadPercentiles: [0.05, 0.95],
  minSamples: 5,
};

/** Summary of one track's warm-up window, for `logs/recording.json`. */
export interface TrackOffsetStats {
  samples: number;
  medianUs: Us;
  lowUs: Us;
  spreadUs: Us;
  minUs: Us;
  maxUs: Us;
  stable: boolean;
}

export interface TrackCalibration {
  id: string;
  kind: TrackKind;
  mode: TrackSyncMode;
  /** `sessionUs = timestampUs + offsetUs` (session clock, absolute). */
  offsetUs: Us;
  /** Cross-process handshake applied, or null for tracks timestamped in the engine. */
  clockHandshakeUs: Us | null;
  /** Why the track got its mode, for logs and Diagnostics. */
  reason: string;
  stats: TrackOffsetStats;
}

export interface CalibrationResult {
  policy: CalibrationPolicy;
  /** The offset shared by `shared` tracks, or null if none share. */
  sharedOffsetUs: Us | null;
  /** The project-level summary: `shared-capture` only when every track is shared. */
  clockMode: 'shared-capture' | 'arrival-calibrated';
  tracks: TrackCalibration[];
}

export type CalibrationError =
  | { code: 'no-tracks' }
  | { code: 'no-samples'; trackId: string }
  | { code: 'duplicate-track'; trackId: string };

/** Linear-interpolated percentile of a sorted array (`p` in 0–1). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('percentile of an empty array');
  const clamped = Math.min(Math.max(p, 0), 1);
  const pos = clamped * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/** Samples within the warm-up window, measured from the track's first arrival. */
function warmupSamples(
  samples: readonly CalibrationSample[],
  warmupUs: Us,
): readonly CalibrationSample[] {
  if (samples.length === 0) return [];
  const firstArrival = samples.reduce((min, s) => Math.min(min, s.arrivalUs), Infinity);
  return samples.filter((s) => s.arrivalUs - firstArrival <= warmupUs);
}

export function offsetStats(
  samples: readonly CalibrationSample[],
  options: Pick<
    CalibrationOptions,
    'warmupUs' | 'arrivalPercentile' | 'spreadPercentiles' | 'stabilityBoundUs' | 'minSamples'
  > = DEFAULT_CALIBRATION_OPTIONS,
): TrackOffsetStats | null {
  const window = warmupSamples(samples, options.warmupUs);
  if (window.length === 0) return null;
  const offsets = window.map((s) => s.arrivalUs - s.timestampUs).sort((a, b) => a - b);
  const [loP, hiP] = options.spreadPercentiles;
  const spreadUs = Math.round(percentile(offsets, hiP) - percentile(offsets, loP));
  return {
    samples: offsets.length,
    medianUs: Math.round(percentile(offsets, 0.5)),
    lowUs: Math.round(percentile(offsets, options.arrivalPercentile)),
    spreadUs,
    minUs: offsets[0] ?? 0,
    maxUs: offsets[offsets.length - 1] ?? 0,
    stable: offsets.length >= options.minSamples && spreadUs < options.stabilityBoundUs,
  };
}

function mayShare(policy: CalibrationPolicy, track: CalibrationTrackInput): boolean {
  if (track.externalClockOffsetUs !== undefined) return false;
  if (policy === 'arrival-only') return false;
  if (policy === 'hybrid') return track.kind === 'video';
  return true;
}

/** Resolves every track's mode and offset from its warm-up samples. */
export function calibrate(
  tracks: readonly CalibrationTrackInput[],
  overrides: Partial<CalibrationOptions> = {},
): Result<CalibrationResult, CalibrationError> {
  const options: CalibrationOptions = { ...DEFAULT_CALIBRATION_OPTIONS, ...overrides };
  if (tracks.length === 0) return err({ code: 'no-tracks' });

  const seen = new Set<string>();
  const stats = new Map<string, TrackOffsetStats>();
  for (const track of tracks) {
    if (seen.has(track.id)) return err({ code: 'duplicate-track', trackId: track.id });
    seen.add(track.id);
    const s = offsetStats(track.samples, options);
    if (!s) return err({ code: 'no-samples', trackId: track.id });
    stats.set(track.id, s);
  }

  const candidates = tracks.filter((t) => mayShare(options.policy, t));
  const reference =
    candidates.find((t) => t.reference) ?? candidates.find((t) => t.kind === 'video');
  const referenceStats = reference ? stats.get(reference.id) : undefined;

  // The shared group: candidates with enough samples whose earliest arrivals agree with the
  // reference's.
  const enough = (s: TrackOffsetStats | undefined): s is TrackOffsetStats =>
    s !== undefined && s.samples >= options.minSamples;
  const shared = new Set<string>();
  if (reference && enough(referenceStats)) {
    for (const t of candidates) {
      const s = stats.get(t.id);
      if (enough(s) && Math.abs(s.lowUs - referenceStats.lowUs) <= options.sharedAgreementUs) {
        shared.add(t.id);
      }
    }
  }

  // One global offset: the lowest-latency observation across the shared group (a low percentile
  // of the pooled offsets), so every shared track keeps Chromium's relative capture times.
  let sharedOffsetUs: Us | null = null;
  if (shared.size > 0) {
    const pooled = tracks
      .filter((t) => shared.has(t.id))
      .flatMap((t) => warmupSamples(t.samples, options.warmupUs))
      .map((s) => s.arrivalUs - s.timestampUs)
      .sort((a, b) => a - b);
    sharedOffsetUs = Math.round(percentile(pooled, options.arrivalPercentile));
  }

  const results: TrackCalibration[] = tracks.map((t) => {
    const s = stats.get(t.id);
    if (!s) throw new Error(`no stats for track ${t.id}`); // every track got stats above
    if (sharedOffsetUs !== null && shared.has(t.id)) {
      return {
        id: t.id,
        kind: t.kind,
        mode: 'shared',
        offsetUs: sharedOffsetUs,
        clockHandshakeUs: null,
        reason: t === reference ? 'reference of the shared domain' : 'agrees with the reference',
        stats: s,
      };
    }
    const handshake = t.externalClockOffsetUs ?? null;
    return {
      id: t.id,
      kind: t.kind,
      mode: 'arrival-calibrated',
      offsetUs: s.lowUs + (handshake ?? 0),
      clockHandshakeUs: handshake,
      reason: arrivalReason(options, t, s, referenceStats, reference?.id),
      stats: s,
    };
  });

  return ok({
    policy: options.policy,
    sharedOffsetUs,
    clockMode: results.every((r) => r.mode === 'shared') ? 'shared-capture' : 'arrival-calibrated',
    tracks: results,
  });
}

function arrivalReason(
  options: CalibrationOptions,
  track: CalibrationTrackInput,
  stats: TrackOffsetStats,
  referenceStats: TrackOffsetStats | undefined,
  referenceId: string | undefined,
): string {
  if (track.externalClockOffsetUs !== undefined) return 'external clock (handshake applied)';
  if (!mayShare(options.policy, track)) return `policy ${options.policy}`;
  if (!referenceStats || referenceStats.samples < options.minSamples) {
    return 'reference track has too few samples';
  }
  if (stats.samples < options.minSamples) return 'too few samples';
  if (track.id === referenceId) return 'reference track';
  return 'disagrees with the reference by more than the shared bound';
}

/** Maps a media timestamp to the session clock, relative to `t0` (the project's reference clock). */
export function toReferenceUs(
  calibration: Pick<TrackCalibration, 'offsetUs'>,
  timestampUs: Us,
  t0Us: Us,
): Us {
  return timestampUs + calibration.offsetUs - t0Us;
}

/**
 * Collects one track's warm-up samples in a pipeline worker. `add` returns false once the window
 * is complete, so the caller can stop recording samples.
 */
export class CalibrationWindow {
  private readonly collected: CalibrationSample[] = [];
  private firstArrivalUs: Us | null = null;

  constructor(private readonly warmupUs: Us = DEFAULT_CALIBRATION_OPTIONS.warmupUs) {}

  add(sample: CalibrationSample): boolean {
    this.firstArrivalUs ??= sample.arrivalUs;
    if (sample.arrivalUs - this.firstArrivalUs > this.warmupUs) return false;
    this.collected.push(sample);
    return true;
  }

  /** True once a sample beyond the window has arrived. */
  isComplete(nowUs: Us): boolean {
    return this.firstArrivalUs !== null && nowUs - this.firstArrivalUs > this.warmupUs;
  }

  get samples(): readonly CalibrationSample[] {
    return this.collected;
  }
}
