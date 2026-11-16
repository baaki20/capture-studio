import { useEffect, useState, type ReactNode } from 'react';
import type { UpdateStatePayload } from '../../shared/ipc/contract';
import { ipcErrorMessage } from '../../shared/ipc/errors';
import type { Settings as SettingsData } from '../../shared/settings/schema';
import { GB, MB, namePreview, parseDiskThresholds } from './settings-form';
import styles from './Settings.module.css';

type Recorder = SettingsData['recorder'];

/** One line about the updater's state (P3 step 9). */
export function updateStatusText(state: UpdateStatePayload): string {
  switch (state.kind) {
    case 'unsupported':
      return state.reason;
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return `Downloading ${state.version}… ${String(state.percent)} %`;
    case 'ready':
      return `Version ${state.version} is ready. It installs when you restart or quit.`;
    case 'up-to-date':
      return 'Capture Studio is up to date.';
    case 'error':
      return `The update check failed: ${state.message}`;
  }
}

/** Updates (P3 step 9): channel, automatic checks, the state and its actions. */
function UpdatesGroup({
  settings,
  onPatch,
}: {
  settings: SettingsData['updates'];
  onPatch: (patch: Partial<SettingsData['updates']>) => void;
}) {
  const api = window.captureStudio;
  const [state, setState] = useState<UpdateStatePayload | null>(null);
  useEffect(() => {
    let active = true;
    void api.updates.status().then((next) => {
      if (active) setState(next);
    });
    const off = api.updates.onChanged(setState);
    return () => {
      active = false;
      off();
    };
  }, [api]);
  const unsupported = state?.kind === 'unsupported';
  return (
    <fieldset className={styles.group}>
      <legend>Updates</legend>
      <Field label="Channel" hint="Pre-releases get new features first and may have rough edges.">
        <select
          aria-label="Update channel"
          value={settings.channel}
          disabled={unsupported}
          onChange={(e) =>
            onPatch({ channel: e.target.value as SettingsData['updates']['channel'] })
          }
        >
          <option value="release">Releases</option>
          <option value="pre-release">Pre-releases</option>
        </select>
      </Field>
      <Field label="Automatic checks">
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={settings.autoCheck}
            disabled={unsupported}
            onChange={(e) => onPatch({ autoCheck: e.target.checked })}
          />
          Check for updates in the background
        </label>
      </Field>
      <Field label="Status">
        <p className={styles.hint} data-testid="update-status" role="status">
          {state ? updateStatusText(state) : 'Loading…'}
        </p>
        {state && !unsupported ? (
          <span className={styles.inline}>
            <button
              type="button"
              disabled={state.kind === 'checking' || state.kind === 'downloading'}
              onClick={() => void api.updates.check().then(setState)}
            >
              Check now
            </button>
            {state.kind === 'ready' ? (
              <button type="button" onClick={() => void api.updates.install()}>
                Restart and update
              </button>
            ) : null}
          </span>
        ) : null}
      </Field>
    </fieldset>
  );
}

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
            <option value="export-gif">Export a small GIF (quick GIF)</option>
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

      <fieldset className={styles.group}>
        <legend>Assistants</legend>
        <Field
          label="Automation"
          hint="Lets AI assistants on this computer (such as Claude Code through the Capture Studio MCP server) open, edit and export your projects. Their edits appear in the editor and can be undone. Diagnostics shows how to connect one."
        >
          <label className={styles.toggle}>
            <input
              type="checkbox"
              data-testid="automation-enabled"
              checked={settings.automation.enabled}
              onChange={(e) =>
                save(api.settings.patch({ automation: { enabled: e.target.checked } }))
              }
            />
            Allow assistants to edit and export projects
          </label>
        </Field>
      </fieldset>

      <UpdatesGroup
        settings={settings.updates}
        onPatch={(updates) => save(api.settings.patch({ updates }))}
      />
    </section>
  );
}
