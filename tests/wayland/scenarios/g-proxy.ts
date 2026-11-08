/**
 * G (acceptance g, R2.23): a 4K recording previews through its 720p proxy with under 1 % late
 * frames on a real display. The harness makes a 4K `testsrc2` project (a few minutes of FFmpeg
 * work), opens it, waits for the proxy, plays the preview for `--preview-seconds` (5 minutes by
 * default) and reads the editor's playback counters. Under Xvfb software GL cannot keep up, so
 * a dry run only reports the numbers.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildRecordedProject } from '../../fixtures/recorded-media';
import { BIN_DIR } from '../lib/app';
import { check, errorCheck, info, pct } from '../lib/checks';
import { countdown } from '../lib/human';
import { configure, sleep, type Scenario } from '../lib/scenario';

interface Counters {
  video: { requested: number; late: number; superseded: number; inexact: number } | null;
  audio: { chunks: number; underruns: number };
}

export const g: Scenario = {
  id: 'G',
  title: '4K preview through the 720p proxy (acceptance g)',
  requirements: ['R2.23'],
  humanActions: ['nothing; leave the machine alone while it plays'],
  long: true,
  async run(ctx, out) {
    const seconds = ctx.durations.previewS + 15;
    ctx.log(`making a ${String(seconds)} s 4K project (FFmpeg, a few minutes)`);
    const started = Date.now();
    const { root, doc } = buildRecordedProject({
      ffmpeg: path.join(BIN_DIR, 'ffmpeg'),
      dir: ctx.projectsDir,
      id: 'prj_01JBQ4ZJ4X6V3K8N2M7P5R9G4K',
      name: 'G 4K preview',
      size: [3840, 2160],
      seconds,
      fps: 30,
    });
    out.projects.push(root);
    out.checks.push(
      info('R2.23', '4K project made', `${((Date.now() - started) / 1000).toFixed(0)} s`),
    );
    const screen = doc.media.find((m) => m.role === 'screen');
    if (!screen) throw new Error('the 4K project has no screen');
    const app = await ctx.launch();
    try {
      await configure(ctx, app, {});
      await app.call('editor.open', { projectId: doc.id });
      const proxy = path.join(root, 'cache', `${screen.id}.proxy.mp4`);
      const proxyStart = Date.now();
      const end = Date.now() + 20 * 60_000;
      let usesProxy = false;
      while (!usesProxy && Date.now() < end) {
        usesProxy =
          existsSync(proxy) &&
          (await app
            .evalIn<string>(
              'editor',
              `window.csEditorDebug?.previewUrls()[${JSON.stringify(screen.id)}] ?? ''`,
            )
            .then((url) => url.endsWith('.proxy.mp4'))
            .catch(() => false));
        if (!usesProxy) await sleep(1_000);
      }
      out.checks.push(
        check(
          'R2.23',
          'the preview switches to the 720p proxy',
          usesProxy,
          usesProxy
            ? `after ${((Date.now() - proxyStart) / 1000).toFixed(0)} s`
            : 'not within 20 minutes',
        ),
      );
      if (!usesProxy) return;
      // GNOME stops painting a covered or minimized window, and then the preview asks for no
      // frames at all (the first live run counted 0 of 0 behind the terminal).
      if (ctx.mode === 'real') {
        ctx.human.instruct('G — keep the editor visible', [
          'Bring the Capture Studio editor window ("G 4K preview") to the front.',
          'Leave it uncovered for the next 5 minutes: no window on top, no screen lock.',
          'Then press Enter here, and leave the mouse and keyboard alone.',
        ]);
        await ctx.human.enter();
      }
      const editor = (await app.windows()).find((w) => w.role === 'editor');
      out.checks.push(
        info(
          'R2.23',
          'editor window before playing',
          editor
            ? `${editor.visible ? 'visible' : 'hidden'}, ${editor.minimized ? 'minimized' : 'not minimized'}, ${editor.focused ? 'focused' : 'not focused'}`
            : 'none',
        ),
      );
      await sleep(3_000);
      await app.evalIn(
        'editor',
        'window.csEditorDebug.resetPlaybackCounters(); window.csEditorDebug.play(0); true',
      );
      await countdown('G preview playback', ctx.durations.previewS * 1000);
      const { counters, playheadUs } = await app.evalIn<{ counters: Counters; playheadUs: number }>(
        'editor',
        `(() => {
          const playheadUs = window.csEditorDebug.ui().playheadUs;
          window.csEditorDebug.pause();
          return { counters: window.csEditorDebug.playbackCounters(), playheadUs };
        })()`,
      );
      out.checks.push(
        check(
          'R2.23',
          'playback advanced over the whole run',
          playheadUs / 1e6 >= ctx.durations.previewS * 0.9,
          `${(playheadUs / 1e6).toFixed(1)} s`,
          `≥ ${(ctx.durations.previewS * 0.9).toFixed(0)} s`,
          `audio ${String(counters.audio.chunks)} chunks, ${String(counters.audio.underruns)} underruns`,
        ),
      );
      const v = counters.video;
      const ratio = v && v.requested > 0 ? v.late / v.requested : null;
      const detail = v
        ? `${String(v.late)} of ${String(v.requested)} (superseded ${String(v.superseded)}, stand-in ${String(v.inexact)})`
        : 'no counters';
      if (ctx.mode === 'dry-run') {
        out.checks.push(info('R2.23', 'late frames (Xvfb: information only)', pct(ratio), detail));
      } else {
        out.checks.push(
          check(
            'R2.23',
            'late frames < 1 %',
            ratio !== null && ratio < 0.01,
            pct(ratio),
            '< 1 %',
            detail,
          ),
        );
      }
    } catch (error) {
      out.checks.push(errorCheck('R2.23', '4K preview', error));
    } finally {
      await app.quit();
    }
  },
};
