import { describe, expect, it } from 'vitest';
import {
  buildActionCommand,
  normalizeCliAction,
  parseCliArgs,
  shellQuote,
} from '../../src/main/cli';
import { CLI_ACTIONS } from '../../src/shared/ipc/actions';

const electronArgv = ['/usr/lib/capture-studio/capture-studio', '--no-sandbox'];

describe('parseCliArgs (R1.2)', () => {
  it('returns no action without --action', () => {
    expect(parseCliArgs(electronArgv)).toEqual({ action: null, error: null });
  });

  it.each(CLI_ACTIONS)('accepts --action %s in both spellings', (action) => {
    expect(parseCliArgs([...electronArgv, '--action', action])).toEqual({ action, error: null });
    expect(parseCliArgs([...electronArgv, `--action=${action}`])).toEqual({ action, error: null });
  });

  it.each([
    ['start', 'new-recording'],
    ['stop', 'stop-recording'],
    ['pause', 'pause-recording'],
    ['resume', 'resume-recording'],
    ['toggle', 'toggle-recording'],
    ['TOGGLE-PAUSE', 'toggle-pause'],
  ])('maps %s to %s', (raw, action) => {
    expect(parseCliArgs(['app', '--action', raw]).action).toBe(action);
  });

  it('finds the flag among Chromium switches, last one wins', () => {
    expect(
      parseCliArgs(['app', '--ozone-platform=wayland', '--action', 'start', '.', '--action=stop'])
        .action,
    ).toBe('stop-recording');
  });

  it('reports unknown actions and missing values', () => {
    const unknown = parseCliArgs(['app', '--action', 'explode']);
    expect(unknown.action).toBeNull();
    expect(unknown.error).toContain('unknown action "explode"');
    expect(parseCliArgs(['app', '--action'])).toEqual({
      action: null,
      error: '--action needs a value',
    });
    expect(parseCliArgs(['app', '--action', '--foo'])).toMatchObject({ action: null });
    expect(parseCliArgs(['app', '--action='])).toMatchObject({ action: null });
  });

  it('normalizes names', () => {
    expect(normalizeCliAction(' New-Recording ')).toBe('new-recording');
    expect(normalizeCliAction('nope')).toBeNull();
  });
});

describe('shortcut commands (R1.4)', () => {
  it('quotes only when needed', () => {
    expect(shellQuote('/usr/bin/capture-studio')).toBe('/usr/bin/capture-studio');
    expect(shellQuote('/opt/Capture Studio/capture-studio')).toBe(
      "'/opt/Capture Studio/capture-studio'",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('uses the installed binary when packaged', () => {
    expect(
      buildActionCommand('toggle-recording', {
        isPackaged: true,
        execPath: '/opt/Capture Studio/capture-studio',
        appPath: '/opt/Capture Studio/resources/app.asar',
      }),
    ).toBe("'/opt/Capture Studio/capture-studio' --action toggle-recording");
  });

  it('uses the AppImage path when running from one', () => {
    expect(
      buildActionCommand('stop-recording', {
        isPackaged: true,
        execPath: '/tmp/.mount_x/capture-studio',
        appPath: '/tmp/.mount_x/resources/app.asar',
        appImage: '/home/u/Apps/Capture-Studio.AppImage',
      }),
    ).toBe('/home/u/Apps/Capture-Studio.AppImage --action stop-recording');
  });

  it('runs Electron with the project folder in development', () => {
    expect(
      buildActionCommand('new-recording', {
        isPackaged: false,
        execPath: '/p/node_modules/electron/dist/electron',
        appPath: '/home/u/My Projects/capture-studio',
      }),
    ).toBe(
      "/p/node_modules/electron/dist/electron '/home/u/My Projects/capture-studio' --action new-recording",
    );
  });
});
