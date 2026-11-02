import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { TimelineOpSchema, type ExternalOp } from '../../src/shared/project/op-schema';
import type { z } from 'zod';
import { arbOpTemplate, arbRecordedProject, resolveOp } from '../fixtures/editor-project';

describe('TimelineOpSchema', () => {
  it('describes exactly the operations automation may send', () => {
    expectTypeOf<z.infer<typeof TimelineOpSchema>>().toEqualTypeOf<ExternalOp>();
  });

  it('accepts every operation the editor can produce', () => {
    fc.assert(
      fc.property(arbRecordedProject, arbOpTemplate, (doc, template) => {
        const op = resolveOp(doc, template);
        // The fixture uses placeholder IDs ('clp_none') when a project has no clips; those are
        // still well-formed, so every resolved op must parse.
        const parsed = TimelineOpSchema.safeParse(op);
        expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects replaceDocument, unknown keys and malformed values', () => {
    const bad: unknown[] = [
      { type: 'replaceDocument', doc: {} },
      { type: 'cutRange', inUs: 0, outUs: 10, extra: true },
      { type: 'cutRange', inUs: 1.5, outUs: 10 },
      { type: 'cutRange', inUs: -1, outUs: 10 },
      { type: 'split', atUs: 2 ** 60 },
      { type: 'setGain', trackId: 'trk_A', gainDb: Infinity },
      { type: 'setGain', trackId: 'clp_A', gainDb: 0 },
      { type: 'delete', clipIds: [] },
      { type: 'setLayout', trackId: 'trk_A', layout: { kind: 'overlay' } },
      { type: 'nudge', target: { componentId: 'cmp_A', mediaIds: ['med_A'] }, syncAdjustUs: 0 },
      { type: 'setMarks', inUs: 5 },
      { type: 'eval', code: '1' },
    ];
    for (const op of bad)
      expect(TimelineOpSchema.safeParse(op).success, JSON.stringify(op)).toBe(false);
  });

  it('leaves ranges to the operations, which clamp them', () => {
    expect(
      TimelineOpSchema.safeParse({
        type: 'setLayout',
        trackId: 'trk_A',
        layout: { width: 0.9, centerX: -1 },
      }).success,
    ).toBe(true);
    expect(
      TimelineOpSchema.safeParse({ type: 'setGain', trackId: 'trk_A', gainDb: -200 }).success,
    ).toBe(true);
  });
});
