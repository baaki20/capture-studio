import { useEffect, useState } from 'react';
import type { EventPayload, InvokeResponse } from '../../shared/ipc/contract';
import styles from './App.module.css';
import { Diagnostics } from './Diagnostics';
import { Library } from './Library';
import { NewRecording } from './NewRecording';
import { Recovery } from './Recovery';
import { Settings } from './Settings';

type WorkerState = 'starting' | 'ok' | 'failed';
type View = 'new' | 'library' | 'settings' | 'diagnostics' | 'about';
type RecState = EventPayload<'rec.state'>;
type Completed = EventPayload<'rec.completed'>;
type LoadNotice = NonNullable<InvokeResponse<'settings.takeLoadNotice'>>;

const VIEWS: readonly { id: View; label: string }[] = [
  { id: 'new', label: 'New recording' },
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'about', label: 'About' },
];

/** Pings the health worker once, which proves the renderer worker build and CSP work. */
function useWorkerHealth(): WorkerState {
  const [state, setState] = useState<WorkerState>('starting');
  useEffect(() => {
    const worker = new Worker(new URL('../common/workers/health.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = () => setState('ok');
    worker.onerror = () => setState('failed');
    worker.postMessage({ type: 'ping' });
    return () => worker.terminate();
  }, []);
  return state;
}

function About() {
  const { versions, platform } = window.captureStudio;
  const workerState = useWorkerHealth();
  return (
    <div className={styles.home}>
      <p className={styles.subtitle}>Phase 1</p>
      <dl className={styles.facts}>
        <dt>Version</dt>
        <dd>{versions.app}</dd>
        <dt>Electron</dt>
        <dd>{versions.electron}</dd>
        <dt>Chromium</dt>
        <dd>{versions.chrome}</dd>
        <dt>Platform</dt>
        <dd>{platform}</dd>
        <dt>Worker</dt>
        <dd data-testid="worker-state">{workerState}</dd>
      </dl>
    </div>
  );
}

/** The recorder's state as the shell sees it, starting from `rec.status`. */
function useRecorderState(): RecState['state'] {
  const api = window.captureStudio;
  const [state, setState] = useState<RecState['state']>('idle');
  useEffect(() => {
    const off = api.rec.onState((payload) => setState(payload.state));
    api.rec.status().then(
      (payload) => setState(payload.state),
      (e: unknown) => console.warn('shell: rec.status failed', e),
    );
    return off;
  }, [api]);
  return state;
}

export function App() {
  const api = window.captureStudio;
  // The setup panel is the default view when idle (R1.2: new-recording opens it).
  const [view, setView] = useState<View>('new');
  const recState = useRecorderState();
  const [completed, setCompleted] = useState<Completed | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<LoadNotice | null>(null);

  // Settings restored from a backup or reset to defaults: told once per launch (R1.50). Main
  // hands the notice to the first call only, so an empty answer must not clear it (React's
  // StrictMode runs this effect twice in development).
  useEffect(() => {
    api.settings.takeLoadNotice().then(
      (notice) => {
        if (notice) setSettingsNotice(notice);
      },
      (e: unknown) => console.warn('shell: settings notice failed', e),
    );
  }, [api]);

  useEffect(() => {
    const offState = api.rec.onState((payload) => {
      // `new-recording` from the tray or the command line opens the setup panel.
      if (payload.state === 'configuring') setView('new');
      if (payload.state === 'acquiring') setCompleted(null);
    });
    const offCompleted = api.rec.onCompleted(setCompleted);
    return () => {
      offState();
      offCompleted();
    };
  }, [api]);

  return (
    <main className={styles.shell}>
      <header className={styles.top}>
        <h1 className={styles.title}>Capture Studio</h1>
        <nav className={styles.nav} aria-label="Sections">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-current={view === v.id ? 'page' : undefined}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </header>
      {settingsNotice ? (
        <div
          className={`${styles.banner ?? ''} ${styles.warning ?? ''}`}
          role="status"
          data-testid="settings-notice"
        >
          <span>{settingsNotice.message}</span>
          <button type="button" onClick={() => setView('settings')}>
            Review settings
          </button>
          <button type="button" aria-label="Dismiss" onClick={() => setSettingsNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
      {recState === 'finalizing' ? (
        <div className={styles.banner} role="status" data-testid="finalizing">
          <span>Saving the recording…</span>
          <progress aria-label="Saving" />
        </div>
      ) : null}
      {completed ? (
        <div className={styles.banner} role="status" data-testid="completion-notice">
          <span>
            Recording saved: <strong>{completed.name}</strong>
          </span>
          <button
            type="button"
            onClick={() => {
              api.project
                .edit(completed.projectId)
                .catch((e: unknown) => console.warn('shell: open editor failed', e));
            }}
          >
            Open in editor
          </button>
          <button
            type="button"
            onClick={() => {
              api.library
                .reveal(completed.projectId)
                .catch((e: unknown) => console.warn('shell: reveal failed', e));
            }}
          >
            Open folder
          </button>
          <button type="button" onClick={() => setView('library')}>
            Show in library
          </button>
          <button type="button" aria-label="Dismiss" onClick={() => setCompleted(null)}>
            ×
          </button>
        </div>
      ) : null}
      {view === 'new' ? (
        <NewRecording recState={recState} />
      ) : view === 'library' ? (
        <Library />
      ) : view === 'settings' ? (
        <Settings />
      ) : view === 'diagnostics' ? (
        <Diagnostics />
      ) : (
        <About />
      )}
      <Recovery />
    </main>
  );
}
