import { useEffect, useReducer, useState } from 'react';
import type { ExportOptions, InvokeResponse } from '../../../shared/ipc/contract';
import type { EditorPreloadApi } from '../../../shared/ipc/preload-api';
import type { ProjectV1 } from '../../../shared/project/schema';
import {
  describeEncoder,
  describeQuality,
  describeSize,
  exportReducer,
  formatEta,
  formatPercent,
  initialExportPhase,
  isBusy,
  QUALITY_LABELS,
  RESOLUTION_LABELS,
} from './export-dialog-state';
import styles from './ExportDialog.module.css';

export interface ExportDialogProps {
  projectId: string;
  /** The editor's current document: the export uses this snapshot (R1.49). */
  doc: ProjectV1;
  /** Called when the user closes the dialog (never while an export runs). */
  onClose: () => void;
  /** Defaults to `window.csEditor`; tests and stories pass their own. */
  api?: Pick<EditorPreloadApi, 'export' | 'settings'>;
}

type Target = InvokeResponse<'export.target'>;

const RESOLUTIONS: ExportOptions['resolution'][] = ['canvas', '1080p', '720p'];
const QUALITIES: ExportOptions['quality'][] = ['draft', 'standard', 'high'];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Export to MP4 (R1.45–R1.47): resolution, frame rate, quality and encoder, the output file
 * (default `<exports folder>/<project name>.mp4`, "Change…" opens the save dialog), then a
 * progress bar with the time left and Cancel, and when done "Show in folder" and "Open".
 * An existing file is replaced only after the user confirms.
 */
export function ExportDialog({
  projectId,
  doc,
  onClose,
  api = window.csEditor,
}: ExportDialogProps) {
  const [options, setOptions] = useState<ExportOptions>({
    resolution: 'canvas',
    fps: 'project',
    quality: 'standard',
    encoder: 'auto',
  });
  const [target, setTarget] = useState<Target | null>(null);
  const [encoders, setEncoders] = useState<InvokeResponse<'export.probeEncoders'> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [phase, dispatch] = useReducer(exportReducer, initialExportPhase);
  const busy = isBusy(phase);

  // Defaults from settings, the current target and the encoder probe.
  useEffect(() => {
    let active = true;
    api.settings.get().then(
      (settings) => {
        if (!active) return;
        setOptions((o) => ({
          ...o,
          quality: settings.export.preset,
          encoder: settings.export.encoder,
        }));
      },
      () => undefined,
    );
    api.export.target(projectId).then(
      (t) => {
        if (active) setTarget(t);
      },
      (e: unknown) => {
        if (active) setActionError(message(e));
      },
    );
    api.export.probeEncoders().then(
      (report) => {
        if (active) setEncoders(report);
      },
      () => {
        if (active) setEncoders({ probedAt: '', encoders: [], hardware: null, software: null });
      },
    );
    return () => {
      active = false;
    };
  }, [api, projectId]);

  useEffect(() => {
    const offs = [
      api.export.onProgress((event) => dispatch({ type: 'progress', event })),
      api.export.onDone((event) => dispatch({ type: 'done', event })),
      api.export.onError((event) => dispatch({ type: 'error', event })),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [api]);

  // Esc closes the dialog when nothing is running.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const start = async (overwrite: boolean) => {
    setActionError(null);
    dispatch({ type: 'start' });
    try {
      void api.settings
        .patch({ export: { preset: options.quality, encoder: options.encoder } })
        .catch(() => undefined);
      const result = await api.export.start({
        projectId,
        options,
        doc,
        ...(overwrite ? { overwrite: true } : {}),
      });
      dispatch({ type: 'started', result });
    } catch (e) {
      dispatch({ type: 'start-failed', message: message(e) });
    }
  };

  const choose = async () => {
    setActionError(null);
    try {
      const chosen = await api.export.chooseOutput(projectId);
      if (chosen) setTarget(chosen);
    } catch (e) {
      setActionError(message(e));
    }
  };

  const act = (task: () => Promise<void>) => {
    setActionError(null);
    task().catch((e: unknown) => setActionError(message(e)));
  };

  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) =>
    setOptions((o) => ({ ...o, [key]: value }));

  const canvas = doc.timeline.canvas;
  const running = phase.kind === 'running' ? phase : null;

  return (
    <dialog
      open
      className={styles.dialog}
      aria-labelledby="export-title"
      aria-busy={busy}
      data-testid="export-dialog"
    >
      <h2 id="export-title">Export video</h2>

      <fieldset
        className={styles.fields}
        disabled={phase.kind !== 'idle' && phase.kind !== 'error'}
      >
        <label className={styles.row}>
          <span>Resolution</span>
          <select
            value={options.resolution}
            onChange={(e) => set('resolution', e.target.value as ExportOptions['resolution'])}
          >
            {RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {RESOLUTION_LABELS[r]} ({describeSize(canvas, r)})
              </option>
            ))}
          </select>
        </label>
        <label className={styles.row}>
          <span>Frame rate</span>
          <select
            value={String(options.fps)}
            onChange={(e) =>
              set(
                'fps',
                e.target.value === 'project' ? 'project' : e.target.value === '60' ? 60 : 30,
              )
            }
          >
            <option value="project">Project ({String(doc.timeline.frameRate)} fps)</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps</option>
          </select>
        </label>
        <div className={styles.row} role="radiogroup" aria-label="Quality">
          <span>Quality</span>
          <div className={styles.segmented}>
            {QUALITIES.map((q) => (
              <button
                key={q}
                type="button"
                role="radio"
                aria-checked={options.quality === q}
                className={options.quality === q ? styles.selected : undefined}
                onClick={() => set('quality', q)}
              >
                {QUALITY_LABELS[q]}
              </button>
            ))}
          </div>
        </div>
        <p className={styles.hint}>{describeQuality(options.quality)}</p>
        <label className={styles.row}>
          <span>Encoder</span>
          <select
            value={options.encoder}
            onChange={(e) => set('encoder', e.target.value as ExportOptions['encoder'])}
          >
            <option value="auto">Auto</option>
            <option value="software">Software</option>
          </select>
        </label>
        <p className={styles.hint}>{describeEncoder(options.encoder, encoders)}</p>
        <div className={styles.row}>
          <span>Save to</span>
          <div className={styles.output}>
            <code className={styles.path} title={target?.path}>
              {target?.path ?? '…'}
            </code>
            <button type="button" onClick={() => void choose()}>
              Change…
            </button>
          </div>
        </div>
        {target?.exists ? (
          <p className={styles.hint}>This file exists. You will be asked before it is replaced.</p>
        ) : null}
      </fieldset>

      {phase.kind === 'confirm-overwrite' ? (
        <div className={styles.confirm} role="alertdialog" aria-label="Replace file">
          <p>
            <strong>{phase.path.split(/[\\/]/).pop()}</strong> already exists. Replace it?
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={() => dispatch({ type: 'dismiss' })}>
              Keep it
            </button>
            <button type="button" className={styles.primary} onClick={() => void start(true)}>
              Replace
            </button>
          </div>
        </div>
      ) : null}

      {running || phase.kind === 'starting' ? (
        <div className={styles.progress}>
          <progress
            max={1}
            value={running?.fraction ?? 0}
            aria-label="Export progress"
            aria-valuetext={formatPercent(running?.fraction ?? 0)}
          />
          <div className={styles.progressText}>
            <span>{formatPercent(running?.fraction ?? 0)}</span>
            <span>{running ? formatEta(running.etaSec) : 'Starting…'}</span>
          </div>
        </div>
      ) : null}

      {phase.kind === 'done' ? (
        <div className={styles.result} role="status">
          <p>
            Exported <strong>{phase.outputName}</strong>.
          </p>
          {phase.notice ? <p className={styles.notice}>{phase.notice}</p> : null}
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <p className={phase.cancelled ? styles.hint : styles.error} role="alert">
          {phase.message}
        </p>
      ) : null}
      {actionError ? (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      ) : null}

      <div className={styles.actions}>
        {phase.kind === 'done' ? (
          <>
            <button type="button" onClick={() => act(() => api.export.reveal(phase.jobId))}>
              Show in folder
            </button>
            <button type="button" onClick={() => act(() => api.export.open(phase.jobId))}>
              Open
            </button>
            <button type="button" className={styles.primary} onClick={onClose}>
              Close
            </button>
          </>
        ) : running ? (
          <button type="button" onClick={() => void api.export.cancel(running.jobId)}>
            Cancel
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy}>
              Close
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || phase.kind === 'confirm-overwrite' || !target}
              onClick={() => void start(false)}
            >
              {phase.kind === 'error' ? 'Try again' : 'Export'}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
