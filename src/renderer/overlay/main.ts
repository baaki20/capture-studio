/**
 * The on-screen overlay page (P3 step 6): a transparent, click-through window over one display.
 * It draws what main sends on `overlay.state`: the recording frame around the region and the
 * live highlighter around the pointer. Nothing here takes input.
 */
import type { OverlayPreloadApi } from '../../shared/ipc/preload-api';
import './overlay.css';

declare global {
  interface Window {
    csOverlay: OverlayPreloadApi;
  }
}

/** Border width in CSS px; the frame is drawn this far outside the region. */
const FRAME_BORDER_PX = 3;

const frame = document.getElementById('frame');
const cursor = document.getElementById('cursor');

window.csOverlay.onState((state) => {
  if (frame) {
    if (state.frame) {
      frame.style.display = 'block';
      frame.style.left = `${String(state.frame.x - FRAME_BORDER_PX)}px`;
      frame.style.top = `${String(state.frame.y - FRAME_BORDER_PX)}px`;
      frame.style.width = `${String(state.frame.width)}px`;
      frame.style.height = `${String(state.frame.height)}px`;
    } else {
      frame.style.display = 'none';
    }
  }
  if (cursor) {
    if (state.cursor) {
      cursor.style.display = 'block';
      cursor.style.transform = `translate(${String(state.cursor.x)}px, ${String(state.cursor.y)}px)`;
    } else {
      cursor.style.display = 'none';
    }
  }
});
