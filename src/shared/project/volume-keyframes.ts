/**
 * Volume keyframes of an audio track (v2, R2.13): dB on top of the track's gain, eased between
 * keyframes (in dB, so a linear fade sounds even). Before the first keyframe the first applies;
 * the first keyframe added later than 0 gets an anchor at 0 at 0 dB (`hold`), so the track keeps
 * its level until then.
 */
import type { Us } from '../time';
import { interpolate, lerp } from './easing';
import type { AudioTrack, Easing } from './schema';

export type VolumeKeyframe = NonNullable<AudioTrack['volumeKeyframes']>[number];

/** Easing of a volume keyframe added without one: a straight ramp in dB. */
export const DEFAULT_VOLUME_EASING: Easing = 'linear';

/** dB the keyframes add at `tUs` (0 without keyframes). */
export function volumeDbAt(keys: readonly VolumeKeyframe[] | undefined, tUs: Us): number {
  if (!keys || keys.length === 0) return 0;
  return interpolate(keys, tUs, (k) => k.gainDb, lerp) ?? 0;
}

/** Sets the keyframe at `tUs`, or adds one starting from the level there (see the file comment). */
export function upsertVolumeKeyframe(
  keys: readonly VolumeKeyframe[] | undefined,
  tUs: Us,
  change: { gainDb?: number; easing?: Easing },
): VolumeKeyframe[] {
  const list = [...(keys ?? [])];
  const index = list.findIndex((k) => k.tUs === tUs);
  const existing = list[index];
  if (existing) {
    list[index] = {
      tUs,
      gainDb: change.gainDb ?? existing.gainDb,
      easing: change.easing ?? existing.easing,
    };
    return list;
  }
  const shown = volumeDbAt(list, tUs);
  if (list.length === 0 && tUs > 0) list.push({ tUs: 0, gainDb: 0, easing: 'hold' });
  list.push({
    tUs,
    gainDb: change.gainDb ?? shown,
    easing: change.easing ?? DEFAULT_VOLUME_EASING,
  });
  return list.sort((a, b) => a.tUs - b.tUs);
}
