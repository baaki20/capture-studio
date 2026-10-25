/**
 * The preview (R1.33, R1.41): the worker-rendered canvas plus the face-overlay handles on top.
 * Clicking the face selects it and shows its bounding box; dragging moves it, corner handles
 * resize it with the aspect locked; the result goes through `layoutFromDestRect`, so the overlay
 * stays inside the canvas. A drag is one undo step.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { overlayDestRect, type PixelRect } from '../../../shared/project/face-layout';
import { trackFrameSize } from '../../../shared/project/timeline-ops';
import { errorText } from '../commands';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import { faceTrack, overlayRectOp } from '../InspectorPanel/inspector-ops';
import { useDocumentStore } from '../store/document-store';
import { useUi } from '../ui-store';
import {
  canvasToDisplay,
  containTransform,
  displayToCanvas,
  dragOverlayRect,
  hitOverlay,
  type OverlayHandle,
} from './overlay-geometry';
import { PreviewClient } from './preview-client';

export function PreviewPane() {
  const { preview, ui, docStore } = useEditor();
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const client = new PreviewClient(surface);
    preview.attach(client);
    const offError = client.onError((message) => ui.getState().setStatus(`Preview: ${message}`));
    // The current frame, once the worker has the document.
    client.render(ui.getState().playheadUs, false);
    return () => {
      offError();
      preview.attach(null);
      client.dispose();
    };
  }, [preview, ui, docStore]);

  return (
    <div className={styles.preview} data-testid="preview">
      <div className={styles.previewSurface} ref={surfaceRef} />
      <FaceHandles />
    </div>
  );
}

interface DragSession {
  handle: OverlayHandle;
  startX: number;
  startY: number;
  startRect: PixelRect;
  started: boolean;
}

function FaceHandles() {
  const { docStore, ui } = useEditor();
  const doc = useDocumentStore(docStore, (s) => s.doc);
  const selected = useUi(ui, (s) => s.overlaySelected);
  const layerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragSession | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const track = doc ? faceTrack(doc) : null;
  const visible = track !== null && !track.hidden && track.clips.length > 0;
  const canvas = doc?.timeline.canvas ?? { width: 1, height: 1 };
  const transform = containTransform(box, canvas);
  const faceRect =
    doc && track ? overlayDestRect(track.layout, canvas, trackFrameSize(doc, track)) : null;
  const shown = faceRect ? canvasToDisplay(transform, faceRect) : null;

  const local = (event: ReactPointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!visible || !shown || !faceRect || event.button !== 0) return;
    const { x, y } = local(event);
    const handle = hitOverlay(shown, x, y);
    const state = ui.getState();
    if (!handle || (!state.overlaySelected && handle !== 'move')) {
      state.setOverlaySelected(handle !== null);
      return;
    }
    state.setOverlaySelected(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { handle, startX: x, startY: y, startRect: faceRect, started: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = drag.current;
    const d = docStore.getState().doc;
    const face = d ? faceTrack(d) : null;
    const { x, y } = local(event);
    if (!session) {
      const handle = shown && visible ? hitOverlay(shown, x, y) : null;
      event.currentTarget.style.cursor =
        handle === 'move'
          ? 'move'
          : handle === 'nw' || handle === 'se'
            ? 'nwse-resize'
            : handle
              ? 'nesw-resize'
              : 'default';
      return;
    }
    if (!d || !face) return;
    if (!session.started) {
      if (Math.hypot(x - session.startX, y - session.startY) < 2) return;
      session.started = true;
      docStore.getState().beginGesture();
    }
    const a = displayToCanvas(transform, session.startX, session.startY);
    const b = displayToCanvas(transform, x, y);
    const rect = dragOverlayRect(session.startRect, session.handle, b.x - a.x, b.y - a.y);
    const op = overlayRectOp(d, face.id, rect);
    if (!op) return;
    const result = docStore.getState().apply(op);
    if (!result.ok) ui.getState().setStatus(errorText(result.error));
  };

  const onPointerUp = () => {
    const session = drag.current;
    drag.current = null;
    if (session?.started) docStore.getState().endGesture();
  };

  return (
    <div
      ref={layerRef}
      className={styles.overlayLayer}
      data-testid="overlay-layer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {selected && visible && shown ? (
        <div
          className={styles.overlayBox}
          data-testid="face-box"
          style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
            <span
              key={h}
              className={styles.overlayHandle}
              style={{
                left: h === 'nw' || h === 'sw' ? 0 : '100%',
                top: h === 'nw' || h === 'ne' ? 0 : '100%',
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
