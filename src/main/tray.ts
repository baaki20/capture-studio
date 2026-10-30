/**
 * Tray icon (R1.3), created only when `ui.tray` is available (a StatusNotifier host on Linux).
 * It shows idle, recording and paused states; its menu items dispatch on the action bus.
 */
import { dialog, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import type { ActionBus } from './action-bus';
import {
  confirmWhenRequired,
  trayMenuTemplate,
  type ConfirmAction,
  type TrayRecordingState,
} from './tray-menu';

export type { TrayRecordingState } from './tray-menu';

const ICON_SIZE = 22;

/** A filled circle with a light ring, drawn in BGRA so no image asset is needed. */
function circleIcon(rgb: [number, number, number]): NativeImage {
  const buffer = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  const centre = (ICON_SIZE - 1) / 2;
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const d = Math.hypot(x - centre, y - centre);
      const offset = (y * ICON_SIZE + x) * 4;
      const ring = d > 8 && d <= 10;
      const fill = d <= 7;
      if (!ring && !fill) continue;
      const [r, g, b] = ring ? [235, 235, 235] : rgb;
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
      buffer[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: ICON_SIZE, height: ICON_SIZE });
}

const ICON_COLOURS: Record<TrayRecordingState, [number, number, number]> = {
  idle: [150, 150, 150],
  recording: [220, 40, 40],
  paused: [235, 170, 30],
  busy: [90, 140, 220],
};

export interface AppTray {
  setState(state: TrayRecordingState): void;
  destroy(): void;
}

const CONFIRM_TEXT = {
  restart: {
    message: 'Discard what was recorded and start again?',
    button: 'Restart',
  },
  abort: { message: 'Abort and delete this recording?', button: 'Abort' },
} as const;

/** The confirmation dialog for Restart and Abort from the tray (R1.12). */
const confirmInDialog: ConfirmAction = async (kind) => {
  const text = CONFIRM_TEXT[kind];
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: text.message,
    buttons: [text.button, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
};

export interface TrayOptions {
  /** Whether Restart or Abort asks first (Abort's confirmation is a setting, R1.12). */
  shouldConfirm?: (kind: 'restart' | 'abort') => boolean;
}

export function createTray(bus: ActionBus, options: TrayOptions = {}): AppTray {
  const confirm = confirmWhenRequired(confirmInDialog, options.shouldConfirm);
  const icons = new Map<TrayRecordingState, NativeImage>();
  const icon = (state: TrayRecordingState): NativeImage => {
    let image = icons.get(state);
    if (!image) {
      image = circleIcon(ICON_COLOURS[state]);
      icons.set(state, image);
    }
    return image;
  };

  const tray = new Tray(icon('idle'));
  const apply = (state: TrayRecordingState): void => {
    tray.setImage(icon(state));
    tray.setToolTip(
      state === 'recording'
        ? 'Capture Studio: recording'
        : state === 'paused'
          ? 'Capture Studio: paused'
          : 'Capture Studio',
    );
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(state, bus, confirm)));
  };
  apply('idle');

  return {
    setState: apply,
    destroy: () => tray.destroy(),
  };
}
