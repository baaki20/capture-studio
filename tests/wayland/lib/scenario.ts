/**
 * What every scenario gets (`Context`) and the steps they share: configuring the recorder,
 * starting a recording through the setup panel with the human answering the portal, the region
 * picker (dragged and confirmed automatically), stopping through the real CLI, and exporting.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExportOptions } from '../../../src/shared/ipc/contract';
import type { Settings } from '../../../src/shared/settings/schema';
import { runExportJob } from '../../../src/utility/media/export/export-job';
import type { AppSession } from './app';
import { BIN_DIR, type Mode } from './app';
import { check, info, inspectProject, type Check } from './checks';
import { countdown, type Human } from './human';

export interface Devices {
  cameraId: string | null;
  cameraLabel: string | null;
  /** The mic that hears the speakers (W1, W2, W8, soak). */
  roomMicId: string | null;
  roomMicLabel: string | null;
  /** The mic the human unplugs in W4 (the USB headset). */
  unplugMicId: string | null;
  unplugMicLabel: string | null;
}

export interface Durations {
  w1S: number;
  w7S: number;
  w8Min: number;
  soakMin: number;
  previewS: number;
}

export interface Context {
  mode: Mode;
  human: Human;
  quick: boolean;
  durations: Durations;
  runDir: string;
  profileDir: string;
  projectsDir: string;
  devices: Devices;
  /** Starts the app for this run's profile (logs go to the run folder). */
  launch(env?: Record<string, string>): Promise<AppSession>;
  log(text: string): void;
}

export interface ScenarioOutput {
  checks: Check[];
  notes: string[];
  projects: string[];
}

export interface Scenario {
  id: string;
  title: string;
  requirements: string[];
  /** What the human does, for the plan and the report. */
  humanActions: string[];
  /** Long scenarios run only when asked for by name. */
  long?: boolean;
  run(ctx: Context, out: ScenarioOutput): Promise<void>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The recorder setup for a scenario, on top of the harness defaults. */
/** Waits until the camera and mic a scenario needs are plugged in (real runs ask the human). */
export async function requireDevices(
  ctx: Context,
  app: AppSession,
  ids: (string | null | undefined)[],
) {
  const wanted = ids.filter((id): id is string => !!id);
  for (;;) {
    const present = await app.evalIn<string[]>(
      'shell',
      `navigator.mediaDevices.enumerateDevices().then((l) => l.map((d) => d.deviceId))`,
    );
    const missing = wanted.filter((id) => !present.includes(id));
    if (missing.length === 0) return;
    const d = ctx.devices;
    const names = missing.map(
      (id) =>
        (id === d.cameraId ? d.cameraLabel : id === d.unplugMicId ? d.unplugMicLabel : null) ??
        (id === d.roomMicId ? d.roomMicLabel : null) ??
        id.slice(0, 12),
    );
    if (ctx.mode !== 'real') throw new Error(`device missing: ${names.join(', ')}`);
    ctx.human.instruct('Device not connected', [
      `Plug in: ${names.join(', ')}.`,
      'Then press Enter.',
    ]);
    await ctx.human.enter();
  }
}

export async function configure(
  ctx: Context,
  app: AppSession,
  recorder: Partial<Settings['recorder']>,
): Promise<void> {
  await requireDevices(ctx, app, [recorder.cameraId, recorder.micId]);
  await app.configure({
    projectsDir: ctx.projectsDir,
    exportsDir: path.join(ctx.runDir, 'exports'),
    recorder: {
      countdownSec: 0,
      fps: 30,
      quality: 'standard',
      minimizeControlsOnStart: 'auto',
      afterRecording: 'show-in-library',
      micProcessing: { ec: false, ns: false, agc: false },
      ...recorder,
    },
  });
}

export const PORTAL_STEPS = [
  'A "Share Screen" dialog opens (it may appear on top of the black flashing pattern).',
  'Choose your monitor (the whole screen), then click "Share".',
  'Then leave the mouse and keyboard alone until the terminal asks for something.',
];

/** The portal line of a pre-recording instruction block (nothing to click in dry runs). */
export function portalHint(mode: Mode): string[] {
  return mode === 'real'
    ? ['A "Share Screen" dialog then opens on top: choose your monitor and click "Share".']
    : [];
}

/**
 * Clicks Record and waits until recording runs: the human answers the portal (real mode); in
 * region mode the picker gets a drag over `region` (fractions) and Enter. Returns the project
 * folder and when recording started.
 */
export async function startRecording(
  ctx: Context,
  app: AppSession,
  options: {
    region?: { from: [number, number]; to: [number, number] };
    portalSteps?: string[];
  } = {},
): Promise<{ root: string; startedAt: number }> {
  const mark = app.mark();
  await app.clickRecord();
  const acquiring = await app.waitState(
    (s) => s.state === 'acquiring' || s.state === 'failed',
    30_000,
    mark,
  );
  const past = (s: { state: string }) =>
    ['picking-region', 'countdown', 'recording', 'failed', 'configuring', 'idle'].includes(s.state);
  const first = await (ctx.mode === 'real'
    ? ctx.human.act(
        'Portal: share your screen',
        options.portalSteps ?? PORTAL_STEPS,
        app.waitState(past, 180_000, acquiring.index),
        180_000,
      )
    : app.waitState(past, 60_000, acquiring.index));
  if (first.value.state === 'picking-region') {
    await pickRegion(app, options.region ?? { from: [0.25, 0.25], to: [0.75, 0.75] });
  } else if (['failed', 'configuring', 'idle'].includes(first.value.state)) {
    throw new Error(
      `recording did not start (${first.value.state}${first.value.failureReason ? `: ${first.value.failureReason}` : ''})`,
    );
  }
  const recording = await app.waitState((s) => s.state === 'recording', 60_000, first.index);
  const root = await app.waitRoot(30_000);
  ctx.log(`recording into ${root}`);
  return { root, startedAt: recording.at };
}

/** Drags a region in the picker window and confirms it with Enter (W2, W6, soak). */
export async function pickRegion(
  app: AppSession,
  region: { from: [number, number]; to: [number, number] },
): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const windows = await app.windows();
    if (windows.some((w) => w.role === 'picker' && w.visible)) break;
    await sleep(200);
  }
  // The picker ignores keys for 500 ms after opening and input until its frame has loaded,
  // which takes longer on a busy machine: retry until it leaves picking-region.
  for (let attempt = 1; ; attempt++) {
    await sleep(1_500);
    const mark = app.mark();
    await app.call('drag', { window: 'picker', from: region.from, to: region.to });
    await sleep(300);
    await app.call('key', { window: 'picker', key: 'Enter' });
    try {
      await app.waitState((s) => s.state !== 'picking-region', 3_000, mark);
      return;
    } catch (error) {
      if (attempt >= 5)
        throw new Error('the region picker did not take the drag and Enter', { cause: error });
    }
  }
}

/** Stops through the real CLI and waits for the project; returns timing checks. */
export async function stopAndFinalize(
  app: AppSession,
  requirement = 'R1.2',
): Promise<{ root: string; checks: Check[]; finalizeMs: number }> {
  const since = Date.now();
  const before = await app.status();
  if (!['recording', 'paused'].includes(before.state))
    throw new Error(
      `the recording stopped before the harness asked (state ${before.state}); app.log names the source ("action: stop (from …)")`,
    );
  const mark = app.mark();
  const cli = await app.cli('stop-recording');
  const finalizing = await app.waitState((s) => s.state === 'finalizing', 15_000, mark);
  const ready = await app.waitProject(since, 15 * 60_000);
  const finalizeMs = ready.at - finalizing.at;
  return {
    root: ready.value.root,
    finalizeMs,
    checks: [
      info(
        requirement,
        'CLI --action stop-recording → finalizing',
        `${String(finalizing.at - cli.startedAt)} ms`,
        `includes starting the second instance (${String(cli.exitMs)} ms to exit, code ${String(cli.code)})`,
      ),
      info('R1.20', 'finalizing → project ready', `${(finalizeMs / 1000).toFixed(1)} s`),
    ],
  };
}

/** The controls window minimizes when recording starts on Wayland (R1.11). */
export async function controlsMinimizedCheck(ctx: Context, app: AppSession): Promise<Check> {
  await sleep(1_000);
  const controls = (await app.windows()).find((w) => w.role === 'controls');
  if (ctx.mode === 'dry-run') {
    return info(
      'R1.11',
      'controls window state (X11 test mode: not minimized by policy)',
      controls ? (controls.minimized ? 'minimized' : 'shown') : 'none',
    );
  }
  return check(
    'R1.11',
    'controls window minimized while recording',
    controls?.minimized === true,
    controls ? (controls.minimized ? 'minimized' : 'not minimized') : 'no controls window',
  );
}

/** Records for `ms`, showing a countdown. */
export async function recordFor(label: string, ms: number): Promise<void> {
  await countdown(label, ms);
}

/** Exports a project at `quality` in-process (the same graph as the app) and times it. */
export async function exportProject(
  ctx: Context,
  root: string,
  quality: ExportOptions['quality'],
): Promise<{ output: string; ms: number; durationUs: number }> {
  const project = await inspectProject(root);
  if (!project.doc) throw new Error(`cannot export: ${project.error ?? 'no project'}`);
  const output = path.join(
    ctx.runDir,
    'exports',
    `${path.basename(root, '.cstudio')}-${quality}.mp4`,
  );
  await fs.mkdir(path.dirname(output), { recursive: true });
  const started = performance.now();
  const result = await runExportJob({
    ffmpegPath: path.join(BIN_DIR, 'ffmpeg'),
    ffprobePath: path.join(BIN_DIR, 'ffprobe'),
    root,
    doc: project.doc,
    options: { resolution: 'canvas', fps: 'project', quality, encoder: 'software' },
    hardwareEncoder: null,
    output,
    overwrite: true,
  });
  return { output, ms: performance.now() - started, durationUs: result.durationUs };
}
