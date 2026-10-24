import { useEffect, useState } from 'react';
import type { InvokeResponse } from '../../shared/ipc/contract';
import styles from './Recovery.module.css';

type Candidate = InvokeResponse<'recovery.list'>[number];

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${String(Math.round(bytes / 1e6))} MB`;
}

/**
 * "Recover recording" (§4.3.6, R1.21): shown at startup when interrupted recordings exist.
 * Each can be recovered, moved to the trash, or left for later.
 */
export function Recovery() {
  const api = window.captureStudio;
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.recovery.list().then(
      (list) => {
        if (active) setCandidates(list);
      },
      (e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (candidates.length === 0 && !error) return null;

  const act = async (id: string, task: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await task();
      setCandidates((list) => list.filter((c) => c.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog open className={styles.dialog} aria-labelledby="recovery-title" data-testid="recovery">
      <h2 id="recovery-title">Recover recording</h2>
      <p>
        {candidates.length === 1
          ? 'A recording was interrupted before it was saved.'
          : `${String(candidates.length)} recordings were interrupted before they were saved.`}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <ul className={styles.list}>
        {candidates.map((c) => (
          <li key={c.id} className={styles.item}>
            <div>
              <strong>{c.name}</strong>
              <div className={styles.muted}>
                {c.startedAt ? new Date(c.startedAt).toLocaleString() : 'Unknown start'} ·{' '}
                {formatSize(c.sizeBytes)}
              </div>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void act(c.id, () => api.recovery.recover(c.id))}
              >
                {busy === c.id ? 'Recovering…' : 'Recover'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm(`Move “${c.name}” to the trash?`)) {
                    void act(c.id, () => api.recovery.discard(c.id, 'trash'));
                  }
                }}
              >
                Move to trash
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void act(c.id, () => api.recovery.discard(c.id, 'leave'))}
              >
                Not now
              </button>
            </div>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
