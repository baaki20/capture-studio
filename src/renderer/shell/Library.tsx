import { useCallback, useEffect, useState } from 'react';
import type { InvokeResponse } from '../../shared/ipc/contract';
import { ipcErrorMessage } from '../../shared/ipc/errors';
import styles from './Library.module.css';

type Entry = InvokeResponse<'library.list'>[number];

const BADGE_LABELS: Record<Entry['components'][number], string> = {
  screen: 'Screen',
  face: 'Face',
  voice: 'Voice',
  system: 'System',
};

function formatDuration(us: number): string {
  const total = Math.round(us / 1_000_000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)}:${mm}:${ss}` : `${mm}:${ss}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The project library (R1.27): list, open in the editor, rename, move to trash, reveal, open the
 * folder, and import an existing `.cstudio` folder (main shows the folder dialog).
 */
export function Library() {
  const api = window.captureStudio;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [imported, setImported] = useState<string | null>(null);

  const load = useCallback(() => {
    api.library.list().then(
      (list) => {
        setEntries(list);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [api]);

  useEffect(() => {
    load();
    return api.library.onChanged(load);
  }, [api, load]);

  const act = (task: Promise<unknown>) => {
    task.then(load, (e: unknown) => setError(errorText(e)));
  };

  const importProject = () => {
    setImported(null);
    api.library.import().then(
      (entry) => {
        if (!entry) return;
        setError(null);
        setImported(entry.name);
        load();
      },
      (e: unknown) => setError(ipcErrorMessage(e)),
    );
  };

  const submitRename = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    setRenaming(null);
    if (name) act(api.library.rename(renaming.id, name));
  };

  return (
    <section className={styles.page} aria-labelledby="library-title">
      <header className={styles.header}>
        <h2 id="library-title">Library</h2>
        <span className={styles.headerActions}>
          <button type="button" onClick={importProject} data-testid="library-import">
            Import…
          </button>
          <button type="button" onClick={() => act(api.library.openFolder())}>
            Open folder
          </button>
        </span>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {imported ? (
        <p role="status" className={styles.muted}>
          Imported “{imported}”.
        </p>
      ) : null}
      {!entries ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p className={styles.muted}>No recordings yet.</p>
      ) : (
        <ul className={styles.list} data-testid="library-list">
          {entries.map((entry) => (
            <li key={entry.id} className={styles.item}>
              <div className={styles.thumb}>
                {entry.thumbUrl ? (
                  <img src={entry.thumbUrl} alt="" loading="lazy" data-testid="library-thumb" />
                ) : null}
              </div>
              <div className={styles.main}>
                {renaming?.id === entry.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitRename();
                    }}
                  >
                    <input
                      aria-label="New name"
                      value={renaming.name}
                      maxLength={200}
                      autoFocus
                      onChange={(e) => setRenaming({ id: entry.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  </form>
                ) : (
                  <span className={styles.name}>{entry.name}</span>
                )}
                <span className={styles.muted}>
                  {new Date(entry.createdAt).toLocaleString()} · {formatDuration(entry.durationUs)}
                  {entry.state !== 'complete' ? ` · ${entry.state}` : ''}
                </span>
                <span className={styles.badges}>
                  {entry.components.map((c) => (
                    <span key={c} className={styles.badge}>
                      {BADGE_LABELS[c]}
                    </span>
                  ))}
                </span>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={entry.state === 'recording' || entry.state === 'finalizing'}
                  onClick={() => act(api.project.edit(entry.id))}
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming({ id: entry.id, name: entry.name })}
                >
                  Rename
                </button>
                <button type="button" onClick={() => act(api.library.reveal(entry.id))}>
                  Reveal
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Move “${entry.name}” to the trash?`)) {
                      act(api.library.trash(entry.id));
                    }
                  }}
                >
                  Move to trash
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
