/**
 * Long runs with the sync-check pattern:
 *
 * - W8: a 30-minute drift run: R1.24 at the start (≤ 40 ms) and after 30 minutes (≤ 60 ms).
 * - soak (§4.6.4): 60 minutes of a 1920×1080 region + camera + mic + system audio:
 *   R1.22 dropped frames over the first 10 minutes (< 1 %), R1.23 memory growth after minute 5
 *   (< 300 MB, from `logs/metrics.json`), W8's drift check at 30 minutes, the project opens,
 *   5 minutes of preview playback with no late frames over 1 % and no audio underruns, and an
 *   export at Draft quality.
 */
import { timelineDurationUs } from '../../../src/shared/project/timeline-ops';
import { analyzeProject, offsetNear } from '../../sync/analysis';
import type { MetricsFile } from '../../../src/main/diagnostics/metrics-sampler';
import type { AppSession } from '../lib/app';
import {
  check,
  droppedChecks,
  errorCheck,
  info,
  inspectProject,
  ms,
  pct,
  projectChecks,
  syncChecks,
  type Check,
} from '../lib/checks';
import { countdown } from '../lib/human';
import { Pattern } from '../lib/pattern';
import {
  configure,
  exportProject,
  portalHint,
  sleep,
  startRecording,
  stopAndFinalize,
  type Context,
  type ScenarioOutput,
  type Scenario,
} from '../lib/scenario';

interface Display {
  bounds: { width: number; height: number };
  scaleFactor: number;
  primary: boolean;
}

/** Picker fractions for a centred 1920×1080 region on the primary display (R1.22). */
async function hdRegion(
  app: AppSession,
): Promise<{ from: [number, number]; to: [number, number] }> {
  const displays = await app.call<Display[]>('displays');
  const d = displays.find((x) => x.primary) ?? displays[0];
  const w = Math.min(1, 1920 / ((d?.bounds.width ?? 1920) * (d?.scaleFactor ?? 1)));
  const h = Math.min(1, 1080 / ((d?.bounds.height ?? 1080) * (d?.scaleFactor ?? 1)));
  return {
    from: [0.5 - w / 2 + 0.001, 0.5 - h / 2 + 0.001],
    to: [0.5 + w / 2 - 0.001, 0.5 + h / 2 - 0.001],
  };
}

/** Records the pattern for `minutes`, printing progress every minute. */
async function patternRun(
  ctx: Context,
  out: ScenarioOutput,
  app: AppSession,
  options: { id: string; minutes: number; region: boolean },
): Promise<string> {
  await configure(ctx, app, {
    captureMode: options.region ? 'region' : 'fullscreen',
    cameraId: ctx.devices.cameraId,
    micId: ctx.devices.roomMicId,
    systemAudio: ctx.mode === 'real',
  });
  const pattern = await Pattern.start({ mode: ctx.mode, mute: ctx.mode === 'dry-run' });
  try {
    const { root, startedAt } = await startRecording(
      ctx,
      app,
      options.region ? { region: await hdRegion(app) } : {},
    );
    out.projects.push(root);
    const end = startedAt + options.minutes * 60_000;
    while (Date.now() < end) {
      await countdown(`${options.id} recording`, Math.min(60_000, end - Date.now()));
      const status = await app.status();
      const metrics = await app.call<MetricsFile | null>('metrics').catch(() => null);
      const last = metrics?.samples.at(-1);
      ctx.log(
        `${options.id}: ${status.state}, ${((Date.now() - startedAt) / 60_000).toFixed(1)} min` +
          (last
            ? `, memory ${(last.totalWorkingSetKb / 1024).toFixed(0)} MB, dropped screen ${pct(last.dropped?.screen)} camera ${pct(last.dropped?.camera)}`
            : ''),
      );
      if (status.state !== 'recording')
        throw new Error(`recording stopped early (${status.state})`);
    }
    return root;
  } finally {
    await pattern.close();
  }
}

function driftChecks(root: string, minutes: number, label: string): Check[] {
  const report = analyzeProject(root, { windowS: 60 });
  const out: Check[] = [];
  const atStart = (role: string) =>
    offsetNear(report.offsets[role]?.pairs ?? [], 60, 60)?.medianMs ?? null;
  out.push(
    ...syncChecks(report, { label: `${label} start (first 2 min)`, limitMs: 40, at: atStart }),
  );
  const at = Math.min(30, minutes) * 60;
  const atLater = (role: string) =>
    offsetNear(report.offsets[role]?.pairs ?? [], at - 60, 60)?.medianMs ?? null;
  out.push(
    ...syncChecks(report, {
      label: `${label} at ${(at / 60).toFixed(0)} min${minutes < 30 ? ' (short run)' : ''}`,
      limitMs: 60,
      at: atLater,
    }),
  );
  for (const [role, o] of Object.entries(report.offsets)) {
    if (o.summary) {
      out.push(
        info(
          'R1.24',
          `${role}: residual drift`,
          `${o.summary.trendPpm.toFixed(1)} ppm`,
          `first ${ms(o.summary.firstMs, 1)}, last ${ms(o.summary.lastMs, 1)}`,
        ),
      );
    }
  }
  return out;
}

export const w8: Scenario = {
  id: 'W8',
  title: '30-minute drift run with the sync-check pattern',
  requirements: ['R1.24'],
  humanActions: ['1 portal click', 'speakers on, leave the machine alone for 30 minutes'],
  long: true,
  async run(ctx, out) {
    ctx.human.instruct('W8 — before you start', [
      `Speakers on. The pattern runs for ${String(ctx.durations.w8Min)} minutes; do not use the computer meanwhile (no screen lock or suspend).`,
      ...portalHint(ctx.mode),
    ]);
    await ctx.human.enter();
    const app = await ctx.launch();
    try {
      await patternRun(ctx, out, app, { id: 'W8', minutes: ctx.durations.w8Min, region: false });
      const stopped = await stopAndFinalize(app);
      out.checks.push(...stopped.checks);
      out.checks.push(...projectChecks(await inspectProject(stopped.root), 'R1.25'));
      ctx.log('W8: analyzing sync…');
      out.checks.push(...driftChecks(stopped.root, ctx.durations.w8Min, 'W8'));
    } finally {
      await app.quit();
    }
  },
};

export const soak: Scenario = {
  id: 'soak',
  title: '60-minute soak: dropped frames, memory, drift, preview, export',
  requirements: ['R1.22', 'R1.23', 'R1.24', 'R1.33', 'R1.20'],
  humanActions: [
    '1 portal click (region drag and Enter are automated)',
    'leave the machine alone for the run',
  ],
  long: true,
  async run(ctx, out) {
    const minutes = ctx.durations.soakMin;
    ctx.human.instruct('Soak — before you start', [
      `Speakers on. The pattern runs for ${String(minutes)} minutes on a 1920×1080 region with camera, mic and system audio.`,
      'Disable screen lock and automatic suspend for the run (Settings → Privacy → Screen; Power).',
      ...portalHint(ctx.mode),
    ]);
    await ctx.human.enter();
    const app = await ctx.launch(ctx.quick ? { CS_METRICS_INTERVAL_MS: '10000' } : {});
    try {
      await patternRun(ctx, out, app, { id: 'soak', minutes, region: true });
      const stopped = await stopAndFinalize(app);
      out.checks.push(...stopped.checks);
      const project = await inspectProject(stopped.root);
      out.checks.push(...projectChecks(project, 'R1.23'));

      // R1.22: dropped frames over the first 10 minutes (the sample at ≤ 10.5 min).
      out.checks.push(
        ...droppedChecks(project, 'R1.22', minutes >= 10 ? 10.5 * 60_000 : undefined),
      );
      const samples = project.metrics?.samples ?? [];
      const loopMax = Math.max(0, ...samples.map((s) => s.eventLoopDelayMaxMs ?? 0));
      out.checks.push(
        info(
          'R1.22',
          'main-process event-loop delay, worst minute',
          ms(loopMax, 1),
          'a proxy only: controls-window input latency (< 100 ms) is not measured automatically',
        ),
      );

      // R1.23: memory growth after minute 5.
      const baseAt = minutes >= 10 ? 5 * 60_000 : (minutes * 60_000) / 2;
      const base = samples.find((s) => s.atMs >= baseAt);
      if (!base) {
        out.checks.push(
          errorCheck(
            'R1.23',
            'memory growth after minute 5',
            `no metrics sample after ${String(baseAt / 60_000)} min (${String(samples.length)} samples)`,
          ),
        );
      } else {
        const later = samples.filter((s) => s.atMs >= base.atMs);
        const peak = Math.max(...later.map((s) => s.totalWorkingSetKb));
        const growthMb = (peak - base.totalWorkingSetKb) / 1024;
        out.checks.push(
          check(
            'R1.23',
            `memory growth after ${(base.atMs / 60_000).toFixed(1)} min`,
            growthMb < 300,
            `${growthMb.toFixed(0)} MB`,
            '< 300 MB',
            `${String(samples.length)} samples; ${(base.totalWorkingSetKb / 1024).toFixed(0)} → peak ${(peak / 1024).toFixed(0)} MB`,
          ),
        );
        for (const label of Object.keys(base.byLabel)) {
          const first = base.byLabel[label]?.workingSetKb ?? 0;
          const last = later.at(-1)?.byLabel[label]?.workingSetKb ?? first;
          out.checks.push(
            info(
              'R1.23',
              `${label} working set`,
              `${(first / 1024).toFixed(0)} → ${(last / 1024).toFixed(0)} MB`,
            ),
          );
        }
      }

      ctx.log('soak: analyzing sync (several minutes for a long recording)…');
      try {
        out.checks.push(...driftChecks(stopped.root, minutes, 'soak'));
      } catch (error) {
        out.checks.push(errorCheck('R1.24', 'soak drift analysis', error));
      }

      // The project opens; preview playback instrumentation (§4.6.4).
      if (project.doc) {
        await previewChecks(ctx, out, app, project.doc.id);
        try {
          const exported = await exportProject(ctx, stopped.root, 'draft');
          const expected = timelineDurationUs(project.doc);
          out.checks.push(info('R1.23', 'export at Draft', `${(exported.ms / 1000).toFixed(0)} s`));
          out.checks.push(
            check(
              'R1.46',
              'export duration = timeline ± 1 frame',
              Math.abs(exported.durationUs - expected) <= 1e6 / 30 + 1,
              `${(exported.durationUs / 1e6).toFixed(3)} s`,
              `${(expected / 1e6).toFixed(3)} s`,
            ),
          );
        } catch (error) {
          out.checks.push(errorCheck('R1.23', 'export at Draft', error));
        }
      }
    } finally {
      await app.quit();
    }
  },
};

interface Counters {
  video: { requested: number; late: number; superseded: number; inexact: number } | null;
  audio: { chunks: number; underruns: number; underrunSeconds: number };
}

async function previewChecks(
  ctx: Context,
  out: ScenarioOutput,
  app: AppSession,
  projectId: string,
) {
  try {
    await app.call('editor.open', { projectId });
    const end = Date.now() + 60_000;
    let ready = false;
    while (!ready && Date.now() < end) {
      ready = await app
        .evalIn<boolean>(
          'editor',
          `window.csEditorDebug?.doc()?.id === ${JSON.stringify(projectId)}`,
        )
        .catch(() => false);
      if (!ready) await sleep(500);
    }
    out.checks.push(check('R1.23', 'the project opens in the editor', ready));
    if (!ready) return;
    await sleep(3_000);
    await app.evalIn(
      'editor',
      'window.csEditorDebug.resetPlaybackCounters(); window.csEditorDebug.play(0); true',
    );
    await countdown('preview playback', ctx.durations.previewS * 1000);
    const counters = await app.evalIn<Counters>(
      'editor',
      'window.csEditorDebug.pause(); window.csEditorDebug.playbackCounters()',
    );
    const v = counters.video;
    const lateRatio = v && v.requested > 0 ? v.late / v.requested : null;
    out.checks.push(
      check(
        'R1.33',
        'preview late frames < 1 %',
        lateRatio !== null && lateRatio < 0.01,
        pct(lateRatio),
        '< 1 %',
        v
          ? `${String(v.late)} of ${String(v.requested)} (superseded ${String(v.superseded)}, stand-in ${String(v.inexact)})`
          : 'no counters',
      ),
    );
    out.checks.push(
      check(
        'R1.33',
        'preview audio underruns',
        counters.audio.underruns === 0,
        String(counters.audio.underruns),
        '0',
        `${String(counters.audio.chunks)} chunks, ${(counters.audio.underrunSeconds * 1000).toFixed(0)} ms late in total`,
      ),
    );
  } catch (error) {
    out.checks.push(errorCheck('R1.33', 'preview playback', error));
  }
}
