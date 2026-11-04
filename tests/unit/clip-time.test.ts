/**
 * v2 clip timing (`clip-time.ts`): speed and freeze frames, and the edit operations that cut or
 * trim such clips.
 */
import fc from 'fast-check';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import {
  clipHead,
  clipMaxEndUs,
  clipMinStartUs,
  clipRefAt,
  clipSpeed,
  clipTail,
  clipTimeAtRef,
  clipTimelineDurationUs,
  clipWithEnd,
  clipWithStart,
} from '../../src/shared/project/clip-time';
import { checkProjectInvariants } from '../../src/shared/project/invariants';
import { clipCoverage } from '../../src/shared/project/render-plan';
import { ProjectSchema, type Clip, type Project } from '../../src/shared/project/schema';
import {
  applyOp,
  clipEndUs,
  cutRange,
  mapTimeThroughCut,
  refTimeAt,
  split,
  timelineDurationUs,
  trim,
} from '../../src/shared/project/timeline-ops';
import { unwrap } from '../../src/shared/result';
import { frameDurationUs } from '../../src/shared/time';
import {
  arbOpTemplate,
  arbRecordedProject,
  counterIds,
  recordedProject,
  resolveOp,
  trackByName,
} from '../fixtures/editor-project';

const S = 1_000_000;

function clip(fields: Partial<Clip> = {}): Clip {
  return {
    id: 'clp_A',
    mediaId: 'med_A',
    timelineStartUs: 10 * S,
    sourceStartUs: 100 * S,
    sourceEndUs: 110 * S,
    linkId: null,
    ...fields,
  };
}

/** Sets a speed on every clip; linked clips share a source length, so they get the same one. */
function withSpeed(doc: Project, speedOf: (index: number) => number): Project {
  return produce(doc, (draft) => {
    const byLink = new Map<string, number>();
    let n = 0;
    for (const track of draft.timeline.tracks) {
      let cursor = 0;
      for (const c of track.clips) {
        const speed = c.linkId !== null ? (byLink.get(c.linkId) ?? speedOf(n++)) : speedOf(n++);
        if (c.linkId !== null) byLink.set(c.linkId, speed);
        // Keep the gaps as they were but scale positions so clips cannot overlap.
        c.timelineStartUs = Math.round(c.timelineStartUs * 4);
        c.timelineStartUs = Math.max(c.timelineStartUs, cursor);
        const length = Math.round((c.sourceEndUs - c.sourceStartUs) / speed);
        // Leave clips that would become shorter than a frame at normal speed.
        if (speed !== 1 && length >= frameDurationUs(draft.timeline.frameRate)) {
          c.speed = speed;
          c.durationUs = length;
        }
        cursor = c.timelineStartUs + clipTimelineDurationUs(c);
      }
    }
  });
}

describe('clip timing', () => {
  it('is the Phase 1 mapping when no v2 field is set', () => {
    const c = clip();
    expect(clipSpeed(c)).toBe(1);
    expect(clipTimelineDurationUs(c)).toBe(10 * S);
    expect(clipRefAt(c, 12 * S)).toBe(102 * S);
    expect(clipTimeAtRef(c, 102 * S)).toBe(12 * S);
  });

  it('plays the source at its speed over durationUs', () => {
    const fast = clip({ speed: 2, durationUs: 5 * S });
    expect(clipSpeed(fast)).toBe(2);
    expect(clipTimelineDurationUs(fast)).toBe(5 * S);
    expect(clipRefAt(fast, 12 * S)).toBe(104 * S);
    expect(clipTimeAtRef(fast, 104 * S)).toBe(12 * S);
    const slow = clip({ speed: 0.25, durationUs: 40 * S });
    expect(clipSpeed(slow)).toBe(0.25);
    expect(clipRefAt(slow, 14 * S)).toBe(101 * S);
  });

  it('holds one picture for a freeze frame', () => {
    const still = clip({ sourceEndUs: 100 * S + 33_334, freeze: true, durationUs: 3 * S });
    expect(clipSpeed(still)).toBe(0);
    expect(clipTimelineDurationUs(still)).toBe(3 * S);
    expect(clipRefAt(still, 12 * S)).toBe(100 * S);
    const media = { startOffsetUs: 0, syncAdjustUs: 0, clockRatio: 1, durationUs: 200 * S };
    expect(clipCoverage(still, media)).toEqual({ startUs: 10 * S, endUs: 13 * S });
  });

  it('cuts into a head and a tail that meet exactly on the timeline', () => {
    const c = clip({ speed: 10 / 7, durationUs: 7 * S, fadeInUs: 1, fadeOutUs: 2 });
    const t = 13 * S + 1;
    const head = clipHead(c, t);
    const tail = clipTail(c, t);
    expect(head.timelineStartUs + clipTimelineDurationUs(head)).toBe(t);
    expect(tail.timelineStartUs).toBe(t);
    expect(tail.timelineStartUs + clipTimelineDurationUs(tail)).toBe(17 * S);
    expect(head.sourceEndUs).toBe(tail.sourceStartUs);
    expect(head.fadeInUs).toBe(1);
    expect(head.fadeOutUs).toBeUndefined();
    expect(tail.fadeInUs).toBeUndefined();
    expect(tail.fadeOutUs).toBe(2);
  });

  it('keeps Phase 1 clips free of v2 fields', () => {
    expect(clipHead(clip(), 12 * S)).not.toHaveProperty('durationUs');
    expect(clipTail(clip(), 12 * S)).not.toHaveProperty('durationUs');
    expect(clipWithEnd(clip(), 15 * S)).toEqual(clip({ sourceEndUs: 105 * S }));
    expect(clipWithStart(clip(), 12 * S)).toEqual(
      clip({ timelineStartUs: 12 * S, sourceStartUs: 102 * S }),
    );
  });

  it('does not let rounding add up over many edits', () => {
    let c = clip({ speed: 0.3, durationUs: Math.round((10 * S) / 0.3) });
    for (let i = 0; i < 500; i++) {
      const start = c.timelineStartUs;
      c = clipWithStart(c, start + 7_777 + (i % 13));
      c = clipWithEnd(c, c.timelineStartUs + clipTimelineDurationUs(c) - 3_333);
      c = clipWithStart(c, c.timelineStartUs - 5_555);
      const error = c.sourceEndUs - c.sourceStartUs - c.durationUs! * 0.3;
      expect(Math.abs(error)).toBeLessThanOrEqual(2);
    }
  });

  it('trims at the same speed and stops at the media bounds', () => {
    const c = clip({ speed: 0.5, durationUs: 20 * S });
    expect(clipMaxEndUs(c, 112 * S)).toBe(34 * S);
    expect(clipMinStartUs(c, 99 * S)).toBe(8 * S);
    const longer = clipWithEnd(c, 34 * S);
    expect(longer.sourceEndUs).toBe(112 * S);
    expect(clipSpeed(longer)).toBeCloseTo(0.5, 9);
    const earlier = clipWithStart(c, 8 * S);
    expect(earlier.sourceStartUs).toBe(99 * S);
    expect(clipTimelineDurationUs(earlier)).toBe(22 * S);
  });
});

describe('edit operations on v2 clips', () => {
  function fastFace(doc: Project): Project {
    return produce(doc, (draft) => {
      // Face and Voice share links; give the first linked pair speed 2, the rest of the
      // timeline moves out of the way.
      const face = draft.timeline.tracks.find((t) => t.name === 'Face')!;
      const voice = draft.timeline.tracks.find((t) => t.name === 'Voice')!;
      for (const track of [face, voice]) {
        const first = track.clips[0]!;
        first.speed = 2;
        first.durationUs = (first.sourceEndUs - first.sourceStartUs) / 2;
      }
    });
  }

  it('splits a fast linked pair into pieces that keep their speed and stay in sync', () => {
    const doc = fastFace(recordedProject());
    expect(checkProjectInvariants(doc)).toEqual([]);
    const face = trackByName(doc, 'Face').clips[0]!;
    const result = unwrap(
      split(doc, { atUs: 4 * S, clipIds: [face.id] }, { generateId: counterIds('X') }),
    );
    expect(checkProjectInvariants(result)).toEqual([]);
    const pieces = trackByName(result, 'Face').clips.slice(0, 2);
    expect(pieces.map(clipSpeed)).toEqual([2, 2]);
    expect(refTimeAt(trackByName(result, 'Face'), 4 * S)).toBe(
      refTimeAt(trackByName(doc, 'Face'), 4 * S),
    );
  });

  it('trims a fast clip without breaking its link', () => {
    const doc = fastFace(recordedProject());
    const face = trackByName(doc, 'Face').clips[0]!;
    const result = unwrap(trim(doc, { clipId: face.id, edge: 'end', toUs: 5 * S }));
    expect(checkProjectInvariants(result)).toEqual([]);
    expect(clipEndUs(trackByName(result, 'Voice').clips[0]!)).toBe(5 * S);
  });

  it('keeps every invariant through random edits of projects with speeds', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.array(fc.constantFrom(0.25, 0.5, 1, 1.5, 2, 4), { minLength: 1, maxLength: 12 }),
        fc.array(arbOpTemplate, { minLength: 1, maxLength: 20 }),
        (initial, speeds, templates) => {
          let doc = withSpeed(initial, (i) => speeds[i % speeds.length] ?? 1);
          expect(checkProjectInvariants(doc)).toEqual([]);
          const generateId = counterIds('P');
          for (const template of templates) {
            const result = applyOp(doc, resolveOp(doc, template), { generateId });
            if (!result.ok) {
              expect(result.error.code).not.toBe('invariant');
              continue;
            }
            doc = result.value;
            expect(checkProjectInvariants(doc)).toEqual([]);
          }
          expect(ProjectSchema.safeParse(doc).success).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('cutRange keeps the session-time correspondence with speeds (within 1 µs)', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.constantFrom(0.25, 0.5, 2, 4),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 5, maxLength: 20 }),
        (initial, speed, x, y, samples) => {
          const doc = withSpeed(initial, () => speed);
          const duration = timelineDurationUs(doc);
          const a = Math.round(Math.min(x, y) * duration);
          const b = Math.max(a + 1, Math.round(Math.max(x, y) * duration));
          const next = unwrap(
            cutRange(doc, { inUs: a, outUs: b }, { generateId: counterIds('C') }),
          );
          expect(checkProjectInvariants(next)).toEqual([]);
          for (const f of samples) {
            const t = Math.round(f * duration);
            if (t >= a && t < b) continue;
            const mapped = mapTimeThroughCut(t, a, b);
            doc.timeline.tracks.forEach((track, i) => {
              const after = refTimeAt(next.timeline.tracks[i]!, mapped);
              const before = refTimeAt(track, t);
              if (after !== null && before !== null) {
                expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
              }
            });
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('v2 invariants', () => {
  function base(): Project {
    return recordedProject();
  }

  it('accepts a project using every v2 field', () => {
    const doc = produce(base(), (d) => {
      const screen = d.timeline.tracks[0]!;
      const c = screen.clips[0]!;
      c.gainDb = -3;
      c.transitionIn = { kind: 'dissolve', durationUs: S / 2 };
      const face = d.timeline.tracks.find((t) => t.name === 'Face')!;
      if (face.type === 'video' && face.layout.kind === 'overlay') {
        face.layoutKeyframes = [
          { tUs: 0, mode: 'overlay', layout: face.layout, easing: 'ease-in-out' },
          { tUs: 2 * S, mode: 'full', layout: face.layout, easing: 'hold' },
        ];
      }
      const voice = d.timeline.tracks.find((t) => t.name === 'Voice')!;
      const system = d.timeline.tracks.find((t) => t.name === 'System audio')!;
      if (system.type === 'audio') {
        system.volumeKeyframes = [{ tUs: 0, gainDb: 0, easing: 'linear' }];
        system.cleanup = {
          noise: 'light',
          normalize: true,
          duck: { byTrackId: voice.id, amountDb: -12, attackMs: 20, releaseMs: 300 },
        };
      }
      d.timeline.camera = [
        { tUs: 0, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: 'ease-in-out' },
        { tUs: S, rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, easing: 'hold' },
      ];
      d.timeline.beautify = {
        background: { type: 'gradient', from: '#112233', to: '#445566', angleDeg: 45 },
        padding: 0.05,
        cornerRadius: 0.02,
      };
      d.timeline.markers = [{ id: 'mrk_A', tUs: S, label: 'Intro', chapter: true }];
      d.timeline.objectTracks = [
        {
          id: 'trk_OBJ',
          name: 'Callouts',
          locked: false,
          hidden: false,
          items: [
            {
              id: 'obj_A',
              kind: 'blur',
              inUs: 0,
              outUs: 2 * S,
              box: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
              radius: 0.01,
              keyframes: [
                { tUs: 0, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, easing: 'linear' },
                { tUs: S, box: { x: 0.3, y: 0.1, width: 0.2, height: 0.1 }, easing: 'linear' },
              ],
            },
          ],
        },
      ];
    });
    expect(checkProjectInvariants(doc)).toEqual([]);
    const parsed = ProjectSchema.safeParse(doc);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it.each([
    [
      'source length that does not match the speed',
      'clip-speed',
      (d: Project) => {
        const c = d.timeline.tracks[0]!.clips[0]!;
        c.speed = 2;
        c.durationUs = c.sourceEndUs - c.sourceStartUs;
      },
    ],
    [
      'speed without a length',
      'clip-speed',
      (d: Project) => {
        d.timeline.tracks[0]!.clips[0]!.speed = 2;
      },
    ],
    [
      'freeze without a length',
      'clip-speed',
      (d: Project) => {
        d.timeline.tracks[0]!.clips[0]!.freeze = true;
      },
    ],
    [
      'transition longer than its clip',
      'transition-length',
      (d: Project) => {
        d.timeline.tracks[0]!.clips[0]!.transitionIn = { kind: 'dissolve', durationUs: 10_000 * S };
      },
    ],
    [
      'linked clips at different speeds',
      'link-mismatch',
      (d: Project) => {
        const face = d.timeline.tracks.find((t) => t.name === 'Face')!.clips[0]!;
        const voice = d.timeline.tracks.find((t) => t.name === 'Voice')!.clips[0]!;
        voice.speed = 2;
        voice.durationUs = face.sourceEndUs - face.sourceStartUs;
        voice.sourceEndUs = voice.sourceStartUs + 2 * voice.durationUs;
      },
    ],
    [
      'unsorted camera keyframes',
      'keyframe-order',
      (d: Project) => {
        const rect = { x: 0, y: 0, width: 1, height: 1 };
        d.timeline.camera = [
          { tUs: S, rect, easing: 'linear' },
          { tUs: 0, rect, easing: 'linear' },
        ];
      },
    ],
    [
      'camera rect outside the canvas',
      'camera-rect',
      (d: Project) => {
        d.timeline.camera = [
          { tUs: 0, rect: { x: 0.8, y: 0, width: 0.5, height: 0.5 }, easing: 'linear' },
        ];
      },
    ],
    [
      'layout keyframes on the screen track',
      'layout-keyframes-track',
      (d: Project) => {
        const screen = d.timeline.tracks[0]!;
        const face = d.timeline.tracks.find((t) => t.name === 'Face')!;
        if (screen.type === 'video' && face.type === 'video' && face.layout.kind === 'overlay') {
          screen.layoutKeyframes = [
            { tUs: 0, mode: 'overlay', layout: face.layout, easing: 'linear' },
          ];
        }
      },
    ],
    [
      'object shorter than a frame',
      'object-range',
      (d: Project) => {
        d.timeline.objectTracks = [
          {
            id: 'trk_OBJ',
            name: 'Objects',
            locked: false,
            hidden: false,
            items: [
              {
                id: 'obj_A',
                kind: 'highlight',
                inUs: S,
                outUs: S + 10,
                box: { x: 0, y: 0, width: 0.1, height: 0.1 },
                color: '#FFFF00',
              },
            ],
          },
        ];
      },
    ],
    [
      'ducking under itself',
      'duck-track',
      (d: Project) => {
        const system = d.timeline.tracks.find((t) => t.name === 'System audio')!;
        if (system.type === 'audio') {
          system.cleanup = {
            noise: 'off',
            normalize: false,
            duck: { byTrackId: system.id, amountDb: -10, attackMs: 10, releaseMs: 100 },
          };
        }
      },
    ],
  ])('rejects %s', (_name, code, mutate) => {
    const doc = produce(base(), (d) => {
      mutate(d);
    });
    expect(checkProjectInvariants(doc).map((v) => v.code)).toContain(code);
  });
});
