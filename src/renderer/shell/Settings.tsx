import { useEffect, useState, type ReactNode } from 'react';
import { ipcErrorMessage } from '../../shared/ipc/errors';
import type { Settings as SettingsData } from '../../shared/settings/schema';
import { GB, MB, namePreview, parseDiskThresholds } from './settings-form';
import styles from './Settings.module.css';

type Recorder = SettingsData['recorder'];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>
        {children}
        {hint ? <p className={styles.hint}>{hint}</p> : null}
      </div>
    </div>
  );
}

/**
 * Settings (§2.11 minimal P1 version, finding F-2): after recording (R1.20), minimizing the
 * controls (R1.11), Abort confirmation (R1.12), countdown, the name pattern with a live preview
 * and the projects and exports folders (R1.25; chosen with main's folder dialog, never typed),
 * and the disk thresholds (R1.17). Every change is saved at once.
 */
export function Settings() {
  const api = window.captureStudio;
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pattern, setPattern] = useState('');
  const [warnGb, setWarnGb] = useState('');
  const [stopMb, setStopMb] = useState('');

  const loaded = (next: SettingsData) => {
    setSettings(next);
    setPattern(next.namePattern);
    setWarnGb(String(next.disk.warnBytes / GB));
    setStopMb(String(next.disk.stopBytes / MB));
  };

  useEffect(() => {
    api.settings.get().then(loaded, (e: unknown) => setError(ipcErrorMessage(e)));
  }, [api]);

  const save = (task: Promise<SettingsData | null>) => {
    setError(null);
    setSaved(false);
    task.then(
      (next) => {
        if (!next) return;
        setSettings(next);
        setSaved(true);
      },
      (e: unknown) => setError(ipcErrorMessage(e)),
    );
  };
  const patchRecorder = (recorder: Partial<Recorder>) => save(api.settings.patch({ recorder }));

  if (!settings) {
    return (
      <section className={styles.page}>
        {error ? <p role="alert">{error}</p> : <p>Loading…</p>}
      </section>
    );
  }

  const r = settings.recorder;
  const preview = namePreview(pattern, settings.nameIncrement);
  const commitPattern = () => {
    if (!preview) {
      setError('The name pattern cannot be empty.');
      return;
    }
    if (pattern !== settings.namePattern) save(api.settings.patch({ namePattern: pattern }));
  };
  const commitDisk = () => {
    const parsed = parseDiskThresholds(warnGb, stopMb);
    if (typeof parsed === 'string') {
      setError(parsed);
      return;
    }
    if (
      parsed.warnBytes !== settings.disk.warnBytes ||
      parsed.stopBytes !== settings.disk.stopBytes
    ) {
      save(api.settings.patch({ disk: parsed }));
    }
  };

  return (
    <section className={styles.page} aria-labelledby="settings-title" data-testid="settings">
      <header className={styles.header}>
        <h2 id="settings-title">Settings</h2>
        <span className={styles.saved} role="status" aria-live="polite">
          {saved ? 'Saved' : ''}
        </span>
      </header>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}

      <fieldset className={styles.group}>
        <legend>Recording</legend>
        <Field label="After recording">
          <select
            aria-label="After recording"
            value={r.afterRecording}
            onChange={(e) =>
              patchRecorder({ afterRecording: e.target.value as Recorder['afterRecording'] })
            }
          >
            <option value="open-editor">Open the editor</option>
            <option value="show-in-library">Show in the library</option>
          </select>
        </Field>
        <Field
          label="Minimize controls when recording starts"
          hint="Automatic minimizes them when the system cannot keep them out of the recording."
        >
          <select
            aria-label="Minimize controls when recording starts"
            value={r.minimizeControlsOnStart}
            onChange={(e) =>
              patchRecorder({
                minimizeControlsOnStart: e.target.value as Recorder['minimizeControlsOnStart'],
              })
            }
          >
            <option value="auto">Automatic</option>
            <option value="on">Always</option>
            <option value="off">Never</option>
          </select>
        </Field>
        <Field label="Countdown">
          <select
            aria-label="Countdown"
            value={r.countdownSec}
            onChange={(e) =>
              patchRecorder({ countdownSec: Number(e.target.value) as Recorder['countdownSec'] })
            }
          >
            <option value={0}>None</option>
            <option value={3}>3 seconds</option>
            <option value={5}>5 seconds</option>
          </select>
        </Field>
        <Field label="Abort" hint="Applies to the controls window and the tray.">
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={r.confirmAbort}
              onChange={(e) => patchRecorder({ confirmAbort: e.target.checked })}
            />
            Ask before aborting a recording
          </label>
        </Field>
      </fieldset>

      <fieldset className={styles.group}>
        <legend>Projects</legend>
        <Field
          label="Projects folder"
          hint="New recordings go here. Projects already in the old folder stay there; use Library → Import to list them."
        >
          <span className={styles.path} data-testid="projects-dir">
            {settings.projectsDir}
          </span>
          <button type="button" onClick={() => save(api.settings.chooseFolder('projectsDir'))}>
            Change…
          </button>
        </Field>
        <Field label="Exports folder" hint="The default place for exported videos.">
          <span className={styles.path} data-testid="exports-dir">
            {settings.exportsDir}
          </span>
          <button type="button" onClick={() => save(api.settings.chooseFolder('exportsDir'))}>
            Change…
          </button>
        </Field>
        <Field
          label="Name pattern"
          hint="%y year, %mo month, %d day, %h hour, %mi minute, %s second, %ra{N} N random characters, %i counter."
        >
          <form
            className={styles.inline}
            onSubmit={(e) => {
              e.preventDefault();
              commitPattern();
            }}
          >
            <input
              aria-label="Name pattern"
              value={pattern}
              maxLength={200}
              onChange={(e) => setPattern(e.target.value)}
              onBlur={commitPattern}
            />
          </form>
          <p className={styles.hint}>
            Next recording:{' '}
            <strong data-testid="settings-name-preview">{preview ?? '(enter a pattern)'}</strong>
          </p>
        </Field>
      </fieldset>

      <fieldset className={styles.group}>
        <legend>Disk space</legend>
        <Field label="Warn below" hint="While recording, free space is checked every 10 seconds.">
          <span className={styles.inline}>
            <input
              aria-label="Warn below (GB)"
              type="number"
              min={0}
              step={0.1}
              value={warnGb}
              onChange={(e) => setWarnGb(e.target.value)}
              onBlur={commitDisk}
            />
            GB
          </span>
        </Field>
        <Field label="Stop and save below">
          <span className={styles.inline}>
            <input
              aria-label="Stop below (MB)"
              type="number"
              min={0}
              step={50}
              value={stopMb}
              onChange={(e) => setStopMb(e.target.value)}
              onBlur={commitDisk}
            />
            MB
          </span>
        </Field>
      </fieldset>
    </section>
  );
}
