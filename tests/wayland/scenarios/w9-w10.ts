/**
 * - W9: tray present versus absent (R1.3). With the AppIndicator extension on, the tray follows
 *   idle → recording → paused → idle, and (optionally) Stop from the tray menu works. With it
 *   off, the app has no tray, recording still works through the CLI, and closing the main window
 *   while idle quits the app.
 * - W10: global shortcuts (R1.2, R1.4; §9.8: the portal is a no-go on GNOME, so the fallback is
 *   a GNOME custom shortcut running `--action`). The human binds two shortcuts once and presses
 *   them while Capture Studio is not focused.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AppSession } from '../lib/app';
import { check, info, inspectProject, notTestable, projectChecks } from '../lib/checks';
import {
  configure,
  recordFor,
  sleep,
  startRecording,
  stopAndFinalize,
  type Context,
  type Scenario,
  type ScenarioOutput,
} from '../lib/scenario';

const EXTENSION = 'ubuntu-appindicators@ubuntu.com';

/** Whether a StatusNotifier host is on the session bus (what the app's tray detection asks). */
function trayHostPresent(): boolean {
  const result = spawnSync('gdbus', [
    'call',
    '--session',
    '--dest',
    'org.freedesktop.DBus',
    '--object-path',
    '/org/freedesktop/DBus',
    '--method',
    'org.freedesktop.DBus.NameHasOwner',
    'org.kde.StatusNotifierWatcher',
  ]);
  return String(result.stdout).includes('true');
}

/** Shows `command` until the tray host is in the wanted state (the extension takes effect). */
async function setExtension(ctx: Context, enabled: boolean): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  ctx.human.instruct(`W9 — ${verb} the AppIndicator extension`, [
    `In another terminal run: gnome-extensions ${verb} ${EXTENSION}`,
    'Then press Enter.',
  ]);
  for (;;) {
    await ctx.human.enter();
    if (trayHostPresent() === enabled) return;
    ctx.human.info(
      `The tray host is still ${enabled ? 'missing' : 'running'}; run the command above, then press Enter.`,
    );
  }
}

const KEYBINDINGS = 'org.gnome.settings-daemon.plugins.media-keys';

/** GNOME custom shortcuts by name → their gsettings path and command. */
function customShortcuts(): Map<string, { path: string; command: string }> {
  const gsettings = (...args: string[]) => String(spawnSync('gsettings', args).stdout).trim();
  const unquote = (v: string) => v.replace(/^'|'$/g, '').replace(/^"|"$/g, '');
  const paths = [...gsettings('get', KEYBINDINGS, 'custom-keybindings').matchAll(/'([^']+)'/g)];
  const found = new Map<string, { path: string; command: string }>();
  for (const [, p] of paths) {
    if (!p) continue;
    const schema = `${KEYBINDINGS}.custom-keybinding:${p}`;
    found.set(unquote(gsettings('get', schema, 'name')), {
      path: p,
      command: unquote(gsettings('get', schema, 'command')),
    });
  }
  return found;
}

/** Offers to point already-bound CS shortcuts at the current command; true when both match. */
async function updateShortcuts(ctx: Context, wanted: Record<string, string>): Promise<boolean> {
  const bound = customShortcuts();
  const stale = Object.entries(wanted).filter(([name, cmd]) => {
    const b = bound.get(name);
    return b !== undefined && b.command !== cmd;
  });
  const missing = Object.keys(wanted).filter((name) => !bound.has(name));
  if (missing.length > 0) return false;
  if (stale.length === 0) return true;
  const yes = await ctx.human.yesNo(
    `Your ${stale.map(([n]) => `"${n}"`).join(' and ')} shortcut runs an old command. Update it now (gsettings)?`,
    false,
  );
  if (!yes) return false;
  for (const [name, cmd] of stale) {
    const b = bound.get(name);
    if (b)
      spawnSync('gsettings', ['set', `${KEYBINDINGS}.custom-keybinding:${b.path}`, 'command', cmd]);
  }
  return true;
}

async function trayState(app: AppSession): Promise<{ present: boolean; state: string }> {
  return (await app.status()).tray;
}

async function variantWithTray(ctx: Context, out: ScenarioOutput): Promise<void> {
  const app = await ctx.launch();
  try {
    let tray = await trayState(app);
    if (!tray.present && ctx.mode === 'real') {
      ctx.human.instruct('W9 — tray', [
        `No tray was found. Enable the AppIndicator extension (run: gnome-extensions enable ${EXTENSION}).`,
        'Then press Enter; the app is restarted.',
      ]);
      await ctx.human.enter();
      await app.quit();
      await variantWithTray(ctx, out);
      return;
    }
    out.checks.push(
      check('R1.3', 'with AppIndicator: tray icon present', tray.present, String(tray.present)),
    );
    if (!tray.present) return;
    out.checks.push(check('R1.3', 'tray shows idle', tray.state === 'idle', tray.state));
    await configure(ctx, app, {
      captureMode: 'fullscreen',
      cameraId: null,
      micId: ctx.devices.roomMicId,
      systemAudio: false,
    });
    await startRecording(ctx, app);
    tray = await trayState(app);
    out.checks.push(check('R1.3', 'tray shows recording', tray.state === 'recording', tray.state));
    const mark = app.mark();
    await app.cli('pause-recording');
    await app.waitState((s) => s.state === 'paused', 10_000, mark);
    tray = await trayState(app);
    out.checks.push(check('R1.3', 'tray shows paused', tray.state === 'paused', tray.state));
    await app.cli('resume-recording');
    await sleep(1_000);
    // One instruction, then the question afterwards: asking first invited an early click.
    const stopMark = app.mark();
    let root: string;
    if (ctx.mode === 'real') {
      const finalizing = await ctx.human.act(
        'W9 — stop from the tray',
        [
          'Click the Capture Studio tray icon (the circle in the top bar, not the screen-sharing indicator).',
          'Look at the menu items, then click "Stop".',
        ],
        app.waitState((s) => s.state === 'finalizing', 120_000, stopMark),
        120_000,
      );
      // The app logs where each action came from; the last stop must be the tray's.
      await sleep(500);
      const stops = readFileSync(app.options.logFile, 'utf8').match(
        /action: stop-recording \(from \w+\)/g,
      );
      const viaTray = stops?.at(-1)?.includes('from tray') === true;
      out.checks.push(
        check('R1.3', 'Stop from the tray menu stops', viaTray, viaTray ? 'from tray' : 'other'),
      );
      root = (await app.waitProject(finalizing.at - 1, 10 * 60_000)).value.root;
      const listed = await ctx.human.yesNo(
        'Did the menu list New recording, Stop, Pause, Restart…, Abort…, Open library and Quit?',
        true,
      );
      const seen = listed
        ? 'as specified'
        : await ctx.human.ask('Type the items you saw, top to bottom, separated by commas:');
      out.checks.push(check('R1.3', 'tray menu items (human)', listed, seen));
    } else {
      root = (await stopAndFinalize(app)).root;
    }
    out.projects.push(root);
    tray = await trayState(app);
    out.checks.push(check('R1.3', 'tray back to idle', tray.state === 'idle', tray.state));
  } finally {
    await app.quit();
  }
}

async function variantWithoutTray(ctx: Context, out: ScenarioOutput): Promise<void> {
  if (ctx.mode === 'dry-run') {
    out.checks.push(
      notTestable(
        'R1.3',
        'without a tray',
        'needs the AppIndicator extension disabled (real run only)',
      ),
    );
    return;
  }
  await setExtension(ctx, false);
  const app = await ctx.launch();
  try {
    const tray = await trayState(app);
    out.checks.push(
      check('R1.3', 'without AppIndicator: no tray icon', !tray.present, String(tray.present)),
    );
    await configure(ctx, app, {
      captureMode: 'fullscreen',
      cameraId: null,
      micId: null,
      systemAudio: false,
    });
    await startRecording(ctx, app);
    const controls = (await app.windows()).find((w) => w.role === 'controls');
    out.checks.push(
      check(
        'R1.3',
        'controls window available as the fallback',
        controls !== undefined,
        controls ? 'present' : 'missing',
      ),
    );
    await recordFor('W9 recording without a tray', 5_000);
    const stopped = await stopAndFinalize(app);
    out.projects.push(stopped.root);
    out.checks.push(...projectChecks(await inspectProject(stopped.root), 'R1.3'));
    await sleep(1_000);
    // Without a tray, closing the main window while idle quits the app.
    await app.call('shell.close');
    const quit = await Promise.race([app.exited.then(() => true), sleep(10_000).then(() => false)]);
    out.checks.push(
      check(
        'R1.3',
        'closing the main window while idle quits',
        quit,
        quit ? 'app exited' : 'still running',
      ),
    );
  } finally {
    await app.quit();
    await setExtension(ctx, true);
  }
}

export const w9: Scenario = {
  id: 'W9',
  title: 'Tray present versus absent',
  requirements: ['R1.3'],
  humanActions: [
    '1 portal click per variant (2)',
    'disable and re-enable the AppIndicator extension',
  ],
  async run(ctx, out) {
    await variantWithTray(ctx, out);
    await variantWithoutTray(ctx, out);
  },
};

export const w10: Scenario = {
  id: 'W10',
  title: 'Global shortcuts through GNOME custom shortcuts',
  requirements: ['R1.2', 'R1.4'],
  humanActions: [
    'bind 2 GNOME custom shortcuts once',
    'press them while another window is focused',
    '1 portal click',
  ],
  async run(ctx, out) {
    const app = await ctx.launch();
    try {
      await configure(ctx, app, {
        captureMode: 'fullscreen',
        cameraId: null,
        micId: null,
        systemAudio: false,
      });
      const toggle = app.shortcutCommand('toggle-recording');
      const pause = app.shortcutCommand('toggle-pause');
      out.checks.push(
        notTestable(
          'R1.4',
          'portal global shortcuts',
          'spike S7: no-go on GNOME Wayland (§9.8); custom shortcuts are the path',
        ),
      );
      // A press made before the operator confirms the binding (Enter) still counts.
      const earlyMark = app.mark();
      const press = async (
        keys: string,
        command: string,
        label: string,
        want: (s: string) => boolean,
        mark = app.mark(),
      ) => {
        if (ctx.mode === 'dry-run') {
          spawn('sh', ['-c', command], { stdio: 'ignore' });
          return app.waitState((s) => want(s.state), 30_000, mark);
        }
        return ctx.human.act(
          `W10 — press ${keys}`,
          [`Press ${keys} (${label}).`],
          app.waitState((s) => want(s.state), 120_000, mark),
          120_000,
        );
      };
      const bound =
        ctx.mode === 'real' &&
        (await updateShortcuts(ctx, { 'CS record': toggle, 'CS pause': pause }));
      if (bound) {
        ctx.human.instruct('W10 — shortcuts bound', [
          'Click on this terminal so Capture Studio is NOT the focused window.',
        ]);
        await ctx.human.enter();
      } else if (ctx.mode === 'real') {
        ctx.human.instruct('W10 — bind two shortcuts (once)', [
          'Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → "+".',
          `Name "CS record", Command: ${toggle}`,
          'Shortcut: Super+Alt+R. Add.',
          `Then "+" again: Name "CS pause", Command: ${pause}`,
          'Shortcut: Super+Alt+P. Add. Close Settings.',
          'Click on this terminal so Capture Studio is NOT the focused window.',
        ]);
        await ctx.human.enter('Press Enter when both are bound (they stay bound for later runs)');
      } else {
        out.notes.push('Dry run: the bound commands are run directly instead of pressing keys.');
      }
      const focused = async () => (await app.windows()).some((w) => w.focused);
      const unfocused = !(await focused());
      out.checks.push(
        ctx.mode === 'real'
          ? check(
              'R1.2',
              'Capture Studio is not focused before the shortcut',
              unfocused,
              unfocused ? 'unfocused' : 'focused',
            )
          : info('R1.2', 'focus before the shortcut', unfocused ? 'unfocused' : 'focused'),
      );
      const acquiring = await press(
        'Super+Alt+R',
        toggle,
        'start recording',
        (s) => ['acquiring', 'countdown', 'recording'].includes(s),
        earlyMark,
      );
      out.checks.push(
        check('R1.2', 'shortcut starts a recording while unfocused', true, acquiring.value.state),
      );
      if (ctx.mode === 'real') {
        await ctx.human.act(
          'Portal: share your screen',
          ['Choose your monitor and click "Share".', 'Then click on this terminal again.'],
          app.waitState((s) => s.state === 'recording', 180_000, acquiring.index),
          180_000,
        );
      } else {
        await app.waitState((s) => s.state === 'recording', 60_000, acquiring.index);
      }
      await sleep(2_000);
      const paused = await press('Super+Alt+P', pause, 'pause', (s) => s === 'paused');
      out.checks.push(check('R1.2', 'pause shortcut pauses', paused.value.state === 'paused'));
      const resumed = await press('Super+Alt+P', pause, 'resume', (s) => s === 'recording');
      out.checks.push(check('R1.2', 'pause shortcut resumes', resumed.value.state === 'recording'));
      await sleep(2_000);
      const since = Date.now();
      const stopping = await press('Super+Alt+R', toggle, 'stop', (s) => s === 'finalizing');
      out.checks.push(
        check('R1.2', 'record shortcut stops', stopping.value.state === 'finalizing'),
      );
      const ready = await app.waitProject(since, 10 * 60_000);
      out.projects.push(ready.value.root);
      out.checks.push(...projectChecks(await inspectProject(ready.value.root), 'R1.2'));
    } finally {
      await app.quit();
    }
  },
};
