/**
 * Audio at a clip's speed (v2, R2.18): the pitch is kept with FFmpeg's `atempo`, one filter per
 * factor in 0.5–2 (its best range), so 4× is `atempo=2,atempo=2` and 0.25× is two 0.5 stages.
 * The export's filter graph and the preview's cached renders (`audioRender` jobs, played by the
 * preview scheduler) use the same filters, so both play the same audio.
 */
import type { Us } from '../time';
import type { NoiseMode } from './audio-cleanup';

/** Factors in 0.5–2 whose product is `speed` (none for 1). */
export function atempoFactors(speed: number): number[] {
  const factors: number[] = [];
  let rest = speed;
  while (rest > 2 + 1e-9) {
    factors.push(2);
    rest /= 2;
  }
  while (rest < 0.5 - 1e-9) {
    factors.push(0.5);
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 1e-9) factors.push(rest);
  return factors;
}

/** The `atempo` filters for `speed`. */
export function atempoFilters(speed: number): string[] {
  return atempoFactors(speed).map((f) => `atempo=${String(Math.round(f * 1e9) / 1e9)}`);
}

/** What a preview audio render is made from: a media's file range played at `speed`. */
export interface AudioRenderSpec {
  mediaId: string;
  fileStartUs: Us;
  fileEndUs: Us;
  speed: number;
  /** Made from the media's cleaned audio (`audio-cleanup.ts`) when not 'off'. */
  noise?: NoiseMode;
}

/**
 * The render's name in the project cache (`cache/audio/<key>.wav`): it changes whenever the audio
 * would, and holds only ID characters, digits and dashes.
 */
export function audioRenderKey(spec: AudioRenderSpec): string {
  return [
    spec.mediaId,
    String(spec.fileStartUs),
    String(spec.fileEndUs),
    String(Math.round(spec.speed * 1_000_000)),
    ...(spec.noise && spec.noise !== 'off' ? [`clean-${spec.noise}`] : []),
  ].join('-');
}

/** `cache/audio/<key>.wav`, relative to the project folder. */
export function audioRenderPath(key: string): string {
  return `cache/audio/${key}.wav`;
}
