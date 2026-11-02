/**
 * Scenarios that need a physical action or the portal itself, so they cannot run in a dry run:
 *
 * - W3: stop through GNOME's "stop sharing" indicator → graceful stop and a valid project (R1.15).
 * - W4: unplug the USB headset mic mid-recording → the recording continues, the mic ends early
 *   with `endedEarly`, and a notice names the device (R1.16).
 * - W5: cancel the portal → back to the panel, no project folder, no error (R1.8).
 */
import { readdirSync } from 'node:fs';
import { check, info, inspectProject, notTestable, projectChecks, type Check } from '../lib/checks';
import {
  configure,
  recordFor,
  requireDevices,
  sleep,
  startRecording,
  stopAndFinalize,
  type Context,
  type Scenario,
} from '../lib/scenario';

function dryRun(
  ctx: Context,
  requirement: string,
  out: { checks: Check[] },
  what: string,
): boolean {
  if (ctx.mode !== 'dry-run') return false;
  out.checks.push(
    notTestable(requirement, what, 'needs the GNOME portal or a physical action (real run only)'),
  );
  return true;
}

export const w3: Scenario = {
  id: 'W3',
  title: 'Stop from the GNOME "stop sharing" indicator',
  requirements: ['R1.15'],
  humanActions: ['1 portal click', '1 click on the top-bar sharing indicator → Stop sharing'],
  async run(ctx, out) {
    if (dryRun(ctx, 'R1.15', out, 'graceful stop when the screen stream ends')) return;
    const app = await ctx.launch();
    try {
      await configure(ctx, app, {
        captureMode: 'fullscreen',
        cameraId: null,
        micId: ctx.devices.roomMicId,
        systemAudio: true,
      });
      const { root, startedAt } = await startRecording(ctx, app);
      out.projects.push(root);
      await recordFor('W3 recording', 8_000);
      const mark = app.mark();
      const stopping = await ctx.human.act(
        'W3 — stop sharing from the top bar',
        [
          'Click the screen-sharing indicator in the top bar (top right).',
          'Choose "Stop sharing" (or "Stop").',
        ],
        app.waitState(
          (s) => ['finalizing', 'failed', 'completed'].includes(s.state),
          120_000,
          mark,
        ),
        120_000,
      );
      const elapsedS = (stopping.at - startedAt) / 1000;
      out.checks.push(
        check(
          'R1.15',
          'the recording stops gracefully (finalizing, not failed)',
          stopping.value.state === 'finalizing',
          stopping.value.state,
        ),
      );
      const ready = await app.waitProject(stopping.at - 1, 10 * 60_000);
      const project = await inspectProject(ready.value.root);
      out.checks.push(...projectChecks(project, 'R1.15'));
      out.checks.push(
        check(
          'R1.15',
          'a notice says screen sharing ended',
          app.notices.some((n) => /screen sharing ended/i.test(n.value.message)),
          app.notices.map((n) => n.value.message).join(' | ') || 'none',
        ),
      );
      const screen = project.media.find((m) => m.role === 'screen');
      out.checks.push(
        check(
          'R1.15',
          'the screen file covers the recording',
          (screen?.probedUs ?? 0) / 1e6 >= elapsedS - 2,
          `${((screen?.probedUs ?? 0) / 1e6).toFixed(1)} s of ${elapsedS.toFixed(1)} s`,
        ),
      );
    } finally {
      await app.quit();
    }
  },
};

export const w4: Scenario = {
  id: 'W4',
  title: 'Unplug the USB headset (mic) mid-recording',
  requirements: ['R1.16'],
  humanActions: ['1 portal click', 'unplug the USB headset when asked, plug it back in at the end'],
  async run(ctx, out) {
    if (dryRun(ctx, 'R1.16', out, 'a disconnected device ends early and recording continues'))
      return;
    if (!ctx.devices.unplugMicId) {
      out.checks.push(
        notTestable(
          'R1.16',
          'unplug the headset mic',
          'no unpluggable (USB) mic was chosen at setup',
        ),
      );
      return;
    }
    const app = await ctx.launch();
    try {
      await configure(ctx, app, {
        captureMode: 'fullscreen',
        cameraId: ctx.devices.cameraId,
        micId: ctx.devices.unplugMicId,
        systemAudio: true,
      });
      const { root, startedAt } = await startRecording(ctx, app);
      out.projects.push(root);
      await recordFor('W4 recording', 8_000);
      // The mic must be recording before the unplug, or the test measures nothing.
      const early = app.notices.find((n) => n.value.stream === 'mic');
      if (early) {
        out.checks.push(
          check('R1.16', 'the mic opened before the unplug', false, early.value.message),
        );
        return;
      }
      const noticesBefore = app.notices.length;
      const notice = await ctx.human.act(
        'W4 — unplug the headset',
        [`Unplug the USB headset now (${ctx.devices.unplugMicLabel ?? 'the chosen mic'}).`],
        (async () => {
          for (;;) {
            const hit = app.notices.slice(noticesBefore).find((n) => n.value.stream === 'mic');
            if (hit) return hit;
            await sleep(200);
          }
        })(),
        120_000,
      );
      const unpluggedS = (notice.at - startedAt) / 1000;
      out.checks.push(info('R1.16', 'notice', notice.value.message));
      const label = ctx.devices.unplugMicLabel ?? '';
      out.checks.push(
        check(
          'R1.16',
          'the notice names the device',
          label !== '' && notice.value.message.includes(label.slice(0, 12)),
          notice.value.message,
        ),
      );
      await recordFor('W4 recording without the mic', 10_000);
      const status = await app.status();
      out.checks.push(
        check('R1.16', 'recording continues', status.state === 'recording', status.state),
      );
      const stopped = await stopAndFinalize(app);
      out.checks.push(...stopped.checks);
      const project = await inspectProject(stopped.root);
      out.checks.push(...projectChecks(project, 'R1.16'));
      const mic = project.media.find((m) => m.role === 'microphone');
      const screen = project.media.find((m) => m.role === 'screen');
      out.checks.push(
        check(
          'R1.16',
          'mic media is marked endedEarly',
          mic?.endedEarly === true,
          String(mic?.endedEarly ?? 'no mic media'),
        ),
      );
      // Session time: the mic file starts at its offset (1.5 s in the re-run), not at 0.
      const micEndS = ((mic?.startOffsetUs ?? 0) + (mic?.probedUs ?? 0)) / 1e6;
      out.checks.push(
        check(
          'R1.16',
          'mic ends near the unplug time',
          mic !== undefined && Math.abs(micEndS - unpluggedS) < 3,
          `${micEndS.toFixed(1)} s (unplugged at ${unpluggedS.toFixed(1)} s)`,
        ),
      );
      out.checks.push(
        check(
          'R1.16',
          'screen keeps going after the unplug',
          (screen?.probedUs ?? 0) / 1e6 > unpluggedS + 8,
          `${((screen?.probedUs ?? 0) / 1e6).toFixed(1)} s`,
        ),
      );
    } finally {
      // Asks for the headset back (only if it is still unplugged) before the next scenario.
      await requireDevices(ctx, app, [ctx.devices.unplugMicId]).catch(() => undefined);
      await app.quit();
    }
  },
};

export const w5: Scenario = {
  id: 'W5',
  title: 'Cancel the portal dialog',
  requirements: ['R1.8'],
  humanActions: ['1 click: Cancel in the portal dialog'],
  async run(ctx, out) {
    if (dryRun(ctx, 'R1.8', out, 'cancelling the portal leaves no project and no error')) return;
    const app = await ctx.launch();
    try {
      await configure(ctx, app, {
        captureMode: 'fullscreen',
        cameraId: null,
        micId: null,
        systemAudio: false,
      });
      const before = readdirSync(ctx.projectsDir).filter((n) => n.endsWith('.cstudio')).length;
      const mark = app.mark();
      await app.clickRecord();
      const acquiring = await app.waitState((s) => s.state === 'acquiring', 30_000, mark);
      const back = await ctx.human.act(
        'W5 — cancel the portal',
        ['In the "Share Screen" dialog, click "Cancel".'],
        app.waitState((s) => s.state !== 'acquiring', 120_000, acquiring.index + 1),
        120_000,
      );
      await sleep(1_000);
      const after = readdirSync(ctx.projectsDir).filter((n) => n.endsWith('.cstudio')).length;
      out.checks.push(
        check(
          'R1.8',
          'returns to the setup panel',
          back.value.state === 'configuring',
          back.value.state,
        ),
      );
      out.checks.push(
        check(
          'R1.8',
          'no project folder is created',
          after === before,
          `${String(after - before)} new`,
        ),
      );
      const errors = app.notices.filter((n) => n.value.level === 'error');
      out.checks.push(
        check(
          'R1.8',
          'no error notice',
          errors.length === 0,
          errors.map((e) => e.value.message).join(' | ') || 'none',
        ),
      );
      const alert = await app.evalIn<string | null>(
        'shell',
        `document.querySelector('[role="alert"]')?.textContent ?? null`,
      );
      out.checks.push(check('R1.8', 'no error shown in the panel', !alert, alert ?? 'none'));
    } finally {
      await app.quit();
    }
  },
};
