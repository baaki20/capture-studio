/**
 * The commands of the test-only control channel (`harness-channel.ts`, §4.6.5). `index.ts`
 * supplies the app objects; window commands find windows by their page (`<role>/index.html`).
 *
 * | command            | does                                                              |
 * |--------------------|-------------------------------------------------------------------|
 * | `status`           | recording state, active project, pid, tray, projects folder       |
 * | `action`           | dispatches a recording/app action on the action bus               |
 * | `settings.get`     | the current settings                                              |
 * | `settings.patch`   | patches settings (recorder setup, disk thresholds, folders)       |
 * | `free-bytes`       | overrides the disk monitor's free space (`null` clears it; R1.17) |
 * | `windows`          | every window's role, title, visible/minimized/focused             |
 * | `key`              | sends a key press to a window (`{ window, key }`)                 |
 * | `drag`             | drags the mouse in a window (`{ window, from, to }`, fractions)   |
 * | `eval`             | runs JavaScript in a window's page (`{ window, code }`)           |
 * | `displays`         | the displays with bounds and scale factor (W6)                    |
 * | `recovery.list`    | interrupted recordings (R1.21)                                    |
 * | `recovery.recover` | recovers one (`{ id }`)                                           |
 * | `editor.open`      | opens a project in the editor (`{ projectId }`)                   |
 * | `metrics`          | the current recording's metrics samples                           |
 * | `capabilities`     | the capability report                                             |
 * | `shell.close`      | closes the main window (R1.3 without a tray)                      |
 * | `quit`             | quits the app                                                     |
 */
import { BrowserWindow, screen } from 'electron';
import { APP_ACTIONS, CLI_ACTIONS, type AppActionType } from '../../shared/ipc/actions';
import type { Settings } from '../../shared/settings/schema';
import type { SettingsPatch } from '../settings/store';
import type { FreeSpaceOverride, HarnessHandler } from './harness-channel';

export const WINDOW_ROLES = ['shell', 'controls', 'picker', 'editor', 'engine'] as const;
export type WindowRole = (typeof WINDOW_ROLES)[number];

/** The role of a window from its page URL (`…/controls/index.html?…`), or null. */
export function windowRole(url: string): WindowRole | null {
  const match = /\/(shell|controls|picker|editor|engine)\/index\.html/.exec(url);
  return (match?.[1] as WindowRole | undefined) ?? null;
}

export interface HarnessCommandDeps {
  status: () => unknown;
  dispatch: (type: AppActionType) => void;
  settings: { get(): Settings; patch(patch: SettingsPatch): Promise<Settings> };
  freeSpace: FreeSpaceOverride;
  recovery: {
    list(): Promise<unknown>;
    recover(id: string): Promise<unknown>;
  };
  openEditor: (projectId: string) => Promise<void>;
  metrics: () => unknown;
  capabilities: () => unknown;
  closeShell: () => void;
  quit: () => void;
}

function record(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) throw new Error('arguments must be an object');
  return args as Record<string, unknown>;
}

function stringArg(args: unknown, key: string): string {
  const value = record(args)[key];
  if (typeof value !== 'string' || value === '') throw new Error(`"${key}" must be a string`);
  return value;
}

function findWindow(args: unknown): BrowserWindow {
  const role = stringArg(args, 'window');
  const window = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && windowRole(w.webContents.getURL()) === role,
  );
  if (!window) throw new Error(`no ${role} window`);
  return window;
}

const ACTIONS: readonly string[] = [...CLI_ACTIONS, ...APP_ACTIONS];

export function harnessCommands(deps: HarnessCommandDeps): Record<string, HarnessHandler> {
  return {
    status: () => deps.status(),
    action: (args) => {
      const type = stringArg(args, 'type');
      if (!ACTIONS.includes(type)) throw new Error(`unknown action ${type}`);
      deps.dispatch(type as AppActionType);
      return null;
    },
    'settings.get': () => deps.settings.get(),
    'settings.patch': (args) => deps.settings.patch(record(args)),
    'free-bytes': (args) => {
      const bytes = record(args).bytes;
      deps.freeSpace.set(typeof bytes === 'number' ? bytes : null);
      return deps.freeSpace.current;
    },
    windows: () =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed())
        .map((w) => ({
          id: w.id,
          role: windowRole(w.webContents.getURL()),
          title: w.getTitle(),
          visible: w.isVisible(),
          minimized: w.isMinimized(),
          focused: w.isFocused(),
          bounds: w.getBounds(),
        })),
    key: (args) => {
      const window = findWindow(args);
      const keyCode = stringArg(args, 'key');
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      return null;
    },
    drag: async (args) => {
      const window = findWindow(args);
      const point = (key: string): [number, number] => {
        const value = record(args)[key];
        const [fx, fy] = Array.isArray(value) ? (value as unknown[]) : [];
        if (typeof fx !== 'number' || typeof fy !== 'number') {
          throw new Error(`"${key}" must be [x, y] fractions of the window`);
        }
        const [width = 0, height = 0] = window.getContentSize();
        return [Math.round(fx * width), Math.round(fy * height)];
      };
      const [x0, y0] = point('from');
      const [x1, y1] = point('to');
      const send = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number) =>
        window.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
      send('mouseMove', x0, y0);
      send('mouseDown', x0, y0);
      for (let step = 1; step <= 10; step++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        send('mouseMove', x0 + ((x1 - x0) * step) / 10, y0 + ((y1 - y0) * step) / 10);
      }
      send('mouseUp', x1, y1);
      return null;
    },
    eval: (args) => findWindow(args).webContents.executeJavaScript(stringArg(args, 'code'), true),
    displays: () =>
      screen.getAllDisplays().map((d) => ({
        id: d.id,
        label: d.label,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        primary: d.id === screen.getPrimaryDisplay().id,
      })),
    'recovery.list': () => deps.recovery.list(),
    'recovery.recover': (args) => deps.recovery.recover(stringArg(args, 'id')),
    'editor.open': (args) => deps.openEditor(stringArg(args, 'projectId')),
    metrics: () => deps.metrics(),
    capabilities: () => deps.capabilities(),
    'shell.close': () => {
      deps.closeShell();
      return null;
    },
    quit: () => {
      setTimeout(() => deps.quit(), 50);
      return null;
    },
  };
}
