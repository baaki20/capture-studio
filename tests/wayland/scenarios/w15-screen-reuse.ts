/**
 * W15: the shared screen is reused within an app run (P3 step 8, R3.19, spike S8).
 *
 * 1. The first recording asks the portal (one click).
 * 2. The second recording starts without a portal dialog and still gets frames.
 * 3. Diagnostics → "Choose the screen again" makes the next recording ask again.
 * 4. Stopping the share from GNOME's top-bar indicator forgets the screen, so the recording
 *    after that asks again too.
 *
 * The app logs "asking the portal for a screen" and "reusing the shared screen" for each
 * recording; the checks read those lines, and the human confirms what was seen on screen.
 */
import { readFileSync, statSync } from 'node:fs';
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

const ASKED = 'recording: asking the portal for a screen';
const REUSED = 'recording: reusing the shared screen';

/** Where the app's log ends now, to read only what comes after. */
function logOffset(app: AppSession): number {
  try {
    return statSync(app.options.logFile).size;
  } catch {
    return 0;
  }
}

function logSince(app: AppSession, offset: number): string {
  return readFileSync(app.options.logFile).subarray(offset).toString('utf8');
}

/** Records one portal-backed recording that must ask, and checks the log says so. */
async function askedRecording(
  ctx: Context,
  app: AppSession,
  out: ScenarioOutput,
  label: string,
): Promise<void> {
  const offset = logOffset(app);
  const { root } = await startRecording(ctx, app);
  out.projects.push(root);
  const log = logSince(app, offset);
  out.checks.push(
    check('R3.19', `${label}: the portal is asked`, log.includes(ASKED) && !log.includes(REUSED)),
  );
}

export const w15: Scenario = {
  id: 'W15',
  title: 'The shared screen is reused within an app run',
  requirements: ['R3.19'],
  humanActions: [
    '3 portal clicks',
    '1 click on the top-bar sharing indicator → Stop sharing',
    '3 yes/no questions',
  ],
  async run(ctx, out) {
    if (ctx.mode === 'dry-run') {
      out.checks.push(
        notTestable('R3.19', 'screen reuse', 'needs the GNOME portal (real run only)'),
      );
      return;
    }
    const app = await ctx.launch();
    try {
      await configure(ctx, app, {
        captureMode: 'fullscreen',
        cameraId: null,
        micId: null,
        systemAudio: false,
      });

      // 1. The first recording asks.
      await askedRecording(ctx, app, out, 'first recording');
      await recordFor('W15 first recording', 3_000);
      const first = await stopAndFinalize(app, 'R3.19');
      out.checks.push(...projectChecks(await inspectProject(first.root), 'R3.19'));
      const indicatorIdle = await ctx.human.yesNo(
        'Nothing is recording now. Is the screen-sharing indicator still in the top bar (top right)?',
        false,
      );
      out.checks.push(
        info(
          'R3.19',
          'sharing indicator between recordings (human)',
          indicatorIdle ? 'shown' : 'not shown',
        ),
      );

      // 2. The second one reuses the screen: no dialog.
      ctx.human.instruct('W15 — second recording', [
        'The harness starts a second recording now. No sharing dialog should appear.',
        'If one does appear anyway, share the screen as before; you are asked about it afterwards.',
      ]);
      const offset = logOffset(app);
      const mark = app.mark();
      await app.clickRecord();
      // Record passes through "configuring" first; wait for "acquiring" before judging the result.
      const acquiring = await app.waitState(
        (s) => s.state === 'acquiring' || s.state === 'failed',
        30_000,
        mark,
      );
      const started = await app.waitState(
        (s) => ['recording', 'failed', 'configuring', 'idle'].includes(s.state),
        180_000,
        acquiring.index,
      );
      out.checks.push(
        check(
          'R3.19',
          'second recording starts',
          started.value.state === 'recording',
          started.value.state,
        ),
      );
      if (started.value.state !== 'recording') return;
      const secondRoot = await app.waitRoot(30_000);
      out.projects.push(secondRoot);
      const log = logSince(app, offset);
      out.checks.push(
        check(
          'R3.19',
          'second recording: the remembered screen is reused, the portal not asked',
          log.includes(REUSED) && !log.includes(ASKED),
        ),
        check(
          'R3.19',
          'second recording: the reused screen was not stale',
          !log.includes('screen is stale'),
        ),
      );
      await recordFor('W15 second recording', 3_000);
      const second = await stopAndFinalize(app, 'R3.19');
      out.checks.push(...projectChecks(await inspectProject(second.root), 'R3.19'));
      const dialog = await ctx.human.yesNo(
        'Did a screen-sharing dialog appear for the second recording?',
        false,
      );
      out.checks.push(
        check('R3.19', 'no sharing dialog for the second recording (human)', !dialog),
      );

      // 3. "Choose the screen again" asks on the next one.
      const forgot = await app.evalIn<{ forgotten: boolean }>(
        'shell',
        'window.captureStudio.diag.forgetScreen()',
      );
      out.checks.push(check('R3.19', '"Choose the screen again" forgets it', forgot.forgotten));
      await askedRecording(ctx, app, out, 'after "Choose the screen again"');
      await recordFor('W15 third recording', 3_000);

      // 4. Stop sharing from GNOME: forgotten, and the next recording asks.
      const stopOffset = logOffset(app);
      const stopMark = app.mark();
      const stopping = await ctx.human.act(
        'W15 — stop sharing from the top bar',
        [
          'Click the screen-sharing indicator in the top bar (top right).',
          'Choose "Stop sharing" (or "Stop").',
        ],
        app.waitState(
          (s) => ['finalizing', 'failed', 'completed'].includes(s.state),
          120_000,
          stopMark,
        ),
        120_000,
      );
      await app.waitProject(stopping.at - 1, 10 * 60_000);
      await sleep(500);
      out.checks.push(
        check(
          'R3.19',
          'stopping the share in GNOME forgets the screen',
          logSince(app, stopOffset).includes('forgot the shared screen (ended)'),
        ),
      );
      await askedRecording(ctx, app, out, 'after GNOME stopped the share');
      await recordFor('W15 last recording', 3_000);
      const last = await stopAndFinalize(app, 'R3.19');
      out.checks.push(...projectChecks(await inspectProject(last.root), 'R3.19'));
      const indicatorAfter = await ctx.human.yesNo(
        'All recordings are done. Is the screen-sharing indicator still in the top bar?',
        false,
      );
      out.checks.push(
        info(
          'R3.19',
          'sharing indicator after the last recording (human)',
          indicatorAfter ? 'shown' : 'not shown',
        ),
      );
    } finally {
      await app.quit();
    }
  },
};
