/**
 * Export dialog state (R1.45, R1.47): phases, own-job filtering, overwrite confirmation, ETA and
 * labels.
 */
import { describe, expect, it } from 'vitest';
import {
  describeEncoder,
  describeQuality,
  describeSize,
  exportReducer,
  formatEta,
  formatPercent,
  initialExportPhase,
  isBusy,
  type ExportPhase,
} from '../../src/renderer/editor/export/export-dialog-state';

const started = (jobId = 'job_1'): ExportPhase =>
  exportReducer(exportReducer(initialExportPhase, { type: 'start' }), {
    type: 'started',
    result: { jobId, status: 'started', path: '/x.mp4', message: null },
  });

describe('export dialog state', () => {
  it('runs start → progress → done for its own job only', () => {
    let phase = started();
    expect(phase).toEqual({ kind: 'running', jobId: 'job_1', fraction: 0, etaSec: null });
    expect(isBusy(phase)).toBe(true);
    phase = exportReducer(phase, {
      type: 'progress',
      event: { jobId: 'job_other', fraction: 0.9, etaSec: 1 },
    });
    expect(phase).toMatchObject({ fraction: 0 });
    phase = exportReducer(phase, {
      type: 'progress',
      event: { jobId: 'job_1', fraction: 0.5, etaSec: 12 },
    });
    expect(phase).toMatchObject({ fraction: 0.5, etaSec: 12 });
    phase = exportReducer(phase, {
      type: 'done',
      event: { jobId: 'job_1', outputName: 'x.mp4', outputPath: '/x.mp4', notice: 'fell back' },
    });
    expect(phase).toEqual({
      kind: 'done',
      jobId: 'job_1',
      outputName: 'x.mp4',
      outputPath: '/x.mp4',
      notice: 'fell back',
    });
    expect(isBusy(phase)).toBe(false);
  });

  it('asks before replacing an existing file (R1.47)', () => {
    const phase = exportReducer(
      { kind: 'starting' },
      {
        type: 'started',
        result: { jobId: null, status: 'exists', path: '/v/Lesson.mp4', message: 'exists' },
      },
    );
    expect(phase).toEqual({ kind: 'confirm-overwrite', path: '/v/Lesson.mp4' });
    expect(exportReducer(phase, { type: 'dismiss' })).toEqual({ kind: 'idle' });
  });

  it('shows blocked starts, failures and cancels as errors', () => {
    expect(
      exportReducer(
        { kind: 'starting' },
        {
          type: 'started',
          result: { jobId: null, status: 'blocked', path: '/x', message: 'Media is missing' },
        },
      ),
    ).toMatchObject({ kind: 'error', message: 'Media is missing', cancelled: false });
    expect(
      exportReducer({ kind: 'starting' }, { type: 'start-failed', message: 'nope' }),
    ).toMatchObject({
      kind: 'error',
      message: 'nope',
    });
    expect(
      exportReducer(started(), {
        type: 'error',
        event: { jobId: 'job_1', message: 'Export cancelled.', cancelled: true },
      }),
    ).toMatchObject({ kind: 'error', cancelled: true });
  });

  it('formats time left and percentages', () => {
    expect(formatEta(null)).toBe('Estimating time left…');
    expect(formatEta(12.4)).toBe('About 12 s left');
    expect(formatEta(65)).toBe('About 1 min 05 s left');
    expect(formatEta(3_725)).toBe('About 1 h 02 min left');
    expect(formatPercent(0.456)).toBe('45 %');
    expect(formatPercent(null)).toBe('0 %');
    expect(formatPercent(1.2)).toBe('100 %');
  });

  it('describes sizes, qualities and encoders', () => {
    expect(describeSize({ width: 1402, height: 922 }, 'canvas')).toBe('1402 × 922');
    expect(describeSize({ width: 1402, height: 922 }, '1080p')).toBe('1642 × 1080');
    expect(describeSize({ width: 2560, height: 1440 }, '720p')).toBe('1280 × 720');
    expect(describeQuality('draft')).toBe('veryfast preset, CRF 28');
    expect(describeQuality('standard')).toBe('medium preset, CRF 21');
    expect(describeQuality('high')).toBe('slow preset, CRF 18');
    const report = { probedAt: '', encoders: [], hardware: null, software: 'libx264' };
    expect(describeEncoder('auto', null)).toMatch(/Checking/);
    expect(describeEncoder('auto', report)).toMatch(/libx264 \(no verified hardware/);
    expect(describeEncoder('auto', { ...report, hardware: 'h264_vaapi' })).toMatch(/h264_vaapi/);
    expect(describeEncoder('software', { ...report, hardware: 'h264_vaapi' })).toBe(
      'libx264 (software)',
    );
  });
});
