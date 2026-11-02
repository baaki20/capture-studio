/**
 * What an edit actually did, by comparing the documents before and after. Several operations
 * clamp silently (trims and moves against neighbours, gain to its range, overlay layouts to the
 * canvas), so automation clients report this instead of what they asked for.
 */
import { usToSeconds } from '../time';
import type { Clip, ProjectV1 } from './schema';
import { timeSummary, type TimeSummary } from './summary';
import { timelineDurationUs } from './timeline-ops';

export interface ChangeSummary {
  changed: boolean;
  duration: { before: TimeSummary; after: TimeSummary; deltaSeconds: number };
  clips: { added: string[]; removed: string[]; changed: string[] };
  /** One readable line per change, e.g. `Track "Voice": gainDb -3 → 0`. */
  lines: string[];
}

function show(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'number') return String(Number(value.toFixed(4)));
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function signedSeconds(seconds: number): string {
  const rounded = Number(seconds.toFixed(3));
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${String(Math.abs(rounded))} s`;
}

function clipsById(doc: ProjectV1): Map<string, { trackId: string; clip: Clip }> {
  const map = new Map<string, { trackId: string; clip: Clip }>();
  for (const track of doc.timeline.tracks) {
    for (const clip of track.clips) map.set(clip.id, { trackId: track.id, clip });
  }
  return map;
}

const TRACK_FIELDS = ['name', 'locked', 'hidden', 'gainDb', 'muted', 'solo'] as const;

export function describeChange(before: ProjectV1, after: ProjectV1): ChangeSummary {
  const fps = after.timeline.frameRate;
  const durationBefore = timelineDurationUs(before);
  const durationAfter = timelineDurationUs(after);
  const lines: string[] = [];

  if (durationBefore !== durationAfter) {
    lines.push(
      `Duration ${timeSummary(durationBefore, fps).timecode} → ${timeSummary(durationAfter, fps).timecode} (${signedSeconds(usToSeconds(durationAfter - durationBefore))})`,
    );
  }

  const oldClips = clipsById(before);
  const newClips = clipsById(after);
  const added = [...newClips.keys()].filter((id) => !oldClips.has(id));
  const removed = [...oldClips.keys()].filter((id) => !newClips.has(id));
  const changed = [...newClips].flatMap(([id, now]) => {
    const was = oldClips.get(id);
    return was && (was.trackId !== now.trackId || !same(was.clip, now.clip)) ? [id] : [];
  });
  const counts = [
    removed.length > 0 ? `${String(removed.length)} removed` : null,
    added.length > 0 ? `${String(added.length)} added` : null,
    changed.length > 0 ? `${String(changed.length)} changed` : null,
  ].filter((part) => part !== null);
  if (counts.length > 0) lines.push(`Clips: ${counts.join(', ')}`);

  const oldTracks = new Map(before.timeline.tracks.map((t) => [t.id, t]));
  for (const track of after.timeline.tracks) {
    const was = oldTracks.get(track.id);
    if (!was) continue;
    const label = `Track "${track.name}"`;
    for (const field of TRACK_FIELDS) {
      const a: unknown = (was as Record<string, unknown>)[field];
      const b: unknown = (track as Record<string, unknown>)[field];
      if (!same(a, b)) lines.push(`${label}: ${field} ${show(a)} → ${show(b)}`);
    }
    if (was.type === 'video' && track.type === 'video') {
      const keys = new Set([...Object.keys(was.layout), ...Object.keys(track.layout)]);
      for (const key of keys) {
        const a: unknown = (was.layout as Record<string, unknown>)[key];
        const b: unknown = (track.layout as Record<string, unknown>)[key];
        if (!same(a, b)) lines.push(`${label}: layout.${key} ${show(a)} → ${show(b)}`);
      }
    }
  }

  const marksBefore = before.timeline.marks;
  const marksAfter = after.timeline.marks;
  for (const key of ['inUs', 'outUs'] as const) {
    const a = marksBefore[key];
    const b = marksAfter[key];
    if (a !== b) {
      const fmt = (us: number | null) => (us === null ? 'none' : timeSummary(us, fps).timecode);
      lines.push(`Mark ${key === 'inUs' ? 'In' : 'Out'}: ${fmt(a)} → ${fmt(b)}`);
    }
  }

  const oldMedia = new Map(before.media.map((m) => [m.id, m]));
  for (const media of after.media) {
    const was = oldMedia.get(media.id);
    if (was && was.syncAdjustUs !== media.syncAdjustUs) {
      lines.push(
        `Sync ${media.role} (${media.id}): ${show(was.syncAdjustUs / 1000)} ms → ${show(media.syncAdjustUs / 1000)} ms`,
      );
    }
  }

  return {
    changed: lines.length > 0,
    duration: {
      before: timeSummary(durationBefore, fps),
      after: timeSummary(durationAfter, fps),
      deltaSeconds: usToSeconds(durationAfter - durationBefore),
    },
    clips: { added, removed, changed },
    lines,
  };
}
