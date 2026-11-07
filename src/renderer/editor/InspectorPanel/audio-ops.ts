/**
 * Audio in the inspector (R2.12–R2.17): intents → timeline operations. Pure, so the mapping is
 * unit-tested; `AudioSections.tsx` renders the controls.
 *
 * - Clip gain and fades apply to the selected audio clips (Voice, System audio).
 * - Volume keyframes, noise reduction and ducking are per audio track; normalization is for the
 *   whole export, so it is set on every audio track at once (one undo step).
 * - Pauses (`findPauses`) come from the waveform peaks the timeline already loaded, through the
 *   same `silence.ts` the assistant uses. Each chosen pause is cut as its own undo step, latest
 *   first so the earlier ones stay where they were found.
 */
import { quietRangesOnTimeline, quietWindows, type UsRange } from '../../../shared/project/silence';
import { isTrackAudible } from '../../../shared/project/render-plan';
import type { AudioTrack, Clip, Project } from '../../../shared/project/schema';
import { findClip, type CleanupPatch, type TimelineOp } from '../../../shared/project/timeline-ops';
import { volumeDbAt } from '../../../shared/project/volume-keyframes';

export const CLIP_GAIN_MIN_DB = -24;
export const CLIP_GAIN_MAX_DB = 12;
export const FADE_LENGTHS_US = [0, 250_000, 500_000, 1_000_000, 2_000_000] as const;

export const PAUSE_THRESHOLDS_DB = [-50, -45, -40, -35] as const;
export const PAUSE_MIN_US = [500_000, 800_000, 1_500_000, 3_000_000] as const;
/** Kept on each side of a pause next to speech, so cuts never clip a word. */
export const PAUSE_PAD_US = 150_000;

export const DEFAULT_DUCK = { amountDb: -12, attackMs: 150, releaseMs: 600 } as const;

export function audioTracks(doc: Project): AudioTrack[] {
  return doc.timeline.tracks.filter((t): t is AudioTrack => t.type === 'audio');
}

/** The selected clips that are on audio tracks. */
export function selectedAudioClips(doc: Project, selection: readonly string[]): Clip[] {
  return selection.flatMap((id) => {
    const found = findClip(doc, id);
    return found && doc.timeline.tracks[found.trackIndex]?.type === 'audio' ? [found.clip] : [];
  });
}

export function clipAudioOp(
  clips: readonly Clip[],
  change: { gainDb?: number | null; fadeInUs?: number | null; fadeOutUs?: number | null },
): TimelineOp | null {
  if (clips.length === 0) return null;
  return { type: 'setClipAudio', clipIds: clips.map((c) => c.id), ...change };
}

/** A volume keyframe at the playhead at the level heard there (or `gainDb`). */
export function volumeKeyOp(track: AudioTrack, atUs: number, gainDb?: number): TimelineOp {
  return {
    type: 'setVolumeKeyframe',
    trackId: track.id,
    tUs: atUs,
    ...(gainDb !== undefined ? { gainDb } : {}),
  };
}

/** The level the track's volume keyframes add at `atUs`. */
export function volumeAt(track: AudioTrack, atUs: number): number {
  return volumeDbAt(track.volumeKeyframes, atUs);
}

export function cleanupOp(track: AudioTrack, cleanup: CleanupPatch): TimelineOp {
  return { type: 'setCleanup', trackId: track.id, cleanup };
}

/** Normalization of the export on (or off) for every audio track: one batch. */
export function normalizeOps(doc: Project, on: boolean): TimelineOp[] {
  return audioTracks(doc)
    .filter((t) => (t.cleanup?.normalize ?? false) !== on)
    .map((t) => cleanupOp(t, { normalize: on }));
}

/** Whether the export is normalized (any audio track asks for it). */
export function normalizes(doc: Project): boolean {
  return audioTracks(doc).some((t) => t.cleanup?.normalize === true);
}

export interface PauseSearch {
  pauses: UsRange[];
  /** Audible media whose waveform has not loaded yet: wait, then search again. */
  waiting: number;
}

/** Pauses on the timeline from the loaded peaks (`silence.ts`). */
export function findPauses(
  doc: Project,
  peaks: ReadonlyMap<string, Int16Array>,
  options: { thresholdDb: number; minDurationUs: number },
): PauseSearch {
  const quiet = new Map<string, UsRange[]>();
  let waiting = 0;
  for (const track of audioTracks(doc)) {
    if (!isTrackAudible(doc, track)) continue;
    for (const clip of track.clips) {
      if (quiet.has(clip.mediaId)) continue;
      const p = peaks.get(clip.mediaId);
      if (p) quiet.set(clip.mediaId, quietWindows(p, options.thresholdDb));
      else waiting += 1;
    }
  }
  if (waiting > 0) return { pauses: [], waiting };
  return {
    pauses: quietRangesOnTimeline(doc, quiet, {
      minDurationUs: options.minDurationUs,
      padUs: PAUSE_PAD_US,
    }),
    waiting: 0,
  };
}

/** One cut per chosen pause, latest first (each is its own undo step). */
export function pauseCutOps(pauses: readonly UsRange[]): TimelineOp[] {
  return [...pauses]
    .sort((a, b) => b.startUs - a.startUs)
    .map((p) => ({ type: 'cutRange', inUs: p.startUs, outUs: p.endUs }));
}
