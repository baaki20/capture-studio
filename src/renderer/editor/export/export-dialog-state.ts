/**
 * State of the export dialog (R1.45, R1.47), kept free of React so it can be unit-tested.
 *
 * Phases: `idle` (choosing options) → `starting` → `confirm-overwrite` (the target exists) or
 * `running` → `done` | `error`. Progress, done and error events only count for the dialog's own
 * job id.
 */
import type { EventPayload, ExportOptions, InvokeResponse } from '../../../shared/ipc/contract';
import {
  DEFAULT_GIF,
  EXPORT_PRESETS,
  FORMATS,
  type ExportFormat,
} from '../../../shared/export/formats';
import { exportSize, QUALITY_SETTINGS } from '../../../shared/export/presets';

export type ExportPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'confirm-overwrite'; path: string }
  | { kind: 'running'; jobId: string; fraction: number | null; etaSec: number | null }
  | {
      kind: 'done';
      jobId: string;
      outputName: string;
      outputPath: string | null;
      notice: string | null;
    }
  | { kind: 'error'; message: string; cancelled: boolean; jobId: string | null };

export type ExportAction =
  | { type: 'start' }
  | { type: 'started'; result: InvokeResponse<'export.start'> }
  | { type: 'start-failed'; message: string }
  | { type: 'dismiss' }
  | { type: 'progress'; event: EventPayload<'export.progress'> }
  | { type: 'done'; event: EventPayload<'export.done'> }
  | { type: 'error'; event: EventPayload<'export.error'> };

export const initialExportPhase: ExportPhase = { kind: 'idle' };

function jobOf(phase: ExportPhase): string | null {
  return phase.kind === 'running' ? phase.jobId : null;
}

export function exportReducer(phase: ExportPhase, action: ExportAction): ExportPhase {
  switch (action.type) {
    case 'start':
      return { kind: 'starting' };
    case 'started': {
      const { result } = action;
      if (result.status === 'started' && result.jobId) {
        return { kind: 'running', jobId: result.jobId, fraction: 0, etaSec: null };
      }
      if (result.status === 'exists') return { kind: 'confirm-overwrite', path: result.path };
      return {
        kind: 'error',
        message: result.message ?? 'The export could not start.',
        cancelled: false,
        jobId: null,
      };
    }
    case 'start-failed':
      return { kind: 'error', message: action.message, cancelled: false, jobId: null };
    case 'dismiss':
      return { kind: 'idle' };
    case 'progress':
      if (jobOf(phase) !== action.event.jobId || phase.kind !== 'running') return phase;
      return { ...phase, fraction: action.event.fraction, etaSec: action.event.etaSec };
    case 'done':
      if (jobOf(phase) !== action.event.jobId) return phase;
      return {
        kind: 'done',
        jobId: action.event.jobId,
        outputName: action.event.outputName,
        outputPath: action.event.outputPath ?? null,
        notice: action.event.notice ?? null,
      };
    case 'error':
      if (jobOf(phase) !== action.event.jobId) return phase;
      return {
        kind: 'error',
        message: action.event.message,
        cancelled: action.event.cancelled,
        jobId: action.event.jobId,
      };
  }
}

/** "about 1 min 05 s left", "about 12 s left", or "estimating…". */
export function formatEta(etaSec: number | null): string {
  if (etaSec === null || !Number.isFinite(etaSec)) return 'Estimating time left…';
  const total = Math.max(0, Math.round(etaSec));
  if (total < 60) return `About ${String(total)} s left`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `About ${String(h)} h ${String(m).padStart(2, '0')} min left`;
  return `About ${String(m)} min ${String(s).padStart(2, '0')} s left`;
}

export function formatPercent(fraction: number | null): string {
  return `${String(Math.floor(Math.min(1, Math.max(0, fraction ?? 0)) * 100))} %`;
}

export const RESOLUTION_LABELS: Record<ExportOptions['resolution'], string> = {
  canvas: 'Canvas',
  '1080p': '1080p',
  '720p': '720p',
};

export const QUALITY_LABELS: Record<ExportOptions['quality'], string> = {
  draft: 'Draft',
  standard: 'Standard',
  high: 'High',
};

/** "1642 × 1080" for a resolution choice on this canvas. */
export function describeSize(
  canvas: { width: number; height: number },
  resolution: ExportOptions['resolution'],
): string {
  const size = exportSize(canvas, resolution);
  return `${String(size.width)} × ${String(size.height)}`;
}

/** "medium preset, CRF 21". */
export function describeQuality(quality: ExportOptions['quality']): string {
  const q = QUALITY_SETTINGS[quality];
  return `${q.preset} preset, CRF ${String(q.crf)}`;
}

/** What "Auto" will use, from the encoder probe. */
export function describeEncoder(
  encoder: ExportOptions['encoder'],
  report: InvokeResponse<'export.probeEncoders'> | null,
): string {
  if (encoder === 'software') return 'libx264 (software)';
  if (!report) return 'Checking hardware encoders…';
  return report.hardware
    ? `${report.hardware} (hardware), libx264 if it fails`
    : 'libx264 (no verified hardware encoder)';
}

export function isBusy(phase: ExportPhase): boolean {
  return phase.kind === 'starting' || phase.kind === 'running';
}

/** The target's file name with the format's extension (main writes there, R2.24). */
export function targetForFormat(file: string, format: ExportFormat): string {
  const extension = FORMATS[format].extension;
  const match = /^(.*[\\/])?([^\\/]*?)(\.[^.\\/]*)?$/.exec(file);
  if (!match) return file;
  const [, dir = '', name = '', ext = ''] = match;
  return ext.toLowerCase() === extension ? file : `${dir}${name}${extension}`;
}

/** Which option groups the dialog shows for a format. */
export function formatControls(format: ExportFormat): {
  resolution: boolean;
  quality: boolean;
  encoder: boolean;
  gif: boolean;
} {
  const info = FORMATS[format];
  return {
    resolution: info.video !== null,
    quality: info.video !== null && info.video !== 'gif',
    encoder: format === 'mp4',
    gif: info.video === 'gif',
  };
}

/** Options with a preset applied; the encoder choice and picture path stay the user's. */
export function applyPreset(options: ExportOptions, presetId: string): ExportOptions {
  const preset = EXPORT_PRESETS.find((p) => p.id === presetId);
  if (!preset) return options;
  const { gif: _gif, ...rest } = options;
  return {
    ...rest,
    ...preset.options,
    ...(preset.options.format === 'gif' ? { gif: preset.options.gif ?? DEFAULT_GIF } : {}),
  };
}

/** The options to send: GIF settings only for GIF, hardware only for MP4, arguments if any. */
export function exportRequestOptions(
  options: ExportOptions,
  advanced: string[] | null,
): ExportOptions {
  const format = options.format ?? 'mp4';
  const { gif, requireHardware, advancedArgs: _a, ...rest } = options;
  return {
    ...rest,
    ...(format === 'gif' ? { gif: gif ?? DEFAULT_GIF } : {}),
    ...(format === 'mp4' && rest.encoder === 'auto' && requireHardware
      ? { requireHardware: true }
      : {}),
    ...(advanced && advanced.length > 0 ? { advancedArgs: advanced } : {}),
  };
}
