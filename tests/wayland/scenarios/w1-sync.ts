/**
 * W1: full screen with every component, recording the sync-check pattern (fullscreen flash and
 * a 1 kHz beep every 2 s through the speakers), then a hand-clap segment. Checks R1.24 at the
 * start (screen ↔ system audio, screen ↔ mic ≤ 40 ms; camera ↔ mic ≤ 60 ms from the flashes the
 * camera sees, or from the claps), the same in the exported file, dropped frames, R1.11 and the
 * project itself.
 */
import { analyzeExport, analyzeProject } from '../../sync/analysis';
import {
  cameraMicCheck,
  check,
  droppedChecks,
  errorCheck,
  info,
  inspectProject,
  ms,
  projectChecks,
  syncChecks,
} from '../lib/checks';
import { Pattern } from '../lib/pattern';
import {
  configure,
  controlsMinimizedCheck,
  exportProject,
  portalHint,
  recordFor,
  sleep,
  startRecording,
  stopAndFinalize,
  type Scenario,
} from '../lib/scenario';

export const w1: Scenario = {
  id: 'W1',
  title: 'Full screen, all components, sync-check pattern',
  requirements: ['R1.24', 'R1.22', 'R1.11', 'R1.13', 'R1.25'],
  humanActions: [
    '1 portal click (pick the monitor, Share)',
    'camera sees the screen (small mirror by the webcam) or the room lit only by the screen',
    'speakers on',
    'clap 5 times in view of the camera when asked',
  ],
  async run(ctx, out) {
    ctx.human.instruct('W1 — before you start', [
      'Turn the speakers on at a normal volume; the built-in mic must hear them.',
      'Make the webcam see the screen: hold or prop a small mirror next to the webcam angled at the screen, or dim the room so the screen lights your face.',
      'When you press Enter the screen turns black and flashes white every 2 s with a beep.',
      ...portalHint(ctx.mode),
      `After about ${String(ctx.durations.w1S)} s the pattern closes and the terminal asks you to clap.`,
    ]);
    await ctx.human.enter();
    const app = await ctx.launch();
    let pattern: Pattern | null = null;
    try {
      await configure(ctx, app, {
        captureMode: 'fullscreen',
        cameraId: ctx.devices.cameraId,
        micId: ctx.devices.roomMicId,
        systemAudio: ctx.mode === 'real',
      });
      pattern = await Pattern.start({ mode: ctx.mode, mute: ctx.mode === 'dry-run' });
      const { root, startedAt } = await startRecording(ctx, app);
      out.projects.push(root);
      out.checks.push(await controlsMinimizedCheck(ctx, app));
      await recordFor('W1 recording the pattern', ctx.durations.w1S * 1000);
      await pattern.close();
      pattern = null;

      // Clap segment: camera ↔ mic when the camera cannot see the flashes.
      const clapFrom = (Date.now() - startedAt) / 1000;
      ctx.human.instruct('W1 — clap', [
        'Clap your hands 5 times, about one second apart, in front of the webcam (hands visible, close to the laptop).',
      ]);
      await recordFor('W1 clap segment', ctx.mode === 'real' ? 12_000 : 3_000);
      const clapTo = (Date.now() - startedAt) / 1000;
      const stopped = await stopAndFinalize(app);
      out.checks.push(...stopped.checks);

      const project = await inspectProject(stopped.root);
      out.checks.push(...projectChecks(project, 'R1.25'));
      out.checks.push(
        check(
          'R1.13',
          'one file per enabled stream',
          project.media.length === (ctx.mode === 'real' ? 4 : 3),
          project.media.map((m) => m.role).join(', '),
        ),
      );
      out.checks.push(...droppedChecks(project, 'R1.22'));
      for (const s of project.log?.streams ?? []) {
        if (s.encoder)
          out.checks.push(
            info(
              'R1.19',
              `${s.kind} encoder`,
              `${s.encoder.name}${s.encoder.hardware ? ' (hw)' : ''}`,
            ),
          );
      }

      ctx.log('analyzing sync (this takes a while for long recordings)…');
      const report = analyzeProject(stopped.root, { clapWindow: [clapFrom - 0.5, clapTo + 0.5] });
      out.checks.push(...syncChecks(report, { label: 'start', limitMs: 40 }));
      out.checks.push(cameraMicCheck(report));
      if (report.clap) {
        out.checks.push(
          info(
            'R1.24',
            'claps heard / paired',
            `${String(report.clap.claps)} / ${String(report.clap.pairs.length)}`,
            report.clap.summary ? `camera − mic ${ms(report.clap.summary.medianMs, 1)}` : undefined,
          ),
        );
      }

      // The exported file (R1.24 "in the exported file").
      try {
        const exported = await exportProject(ctx, stopped.root, 'draft');
        const e = analyzeExport(exported.output);
        const median = e.summary?.medianMs ?? null;
        out.checks.push(
          median === null
            ? errorCheck(
                'R1.24',
                'export: screen ↔ audio mix',
                `${String(e.flashes)} flashes, ${String(e.beeps)} beeps matched none`,
              )
            : check(
                'R1.24',
                'export: screen ↔ audio mix',
                Math.abs(median) <= 40,
                ms(median, 1),
                '≤ 40 ms',
                `${String(e.pairs.length)} pairs`,
              ),
        );
      } catch (error) {
        out.checks.push(errorCheck('R1.24', 'export: screen ↔ audio mix', error));
      }
      if (ctx.mode === 'dry-run') {
        out.notes.push(
          'Dry run: fake devices and a muted pattern, so audio and camera offsets are not meaningful.',
        );
      }
      await sleep(200);
    } finally {
      await pattern?.close();
      await app.quit();
    }
  },
};
