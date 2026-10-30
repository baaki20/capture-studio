/**
 * W2: region recording with a pause in the middle (R1.14, R1.9, R1.24 after resume). During the
 * pause the pattern turns red and plays a steady 3 kHz tone (and a TTS phrase is spoken when
 * `spd-say` exists); none of it may appear in any recorded file, and no screen or camera frame
 * may fall inside the pause. The region is dragged and confirmed automatically.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  analyzeProject,
  framesInSpan,
  pauseToneSpans,
  readProject,
  redFrames,
  videoStats,
} from '../../sync/analysis';
import { check, errorCheck, info, inspectProject, projectChecks, syncChecks } from '../lib/checks';
import { Pattern } from '../lib/pattern';
import {
  configure,
  portalHint,
  recordFor,
  sleep,
  startRecording,
  stopAndFinalize,
  type Scenario,
} from '../lib/scenario';

const PAUSE_PHRASE = 'This sentence is spoken during the pause and must not be recorded.';

export const w2: Scenario = {
  id: 'W2',
  title: 'Region recording with a pause in the middle',
  requirements: ['R1.14', 'R1.9', 'R1.24', 'R1.32'],
  humanActions: ['1 portal click (the region drag and Enter are automated)', 'speakers on'],
  async run(ctx, out) {
    ctx.human.instruct('W2 — before you start', [
      'Speakers on. The pattern flashes and beeps; the harness draws a region in the picker and presses Enter for you.',
      ...portalHint(ctx.mode),
      'Mid-way the screen turns red with a high tone (that is the pause; it must not be recorded).',
    ]);
    await ctx.human.enter();
    const app = await ctx.launch();
    let pattern: Pattern | null = null;
    try {
      await configure(ctx, app, {
        captureMode: 'region',
        cameraId: ctx.devices.cameraId,
        micId: ctx.devices.roomMicId,
        systemAudio: ctx.mode === 'real',
      });
      pattern = await Pattern.start({ mode: ctx.mode, mute: ctx.mode === 'dry-run' });
      const { root } = await startRecording(ctx, app, {
        region: { from: [0.2, 0.2], to: [0.8, 0.8] },
      });
      out.projects.push(root);
      await recordFor('W2 before the pause', ctx.quick ? 8_000 : 12_000);

      const mark = app.mark();
      const cli = await app.cli('pause-recording');
      const paused = await app.waitState((s) => s.state === 'paused', 10_000, mark);
      out.checks.push(
        info('R1.2', 'CLI pause → paused', `${String(paused.at - cli.startedAt)} ms`),
      );
      await sleep(500);
      pattern.pause(true);
      const tts = spawnSync('which', ['spd-say']).status === 0;
      if (tts && ctx.mode === 'real') spawn('spd-say', ['-w', PAUSE_PHRASE], { stdio: 'ignore' });
      else
        out.notes.push(
          'No TTS phrase during the pause (spd-say not installed, or dry run); the 3 kHz tone stands in.',
        );
      await recordFor('W2 paused (red + tone)', 6_000);
      pattern.pause(false);
      await sleep(1_500);
      const resumeMark = app.mark();
      await app.cli('resume-recording');
      await app.waitState((s) => s.state === 'recording', 10_000, resumeMark);
      await recordFor('W2 after the pause', ctx.quick ? 10_000 : 16_000);
      await pattern.close();
      pattern = null;

      const stopped = await stopAndFinalize(app);
      out.checks.push(...stopped.checks);
      const project = await inspectProject(stopped.root);
      out.checks.push(...projectChecks(project, 'R1.25'));
      const doc = readProject(stopped.root);
      const pauses = (doc.recording?.pauses ?? []).map(
        (p) => [p.startUs / 1e6, p.endUs / 1e6] as [number, number],
      );
      out.checks.push(
        check('R1.14', 'one pause recorded', pauses.length === 1, String(pauses.length)),
      );
      const region = project.doc?.recording?.source.region ?? null;
      out.checks.push(
        check(
          'R1.9',
          'the region is kept as the screen crop',
          region !== null,
          region
            ? `${String(region.width)}×${String(region.height)} at ${String(region.x)},${String(region.y)}`
            : 'none',
        ),
      );
      const pause = pauses[0];
      if (!pause) return;

      // No frames inside the pause, and no red (pause-mode) frames anywhere.
      for (const media of doc.media.filter((m) => m.kind === 'video')) {
        const stats = videoStats(path.join(stopped.root, media.path));
        const inside = framesInSpan(media, stats.times, [pause[0] + 0.15, pause[1] - 0.15]);
        out.checks.push(
          check(
            'R1.14',
            `${media.role}: no frames inside the pause`,
            inside.length === 0,
            String(inside.length),
          ),
        );
        if (media.role === 'screen') {
          const red = redFrames(stats);
          out.checks.push(
            check(
              'R1.14',
              'screen: no pause-mode (red) frames',
              red.length === 0,
              String(red.length),
              '0',
              red.length ? `first at ${red[0]?.toFixed(2) ?? ''} s (file time)` : undefined,
            ),
          );
        }
      }
      // No pause tone in any audio file.
      for (const media of doc.media.filter((m) => m.kind === 'audio')) {
        try {
          const spans = pauseToneSpans(path.join(stopped.root, media.path));
          out.checks.push(
            check(
              'R1.14',
              `${media.role}: no pause tone (3 kHz)`,
              spans.length === 0,
              spans.length
                ? spans.map((s) => `${s.startS.toFixed(1)}–${s.endS.toFixed(1)} s`).join(', ')
                : 'absent',
            ),
          );
        } catch (error) {
          out.checks.push(errorCheck('R1.14', `${media.role}: no pause tone`, error));
        }
      }
      if (ctx.mode === 'real') {
        out.notes.push(
          'Listen to the mic track around the pause in the editor: the TTS phrase must not be audible (not checked automatically).',
        );
      }

      // Sync after the resume (R1.24) and one clip per active interval (R1.32).
      const after = analyzeProject(stopped.root, { sessionRange: [pause[1] + 0.5, Infinity] });
      out.checks.push(...syncChecks(after, { label: 'after resume', limitMs: 40 }));
      for (const track of project.doc?.timeline.tracks ?? []) {
        out.checks.push(
          check(
            'R1.32',
            `${track.name}: one clip per active interval`,
            track.clips.length === 2,
            String(track.clips.length),
            '2',
          ),
        );
      }
    } finally {
      await pattern?.close();
      await app.quit();
    }
  },
};
