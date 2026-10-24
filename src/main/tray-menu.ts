/** The tray menu (R1.3), kept free of Electron runtime imports so it can be unit-tested. */
import type { MenuItemConstructorOptions } from 'electron';
import type { ActionBus } from './action-bus';

export type TrayRecordingState = 'idle' | 'recording' | 'paused' | 'busy';

/** Asks the user to confirm a destructive action (a dialog in the app; tests answer directly). */
export type ConfirmAction = (kind: 'restart' | 'abort') => Promise<boolean>;

/**
 * Menu items for a recording state; every click dispatches on the action bus. Restart and Abort
 * ask for confirmation first (R1.12).
 */
export function trayMenuTemplate(
  state: TrayRecordingState,
  bus: ActionBus,
  confirm: ConfirmAction = () => Promise.resolve(true),
): MenuItemConstructorOptions[] {
  const active = state === 'recording' || state === 'paused';
  const confirmed = (kind: 'restart' | 'abort', type: 'restart-recording' | 'abort-recording') => {
    void confirm(kind).then((ok) => {
      if (ok) bus.dispatch({ type, source: 'tray' });
    });
  };
  return [
    {
      label: 'New recording',
      enabled: state === 'idle',
      click: () => bus.dispatch({ type: 'new-recording', source: 'tray' }),
    },
    {
      label: 'Stop',
      enabled: active,
      click: () => bus.dispatch({ type: 'stop-recording', source: 'tray' }),
    },
    {
      label: state === 'paused' ? 'Resume' : 'Pause',
      enabled: active,
      click: () => bus.dispatch({ type: 'toggle-pause', source: 'tray' }),
    },
    {
      label: 'Restart…',
      enabled: active,
      click: () => confirmed('restart', 'restart-recording'),
    },
    {
      label: 'Abort…',
      enabled: active,
      click: () => confirmed('abort', 'abort-recording'),
    },
    { type: 'separator' },
    { label: 'Open library', click: () => bus.dispatch({ type: 'open-library', source: 'tray' }) },
    { label: 'Quit', click: () => bus.dispatch({ type: 'quit', source: 'tray' }) },
  ];
}
