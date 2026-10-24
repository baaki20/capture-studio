import { useEffect, useState } from 'react';
import { CAPABILITY_KEYS } from '../../shared/capabilities/keys';
import type { DiagnosticsReport } from '../../shared/ipc/contract';
import styles from './Diagnostics.module.css';

type CopyState = 'idle' | 'copied' | 'failed';

/** Settings → Diagnostics (R1.1, R1.4): capabilities, versions, paths and shortcut commands. */
export function Diagnostics() {
  const api = window.captureStudio;
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<CopyState>('idle');

  // Loads the report now and again whenever capabilities change (a refresh broadcasts
  // `caps.changed`, and so does the encoder probe finishing).
  useEffect(() => {
    let active = true;
    const load = (): void => {
      api.diag.get().then(
        (next) => {
          if (!active) return;
          setReport(next);
          setError(null);
        },
        (e: unknown) => {
          if (active) setError(e instanceof Error ? e.message : String(e));
        },
      );
    };
    load();
    const off = api.caps.onChanged(load);
    return () => {
      active = false;
      off();
    };
  }, [api]);

  const refresh = async () => {
    setBusy(true);
    try {
      await api.caps.refresh();
    } finally {
      setBusy(false);
    }
  };

  const copyReport = async () => {
    try {
      await api.diag.copyReport();
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
    setTimeout(() => setCopy('idle'), 2000);
  };

  if (error) return <p role="alert">Diagnostics could not be loaded: {error}</p>;
  if (!report) return <p>Loading diagnostics…</p>;

  const { versions, paths, capabilities } = report;
  return (
    <section className={styles.page} aria-labelledby="diag-title">
      <header className={styles.header}>
        <h2 id="diag-title">Diagnostics</h2>
        <div className={styles.actions}>
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Checking…' : 'Check again'}
          </button>
          <button type="button" onClick={() => void copyReport()} data-testid="copy-report">
            {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy report'}
          </button>
        </div>
      </header>

      <h3>Versions</h3>
      <dl className={styles.facts}>
        <dt>Capture Studio</dt>
        <dd>{versions.app}</dd>
        <dt>Electron</dt>
        <dd>{versions.electron}</dd>
        <dt>Chromium</dt>
        <dd>{versions.chrome}</dd>
        <dt>Node</dt>
        <dd>{versions.node}</dd>
        <dt>FFmpeg</dt>
        <dd data-testid="ffmpeg-version">
          {versions.ffmpeg ?? `unavailable${report.ffmpegError ? ` (${report.ffmpegError})` : ''}`}
        </dd>
        <dt>Session</dt>
        <dd>
          {capabilities.platform} · {capabilities.session.type ?? '–'} ·{' '}
          {capabilities.session.desktop ?? '–'} · {capabilities.session.ozonePlatform ?? '–'}
        </dd>
        <dt>Secrets</dt>
        <dd>
          {report.secrets.backend} ({report.secrets.persistent ? 'persistent' : 'session only'})
        </dd>
      </dl>

      <h3>Paths</h3>
      <dl className={styles.facts}>
        <dt>FFmpeg</dt>
        <dd className={styles.path}>{paths.ffmpeg ?? '–'}</dd>
        <dt>ffprobe</dt>
        <dd className={styles.path}>{paths.ffprobe ?? '–'}</dd>
        <dt>Log file</dt>
        <dd className={styles.path} data-testid="log-path">
          {paths.logFile}
        </dd>
        <dt>Projects</dt>
        <dd className={styles.path}>{paths.projectsDir}</dd>
      </dl>

      <h3>Encoders</h3>
      {report.encoders ? (
        <ul className={styles.list}>
          {report.encoders.encoders.map((e) => (
            <li key={e.name}>
              <code>{e.name}</code> ({e.kind}):{' '}
              {e.works
                ? 'works'
                : e.listed
                  ? `fails – ${e.error ?? 'unknown error'}`
                  : 'not in this build'}
            </li>
          ))}
          <li>
            Export uses{' '}
            <code>{report.encoders.hardware ?? report.encoders.software ?? 'none'}</code>
          </li>
        </ul>
      ) : (
        <p className={styles.muted}>Probing FFmpeg encoders…</p>
      )}

      <h3>Keyboard shortcuts</h3>
      <p className={styles.muted}>
        Global shortcuts are not available on this desktop. In GNOME Settings → Keyboard → Custom
        Shortcuts, add a shortcut with one of these commands:
      </p>
      <table className={styles.table}>
        <tbody>
          {report.shortcuts.map((s) => (
            <tr key={s.action}>
              <th scope="row">{s.label}</th>
              <td>
                <code className={styles.command} data-testid={`shortcut-${s.action}`}>
                  {s.command}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Capabilities</h3>
      <table className={styles.table} data-testid="capabilities">
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col">State</th>
            <th scope="col">Strategy</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {CAPABILITY_KEYS.map((key) => {
            const c = capabilities.capabilities[key];
            return (
              <tr key={key}>
                <th scope="row">
                  <code>{key}</code>
                </th>
                <td>
                  <span className={`${styles.state} ${styles[c.state]}`}>{c.state}</span>
                </td>
                <td>{c.strategy ?? '–'}</td>
                <td>{c.reason}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
