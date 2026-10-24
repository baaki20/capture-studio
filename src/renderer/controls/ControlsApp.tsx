import { useEffect, useReducer, useState } from 'react';
import { Meter } from '../common/Meter';
import { formatElapsed, formatPercent } from '../common/recorder-format';
import styles from './ControlsApp.module.css';
import {
  controlsReducer,
  controlsView,
  dropIndicator,
  elapsedNow,
  initialControlsState,
} from './state';

const TICK_MS = 250;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Re-renders every `TICK_MS` while `active`, so the timer moves between updates. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(performance.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const DROP_TEXT = {
  ok: 'No dropped frames',
  amber: 'Dropping frames',
  red: 'Dropping many frames',
};

/**
 * The recording controls window (R1.10–R1.12): countdown with cancel, then the elapsed timer
 * (pauses excluded), pause/resume, stop, restart and abort (both confirmed), the mic and system
 * meters, the dropped-frame indicator and notices.
 */
export function ControlsApp() {
  const api = window.csControls;
  const [state, dispatch] = useReducer(controlsReducer, undefined, initialControlsState);
  const [error, setError] = useState<string | null>(null);
  const view = controlsView(state);
  const now = useTicker(state.rec.state === 'recording');

  useEffect(() => {
    const offs = [
      api.rec.onState((payload) => dispatch({ type: 'state', payload, atMs: performance.now() })),
      api.rec.onStats((payload) => dispatch({ type: 'stats', payload, atMs: performance.now() })),
      api.rec.onLevels((payload) => dispatch({ type: 'levels', payload })),
      api.rec.onNotice((payload) => dispatch({ type: 'notice', payload })),
    ];
    api.rec.status().then(
      (payload) => dispatch({ type: 'state', payload, atMs: performance.now() }),
      (e: unknown) => setError(errorText(e)),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [api]);

  const run = (task: () => Promise<unknown>) => {
    setError(null);
    task().catch((e: unknown) => setError(errorText(e)));
  };

  // Esc cancels the countdown (R1.10) or the portal wait, and dismisses a confirmation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (state.confirm) dispatch({ type: 'cancel-confirm' });
      else if (view === 'countdown' || view === 'preparing') run(() => api.rec.stop());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const notices =
    state.notices.length > 0 ? (
      <ul className={styles.notices} aria-label="Notices">
        {state.notices.map((n) => (
          <li key={n.id} className={styles[n.level]}>
            <span>{n.message}</span>
            <button
              type="button"
              className={styles.dismiss}
              aria-label="Dismiss"
              onClick={() => dispatch({ type: 'dismiss-notice', id: n.id })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    ) : null;
  const errorLine =
    error || state.rec.failureReason ? (
      <p role="alert" className={styles.errorText}>
        {error ?? state.rec.failureReason}
      </p>
    ) : null;

  if (view === 'countdown') {
    return (
      <main className={styles.countdown} data-testid="countdown">
        <span className={styles.count} data-testid="countdown-remaining" aria-live="assertive">
          {state.rec.countdownRemainingSec ?? 0}
        </span>
        <span className={styles.muted}>Recording starts…</span>
        <button type="button" onClick={() => run(() => api.rec.stop())}>
          Cancel (Esc)
        </button>
        {errorLine}
      </main>
    );
  }

  if (view === 'preparing' || view === 'idle') {
    return (
      <main className={styles.centered} data-testid="preparing">
        <span className={styles.muted}>
          {state.rec.state === 'picking-region'
            ? 'Select the region to record…'
            : view === 'preparing'
              ? 'Waiting for the screen selection…'
              : 'Not recording.'}
        </span>
        {view === 'preparing' ? (
          <button type="button" onClick={() => run(() => api.rec.stop())}>
            Cancel (Esc)
          </button>
        ) : null}
        {errorLine}
        {notices}
      </main>
    );
  }

  if (view === 'finalizing') {
    return (
      <main className={styles.centered} data-testid="finalizing">
        <span>Saving the recording…</span>
        <progress className={styles.progress} aria-label="Saving" />
        {notices}
      </main>
    );
  }

  const paused = state.rec.state === 'paused';
  const drops = dropIndicator(state);
  return (
    <main className={styles.recording} data-testid="controls">
      <div className={styles.row}>
        <span
          className={paused ? `${styles.dot ?? ''} ${styles.pausedDot ?? ''}` : styles.dot}
          aria-hidden="true"
        />
        <span className={styles.status} data-testid="rec-status">
          {paused ? 'Paused' : 'Recording'}
        </span>
        <span className={styles.elapsed} data-testid="elapsed" aria-label="Elapsed time">
          {formatElapsed(elapsedNow(state, now))}
        </span>
        <span
          className={`${styles.drops ?? ''} ${styles[drops.level] ?? ''}`}
          data-testid="drop-indicator"
          data-level={drops.level}
          title={`${DROP_TEXT[drops.level]} (${formatPercent(drops.ratio)})`}
        >
          {drops.level === 'ok' ? 'OK' : formatPercent(drops.ratio)}
        </span>
      </div>

      {state.confirm ? (
        <div className={styles.confirm} role="alertdialog" aria-label="Confirm">
          <span>
            {state.confirm === 'restart'
              ? 'Discard what was recorded and start again?'
              : 'Abort and delete this recording?'}
          </span>
          <button
            type="button"
            className={styles.danger}
            onClick={() => {
              const kind = state.confirm;
              dispatch({ type: 'cancel-confirm' });
              run(() => (kind === 'restart' ? api.rec.restart() : api.rec.abort()));
            }}
          >
            {state.confirm === 'restart' ? 'Restart' : 'Abort'}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'cancel-confirm' })}>
            Keep recording
          </button>
        </div>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            onClick={() => run(() => (paused ? api.rec.resume() : api.rec.pause()))}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => run(() => api.rec.stop())}
          >
            Stop
          </button>
          <button type="button" onClick={() => dispatch({ type: 'ask', confirm: 'restart' })}>
            Restart
          </button>
          <button type="button" onClick={() => dispatch({ type: 'ask', confirm: 'abort' })}>
            Abort
          </button>
        </div>
      )}

      <Meter label="Mic" peak={state.levels.mic} testId="controls-mic-meter" />
      <Meter label="System" peak={state.levels.system} testId="controls-system-meter" />
      {errorLine}
      {notices}
    </main>
  );
}
