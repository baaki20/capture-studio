import { useEffect, useMemo, useReducer, useState } from 'react';
import {
  DEFAULT_GIF,
  EXPORT_FORMATS,
  EXPORT_PRESETS,
  FORMATS,
  parseAdvancedArgs,
  type ExportFormat,
  type GifOptions,
} from '../../../shared/export/formats';
import type { ExportOptions, InvokeResponse } from '../../../shared/ipc/contract';
import type { EditorPreloadApi } from '../../../shared/ipc/preload-api';
import type { Project } from '../../../shared/project/schema';
import {
  applyPreset,
  describeEncoder,
  describeQuality,
  describeSize,
  exportReducer,
  exportRequestOptions,
  formatControls,
  formatEta,
  formatPercent,
  initialExportPhase,
  isBusy,
  QUALITY_LABELS,
  RESOLUTION_LABELS,
  targetForFormat,
} from './export-dialog-state';
import styles from './ExportDialog.module.css';

export interface ExportDialogProps {
  projectId: string;
  /** The editor's current document: the export uses this snapshot (R1.49). */
  doc: Project;
  /** Called when the user closes the dialog (never while an export runs). */
  onClose: () => void;
  /** The preview's current frame as PNG (base64), for "Save frame"; null when none is shown. */
  captureFrame?: () => Promise<string | null>;
  /** Defaults to `window.csEditor`; tests and stories pass their own. */
  api?: Pick<EditorPreloadApi, 'export' | 'settings'>;
}

type Target = InvokeResponse<'export.target'>;

const RESOLUTIONS: ExportOptions['resolution'][] = ['canvas', '1080p', '720p'];
const QUALITIES: ExportOptions['quality'][] = ['draft', 'standard', 'high'];
const DITHERS: { value: GifOptions['dither']; label: string }[] = [
  { value: 'sierra2_4a', label: 'Sierra (fine, default)' },
  { value: 'floyd_steinberg', label: 'Floyd–Steinberg' },
  { value: 'bayer', label: 'Bayer pattern (smaller files)' },
  { value: 'none', label: 'None (bands on gradients)' },
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Export (R1.45–R1.47, R2.24–R2.28): a preset or a format (MP4, WebM, GIF, audio only) with its
 * options (resolution, frame rate, quality, encoder; GIF frame rate, width, palette and dither),
 * "Require hardware encoder", advanced FFmpeg arguments, and the output file (default
 * `<exports folder>/<project name>.<format's extension>`, "Change…" opens the save dialog), then
 * a progress bar with the time left and Cancel, and when done "Show in folder" and "Open". An
 * existing file is replaced only after the user confirms. "Save frame" writes the preview's
 * current picture as PNG.
 */
export function ExportDialog({
  projectId,
  doc,
  onClose,
  captureFrame,
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
  const [presetId, setPresetId] = useState('custom');
  const [advancedText, setAdvancedText] = useState('');
  const [frameNote, setFrameNote] = useState<string | null>(null);
  const advanced = useMemo(() => parseAdvancedArgs(advancedText), [advancedText]);
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
        options: exportRequestOptions(options, advanced.ok ? advanced.args : null),
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
      const chosen = await api.export.chooseOutput(projectId, format);
      if (chosen) setTarget(chosen);
    } catch (e) {
      setActionError(message(e));
    }
  };

  const act = (task: () => Promise<void>) => {
    setActionError(null);
    task().catch((e: unknown) => setActionError(message(e)));
  };

  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
    setPresetId('custom');
    setOptions((o) => ({ ...o, [key]: value }));
  };
  const setGif = <K extends keyof GifOptions>(key: K, value: GifOptions[K]) => {
    setPresetId('custom');
    setOptions((o) => ({ ...o, gif: { ...(o.gif ?? DEFAULT_GIF), [key]: value } }));
  };
  const choosePreset = (id: string) => {
    setPresetId(id);
    setOptions((o) => applyPreset(o, id));
  };

  const saveFrame = async () => {
    setActionError(null);
    setFrameNote(null);
    try {
      const png = await captureFrame?.();
      if (!png) throw new Error('There is no picture to save.');
      const saved = await api.export.saveFrame(projectId, png);
      if (saved) setFrameNote(`Saved ${saved.path.split(/[\\/]/).pop() ?? 'the frame'}.`);
    } catch (e) {
      setActionError(message(e));
    }
  };

  const format: ExportFormat = options.format ?? 'mp4';
  const controls = formatControls(format);
  const gif = options.gif ?? DEFAULT_GIF;
  const targetPath = target ? targetForFormat(target.path, format) : null;
  const preset = EXPORT_PRESETS.find((p) => p.id === presetId);

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
      <h2 id="export-title">Export</h2>

      <fieldset
        className={styles.fields}
        disabled={phase.kind !== 'idle' && phase.kind !== 'error'}
      >
        <label className={styles.row}>
          <span>Preset</span>
          <select value={presetId} onChange={(e) => choosePreset(e.target.value)}>
            <option value="custom">Custom</option>
            {EXPORT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {preset ? <p className={styles.hint}>{preset.note}</p> : null}
        <label className={styles.row}>
          <span>Format</span>
          <select
            value={format}
            onChange={(e) => {
              const next = e.target.value as ExportFormat;
              setPresetId('custom');
              setOptions((o) => ({
                ...o,
                format: next,
                ...(next === 'gif' && !o.gif ? { gif: DEFAULT_GIF } : {}),
              }));
            }}
          >
            {EXPORT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMATS[f].label}
              </option>
            ))}
          </select>
        </label>
        {controls.resolution ? (
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
        ) : null}
        {controls.quality ? (
          <>
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
          </>
        ) : null}
        {controls.gif ? (
          <>
            <label className={styles.row}>
              <span>GIF frame rate</span>
              <select
                value={String(gif.fps)}
                onChange={(e) => setGif('fps', Number(e.target.value))}
              >
                {[5, 8, 10, 12, 15, 20, 25, 30].map((fps) => (
                  <option key={fps} value={fps}>
                    {fps} fps
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.row}>
              <span>Widest</span>
              <select
                value={String(gif.maxWidth ?? 0)}
                onChange={(e) => {
                  const width = Number(e.target.value);
                  setGif('maxWidth', width > 0 ? width : null);
                }}
              >
                {[320, 480, 640, 800, 960, 1280].map((w) => (
                  <option key={w} value={w}>
                    {w} px
                  </option>
                ))}
                <option value="0">Export size</option>
              </select>
            </label>
            <label className={styles.row}>
              <span>Colours</span>
              <select
                value={String(gif.colors)}
                onChange={(e) => setGif('colors', Number(e.target.value))}
              >
                {[32, 64, 128, 256].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.row}>
              <span>Dither</span>
              <select
                value={gif.dither}
                onChange={(e) => setGif('dither', e.target.value as GifOptions['dither'])}
              >
                {DITHERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        {controls.encoder ? (
          <>
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
            {options.encoder === 'auto' ? (
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={options.requireHardware ?? false}
                  onChange={(e) => set('requireHardware', e.target.checked)}
                />
                <span>Require the hardware encoder (fail instead of using software)</span>
              </label>
            ) : null}
          </>
        ) : null}
        <label className={styles.row}>
          <span>FFmpeg options</span>
          <input
            type="text"
            value={advancedText}
            placeholder="Advanced, e.g. -tune film"
            spellCheck={false}
            aria-invalid={!advanced.ok}
            onChange={(e) => setAdvancedText(e.target.value)}
          />
        </label>
        {!advanced.ok ? (
          <p className={styles.error} role="alert">
            {advanced.message}
          </p>
        ) : null}
        <div className={styles.row}>
          <span>Save to</span>
          <div className={styles.output}>
            <code className={styles.path} title={targetPath ?? undefined}>
              {targetPath ?? '…'}
            </code>
            <button type="button" onClick={() => void choose()}>
              Change…
            </button>
          </div>
        </div>
        {target?.exists && targetPath === target.path ? (
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
      {frameNote ? (
        <p className={styles.hint} role="status">
          {frameNote}
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
            {captureFrame ? (
              <button type="button" onClick={() => void saveFrame()} disabled={busy}>
                Save frame as PNG
              </button>
            ) : null}
            <button type="button" onClick={onClose} disabled={busy}>
              Close
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || phase.kind === 'confirm-overwrite' || !target || !advanced.ok}
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
