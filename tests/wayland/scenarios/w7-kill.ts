/**
 * W7: SIGKILL the app during a recording, relaunch, recover (R1.21). The next launch must offer
 * the recording; the recovered project holds every stream up to at most 2 s before the kill, in
 * sync per R1.24, with `recording.state = "recovered"`. Recovery itself is driven through the
 * control channel (the same service the Recover button calls).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { analyzeProject } from '../../sync/analysis';
import { check, errorCheck, info, inspectProject, projectChecks, syncChecks } from '../lib/checks';
import { Pattern } from '../lib/pattern';
import {
  configure,
  portalHint,
  recordFor,
  sleep,
  startRecording,
  type Scenario,
} from '../lib/scenario';

interface Candidate {
  id: string;
  name: string;
  state: string;
}

function pwRecordPids(): string[] {
  return spawnSync('pgrep', ['-x', 'pw-record']).stdout.toString().split('\n').filter(Boolean);
}

export const w7: Scenario = {
  id: 'W7',
  title: 'SIGKILL during recording, relaunch, recover',
  requirements: ['R1.21', 'R1.24'],
  humanActions: ['1 portal click'],
  async run(ctx, out) {
    ctx.human.instruct('W7 — before you start', [
      'Speakers on. The pattern flashes and beeps; the harness kills the app mid-recording and restarts it.',
      ...portalHint(ctx.mode),
    ]);
    await ctx.human.enter();
    let app = await ctx.launch();
    let pattern: Pattern | null = null;
    try {
      await configure(ctx, app, {
        captureMode: 'fullscreen',
        cameraId: ctx.devices.cameraId,
        micId: ctx.devices.roomMicId,
        systemAudio: ctx.mode === 'real',
      });
      pattern = await Pattern.start({ mode: ctx.mode, mute: ctx.mode === 'dry-run' });
      const before = pwRecordPids();
      const { root, startedAt } = await startRecording(ctx, app);
      out.projects.push(root);
      await recordFor('W7 recording', ctx.durations.w7S * 1000);
      const killedAt = Date.now();
      const killS = (killedAt - startedAt) / 1000;
      await app.kill();
      out.checks.push(info('R1.21', 'killed after', `${killS.toFixed(1)} s`));
      await pattern.close();
      pattern = null;
      // The utility's pw-record must die with the app: count the ones that appeared since the
      // recording started and are still running.
      await sleep(2_000);
      const leftover = pwRecordPids().filter((pid) => !before.includes(pid));
      out.checks.push(
        check(
          'R1.21',
          'no capture process outlives the kill',
          leftover.length === 0,
          String(leftover.length),
          '0',
          leftover.length ? `pw-record pids ${leftover.join(', ')}` : undefined,
        ),
      );

      // The lock goes stale after 15 s (§1.5); relaunch after that.
      await sleep(16_000);
      app = await ctx.launch();
      const candidates = await app.call<Candidate[]>('recovery.list');
      const match = candidates.find((c) => c.name === path.basename(root, '.cstudio'));
      out.checks.push(
        check(
          'R1.21',
          'the next launch offers the recording',
          match !== undefined,
          `${String(candidates.length)} candidate(s)`,
        ),
      );
      const offered = await app
        .evalIn<boolean>('shell', `document.body.innerText.includes('Recover')`)
        .catch(() => false);
      out.checks.push(
        check('R1.21', 'the main window shows "Recover"', offered, offered ? 'shown' : 'not shown'),
      );
      if (!match) return;
      await app.call('recovery.recover', { id: match.id }, 10 * 60_000);
      const project = await inspectProject(root);
      out.checks.push(...projectChecks(project, 'R1.21', 'recovered'));
      for (const m of project.doc?.media ?? []) {
        const file = project.media.find((f) => f.path === m.path);
        const endS = (m.startOffsetUs + (file?.probedUs ?? 0) * m.clockRatio) / 1e6;
        out.checks.push(
          check(
            'R1.21',
            `${m.role} reaches within 2 s of the kill`,
            endS >= killS - 2,
            `ends at ${endS.toFixed(1)} s`,
            `≥ ${(killS - 2).toFixed(1)} s`,
          ),
        );
      }
      try {
        const report = analyzeProject(root);
        out.checks.push(...syncChecks(report, { label: 'recovered', limitMs: 40 }));
      } catch (error) {
        out.checks.push(errorCheck('R1.24', 'recovered: sync analysis', error));
      }
    } finally {
      await pattern?.close();
      await app.quit();
    }
  },
};
