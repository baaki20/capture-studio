/**
 * Property tests (fast-check, §4.6.1) for the timeline operations: invariants after any sequence
 * of operations, sync preservation through `cutRange`, and split + delete-left ≡ trim.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkProjectInvariants } from '../../src/shared/project/invariants';
import { ProjectV1Schema, type ProjectV1 } from '../../src/shared/project/schema';
import {
  applyOp,
  clipDurationUs,
  clipEndUs,
  cutRange,
  deleteClips,
  mapTimeThroughCut,
  refTimeAt,
  split,
  timelineDurationUs,
  trim,
} from '../../src/shared/project/timeline-ops';
import { frameDurationUs } from '../../src/shared/time';
import {
  arbOpTemplate,
  arbRecordedProject,
  counterIds,
  resolveOp,
} from '../fixtures/editor-project';

const RUNS = { numRuns: 150 };

/** Replaces clip and link IDs by their order of appearance, so documents compare by content. */
function canonical(doc: ProjectV1) {
  const clipIds = new Map<string, string>();
  const linkIds = new Map<string, string>();
  const name = (map: Map<string, string>, id: string) => {
    if (!map.has(id)) map.set(id, `#${String(map.size)}`);
    return map.get(id);
  };
  return {
    ...doc,
    timeline: {
      ...doc.timeline,
      tracks: doc.timeline.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({
          ...c,
          id: name(clipIds, c.id),
          linkId: c.linkId === null ? null : name(linkIds, c.linkId),
        })),
      })),
    },
  };
}

describe('timeline operations (properties)', () => {
  it('every operation keeps every invariant and never mutates its input', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.array(arbOpTemplate, { minLength: 1, maxLength: 25 }),
        (initial, templates) => {
          const generateId = counterIds('P');
          let doc = initial;
          for (const template of templates) {
            const op = resolveOp(doc, template);
            const before = JSON.stringify(doc);
            const result = applyOp(doc, op, { generateId });
            expect(JSON.stringify(doc)).toBe(before);
            if (!result.ok) {
              expect(result.error.code).not.toBe('invariant');
              continue;
            }
            doc = result.value;
            expect(checkProjectInvariants(doc)).toEqual([]);
          }
          expect(ProjectV1Schema.safeParse(doc).success).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('cutRange keeps the session-time correspondence between tracks', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 5, maxLength: 20 }),
        (doc, x, y, samples) => {
          const duration = timelineDurationUs(doc);
          const a = Math.round(Math.min(x, y) * duration);
          const b = Math.max(a + 1, Math.round(Math.max(x, y) * duration));
          const result = cutRange(doc, { inUs: a, outUs: b }, { generateId: counterIds('C') });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const next = result.value;
          expect(timelineDurationUs(next)).toBeLessThanOrEqual(
            duration - Math.min(b, duration) + a,
          );
          for (const f of samples) {
            const t = Math.round(f * duration);
            if (t >= a && t < b) continue;
            const mapped = mapTimeThroughCut(t, a, b);
            doc.timeline.tracks.forEach((track, i) => {
              const after = refTimeAt(next.timeline.tracks[i]!, mapped);
              const before = refTimeAt(track, t);
              // Content after the cut is the same session instant as before (slivers shorter
              // than a frame may be dropped, which leaves a gap, never different content).
              if (after !== null) expect(after).toBe(before);
              // Removed time shifts every track by the same amount: the shift is b − a after b.
              if (t >= b) expect(mapped).toBe(t - (b - a));
            });
          }
        },
      ),
      RUNS,
    );
  });

  it('split then delete-left equals trim-start', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        (doc, pick, where, includeLinked) => {
          const clips = doc.timeline.tracks.flatMap((t) => t.clips);
          const clip = clips[Math.floor(pick * clips.length)];
          if (!clip) return;
          const min = frameDurationUs(doc.timeline.frameRate);
          const span = clipDurationUs(clip) - 2 * min;
          if (span < 0) return;
          const at = clip.timelineStartUs + min + Math.round(where * span);
          const viaSplit = split(
            doc,
            { atUs: at, clipIds: [clip.id], includeLinked },
            { generateId: counterIds('S') },
          );
          expect(viaSplit.ok).toBe(true);
          if (!viaSplit.ok) return;
          const deleted = deleteClips(viaSplit.value, { clipIds: [clip.id], includeLinked });
          const viaTrim = trim(doc, { clipId: clip.id, edge: 'start', toUs: at, includeLinked });
          expect(deleted.ok && viaTrim.ok).toBe(true);
          if (!deleted.ok || !viaTrim.ok) return;
          // Links differ only in naming once both sides are canonical; an unlinked sibling may
          // keep or lose a link that has a single member, which is the same state.
          expect(canonical(deleted.value)).toEqual(canonical(viaTrim.value));
        },
      ),
      RUNS,
    );
  });

  it('split preserves the content at every time', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 5, maxLength: 20 }),
        (doc, where, samples) => {
          const duration = timelineDurationUs(doc);
          const result = split(
            doc,
            { atUs: Math.round(where * duration) },
            { generateId: counterIds('S') },
          );
          if (!result.ok) return;
          for (const f of samples) {
            const t = Math.round(f * duration);
            doc.timeline.tracks.forEach((track, i) => {
              expect(refTimeAt(result.value.timeline.tracks[i]!, t)).toBe(refTimeAt(track, t));
            });
          }
          expect(timelineDurationUs(result.value)).toBe(duration);
          for (const track of result.value.timeline.tracks) {
            for (const c of track.clips)
              expect(clipEndUs(c) - c.timelineStartUs).toBeGreaterThan(0);
          }
        },
      ),
      RUNS,
    );
  });
});
