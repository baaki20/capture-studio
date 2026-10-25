/**
 * The timeline (R1.31–R1.44): React track headers (with Face + Voice as one linked component
 * group) beside a canvas that draws the ruler, clips, waveforms, thumbnails, marks and playhead
 * (`draw.ts`). Pointer handling on the canvas: scrub on the ruler, select, move and trim clips
 * (one undo step per drag), Ctrl+wheel zoom, wheel scroll. Hit testing and drawing share
 * `geometry.ts`.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Track } from '../../../shared/project/schema';
import { linkedClips, timelineDurationUs } from '../../../shared/project/timeline-ops';
import { frameToUs, usToFrame } from '../../../shared/time';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { toggleOp } from '../InspectorPanel/inspector-ops';
import { errorText } from '../commands';
import { useDocumentStore } from '../store/document-store';
import { beginClipDrag, dragOp, type ClipDrag } from './drag';
import { drawTimeline } from './draw';
import {
  clampScroll,
  fitView,
  hitTest,
  layoutRows,
  revealTime,
  snapThresholdUs,
  xToTime,
  zoomAround,
  type Row,
} from './geometry';

type Session =
  { kind: 'scrub' } | { kind: 'clip'; drag: ClipDrag; startX: number; started: boolean };

const DRAG_START_PX = 3;

export function Timeline() {
  const { docStore, ui, assets, playback } = useEditor();
  const doc = useDocumentStore(docStore, (s) => s.doc);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const session = useRef<Session | null>(null);
  const snapUs = useRef<number | null>(null);
  const fitted = useRef(false);
  const redraw = useRef<() => void>(() => undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const layout = useMemo(() => (doc ? layoutRows(doc) : { rows: [], height: 0 }), [doc]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // Show the whole timeline when the project opens.
  useEffect(() => {
    if (fitted.current || !doc || size.width <= 0) return;
    fitted.current = true;
    ui.getState().setView(fitView(timelineDurationUs(doc), size.width));
  }, [doc, size.width, ui]);

  // Redraw on any change of the document, UI state or assets, at most once per frame.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = 0;
      const canvas = canvasRef.current;
      const d = docStore.getState().doc;
      if (!canvas || !d || size.width <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const height = Math.max(size.height, layoutRows(d).height);
      if (canvas.width !== Math.round(size.width * dpr))
        canvas.width = Math.round(size.width * dpr);
      if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
      canvas.style.width = `${String(size.width)}px`;
      canvas.style.height = `${String(height)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const state = ui.getState();
      const linked = new Set<string>();
      for (const id of state.selection) {
        for (const loc of linkedClips(d, id)) if (loc.clip.id !== id) linked.add(loc.clip.id);
      }
      drawTimeline(ctx, {
        doc: d,
        rows: layoutRows(d).rows,
        view: state.view,
        width: size.width,
        height,
        selection: new Set(state.selection),
        linkedToSelection: linked,
        playheadUs: state.playheadUs,
        snapUs: snapUs.current,
        assets,
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    redraw.current = schedule;
    schedule();
    const offDoc = docStore.subscribe(schedule);
    const offUi = ui.subscribe((state, previous) => {
      // Keep the playhead in view while playing.
      if (state.playing && state.playheadUs !== previous.playheadUs && size.width > 0) {
        const view = revealTime(state.view, state.playheadUs, size.width);
        if (view !== state.view) state.setView(view);
      }
      schedule();
    });
    const offAssets = assets.onChange(schedule);
    return () => {
      offDoc();
      offUi();
      offAssets();
      cancelAnimationFrame(frame);
    };
  }, [docStore, ui, assets, size]);

  // Wheel: Ctrl zooms around the pointer (R1.44), otherwise scrolls.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const d = docStore.getState().doc;
      if (!d) return;
      event.preventDefault();
      const state = ui.getState();
      const x = event.clientX - canvas.getBoundingClientRect().left;
      const duration = timelineDurationUs(d);
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.0025);
        state.setView(clampScroll(zoomAround(state.view, factor, x), duration, size.width));
      } else {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        const scrollUs = state.view.scrollUs + (delta * 1_000_000) / state.view.pxPerSec;
        state.setView(clampScroll({ ...state.view, scrollUs }, duration, size.width));
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [docStore, ui, size.width]);

  const local = (event: ReactPointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const scrubTo = (tUs: number) => {
    const d = docStore.getState().doc;
    if (!d) return;
    const fps = d.timeline.frameRate;
    playback.seek(frameToUs(usToFrame(Math.max(0, tUs), fps), fps));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = docStore.getState().doc;
    if (!d || event.button !== 0) return;
    const { x, y } = local(event);
    const state = ui.getState();
    const hit = hitTest(layoutRows(d).rows, state.view, x, y);
    event.currentTarget.setPointerCapture(event.pointerId);
    state.setOverlaySelected(false);
    if (hit.kind === 'ruler') {
      session.current = { kind: 'scrub' };
      scrubTo(hit.tUs);
      return;
    }
    if (hit.kind !== 'clip') {
      if (!event.shiftKey && !event.ctrlKey) state.select([]);
      session.current = null;
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey) state.toggleSelected(hit.clipId);
    else if (!state.selection.includes(hit.clipId)) state.select([hit.clipId]);
    const drag = beginClipDrag(d, hit.clipId, hit.zone, hit.tUs);
    session.current = drag ? { kind: 'clip', drag, startX: x, started: false } : null;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = docStore.getState().doc;
    if (!d) return;
    const { x, y } = local(event);
    const state = ui.getState();
    const current = session.current;
    if (!current) {
      const hit = hitTest(layoutRows(d).rows, state.view, x, y);
      event.currentTarget.style.cursor =
        hit.kind === 'clip'
          ? hit.zone === 'body'
            ? 'grab'
            : 'ew-resize'
          : hit.kind === 'ruler'
            ? 'text'
            : 'default';
      return;
    }
    if (current.kind === 'scrub') {
      scrubTo(xToTime(state.view, x));
      return;
    }
    if (!current.started) {
      if (Math.abs(x - current.startX) < DRAG_START_PX) return;
      current.started = true;
      docStore.getState().beginGesture();
    }
    const result = dragOp(d, current.drag, xToTime(state.view, x), {
      includeLinked: !event.altKey,
      snapping: state.snapping,
      thresholdUs: snapThresholdUs(state.view),
      playheadUs: state.playheadUs,
    });
    if (!result) return;
    snapUs.current = result.snappedUs;
    const applied = docStore.getState().apply(result.op);
    if (!applied.ok && applied.error.code !== 'overlap') state.setStatus(errorText(applied.error));
  };

  const endSession = () => {
    const current = session.current;
    session.current = null;
    if (current?.kind === 'clip' && current.started) docStore.getState().endGesture();
    if (snapUs.current !== null) {
      snapUs.current = null;
      redraw.current(); // without the snap guide
    }
  };

  if (!doc) return null;
  return (
    <div className={styles.timeline} data-testid="timeline">
      <TrackHeaders rows={layout.rows} />
      <div className={styles.canvasWrap} ref={wrapRef}>
        <canvas
          ref={canvasRef}
          data-testid="timeline-canvas"
          aria-label="Timeline"
          role="application"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endSession}
          onPointerCancel={endSession}
        />
      </div>
    </div>
  );
}

function TrackHeaders({ rows }: { rows: readonly Row[] }) {
  const { docStore, ui } = useEditor();
  const doc = useDocumentStore(docStore, (s) => s.doc);
  if (!doc) return null;
  const toggle = (track: Track, what: 'mute' | 'solo' | 'hide' | 'lock') => {
    const op = toggleOp(track, what);
    if (!op) return;
    const result = docStore.getState().apply(op);
    ui.getState().setStatus(result.ok ? null : errorText(result.error));
  };
  // Face + Voice: rows sharing a face-voice component form one linked header group (R1.31).
  const faceVoice = doc.components.find((c) => c.type === 'face-voice');
  const groupRows = faceVoice ? rows.filter((r) => r.track.componentId === faceVoice.id) : [];
  const first = groupRows[0];
  const last = groupRows[groupRows.length - 1];
  return (
    <div className={styles.headers} data-testid="track-headers">
      {first && last && groupRows.length > 1 ? (
        <div
          className={styles.linkGroup}
          style={{ top: first.top - 1, height: last.top + last.height - first.top + 2 }}
          data-testid="face-voice-group"
          aria-label="Face + Voice (linked)"
        >
          <span className={styles.linkBadge}>Face + Voice · linked</span>
        </div>
      ) : null}
      {rows.map(({ track, top, height }) => (
        <div
          key={track.id}
          className={styles.trackHeader}
          style={{ top, height }}
          data-testid={`track-header-${track.name}`}
        >
          <span className={styles.trackName} title={track.name}>
            {track.name}
          </span>
          {track.type === 'audio' ? (
            <>
              <button
                type="button"
                aria-pressed={track.muted}
                aria-label={`Mute ${track.name}`}
                title="Mute"
                onClick={() => toggle(track, 'mute')}
              >
                M
              </button>
              <button
                type="button"
                aria-pressed={track.solo}
                aria-label={`Solo ${track.name}`}
                title="Solo"
                onClick={() => toggle(track, 'solo')}
              >
                S
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-pressed={track.hidden}
              aria-label={`Hide ${track.name}`}
              title="Hide"
              onClick={() => toggle(track, 'hide')}
            >
              Hide
            </button>
          )}
          <button
            type="button"
            aria-pressed={track.locked}
            aria-label={`Lock ${track.name}`}
            title="Lock"
            onClick={() => toggle(track, 'lock')}
          >
            Lock
          </button>
        </div>
      ))}
    </div>
  );
}
