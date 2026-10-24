import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { InvokeResponse } from '../../shared/ipc/contract';
import {
  clientToSource,
  containBox,
  finalizeRegion,
  fullFrameRegion,
  HANDLES,
  hitTest,
  moveRect,
  rectFromCorners,
  resizeRect,
  sourceToClient,
  type Box,
  type Handle,
  type Point,
  type Size,
} from '../../shared/recording/region';
import styles from './PickerApp.module.css';

type Load = InvokeResponse<'picker.load'>;

/** Pointer travel (CSS px) before a press becomes a new selection (§2.3). */
const DRAG_THRESHOLD_PX = 4;
/** Handle grab distance in CSS px. */
const HANDLE_TOLERANCE_PX = 10;
/** Keys are ignored this long after opening, so a held Enter cannot confirm by accident (§2.3). */
const KEY_GUARD_MS = 500;
/** Magnifier: source pixels per side (odd) and CSS px per source pixel. */
const MAGNIFIER_PIXELS = 11;
const MAGNIFIER_ZOOM = 12;
const MAGNIFIER_SIZE = MAGNIFIER_PIXELS * MAGNIFIER_ZOOM;

interface Drag {
  mode: 'draw' | 'move' | Handle;
  startClient: Point;
  startSource: Point;
  origin: Box | null;
  /** A new selection replaces the old one only once the pointer moved past the threshold. */
  moved: boolean;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function useViewport(): Size {
  const [size, setSize] = useState<Size>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

const CURSORS: Record<Handle | 'move', string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  move: 'move',
};

function handlePosition(box: Box, handle: Handle): Point {
  return {
    x: handle.includes('w')
      ? box.x
      : handle.includes('e')
        ? box.x + box.width
        : box.x + box.width / 2,
    y: handle.includes('n')
      ? box.y
      : handle.includes('s')
        ? box.y + box.height
        : box.y + box.height / 2,
  };
}

/** Draws the zoomed pixels around `at` (stream px) with a pixel grid and the centre marked. */
function drawMagnifier(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  at: Point,
  source: Size,
) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const half = Math.floor(MAGNIFIER_PIXELS / 2);
  const cx = Math.min(source.width - 1, Math.floor(at.x));
  const cy = Math.min(source.height - 1, Math.floor(at.y));
  // The still may differ in size from the stream; sample it in its own pixels.
  const sx = image.naturalWidth / source.width;
  const sy = image.naturalHeight / source.height;
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#000';
  context.fillRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
  context.drawImage(
    image,
    (cx - half) * sx,
    (cy - half) * sy,
    MAGNIFIER_PIXELS * sx,
    MAGNIFIER_PIXELS * sy,
    0,
    0,
    MAGNIFIER_SIZE,
    MAGNIFIER_SIZE,
  );
  context.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  context.lineWidth = 1;
  context.beginPath();
  for (let i = 1; i < MAGNIFIER_PIXELS; i += 1) {
    const p = i * MAGNIFIER_ZOOM + 0.5;
    context.moveTo(p, 0);
    context.lineTo(p, MAGNIFIER_SIZE);
    context.moveTo(0, p);
    context.lineTo(MAGNIFIER_SIZE, p);
  }
  context.stroke();
  context.strokeStyle = '#fff';
  context.strokeRect(
    half * MAGNIFIER_ZOOM + 0.5,
    half * MAGNIFIER_ZOOM + 0.5,
    MAGNIFIER_ZOOM - 1,
    MAGNIFIER_ZOOM - 1,
  );
}

/**
 * The region picker (§4.3.7, R1.9): the frozen frame fit to the window, drag to select, move by
 * dragging inside, 8 resize handles, Shift for a square, a magnifier with a pixel grid, the size in
 * source pixels, Enter or double-click to confirm, Esc to cancel, and "Full frame" / "Last region".
 */
export function PickerApp() {
  const api = window.csPicker;
  const viewport = useViewport();
  const [load, setLoad] = useState<Load | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rect, setRect] = useState<Box | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [hover, setHover] = useState<Handle | 'move' | null>(null);
  const [dragMode, setDragMode] = useState<Drag['mode'] | null>(null);
  const drag = useRef<Drag | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const magnifier = useRef<HTMLCanvasElement>(null);
  const openedAt = useRef(Number.POSITIVE_INFINITY);
  const submitted = useRef(false);

  useEffect(() => {
    openedAt.current = performance.now();
    api.load().then(setLoad, (e: unknown) => setError(errorText(e)));
  }, [api]);

  const source = useMemo<Size | null>(
    () => (load ? { width: load.sourceWidth, height: load.sourceHeight } : null),
    [load],
  );
  const scale = source ? containBox(viewport, source).scale : 1;

  const toSource = useCallback(
    (clientX: number, clientY: number): Point | null =>
      source ? clientToSource({ x: clientX, y: clientY }, viewport, source) : null,
    [source, viewport],
  );

  const confirm = useCallback(() => {
    if (!load || !rect || submitted.current) return;
    submitted.current = true;
    const size = { width: load.sourceWidth, height: load.sourceHeight };
    api
      .submit({
        sourceWidth: load.sourceWidth,
        sourceHeight: load.sourceHeight,
        rect: finalizeRegion(rect, size),
      })
      .catch((e: unknown) => {
        submitted.current = false;
        setError(errorText(e));
      });
  }, [api, load, rect]);

  const cancel = useCallback(() => {
    if (submitted.current) return;
    submitted.current = true;
    api.cancel().catch((e: unknown) => setError(errorText(e)));
  }, [api]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (performance.now() - openedAt.current < KEY_GUARD_MS) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        confirm();
      } else if (event.key.startsWith('Arrow') && rect && source) {
        // Nudge the selection by one source pixel (ten with Shift).
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        setRect(moveRect(rect, dx, dy, source));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, confirm, rect, source]);

  useEffect(() => {
    const canvas = magnifier.current;
    const img = image.current;
    if (!canvas || !img || !pointer || !source || !img.complete) return;
    drawMagnifier(canvas, img, pointer, source);
  }, [pointer, source]);

  if (error) {
    return (
      <main className={styles.message}>
        <p role="alert">The region picker could not open: {error}</p>
        <button type="button" onClick={() => void api.cancel()}>
          Close
        </button>
      </main>
    );
  }
  if (!load || !source) return <main className={styles.message}>Loading the frame…</main>;

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const p = toSource(event.clientX, event.clientY);
    if (!p) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const hit = rect ? hitTest(p, rect, HANDLE_TOLERANCE_PX / scale) : null;
    drag.current = {
      mode: hit ?? 'draw',
      startClient: { x: event.clientX, y: event.clientY },
      startSource: p,
      origin: rect,
      moved: false,
    };
    setDragMode(hit ?? 'draw');
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const p = toSource(event.clientX, event.clientY);
    if (!p) return;
    setPointer(p);
    const d = drag.current;
    if (!d) {
      setHover(rect ? hitTest(p, rect, HANDLE_TOLERANCE_PX / scale) : null);
      return;
    }
    if (!d.moved) {
      const distance = Math.hypot(event.clientX - d.startClient.x, event.clientY - d.startClient.y);
      if (distance < DRAG_THRESHOLD_PX) return;
      d.moved = true;
    }
    if (d.mode === 'draw') setRect(rectFromCorners(d.startSource, p, source, event.shiftKey));
    else if (d.mode === 'move' && d.origin)
      setRect(moveRect(d.origin, p.x - d.startSource.x, p.y - d.startSource.y, source));
    else if (d.mode !== 'move' && d.origin)
      setRect(resizeRect(d.origin, d.mode, p, source, event.shiftKey));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setDragMode(null);
  };

  // Right-click cancels the drag in progress, or clears the selection (§2.3).
  const onContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    const d = drag.current;
    drag.current = null;
    setDragMode(null);
    if (d) setRect(d.origin);
    else setRect(null);
  };

  const onDoubleClick = (event: ReactMouseEvent) => {
    const p = toSource(event.clientX, event.clientY);
    if (p && rect && hitTest(p, rect, 0) === 'move') confirm();
  };

  const selection = rect ? sourceToClient(rect, viewport, source) : null;
  const region = rect ? finalizeRegion(rect, source) : null;
  const pointerClient = pointer
    ? sourceToClient({ ...pointer, width: 0, height: 0 }, viewport, source)
    : null;
  const magnifierLeft = pointerClient
    ? pointerClient.x + 24 + MAGNIFIER_SIZE > viewport.width
      ? pointerClient.x - 24 - MAGNIFIER_SIZE
      : pointerClient.x + 24
    : 0;
  const magnifierTop = pointerClient
    ? pointerClient.y + 24 + MAGNIFIER_SIZE + 20 > viewport.height
      ? pointerClient.y - 24 - MAGNIFIER_SIZE - 20
      : pointerClient.y + 24
    : 0;
  const cursor = dragMode
    ? dragMode === 'draw'
      ? 'crosshair'
      : CURSORS[dragMode]
    : hover
      ? CURSORS[hover]
      : 'crosshair';

  return (
    <main
      className={styles.stage}
      style={{ cursor }}
      data-testid="picker-stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setPointer(null)}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      <img
        ref={image}
        className={styles.frame}
        src={load.imageUrl}
        alt="The frozen frame of the chosen screen"
        draggable={false}
      />
      {selection ? (
        <div
          className={styles.selection}
          data-testid="picker-selection"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        >
          {HANDLES.map((handle) => {
            const p = handlePosition(
              { x: 0, y: 0, width: selection.width, height: selection.height },
              handle,
            );
            return (
              <span
                key={handle}
                className={styles.handle}
                data-handle={handle}
                style={{ left: p.x, top: p.y }}
              />
            );
          })}
          {region ? (
            <span className={styles.size} data-testid="region-size">
              {region.width} × {region.height}
            </span>
          ) : null}
        </div>
      ) : (
        <div className={styles.dim} />
      )}

      <div
        className={styles.toolbar}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span className={styles.hint}>
          {region
            ? `${String(region.width)} × ${String(region.height)} px of ${String(source.width)} × ${String(source.height)}`
            : 'Drag to select a region · Shift: square · Enter: record · Esc: cancel'}
        </span>
        <button type="button" onClick={() => setRect(fullFrameRegion(source))}>
          Full frame
        </button>
        <button
          type="button"
          disabled={!load.lastRegion}
          title={load.lastRegion ? undefined : 'No last region for a screen of this size'}
          onClick={() => {
            if (load.lastRegion) setRect(load.lastRegion);
          }}
        >
          Last region
        </button>
        <button type="button" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className={styles.primary} disabled={!rect} onClick={confirm}>
          Record region
        </button>
      </div>

      {pointerClient ? (
        <div
          className={styles.magnifier}
          style={{ left: magnifierLeft, top: magnifierTop }}
          aria-hidden="true"
        >
          <canvas ref={magnifier} width={MAGNIFIER_SIZE} height={MAGNIFIER_SIZE} />
          <span>
            {Math.floor(pointer?.x ?? 0)}, {Math.floor(pointer?.y ?? 0)}
          </span>
        </div>
      ) : null}
    </main>
  );
}
