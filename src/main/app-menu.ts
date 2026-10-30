/**
 * The application menu: Electron's default menu, except that File → Quit (Ctrl+Q) goes through the
 * quit guard as a quit the user asked for, so a recording in progress is asked about (F-7).
 * Electron's own `quit` role cannot be told apart from SIGTERM. Kept free of Electron runtime
 * imports so it can be unit-tested.
 */
import type { MenuItemConstructorOptions } from 'electron';

export function appMenuTemplate(quitInteractively: () => void): MenuItemConstructorOptions[] {
  return [
    {
      label: '&File',
      submenu: [{ label: '&Quit', accelerator: 'CmdOrCtrl+Q', click: () => quitInteractively() }],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
