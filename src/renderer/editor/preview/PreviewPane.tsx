/**
 * The preview (R1.33, R1.41, R2.8): the worker-rendered canvas plus handles on top for the face
 * overlay and for annotation objects. Objects draw above the face, so a click picks the topmost
 * object under the pointer first and selects it (dragging moves it at once); a selected object's
 * corners resize it freely. Box edits go through `annotation-ops.ts` (the box, or the box
 * keyframe at the playhead when the object moves on keyframes), one undo step per drag.
 * Clicking the face selects it and shows its bounding box; dragging moves it, corner handles
 * resize it with the aspect locked; the result goes through `layoutFromDestRect`, so the overlay
 * stays inside the canvas. A drag is one undo step. With layout keyframes the box is the face at
 * the playhead, draggable while it is settled in overlay mode, and a drag changes the keyframe in
 * effect there (`inspector-ops.ts`).
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PixelRect } from '../../../shared/project/face-layout';
import { errorText } from '../commands';
import { useEditor } from '../EditorContext';
import styles from '../Editor.module.css';
import {
  boxFromFrameRect,
  objectAt,
  objectBoxOp,
  objectsUnder,
} from '../InspectorPanel/annotation-ops';
import { faceBoxAt, faceTrack, overlayRectOp } from '../InspectorPanel/inspector-ops';
import { useDocumentStore } from '../store/document-store';
import { useUi } from '../ui-store';
import {
  canvasToDisplay,
  containTransform,
  displayToCanvas,
  dragFreeRect,
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
      <Handles />
    </div>
  );
}

interface DragSession {
  /** The face overlay, or an annotation object (by ID). */
  target: 'face' | { objectId: string };
  handle: OverlayHandle;
  startX: number;
  startY: number;
  startRect: PixelRect;
  started: boolean;
}

function Handles() {
  const { docStore, ui } = useEditor();
  const doc = useDocumentStore(docStore, (s) => s.doc);
  const selected = useUi(ui, (s) => s.overlaySelected);
  const selectedObject = useUi(ui, (s) => s.selectedObject);
  const playheadUs = useUi(ui, (s) => s.playheadUs);
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
  const faceRect = doc ? faceBoxAt(doc, playheadUs) : null;
  const visible = track !== null && faceRect !== null;
  const canvas = doc?.timeline.canvas ?? { width: 1, height: 1 };
  const transform = containTransform(box, canvas);
  const shown = faceRect ? canvasToDisplay(transform, faceRect) : null;
  const objectRect =
    doc && selectedObject
      ? (objectsUnder(doc, playheadUs).find((o) => o.id === selectedObject)?.rect ?? null)
      : null;
  const shownObject = objectRect ? canvasToDisplay(transform, objectRect) : null;

  const local = (event: ReactPointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !doc) return;
    const { x, y } = local(event);
    const state = ui.getState();
    const startObjectDrag = (objectId: string, handle: OverlayHandle, rect: PixelRect) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        target: { objectId },
        handle,
        startX: x,
        startY: y,
        startRect: rect,
        started: false,
      };
    };
    // The selected object's handles, then the topmost object under the pointer.
    const objectHandle = shownObject ? hitOverlay(shownObject, x, y) : null;
    if (objectHandle && objectRect && selectedObject) {
      startObjectDrag(selectedObject, objectHandle, objectRect);
      return;
    }
    const point = displayToCanvas(transform, x, y);
    const hit = objectAt(doc, state.playheadUs, point.x, point.y);
    if (hit) {
      state.setOverlaySelected(false);
      state.selectObject(hit);
      const rect = objectsUnder(doc, state.playheadUs).find((o) => o.id === hit)?.rect;
      if (rect) startObjectDrag(hit, 'move', rect);
      return;
    }
    if (state.selectedObject) state.selectObject(null);
    if (!visible || !shown) return;
    const handle = hitOverlay(shown, x, y);
    if (!handle || (!state.overlaySelected && handle !== 'move')) {
      state.setOverlaySelected(handle !== null);
      return;
    }
    state.setOverlaySelected(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      target: 'face',
      handle,
      startX: x,
      startY: y,
      startRect: faceRect,
      started: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = drag.current;
    const d = docStore.getState().doc;
    const face = d ? faceTrack(d) : null;
    const { x, y } = local(event);
    if (!session) {
      const handle =
        (shownObject ? hitOverlay(shownObject, x, y) : null) ??
        (shown && visible ? hitOverlay(shown, x, y) : null);
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
    if (!d) return;
    if (!session.started) {
      if (Math.hypot(x - session.startX, y - session.startY) < 2) return;
      session.started = true;
      docStore.getState().beginGesture();
    }
    const a = displayToCanvas(transform, session.startX, session.startY);
    const b = displayToCanvas(transform, x, y);
    if (session.target !== 'face') {
      const t = ui.getState().playheadUs;
      const moved = dragFreeRect(session.startRect, session.handle, b.x - a.x, b.y - a.y);
      const op = objectBoxOp(d, session.target.objectId, boxFromFrameRect(d, moved, t), t);
      const result = op ? docStore.getState().apply(op) : null;
      if (result && !result.ok) ui.getState().setStatus(errorText(result.error));
      return;
    }
    if (!face) return;
    const rect = dragOverlayRect(session.startRect, session.handle, b.x - a.x, b.y - a.y);
    const op = overlayRectOp(d, face.id, rect, ui.getState().playheadUs);
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
      {shownObject ? (
        <div
          className={styles.overlayBox}
          data-testid="object-box"
          style={{
            left: shownObject.x,
            top: shownObject.y,
            width: shownObject.width,
            height: shownObject.height,
          }}
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
