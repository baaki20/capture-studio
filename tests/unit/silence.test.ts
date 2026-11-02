import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fileToRefUs } from '../../src/shared/project/media-time';
import { PEAK_WINDOW_US } from '../../src/shared/project/peaks';
import type { Media, ProjectV1 } from '../../src/shared/project/schema';
import {
  normalizeRanges,
  quietRangesOnTimeline,
  quietWindows,
  type UsRange,
} from '../../src/shared/project/silence';
import { applyOp, timelineDurationUs } from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { arbRecordedProject, recordedProject, trackByName } from '../fixtures/editor-project';

const S = 1_000_000;
const LOUD = 12_000;
const QUIET = 30; // about −61 dBFS

/** Peaks for `durationUs` of audio: loud except inside `quiet` (file-local µs). */
function peaks(durationUs: number, quiet: UsRange[] = []): Int16Array {
  const pairs = Math.ceil(durationUs / PEAK_WINDOW_US);
  const out = new Int16Array(pairs * 2);
  for (let i = 0; i < pairs; i++) {
    const t = i * PEAK_WINDOW_US;
    const level = quiet.some((r) => t >= r.startUs && t < r.endUs) ? QUIET : LOUD;
    out[i * 2] = -level;
    out[i * 2 + 1] = level;
  }
  return out;
}

function mediaOf(doc: ProjectV1, role: Media['role']): Media {
  const media = doc.media.find((m) => m.role === role);
  if (!media) throw new Error(`no ${role}`);
  return media;
}

/** Timeline time of a file-local instant of `media`, through the track's clip that shows it. */
function onTimeline(doc: ProjectV1, media: Media, fileUs: number): number {
  const ref = fileToRefUs(media, fileUs);
  for (const track of doc.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaId === media.id && ref >= clip.sourceStartUs && ref < clip.sourceEndUs) {
        return clip.timelineStartUs + (ref - clip.sourceStartUs);
      }
    }
  }
  throw new Error('instant is not on the timeline');
}

describe('quietWindows', () => {
  it('finds runs at or below the threshold', () => {
    const p = peaks(1 * S, [
      { startUs: 100_000, endUs: 300_000 },
      { startUs: 900_000, endUs: S },
    ]);
    expect(quietWindows(p, -40)).toEqual([
      { startUs: 100_000, endUs: 300_000 },
      { startUs: 900_000, endUs: S },
    ]);
    expect(quietWindows(p, -100)).toEqual([]);
    expect(quietWindows(p, 0)).toEqual([{ startUs: 0, endUs: S }]);
  });

  it('uses the larger of |min| and |max|', () => {
    const p = new Int16Array([-20_000, 10, -10, 10]);
    expect(quietWindows(p, -40)).toEqual([{ startUs: PEAK_WINDOW_US, endUs: 2 * PEAK_WINDOW_US }]);
  });
});

describe('quietRangesOnTimeline', () => {
  const options = { minDurationUs: 500_000, padUs: 100_000 };

  it('reports a pause only where the mic and system audio are both quiet', () => {
    const doc = recordedProject({ pauses: [] });
    const mic = mediaOf(doc, 'microphone');
    const system = mediaOf(doc, 'system-audio');
    const quiet = new Map([
      [mic.id, quietWindows(peaks(mic.durationUs, [{ startUs: 10 * S, endUs: 14 * S }]), -40)],
      [
        system.id,
        quietWindows(peaks(system.durationUs, [{ startUs: 12 * S, endUs: 30 * S }]), -40),
      ],
    ]);
    const ranges = quietRangesOnTimeline(doc, quiet, options);
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    // Starts where system audio goes quiet, ends where the mic gets loud, each padded.
    expect(range!.startUs).toBeCloseTo(onTimeline(doc, system, 12 * S) + 100_000, -4);
    expect(range!.endUs).toBeCloseTo(onTimeline(doc, mic, 14 * S) - 100_000, -4);
  });

  it('ignores muted tracks and drops short pauses', () => {
    let doc = recordedProject({ pauses: [] });
    const mic = mediaOf(doc, 'microphone');
    const system = mediaOf(doc, 'system-audio');
    doc = unwrap(
      applyOp(doc, { type: 'setMuted', trackId: trackByName(doc, 'System audio').id, muted: true }),
    );
    const quiet = new Map([
      [
        mic.id,
        quietWindows(
          peaks(mic.durationUs, [
            { startUs: 5 * S, endUs: 5.3 * S },
            { startUs: 20 * S, endUs: 22 * S },
          ]),
          -40,
        ),
      ],
      [system.id, quietWindows(peaks(system.durationUs), -40)],
    ]);
    const ranges = quietRangesOnTimeline(doc, quiet, options);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.startUs).toBeCloseTo(onTimeline(doc, mic, 20 * S) + 100_000, -4);
  });

  it('never cuts where peaks are missing', () => {
    const doc = recordedProject({ pauses: [] });
    const system = mediaOf(doc, 'system-audio');
    const quiet = new Map([
      [system.id, quietWindows(peaks(system.durationUs, [{ startUs: 0, endUs: 60 * S }]), -40)],
    ]);
    expect(quietRangesOnTimeline(doc, quiet, options)).toEqual([]);
  });

  it('is empty without audible audio', () => {
    const doc = recordedProject({ mic: false, system: false });
    expect(quietRangesOnTimeline(doc, new Map(), options)).toEqual([]);
  });

  it('gives sorted, disjoint ranges inside the timeline that are long enough', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.array(
          fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 1, max: 400 })),
          { maxLength: 8 },
        ),
        (doc, spots) => {
          const quiet = new Map(
            doc.media
              .filter((m) => m.kind === 'audio')
              .map((m) => [
                m.id,
                quietWindows(
                  peaks(
                    m.durationUs,
                    spots.map(([at, len]) => {
                      const startUs = Math.round(at * m.durationUs);
                      return { startUs, endUs: startUs + len * PEAK_WINDOW_US };
                    }),
                  ),
                  -40,
                ),
              ]),
          );
          const ranges = quietRangesOnTimeline(doc, quiet, options);
          const end = timelineDurationUs(doc);
          expect(normalizeRanges(ranges)).toEqual(ranges);
          for (const [i, r] of ranges.entries()) {
            expect(r.startUs).toBeGreaterThanOrEqual(0);
            expect(r.endUs).toBeLessThanOrEqual(end);
            expect(r.endUs - r.startUs).toBeGreaterThan(0);
            expect(r.endUs - r.startUs).toBeGreaterThanOrEqual(
              options.minDurationUs - 2 * options.padUs,
            );
            if (i > 0) expect(r.startUs).toBeGreaterThan(ranges[i - 1]!.endUs);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
