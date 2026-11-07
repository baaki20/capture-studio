/**
 * Audio cleanup (v2, R2.14, R2.15; D6): noise reduction and loudness normalization.
 *
 * - **Noise reduction** measures a media's noise floor (`noiseFloorDb`), then runs FFmpeg's
 *   `afftdn` tuned to it (`noiseFilter`) over the whole audio once, into the project
 *   cache (`cache/audio/<mediaId>-clean-<mode>.wav`, same timing as the file). The preview plays
 *   that file and the export reads it, so both hear exactly the same cleaned audio. "Light"
 *   removes a steady hiss; "Strong" removes more, at some cost to the voice. (D6 planned RNNoise
 *   `arnndn` for "Strong"; that needs a bundled model, so both modes use `afftdn` for now.)
 * - **Loudness**: when any audio track asks for it, the export's mix is brought to −16 LUFS
 *   (−1.5 dBTP, LRA 11) with two-pass `loudnorm`: one pass measures, the second applies the
 *   measured values in linear mode. The preview is not normalized.
 */
import type { AudioTrack, Project } from './schema';

export type NoiseMode = NonNullable<AudioTrack['cleanup']>['noise'];

/** Most noise each mode removes, dB (`afftdn` `nr`). */
export const NOISE_REDUCTION_DB: Record<Exclude<NoiseMode, 'off'>, number> = {
  light: 12,
  strong: 24,
};

/** Rate of the noise-floor analysis: full band, so broadband noise is measured whole. */
export const NOISE_ANALYSIS_RATE = 48_000;
const NOISE_WINDOW = 2400; // 50 ms

/**
 * A recording's noise floor (dBFS): the 10th-percentile RMS of its 50 ms windows (mono s16 at
 * `NOISE_ANALYSIS_RATE`), so the pauses between words decide it. Fed in chunks (`push`), so a
 * long recording is never held in memory; −90 for silence.
 */
export class NoiseFloorMeter {
  private readonly levels: number[] = [];
  private sum = 0;
  private count = 0;

  push(samples: Int16Array): void {
    for (const v of samples) {
      this.sum += (v / 32768) ** 2;
      if (++this.count === NOISE_WINDOW) {
        this.levels.push(10 * Math.log10(Math.max(1e-9, this.sum / NOISE_WINDOW)));
        this.sum = 0;
        this.count = 0;
      }
    }
  }

  floorDb(): number {
    if (this.levels.length === 0) return -90;
    const sorted = [...this.levels].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.1)] ?? -90;
  }
}

/** `NoiseFloorMeter` over one buffer of samples. */
export function noiseFloorDb(pcm: Int16Array): number {
  const meter = new NoiseFloorMeter();
  meter.push(pcm);
  return meter.floorDb();
}

/**
 * The `afftdn` filter of a mode for a recording whose noise floor is `floorDb`: the floor it is
 * told is 3 dB above the measured one (just under it, `afftdn` hardly reduces), clamped to −80…−20.
 * Noise tracking (`tn`) stays off: on steady noise it undoes the reduction.
 */
export function noiseFilter(mode: Exclude<NoiseMode, 'off'>, floorDb: number): string {
  const nf = Math.round(Math.min(-20, Math.max(-80, floorDb + 3)));
  return `afftdn=nr=${String(NOISE_REDUCTION_DB[mode])}:nf=${String(nf)}`;
}

/** `cache/audio/<mediaId>-clean-<mode>.wav`, relative to the project folder. */
export function cleanedAudioPath(mediaId: string, mode: Exclude<NoiseMode, 'off'>): string {
  return `cache/audio/${mediaId}-clean-${mode}.wav`;
}

/** The noise mode each audio media is cleaned with (from the track its clips are on). */
export function noiseByMedia(doc: Project): Map<string, Exclude<NoiseMode, 'off'>> {
  const out = new Map<string, Exclude<NoiseMode, 'off'>>();
  for (const track of doc.timeline.tracks) {
    if (track.type !== 'audio') continue;
    const mode = track.cleanup?.noise ?? 'off';
    if (mode === 'off') continue;
    for (const clip of track.clips) if (!out.has(clip.mediaId)) out.set(clip.mediaId, mode);
  }
  return out;
}

/** The noise mode of each audio track ('off' is left out). */
export function noiseByTrack(doc: Project): Map<string, Exclude<NoiseMode, 'off'>> {
  const out = new Map<string, Exclude<NoiseMode, 'off'>>();
  for (const track of doc.timeline.tracks) {
    const mode = track.type === 'audio' ? (track.cleanup?.noise ?? 'off') : 'off';
    if (mode !== 'off') out.set(track.id, mode);
  }
  return out;
}

/** The cache key of a media's cleaned audio (`media.audioRender` without a range). */
export function cleanedAudioKey(mediaId: string, mode: Exclude<NoiseMode, 'off'>): string {
  return `${mediaId}-clean-${mode}`;
}

/** Loudness target of normalized exports. */
export const LOUDNESS_TARGET = { integratedLufs: -16, truePeakDb: -1.5, range: 11 } as const;

/** Whether the export normalizes its loudness (any audio track asks for it). */
export function wantsNormalize(doc: Project): boolean {
  return doc.timeline.tracks.some((t) => t.type === 'audio' && t.cleanup?.normalize === true);
}

/** `loudnorm`'s first-pass measurements (its JSON output). */
export interface LoudnormMeasured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

const TARGET = `I=${String(LOUDNESS_TARGET.integratedLufs)}:TP=${String(LOUDNESS_TARGET.truePeakDb)}:LRA=${String(LOUDNESS_TARGET.range)}`;

/** The measuring pass's filter. */
export const LOUDNORM_MEASURE = `loudnorm=${TARGET}:print_format=json`;

/** The second pass's filter, with the first pass's measurements. */
export function loudnormApply(m: LoudnormMeasured): string {
  return (
    `loudnorm=${TARGET}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}` +
    ':linear=true:print_format=summary'
  );
}

/** The measurements in `loudnorm`'s stderr output, or null. */
export function parseLoudnorm(stderr: string): LoudnormMeasured | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const json = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnormMeasured>;
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;
    if (!keys.every((k) => typeof json[k] === 'string' && Number.isFinite(Number(json[k])))) {
      return null;
    }
    return json as LoudnormMeasured;
  } catch {
    return null;
  }
}
