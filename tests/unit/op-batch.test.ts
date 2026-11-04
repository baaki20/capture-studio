import fc from 'fast-check';
import { applyPatches } from 'immer';
import { describe, expect, it } from 'vitest';
import {
  applyOp,
  applyOpsWithPatches,
  type TimelineOp,
} from '../../src/shared/project/timeline-ops';
import type { ProjectV1 } from '../../src/shared/project/schema';
import {
  arbOpTemplate,
  arbRecordedProject,
  counterIds,
  recordedProject,
  resolveOp,
  trackByName,
} from '../fixtures/editor-project';

const S = 1_000_000;

/** Resolves templates one after another, each against the document the previous ones produce. */
function resolveSequence(doc: ProjectV1, templates: Parameters<typeof resolveOp>[1][]) {
  const generateId = counterIds('Q');
  const ops: TimelineOp[] = [];
  let current = doc;
  for (const template of templates) {
    const op = resolveOp(current, template);
    const result = applyOp(current, op, { generateId });
    if (!result.ok) continue;
    ops.push(op);
    current = result.value;
  }
  return ops;
}

describe('applyOpsWithPatches', () => {
  it('equals applying the operations one by one, and one inverse restores the input', () => {
    fc.assert(
      fc.property(
        arbRecordedProject,
        fc.array(arbOpTemplate, { minLength: 1, maxLength: 12 }),
        (doc, templates) => {
          const ops = resolveSequence(doc, templates);
          const batch = applyOpsWithPatches(doc, ops, { generateId: counterIds('Q') });
          expect(batch.ok).toBe(true);
          if (!batch.ok) return;

          const generateId = counterIds('Q');
          let sequential = doc;
          for (const op of ops) {
            const result = applyOp(sequential, op, { generateId });
            if (result.ok) sequential = result.value;
          }
          expect(batch.value.doc).toEqual(sequential);
          expect(applyPatches(doc, batch.value.patches)).toEqual(batch.value.doc);
          expect(applyPatches(batch.value.doc, batch.value.inversePatches)).toEqual(doc);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('is all or nothing: a failing operation leaves the input and names its index', () => {
    const doc = recordedProject();
    const voice = trackByName(doc, 'Voice');
    const before = JSON.stringify(doc);
    const result = applyOpsWithPatches(doc, [
      { type: 'cutRange', inUs: 0, outUs: 2 * S },
      { type: 'setGain', trackId: voice.id, gainDb: -6 },
      { type: 'setHidden', trackId: voice.id, hidden: true },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'wrong-track-type', index: 2 });
    expect(result.error.message).toMatch(/^operation 3 \(setHidden\): /);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('returns the same document and no patches when nothing changes', () => {
    const doc = recordedProject();
    const voice = trackByName(doc, 'Voice');
    const result = applyOpsWithPatches(doc, [
      { type: 'setGain', trackId: voice.id, gainDb: 0 },
      { type: 'setMuted', trackId: voice.id, muted: false },
    ]);
    expect(result.ok && result.value.doc).toBe(doc);
    expect(result.ok && result.value.patches).toEqual([]);
  });

  it('an empty batch is a no-op', () => {
    const doc = recordedProject();
    const result = applyOpsWithPatches(doc, []);
    expect(result.ok && result.value.doc).toBe(doc);
  });
});
