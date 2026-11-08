/**
 * The application menu: Electron's default menu, except that File → Quit (Ctrl+Q) goes through the
 * quit guard as a quit the user asked for, so a recording in progress is asked about (F-7).
 * Electron's own `quit` role cannot be told apart from SIGTERM. On macOS the first menu is the
 * application menu (About, Services, Hide, Quit), as the platform expects, and Quit lives there.
 * Kept free of Electron runtime imports so it can be unit-tested.
 */
import type { MenuItemConstructorOptions } from 'electron';

export function appMenuTemplate(
  quitInteractively: () => void,
  platform: NodeJS.Platform = process.platform,
  appName = 'Capture Studio',
): MenuItemConstructorOptions[] {
  const quit: MenuItemConstructorOptions = {
    label: platform === 'darwin' ? `Quit ${appName}` : '&Quit',
    accelerator: 'CmdOrCtrl+Q',
    click: () => quitInteractively(),
  };
  const first: MenuItemConstructorOptions[] =
    platform === 'darwin'
      ? [
          {
            label: appName,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              quit,
            ],
          },
          { label: 'File', submenu: [{ role: 'close' }] },
        ]
      : [{ label: '&File', submenu: [quit] }];
  return [...first, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }];
}
