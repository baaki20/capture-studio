/**
 * The screen-source picker page (R1.53, D-6): one card per monitor with its thumbnail and name.
 * Click highlights, double-click or Enter records the highlighted screen, Esc cancels. The last
 * choice starts highlighted (main sends it as `initialId`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourcePickerLoad } from '../../shared/ipc/source-picker';
import styles from './SourcePickerApp.module.css';
import { gridColumns, initialIndex, pickerKey } from './selection';

export function SourcePickerApp() {
  const api = window.csSourcePicker;
  const [load, setLoad] = useState<SourcePickerLoad | null>(null);
  const [error, setError] = useState<string | null>(
    api ? null : 'The picker is not connected to the app.',
  );
  const [index, setIndex] = useState(0);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const answered = useRef(false);

  useEffect(() => {
    if (!api) return;
    api.load().then(
      (value) => {
        setLoad(value);
        setIndex(initialIndex(value.sources, value.initialId));
      },
      (e: unknown) => setError(String(e)),
    );
  }, [api]);

  useEffect(() => {
    cards.current[index]?.focus();
  }, [index, load]);

  const choose = useCallback(
    (i: number) => {
      const source = load?.sources[i];
      if (!api || !source || answered.current) return;
      answered.current = true;
      void api.choose(source.id);
    },
    [api, load],
  );

  const cancel = useCallback(() => {
    if (!api || answered.current) return;
    answered.current = true;
    void api.cancel();
  }, [api]);

  const count = load?.sources.length ?? 0;
  const columns = gridColumns(count);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const result = pickerKey(event.key, index, count, columns);
      if (result.kind === 'none') return;
      event.preventDefault();
      if (result.kind === 'cancel') cancel();
      else if (result.kind === 'choose') choose(result.index);
      else setIndex(result.index);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, columns, choose, cancel]);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Choose a screen to record</h1>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {load && (
        <div
          role="listbox"
          aria-label="Screens"
          className={styles.grid}
          style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }}
        >
          {load.sources.map((source, i) => (
            <button
              key={source.id}
              ref={(el) => {
                cards.current[i] = el;
              }}
              type="button"
              role="option"
              aria-selected={i === index}
              data-source-id={source.id}
              className={i === index ? `${styles.card} ${styles.selected}` : styles.card}
              onClick={() => setIndex(i)}
              onDoubleClick={() => choose(i)}
            >
              {source.thumbnail ? (
                <img className={styles.thumb} src={source.thumbnail} alt="" />
              ) : (
                <span className={styles.thumb} aria-hidden="true" />
              )}
              <span className={styles.name}>{source.name}</span>
            </button>
          ))}
        </div>
      )}
      <footer className={styles.actions}>
        <span className={styles.hint}>Arrow keys to move · Enter to record · Esc to cancel</span>
        <button type="button" onClick={cancel}>
          Cancel
        </button>
        <button type="button" disabled={!load} onClick={() => choose(index)}>
          Record this screen
        </button>
      </footer>
    </main>
  );
}
