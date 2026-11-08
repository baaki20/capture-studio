/**
 * Phase 2 recorder scenarios (manual checks W11–W14 in `docs/wayland-manual-checklist.md`):
 *
 * - W11: record one window and resize it twice → the recording keeps its first size and shows
 *   the window whole with black bars (acceptance f, R2.29). Bars are measured on frames after each
 *   resize; the human confirms the saved frames.
 * - W12: audio only with "Stop after 10 s" → no portal, stops by itself, Voice and System audio
 *   tracks and no screen, the editor plays it and an MP3 export has sound (R2.30, R2.32).
 * - W13: region, "Record only the region", When done: Export a small GIF → the screen file has
 *   the region's size, a GIF lands in the exports folder and the file manager shows it (R2.31,
 *   R2.33).
 * - W14: "Require a hardware encoder" on this machine (a hardware encoder is used, or the
 *   recording refuses to start) and with Chromium's hardware encoders switched off (the
 *   recording must refuse to start and say why) (R2.34a).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { runExportJob } from '../../../src/utility/media/export/export-job';
import type { AppSession } from '../lib/app';
import { BIN_DIR } from '../lib/app';
import {
  check,
  errorCheck,
  info,
  inspectProject,
  notTestable,
  projectChecks,
  type Check,
} from '../lib/checks';
import { countdown } from '../lib/human';
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

const FFMPEG = path.join(BIN_DIR, 'ffmpeg');
const FFPROBE = path.join(BIN_DIR, 'ffprobe');

/** Width and height of a file's first video stream. */
function videoSize(file: string): { width: number; height: number } | null {
  const r = spawnSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  );
  const [width, height] = r.stdout.trim().split(',').map(Number);
  return r.status === 0 && width && height ? { width, height } : null;
}

/** One frame at `seconds` as 8-bit luma, at the file's size. */
function lumaFrame(file: string, seconds: number, width: number, height: number): Buffer | null {
  const r = spawnSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-ss',
      seconds.toFixed(2),
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return r.status === 0 && r.stdout.length === width * height ? r.stdout : null;
}

function savePng(file: string, seconds: number, output: string): void {
  spawnSync(FFMPEG, [
    '-v',
    'error',
    '-y',
    '-ss',
    seconds.toFixed(2),
    '-i',
    file,
    '-frames:v',
    '1',
    output,
  ]);
}

/** The brightest luma in a 1 % strip along each edge (black bars stay near 16 or below). */
function edgeLuma(frame: Buffer, width: number, height: number) {
  const sx = Math.max(1, Math.round(width * 0.01));
  const sy = Math.max(1, Math.round(height * 0.01));
  const max = (x0: number, x1: number, y0: number, y1: number) => {
    let m = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) m = Math.max(m, frame[y * width + x] ?? 0);
    return m;
  };
  return {
    left: max(0, sx, 0, height),
    right: max(width - sx, width, 0, height),
    top: max(0, width, 0, sy),
    bottom: max(0, width, height - sy, height),
  };
}

const BLACK = 24;

/** Peak level of a file's audio in dBFS (−∞ for silence, null when unreadable). */
function peakDb(file: string): number | null {
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    {
      encoding: 'utf8',
    },
  );
  const match = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
  if (!match?.[1]) return null;
  return match[1] === '-inf' ? -Infinity : Number(match[1]);
}

const errorNotices = (app: AppSession) =>
  app.notices.filter((n) => n.value.level === 'error').map((n) => n.value.message);

function noErrorsCheck(app: AppSession, requirement: string): Check {
  const errors = errorNotices(app);
  return check(
    requirement,
    'no error notices',
    errors.length === 0,
    String(errors.length),
    '0',
    errors.join(' | ') || undefined,
  );
}

function dryRunOnly(ctx: Context, out: ScenarioOutput, requirement: string, what: string) {
  if (ctx.mode !== 'dry-run') return false;
  out.checks.push(notTestable(requirement, what, 'needs the GNOME portal (real run only)'));
  return true;
}

export const w11: Scenario = {
  id: 'W11',
  title: 'Window recording: resize the window, letterbox (acceptance f)',
  requirements: ['R2.29'],
  humanActions: [
    'open a text editor',
    '1 portal click (Window tab)',
    'resize the window twice when asked',
    'look at three saved frames',
  ],
  async run(ctx, out) {
    if (dryRunOnly(ctx, out, 'R2.29', 'window recording with resizes')) return;
    const app = await ctx.launch();
    try {
      await configure(ctx, app, {
        captureMode: 'window',
        cameraId: null,
        micId: null,
        systemAudio: false,
      });
      ctx.human.instruct('W11 — get a window ready', [
        'Open a NEW, EMPTY text editor window (Text Editor → New) and type a few harmless words.',
        'Do not use a file with private content: the recording and three frames are saved.',
        'If it fills the screen, double-click its title bar so it is not maximized.',
        'Give it a medium size, about a third of the screen, with room around it to grow.',
        'Then press Enter here.',
      ]);
      await ctx.human.enter();
      const { root, startedAt } = await startRecording(ctx, app, {
        portalSteps: [
          'A "Share" dialog opens. Choose its "Window" tab.',
          'Pick the text editor window, then click "Share".',
          'Leave the window at its size until the terminal asks.',
        ],
      });
      out.projects.push(root);
      const at = (ms: number) => (ms - startedAt) / 1000;
      await recordFor('W11 first size', 6_000);
      const first = at(Date.now()) - 1;
      ctx.human.instruct('W11 — narrower', [
        'Drag the editor window’s right edge to make it about half as wide. Keep its height.',
        'Then let go and wait.',
      ]);
      await countdown('W11 narrower', 10_000);
      const narrow = at(Date.now()) - 1;
      ctx.human.instruct('W11 — wider and shorter', [
        'Drag the bottom-right corner: make the window wider than at first and about half as tall.',
        'Then let go and wait.',
      ]);
      await countdown('W11 wider and shorter', 10_000);
      const wide = at(Date.now()) - 1;
      const stop = await stopAndFinalize(app, 'R2.29');
      out.checks.push(...stop.checks);
      const project = await inspectProject(stop.root);
      out.checks.push(...projectChecks(project, 'R2.29'));
      out.checks.push(noErrorsCheck(app, 'R2.29'));
      const screen = project.media.find((m) => m.role === 'screen');
      const file = screen ? path.join(stop.root, screen.path) : null;
      const size = file ? videoSize(file) : null;
      const source = project.doc?.recording?.source;
      out.checks.push(
        check(
          'R2.29',
          'the recording names a window source',
          source?.kind === 'window',
          source ? `${source.kind} ${String(source.widthPx)}×${String(source.heightPx)}` : 'none',
        ),
      );
      if (!file || !size) {
        out.checks.push(check('R2.29', 'the screen file probes', false));
        return;
      }
      out.checks.push(
        info('R2.29', 'recording size', `${String(size.width)}×${String(size.height)}`),
      );
      const offset = (screen?.startOffsetUs ?? 0) / 1e6;
      const frames = { first, narrow, wide };
      const edges: Record<string, ReturnType<typeof edgeLuma> | null> = {};
      const pngs: string[] = [];
      for (const [name, t] of Object.entries(frames)) {
        const seconds = Math.max(0, t - offset);
        const frame = lumaFrame(file, seconds, size.width, size.height);
        edges[name] = frame ? edgeLuma(frame, size.width, size.height) : null;
        const png = path.join(ctx.runDir, `w11-${name}.png`);
        savePng(file, seconds, png);
        pngs.push(png);
      }
      const n = edges.narrow;
      const w = edges.wide;
      const show = (e: ReturnType<typeof edgeLuma> | null | undefined) =>
        e
          ? `left ${String(e.left)}, right ${String(e.right)}, top ${String(e.top)}, bottom ${String(e.bottom)}`
          : 'no frame';
      out.checks.push(
        info(
          'R2.29',
          'edge luma at the first size',
          show(edges.first),
          'brightest pixel per 1 % edge strip',
        ),
      );
      // People do not always resize in the order asked (the 2026-11-08 run went wide first), so
      // each resized frame only has to be letterboxed or pillarboxed: black on two opposite sides.
      const boxed = (e: ReturnType<typeof edgeLuma> | null | undefined) =>
        !!e && ((e.left <= BLACK && e.right <= BLACK) || (e.top <= BLACK && e.bottom <= BLACK));
      for (const [name, e] of [
        ['first resize', n],
        ['second resize', w],
      ] as const) {
        out.checks.push(
          check(
            'R2.29',
            `after the ${name}: black bars on two opposite sides`,
            boxed(e),
            show(e),
            `left and right, or top and bottom, ≤ ${String(BLACK)}`,
          ),
        );
      }
      ctx.human.instruct('W11 — look at the frames', [
        ...pngs.map((p) => `Open ${p}`),
        'In each one the whole editor window should show, centred, with its text not squashed or stretched,',
        'and black bars filling the rest (none at the first size).',
      ]);
      const looks = await ctx.human.yesNo('Do all three frames look like that?', true);
      out.checks.push(
        check('R2.29', 'the operator confirms: whole, centred, not stretched', looks),
      );
    } finally {
      await app.quit();
    }
  },
};

/** Plays a 2 s 1 kHz tone through the default output (the system audio W12 records). */
async function playTone(ctx: Context): Promise<void> {
  const wav = path.join(ctx.runDir, 'w12-tone.wav');
  if (!existsSync(wav)) {
    spawnSync(FFMPEG, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=1000:r=48000:d=2',
      '-af',
      'volume=0.3',
      wav,
    ]);
  }
  await new Promise<void>((resolve) => {
    const child = spawn('pw-play', [wav], { stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}

export const w12: Scenario = {
  id: 'W12',
  title: 'Audio only, Stop after 10 s',
  requirements: ['R2.30', 'R2.32'],
  humanActions: ['nothing (the harness plays a tone); no portal must appear'],
  async run(ctx, out) {
    const app = await ctx.launch();
    try {
      await configure(ctx, app, {
        captureMode: 'audio-only',
        cameraId: null,
        micId: ctx.devices.roomMicId,
        systemAudio: true,
        durationLimitSec: 10,
      });
      if (ctx.mode === 'real') {
        ctx.human.instruct('W12 — audio only', [
          'Nothing to click. If a "Share Screen" dialog appears, that is a failure: click Cancel.',
          'The harness plays a short tone through the speakers.',
        ]);
      }
      const mark = app.mark();
      await app.clickRecord();
      const recording = await app.waitState(
        (s) => ['recording', 'failed', 'idle'].includes(s.state),
        30_000,
        mark,
      );
      const portal = app.states.some(
        (s, i) => i >= mark && ['acquiring', 'picking-region'].includes(s.value.state),
      );
      out.checks.push(
        check(
          'R2.30',
          'recording starts without asking for a screen',
          recording.value.state === 'recording',
          recording.value.state,
          'recording',
          recording.value.failureReason ?? (portal ? 'went through acquiring' : undefined),
        ),
      );
      if (recording.value.state !== 'recording') return;
      await sleep(2_000);
      if (ctx.mode === 'real') await playTone(ctx);
      const stopped = await app.waitState(
        (s) => ['finalizing', 'failed', 'idle'].includes(s.state),
        30_000,
        recording.index,
      );
      const seconds = (stopped.at - recording.at) / 1000;
      out.checks.push(
        check(
          'R2.32',
          'it stops by itself after 10 s',
          stopped.value.state === 'finalizing' && seconds >= 9.5 && seconds <= 11.5,
          `${stopped.value.state} after ${seconds.toFixed(1)} s`,
          '9.5–11.5 s',
        ),
      );
      const ready = await app.waitProject(stopped.at - 1, 5 * 60_000);
      out.projects.push(ready.value.root);
      const project = await inspectProject(ready.value.root);
      out.checks.push(...projectChecks(project, 'R2.30'));
      out.checks.push(noErrorsCheck(app, 'R2.30'));
      const roles = project.media.map((m) => m.role);
      out.checks.push(
        check(
          'R2.30',
          'microphone and system audio, no screen or camera',
          roles.includes('microphone') &&
            roles.includes('system-audio') &&
            !roles.includes('screen') &&
            !roles.includes('camera'),
          roles.join(', '),
        ),
      );
      const tracks = project.doc?.timeline.tracks.map((t) => t.name) ?? [];
      out.checks.push(
        check(
          'R2.30',
          'Voice and System audio tracks',
          tracks.includes('Voice') && tracks.includes('System audio'),
          tracks.join(', '),
        ),
      );
      const system = project.media.find((m) => m.role === 'system-audio');
      if (system && ctx.mode === 'real') {
        const peak = peakDb(path.join(ready.value.root, system.path));
        out.checks.push(
          check(
            'R2.30',
            'system audio holds the tone',
            peak !== null && peak > -30,
            peak === null ? 'unreadable' : `${peak.toFixed(1)} dBFS peak`,
            '> −30 dBFS',
          ),
        );
      }
      await editorPlays(app, out, ready.value.projectId);
      await mp3Export(ctx, out, ready.value.root);
    } finally {
      await app.quit();
    }
  },
};

async function editorPlays(app: AppSession, out: ScenarioOutput, projectId: string) {
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
    if (!ready) {
      out.checks.push(check('R2.30', 'the project opens in the editor', false));
      return;
    }
    await sleep(2_000);
    await app.evalIn(
      'editor',
      'window.csEditorDebug.resetPlaybackCounters(); window.csEditorDebug.play(0); true',
    );
    await sleep(4_000);
    const counters = await app.evalIn<{ audio: { chunks: number; underruns: number } }>(
      'editor',
      'window.csEditorDebug.pause(); window.csEditorDebug.playbackCounters()',
    );
    out.checks.push(
      check(
        'R2.30',
        'the editor plays it (audio chunks, no underruns)',
        counters.audio.chunks > 0 && counters.audio.underruns === 0,
        `${String(counters.audio.chunks)} chunks, ${String(counters.audio.underruns)} underruns`,
      ),
    );
  } catch (error) {
    out.checks.push(errorCheck('R2.30', 'editor playback', error));
  }
}

async function mp3Export(ctx: Context, out: ScenarioOutput, root: string) {
  try {
    const project = await inspectProject(root);
    if (!project.doc) throw new Error(project.error ?? 'no project');
    const output = path.join(ctx.runDir, 'exports', `${path.basename(root, '.cstudio')}.mp3`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await runExportJob({
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      root,
      doc: project.doc,
      options: {
        resolution: 'canvas',
        fps: 'project',
        quality: 'standard',
        encoder: 'software',
        format: 'mp3',
      },
      hardwareEncoder: null,
      output,
      overwrite: true,
    });
    const r = spawnSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', output],
      { encoding: 'utf8' },
    );
    const probed = JSON.parse(r.stdout || '{}') as {
      streams?: { codec_name?: string }[];
      format?: { duration?: string };
    };
    const codecs = (probed.streams ?? []).map((s) => s.codec_name).join(', ');
    const duration = Number(probed.format?.duration ?? 0);
    const peak = peakDb(output);
    out.checks.push(
      check(
        'R2.30',
        'MP3 export: one MP3 stream, about 10 s',
        codecs === 'mp3' && duration > 9 && duration < 12,
        `${codecs || 'none'}, ${duration.toFixed(1)} s`,
      ),
    );
    if (ctx.mode === 'real') {
      out.checks.push(
        check(
          'R2.30',
          'MP3 export has sound',
          peak !== null && peak > -30,
          peak === null ? 'unreadable' : `${peak.toFixed(1)} dBFS peak`,
          '> −30 dBFS',
        ),
      );
    }
  } catch (error) {
    out.checks.push(errorCheck('R2.30', 'MP3 export', error));
  }
}

export const w13: Scenario = {
  id: 'W13',
  title: 'Record only the region, then a small GIF',
  requirements: ['R2.31', 'R2.33'],
  humanActions: [
    '1 portal click (the region is dragged automatically)',
    'say whether the file manager showed the GIF',
  ],
  async run(ctx, out) {
    const app = await ctx.launch();
    const exportsDir = path.join(ctx.runDir, 'exports');
    try {
      await configure(ctx, app, {
        captureMode: 'region',
        cameraId: null,
        micId: null,
        systemAudio: false,
        cropAtRecord: true,
        afterRecording: 'export-gif',
      });
      await fs.mkdir(exportsDir, { recursive: true });
      const before = new Set(await fs.readdir(exportsDir));
      const { root, picked } = await startRecording(ctx, app, {
        region: { from: [0.3, 0.3], to: [0.7, 0.6] },
      });
      out.projects.push(root);
      await recordFor('W13 recording', 5_000);
      const stop = await stopAndFinalize(app, 'R2.33');
      out.checks.push(...stop.checks);
      const project = await inspectProject(stop.root);
      out.checks.push(...projectChecks(project, 'R2.33'));
      // Cropped at record time, the source is the region itself (`region` is null). The picker
      // shows the screen scaled to fit its window, so the size to expect is the one it labelled.
      const source = project.doc?.recording?.source;
      const screen = project.media.find((m) => m.role === 'screen');
      const size = screen ? videoSize(path.join(stop.root, screen.path)) : null;
      const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
      out.checks.push(
        check(
          'R2.33',
          'the screen file has the recorded source size, with no crop left',
          !!source &&
            !!size &&
            source.region === null &&
            near(size.width, source.widthPx, 2) &&
            near(size.height, source.heightPx, 2),
          size ? `${String(size.width)}×${String(size.height)}` : 'no screen file',
          source ? `${String(source.widthPx)}×${String(source.heightPx)} (±2)` : 'no source',
        ),
      );
      out.checks.push(
        check(
          'R2.33',
          'that size is the region the picker showed',
          !!picked &&
            !!size &&
            near(size.width, picked.width, 2) &&
            near(size.height, picked.height, 2),
          size ? `${String(size.width)}×${String(size.height)}` : 'no screen file',
          picked
            ? `${String(picked.width)}×${String(picked.height)} (±2)`
            : 'picker label not read',
        ),
      );
      const end = Date.now() + 3 * 60_000;
      let gif: string | null = null;
      while (!gif && Date.now() < end) {
        const found = (await fs.readdir(exportsDir)).find(
          (f) => f.endsWith('.gif') && !before.has(f),
        );
        if (found) gif = path.join(exportsDir, found);
        else await sleep(1_000);
      }
      // Wait for the export to finish writing (the file appears under its final name at the end).
      const gifSize = gif ? videoSize(gif) : null;
      const bytes = gif ? (await fs.stat(gif)).size : 0;
      out.checks.push(
        check(
          'R2.31',
          'a GIF appears in the exports folder',
          !!gif && !!gifSize,
          gif ? `${path.basename(gif)}, ${(bytes / 1024).toFixed(0)} KB` : 'none within 3 minutes',
          undefined,
          gifSize ? `${String(gifSize.width)}×${String(gifSize.height)}` : undefined,
        ),
      );
      out.checks.push(noErrorsCheck(app, 'R2.31'));
      if (ctx.mode === 'real' && gif) {
        const shown = await ctx.human.yesNo(
          `Did a file manager window open with ${path.basename(gif)} selected?`,
          true,
        );
        out.checks.push(check('R2.31', 'the file manager shows the GIF', shown));
      }
    } finally {
      await app.quit();
    }
  },
};

/** Starts a recording that may be refused; returns the project root or the refusal. */
async function tryRecording(
  ctx: Context,
  app: AppSession,
): Promise<{ root: string } | { refused: string }> {
  try {
    const { root } = await startRecording(ctx, app);
    // The engine is started after the state reaches "recording", so a refusal lands just after.
    await sleep(1_500);
    if ((await app.status()).state === 'failed') throw new Error('failed after starting');
    return { root };
  } catch (error) {
    const failed = [...app.states].reverse().find((s) => s.value.state === 'failed');
    const notices = app.notices.map((n) => n.value.message).join(' | ');
    return {
      refused:
        failed?.value.failureReason ??
        (notices || (error instanceof Error ? error.message : String(error))),
    };
  }
}

const HARDWARE_REFUSAL = /no hardware .*encoder works/i;

async function hardwareRun(
  ctx: Context,
  out: ScenarioOutput,
  variant: 'this machine' | 'hardware encoders off',
): Promise<void> {
  const app = await ctx.launch(
    undefined,
    variant === 'hardware encoders off' ? ['--disable-accelerated-video-encode'] : undefined,
  );
  try {
    await configure(ctx, app, {
      captureMode: 'fullscreen',
      cameraId: null,
      micId: null,
      systemAudio: false,
      requireHardware: true,
    });
    if (variant === 'hardware encoders off') {
      ctx.human.instruct('W14 — without a hardware encoder', [
        'The app now runs with Chromium’s hardware encoders switched off.',
        'If a "Share Screen" dialog appears, share the monitor as usual.',
      ]);
    }
    const result = await tryRecording(ctx, app);
    if ('refused' in result) {
      const said = HARDWARE_REFUSAL.test(result.refused);
      if (variant === 'this machine') {
        out.checks.push(
          info(
            'R2.34a',
            'this machine: refused (no working hardware encoder here)',
            said ? 'refused, says why' : 'refused for another reason',
            result.refused,
          ),
        );
      }
      out.checks.push(
        check(
          'R2.34a',
          `${variant}: the refusal says no hardware encoder works`,
          said,
          result.refused.slice(0, 200),
        ),
      );
      return;
    }
    out.projects.push(result.root);
    if (variant === 'hardware encoders off') {
      out.checks.push(
        check('R2.34a', 'hardware encoders off: the recording does not start', false, 'it started'),
      );
      await stopAndFinalize(app, 'R2.34a');
      return;
    }
    await recordFor('W14 recording', 5_000);
    const stop = await stopAndFinalize(app, 'R2.34a');
    const project = await inspectProject(stop.root);
    out.checks.push(...projectChecks(project, 'R2.34a'));
    const encoder = project.doc?.media.find((m) => m.role === 'screen')?.encoder;
    out.checks.push(
      check(
        'R2.34a',
        'this machine: project.json names a hardware encoder',
        encoder?.hardware === true,
        encoder ? `${encoder.name} (hardware ${String(encoder.hardware)})` : 'none',
      ),
    );
  } finally {
    await app.quit();
  }
}

export const w14: Scenario = {
  id: 'W14',
  title: 'Require a hardware encoder (with and without one)',
  requirements: ['R2.34a'],
  humanActions: ['1–2 portal clicks'],
  async run(ctx, out) {
    if (dryRunOnly(ctx, out, 'R2.34a', 'hardware encoder requirement')) return;
    await hardwareRun(ctx, out, 'this machine');
    await hardwareRun(ctx, out, 'hardware encoders off');
  },
};
