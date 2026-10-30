/**
 * The editor window (§4.2, steps 16–18): opens the project named in `?project=`, then shows the
 * toolbar, banners (read-only, reloaded, offline media), preview with face handles, inspector,
 * transport, timeline and status line. Keyboard shortcuts follow `keyboard.ts`.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { InvokeResponse } from '../../shared/ipc/contract';
import { ipcErrorMessage } from '../../shared/ipc/errors';
import { formatTimecode } from '../../shared/time';
import { timelineDurationUs } from '../../shared/project/timeline-ops';
import { runCommand, type CommandContext } from './commands';
import { EditorContext, useEditor } from './EditorContext';
import styles from './Editor.module.css';
import { InspectorPanel } from './InspectorPanel/InspectorPanel';
import { commandForKey, isTextEntryTarget, type EditorCommand } from './keyboard';
import { PreviewPane } from './preview/PreviewPane';
import { createEditorServices, type EditorServices } from './services';
import type { ProjectV1 } from '../../shared/project/schema';
import { useDocumentStore } from './store/document-store';
import { Timeline } from './Timeline/Timeline';
import { useUi } from './ui-store';

/** The export dialog (step 19, `export/`), loaded when first opened. */
const ExportDialog = lazy(() =>
  import('./export/ExportDialog').then((m) => ({ default: m.ExportDialog })),
);

export function App() {
  const projectId = new URLSearchParams(window.location.search).get('project');
  const [services, setServices] = useState<EditorServices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState<OfflineReasons>({});

  useEffect(() => {
    if (!projectId) return;
    const api = window.csEditor;
    const created = createEditorServices(api, projectId);
    let cancelled = false;
    api.project.open(projectId).then(
      (open) => {
        if (cancelled) return;
        created.docStore.getState().load(open);
        setOffline(open.offline ?? {});
        document.title = `${open.doc.name} – Capture Studio`;
        setServices(created);
      },
      (e: unknown) => {
        if (!cancelled) setError(ipcErrorMessage(e));
      },
    );
    window.__csEditorFlush = () => created.autosave.flush();
    window.csEditorDebug = {
      doc: () => created.docStore.getState().doc,
      ui: () => {
        const { playheadUs, playing, selection, snapping } = created.ui.getState();
        return { playheadUs, playing, selection, snapping };
      },
      probePreview: async (tUs) => {
        const client = created.preview.current;
        if (!client) throw new Error('the preview is not ready');
        return client.probe(tUs ?? created.ui.getState().playheadUs);
      },
      saveStatus: () => created.docStore.getState().saveStatus,
      capturePreview: async (tUs) => {
        const client = created.preview.current;
        if (!client) throw new Error('the preview is not ready');
        const picture = await client.capture(tUs);
        if (!picture) return null;
        let binary = '';
        for (let i = 0; i < picture.rgba.length; i += 0x8000) {
          binary += String.fromCharCode(...picture.rgba.subarray(i, i + 0x8000));
        }
        return {
          width: picture.width,
          height: picture.height,
          exact: picture.exact,
          rgbaBase64: btoa(binary),
        };
      },
      playbackCounters: () => ({
        video: created.preview.current?.counters() ?? null,
        audio: created.scheduler.counters(),
      }),
      resetPlaybackCounters: () => {
        created.preview.current?.resetCounters();
        created.scheduler.resetCounters();
      },
      play: (fromUs) => {
        if (fromUs !== undefined) created.playback.seek(fromUs);
        created.playback.play(1);
      },
      pause: () => created.playback.pause(),
    };
    return () => {
      cancelled = true;
      created.dispose();
      setServices(null);
    };
  }, [projectId]);

  if (!projectId) return <p className={styles.banner}>No project was given to the editor.</p>;
  if (error) {
    return (
      <p className={styles.banner} role="alert">
        The project could not be opened: {error}
      </p>
    );
  }
  if (!services) return <p className={styles.banner}>Opening the project…</p>;
  return (
    <EditorContext value={services}>
      <EditorLayout offline={offline} onOffline={setOffline} />
    </EditorContext>
  );
}

/** The command context of this window (keyboard, toolbar). */
function useCommandContext(): CommandContext {
  const { docStore, ui, playback } = useEditor();
  return useMemo(
    () => ({
      docStore,
      ui,
      transport: playback,
      timelineWidth: () =>
        document.querySelector('[data-testid="timeline-canvas"]')?.getBoundingClientRect().width ??
        0,
    }),
    [docStore, ui, playback],
  );
}

/** Why each offline media is offline (R1.29), from `project.open`. */
type OfflineReasons = NonNullable<InvokeResponse<'project.open'>['offline']>;

interface OfflineProps {
  offline: OfflineReasons;
  onOffline: (offline: OfflineReasons) => void;
}

function EditorLayout({ offline, onOffline }: OfflineProps) {
  const services = useEditor();
  const { docStore, autosave, ui } = services;
  const context = useCommandContext();
  /** The document snapshot being exported (R1.49), while the dialog is open. */
  const [exporting, setExporting] = useState<ProjectV1 | null>(null);

  const openExport = () => {
    // Save first so the project on disk matches the snapshot the export uses.
    void autosave.flush().finally(() => {
      const doc = docStore.getState().doc;
      if (doc) setExporting(doc);
      else ui.getState().setStatus('No project is open.');
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (isTextEntryTarget(event.target) && event.key !== 'Escape') return;
      const command = commandForKey(event);
      if (!command) return;
      event.preventDefault();
      runCommand(command, context);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [context]);

  return (
    <div className={styles.editor} data-testid="editor">
      <Toolbar onExport={openExport} />
      <Banners offline={offline} onOffline={onOffline} />
      <div className={styles.main}>
        <PreviewPane />
        <InspectorPanel />
      </div>
      <Transport />
      <Timeline />
      <StatusLine />
      {exporting ? (
        <Suspense fallback={null}>
          <ExportDialog
            projectId={services.projectId}
            doc={exporting}
            onClose={() => setExporting(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

const SAVE_LABELS: Record<string, string> = {
  saved: 'Saved',
  pending: 'Edited',
  saving: 'Saving…',
  error: 'Not saved',
  'read-only': 'Read-only',
};

function Toolbar({ onExport }: { onExport: () => void }) {
  const { docStore, ui } = useEditor();
  const context = useCommandContext();
  const name = useDocumentStore(docStore, (s) => s.doc?.name ?? '');
  const saveStatus = useDocumentStore(docStore, (s) => s.saveStatus);
  const undoLabel = useDocumentStore(docStore, (s) => s.undoLabel);
  const redoLabel = useDocumentStore(docStore, (s) => s.redoLabel);
  const snapping = useUi(ui, (s) => s.snapping);
  const run = (command: EditorCommand) => runCommand(command, context);
  return (
    <header className={styles.toolbar}>
      <h1 title={name}>{name}</h1>
      <span className={styles.group}>
        <button
          type="button"
          disabled={!undoLabel}
          title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
          onClick={() => run('undo')}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!redoLabel}
          title={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'}
          onClick={() => run('redo')}
        >
          Redo
        </button>
      </span>
      <span className={styles.group}>
        <button type="button" title="Split at the playhead (S)" onClick={() => run('split')}>
          Split
        </button>
        <button type="button" title="Delete, leaving a gap (Delete)" onClick={() => run('delete')}>
          Delete
        </button>
        <button
          type="button"
          title="Ripple delete (Shift+Delete)"
          onClick={() => run('ripple-delete')}
        >
          Ripple delete
        </button>
      </span>
      <span className={styles.group}>
        <button type="button" title="Mark In (I)" onClick={() => run('mark-in')}>
          In
        </button>
        <button type="button" title="Mark Out (O)" onClick={() => run('mark-out')}>
          Out
        </button>
        <button
          type="button"
          title="Cut the In–Out range (Ctrl+Shift+X)"
          onClick={() => run('cut-range')}
        >
          Cut range
        </button>
      </span>
      <button
        type="button"
        aria-pressed={snapping}
        title="Snap to playhead, clip edges and marks (N)"
        onClick={() => run('toggle-snap')}
      >
        Snap
      </button>
      <button type="button" title="Zoom to fit (Shift+Z)" onClick={() => run('zoom-fit')}>
        Fit
      </button>
      <span className={styles.spacer} />
      <span className={styles.saveStatus} data-status={saveStatus} data-testid="save-status">
        {SAVE_LABELS[saveStatus] ?? saveStatus}
      </span>
      <button type="button" title="Export an MP4" onClick={onExport} data-testid="export-button">
        Export…
      </button>
    </header>
  );
}

function Banners({ offline: reasons, onOffline }: OfflineProps) {
  const { docStore, api, projectId, autosave, ui } = useEditor();
  const readOnly = useDocumentStore(docStore, (s) => s.readOnly);
  const notice = useDocumentStore(docStore, (s) => s.notice);
  const doc = useDocumentStore(docStore, (s) => s.doc);
  const offline = (doc?.media ?? []).filter((m) => m.status === 'missing' || m.status === 'failed');

  const relink = async (mediaId: string) => {
    try {
      await autosave.flush();
      const result = await api.project.relink(projectId, mediaId);
      if (!result.relinked) return;
      const reopened = await api.project.open(projectId);
      docStore.getState().load(reopened);
      onOffline(reopened.offline ?? {});
      ui.getState().setStatus('Media relinked.');
    } catch (e) {
      ui.getState().setStatus(`Relink failed: ${ipcErrorMessage(e)}`);
    }
  };

  return (
    <div className={styles.banners}>
      {readOnly ? (
        <div className={styles.banner} role="status">
          This project was made by a newer version of Capture Studio. It opens read-only.
        </div>
      ) : null}
      {notice ? (
        <div className={styles.banner} role="status" data-testid="notice">
          <span>{notice.message}</span>
          {notice.discardedDoc ? (
            <button type="button" onClick={() => docStore.getState().restoreDiscarded()}>
              Restore my edits
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => docStore.getState().dismissNotice()}
          >
            ×
          </button>
        </div>
      ) : null}
      {offline.length > 0 ? (
        <div className={styles.banner} role="alert" data-testid="offline-banner">
          <span>
            {offline.length === 1 ? 'A media file is' : `${String(offline.length)} media files are`}{' '}
            offline. Their clips cannot play or export until relinked or removed.
            {offline.map((m) => {
              const why = reasons[m.id];
              const name = m.path.split('/').pop() ?? m.path;
              if (m.status === 'failed') return ` ${name} failed to record.`;
              if (why?.reason === 'unreadable') {
                return ` ${name} is damaged or unreadable${why.detail ? ` (${why.detail})` : ''}.`;
              }
              return ` ${name} is missing.`;
            })}
          </span>
          {offline.map((m) => (
            <button key={m.id} type="button" onClick={() => void relink(m.id)}>
              Relink {m.path.split('/').pop()}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Transport() {
  const { ui, playback, docStore } = useEditor();
  const playhead = useUi(ui, (s) => s.playheadUs);
  const playing = useUi(ui, (s) => s.playing);
  const rate = useUi(ui, (s) => s.rate);
  const doc = useDocumentStore(docStore, (s) => s.doc);
  const fps = doc?.timeline.frameRate ?? 30;
  const duration = doc ? timelineDurationUs(doc) : 0;
  return (
    <div className={styles.transport} data-testid="transport">
      <span className={styles.group}>
        <button
          type="button"
          title="Start (Home)"
          aria-label="Go to start"
          onClick={() => playback.home()}
        >
          |◀
        </button>
        <button
          type="button"
          title="Previous frame (←)"
          aria-label="Previous frame"
          onClick={() => playback.step(-1)}
        >
          ◀|
        </button>
        <button
          type="button"
          title="Play/pause (Space)"
          aria-label={playing ? 'Pause' : 'Play'}
          data-testid="play-button"
          onClick={() => playback.toggle()}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          title="Next frame (→)"
          aria-label="Next frame"
          onClick={() => playback.step(1)}
        >
          |▶
        </button>
        <button
          type="button"
          title="End (End)"
          aria-label="Go to end"
          onClick={() => playback.end()}
        >
          ▶|
        </button>
      </span>
      <span className={styles.timecode} data-testid="timecode">
        {formatTimecode(playhead, fps)}
      </span>
      <span className={styles.muted}>/ {formatTimecode(duration, fps)}</span>
      {playing && rate !== 1 ? (
        <span className={styles.muted}>{`${rate > 0 ? '' : '−'}${String(Math.abs(rate))}×`}</span>
      ) : null}
      <span className={styles.spacer} />
      <span className={styles.muted}>
        J K L shuttle · S split · I/O marks · N snap · Shift+Z fit
      </span>
    </div>
  );
}

function StatusLine() {
  const { ui, docStore } = useEditor();
  const status = useUi(ui, (s) => s.status);
  const lastError = useDocumentStore(docStore, (s) => s.lastError);
  return (
    <footer className={styles.statusLine} role="status" data-testid="status-line">
      {status ?? (lastError ? lastError.message : '')}
    </footer>
  );
}
