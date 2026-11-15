import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  AUTOMATION_MAX_BATCH_OPS,
  AUTOMATION_METHODS,
  AutomationRequestSchema,
  AutomationResponseSchema,
  ChangeSummarySchema,
  isAutomationMethod,
} from '../../src/shared/automation/protocol';
import type { ChangeSummary } from '../../src/shared/project/change-summary';
import { describeChange } from '../../src/shared/project/change-summary';
import { recordedProject } from '../fixtures/editor-project';

const PROJECT = 'prj_01JBQ4ZJ4X6V3K8N2M7P5R9T0W';

describe('automation protocol', () => {
  it('keeps the change summary schema equal to the type', () => {
    expectTypeOf<z.infer<typeof ChangeSummarySchema>>().toEqualTypeOf<ChangeSummary>();
    const doc = recordedProject();
    expect(ChangeSummarySchema.safeParse(describeChange(doc, doc)).success).toBe(true);
  });

  it('lists only known methods, and none that run code or take paths', () => {
    expect(Object.keys(AUTOMATION_METHODS).sort()).toEqual([
      'audio.silences',
      'cursor.autoZoom',
      'export.cancel',
      'export.start',
      'export.status',
      'hello',
      'preview.frame',
      'project.edit',
      'project.get',
      'project.redo',
      'project.undo',
      'projects.list',
    ]);
    expect(isAutomationMethod('project.edit')).toBe(true);
    expect(isAutomationMethod('eval')).toBe(false);
    expect(isAutomationMethod('toString')).toBe(false);
    expect(
      AUTOMATION_METHODS['export.start'].params.safeParse({
        projectId: PROJECT,
        options: { resolution: '720p', fps: 30, quality: 'draft', encoder: 'auto' },
        output: '/tmp/x.mp4',
      }).success,
    ).toBe(false);
  });

  it('validates edit batches', () => {
    const edit = AUTOMATION_METHODS['project.edit'].params;
    const cut = { type: 'cutRange', inUs: 0, outUs: 1_000_000 };
    expect(edit.safeParse({ projectId: PROJECT, label: 'Cut', ops: [cut] }).success).toBe(true);
    expect(edit.safeParse({ projectId: PROJECT, label: 'Cut', ops: [] }).success).toBe(false);
    expect(
      edit.safeParse({
        projectId: PROJECT,
        label: 'Cut',
        ops: Array.from({ length: AUTOMATION_MAX_BATCH_OPS + 1 }, () => cut),
      }).success,
    ).toBe(false);
    expect(
      edit.safeParse({
        projectId: PROJECT,
        label: 'Swap',
        ops: [{ type: 'replaceDocument', doc: recordedProject() }],
      }).success,
    ).toBe(false);
  });

  it('parses envelopes', () => {
    expect(AutomationRequestSchema.safeParse({ id: 1, method: 'hello', params: {} }).success).toBe(
      true,
    );
    expect(AutomationRequestSchema.safeParse({ id: -1, method: 'hello' }).success).toBe(false);
    expect(
      AutomationResponseSchema.safeParse({
        id: 1,
        ok: false,
        error: { code: 'busy', message: 'the user is dragging a clip' },
      }).success,
    ).toBe(true);
    expect(
      AutomationResponseSchema.safeParse({ id: 1, ok: false, error: { code: 'nope', message: '' } })
        .success,
    ).toBe(false);
  });
});
