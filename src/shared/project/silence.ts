/**
 * Silence detection from the waveform peaks cache, for "remove the long pauses".
 *
 * 1. `quietWindows` finds the quiet runs of one media file (file-local µs), where every 10 ms
 *    window's peak stays at or under a dBFS threshold.
 * 2. `quietRangesOnTimeline` maps those runs through each clip to timeline time and keeps only
 *    the time where **every audible audio track** is quiet, so a pause counts only when both the
 *    mic and system audio are silent. Gaps between clips and parts of a clip that a sync nudge
 *    left without media are silent too. A clip whose media has no peaks yet counts as sound, so
 *    nothing is ever cut on missing data.
 * 3. Runs shorter than `minDurationUs` are dropped and the rest shrink by `padUs` on each side
 *    that touches sound, leaving a natural breath around speech.
 *
 * Pure: the caller reads the peaks files (`parsePeaks`) and decides what to cut.
 */
import { type Us } from '../time';
import { fileToRefUs } from './media-time';
import { PEAK_WINDOW_US } from './peaks';
import { clipCoverage, isTrackAudible } from './render-plan';
import type { AudioTrack, ProjectV1 } from './schema';
import { timelineDurationUs } from './timeline-ops';

/** A half-open time range `[startUs, endUs)`. */
export interface UsRange {
  startUs: Us;
  endUs: Us;
}

export interface QuietOptions {
  /** Shortest pause to report, before padding. */
  minDurationUs: Us;
  /** Kept on each side of a pause that touches sound. */
  padUs: Us;
}

/** Quiet runs of a peaks array, in file-local µs: windows whose peak is ≤ `thresholdDb` dBFS. */
export function quietWindows(peaks: Int16Array, thresholdDb: number): UsRange[] {
  const limit = 32768 * 10 ** (thresholdDb / 20);
  const pairs = Math.floor(peaks.length / 2);
  const out: UsRange[] = [];
  let runStart = -1;
  for (let i = 0; i < pairs; i++) {
    const level = Math.max(Math.abs(peaks[i * 2] ?? 0), Math.abs(peaks[i * 2 + 1] ?? 0));
    const quiet = level <= limit;
    if (quiet && runStart < 0) runStart = i;
    else if (!quiet && runStart >= 0) {
      out.push({ startUs: runStart * PEAK_WINDOW_US, endUs: i * PEAK_WINDOW_US });
      runStart = -1;
    }
  }
  if (runStart >= 0)
    out.push({ startUs: runStart * PEAK_WINDOW_US, endUs: pairs * PEAK_WINDOW_US });
  return out;
}

/** Sorted, merged, non-empty ranges. */
export function normalizeRanges(ranges: readonly UsRange[]): UsRange[] {
  const sorted = ranges.filter((r) => r.endUs > r.startUs).sort((a, b) => a.startUs - b.startUs);
  const out: UsRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startUs <= last.endUs) last.endUs = Math.max(last.endUs, r.endUs);
    else out.push({ ...r });
  }
  return out;
}

/** `[fromUs, toUs)` minus `ranges` (which must be normalized). */
function complement(ranges: readonly UsRange[], fromUs: Us, toUs: Us): UsRange[] {
  const out: UsRange[] = [];
  let at = fromUs;
  for (const r of ranges) {
    if (r.endUs <= at) continue;
    if (r.startUs >= toUs) break;
    if (r.startUs > at) out.push({ startUs: at, endUs: r.startUs });
    at = Math.max(at, r.endUs);
  }
  if (at < toUs) out.push({ startUs: at, endUs: toUs });
  return out;
}

/** Intersection of two normalized range lists. */
function intersect(a: readonly UsRange[], b: readonly UsRange[]): UsRange[] {
  const out: UsRange[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const x = a[i];
    const y = b[j];
    if (!x || !y) break;
    const startUs = Math.max(x.startUs, y.startUs);
    const endUs = Math.min(x.endUs, y.endUs);
    if (endUs > startUs) out.push({ startUs, endUs });
    if (x.endUs < y.endUs) i++;
    else j++;
  }
  return out;
}

/** Where one audio track makes sound on the timeline (normalized). */
function trackSound(
  doc: ProjectV1,
  track: AudioTrack,
  quietByMedia: ReadonlyMap<string, readonly UsRange[]>,
): UsRange[] {
  const media = new Map(doc.media.map((m) => [m.id, m]));
  const sound: UsRange[] = [];
  for (const clip of track.clips) {
    const m = media.get(clip.mediaId);
    if (!m) continue;
    const covered = clipCoverage(clip, m);
    if (!covered) continue;
    const quiet = quietByMedia.get(clip.mediaId);
    if (!quiet) {
      sound.push(covered);
      continue;
    }
    const toTimeline = (fileUs: Us) =>
      clip.timelineStartUs + (fileToRefUs(m, fileUs) - clip.sourceStartUs);
    const quietOnTimeline = normalizeRanges(
      quiet.map((r) => ({ startUs: toTimeline(r.startUs), endUs: toTimeline(r.endUs) })),
    );
    sound.push(...complement(quietOnTimeline, covered.startUs, covered.endUs));
  }
  return normalizeRanges(sound);
}

/**
 * Pauses on the timeline: time where every audible audio track is quiet, at least
 * `minDurationUs` long, shrunk by `padUs` where they touch sound. Empty when no audio track is
 * audible (there is nothing to judge by).
 */
export function quietRangesOnTimeline(
  doc: ProjectV1,
  quietByMedia: ReadonlyMap<string, readonly UsRange[]>,
  options: QuietOptions,
): UsRange[] {
  const endUs = timelineDurationUs(doc);
  const tracks = doc.timeline.tracks.filter(
    (t): t is AudioTrack => t.type === 'audio' && isTrackAudible(doc, t),
  );
  if (endUs === 0 || tracks.length === 0) return [];
  let quiet: UsRange[] = [{ startUs: 0, endUs }];
  for (const track of tracks) {
    quiet = intersect(quiet, complement(trackSound(doc, track, quietByMedia), 0, endUs));
  }
  const out: UsRange[] = [];
  for (const r of quiet) {
    if (r.endUs - r.startUs < options.minDurationUs) continue;
    const startUs = r.startUs === 0 ? 0 : r.startUs + options.padUs;
    const end = r.endUs === endUs ? endUs : r.endUs - options.padUs;
    if (end > startUs) out.push({ startUs, endUs: end });
  }
  return out;
}
