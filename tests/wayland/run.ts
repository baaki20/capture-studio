/**
 * The Wayland scenario harness (§4.6.5, §4.6.4): `npm run test:wayland [-- <ids>] [options]`.
 *
 * It builds the app, launches it per scenario with a harness profile and the test-only control
 * channel, tells the human exactly what to click (the GNOME portal needs one click per
 * recording), drives everything else through the real CLI (`--action`) and the channel, then
 * analyzes the recorded projects and prints PASS/FAIL with numbers. Reports go to
 * `docs/verification/wayland-<date>-<time>.{json,md}`.
 *
 * Scenarios: R1.20 (no human), W1–W7, W9, W10 by default; W8 (30 min) and soak (60 min) only when
 * named (`npm run test:soak` runs the soak). Options:
 *   --dry-run            X11 test mode, fake camera/mic, no portal, no human (proves the harness)
 *   --yes                answer every prompt automatically (implied by --dry-run)
 *   --quick              shorter recordings (W1 20 s, W8 1 min, soak 2 min, preview 20 s)
 *   --w1-seconds <n>     --w8-minutes <n>     --soak-minutes <n>     --preview-seconds <n>
 *   --no-build           use the existing out/ build
 *   --keep               keep a dry run's temporary profile and projects
 *   --list               list the scenarios and exit
 *
 * Real runs keep their profile in ~/.cache/capture-studio-harness/profile (device choices) and
 * projects in ~/.cache/capture-studio-harness/runs/<run>/projects for inspection.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppSession, BIN_DIR, MAIN, ROOT, type Mode } from './lib/app';
import { errorCheck } from './lib/checks';
import { Human } from './lib/human';
import {
  machineInfo,
  overallStatus,
  totals,
  writeReport,
  type RunReport,
  type ScenarioResult,
} from './lib/report';
import type { Context, Devices, Durations, Scenario, ScenarioOutput } from './lib/scenario';
import { finalize } from './scenarios/r1-20-finalize';
import { w1 } from './scenarios/w1-sync';
import { w2 } from './scenarios/w2-region-pause';
import { w3, w4, w5 } from './scenarios/w3-w5';
import { w6 } from './scenarios/w6-scaling';
import { w7 } from './scenarios/w7-kill';
import { soak, w8 } from './scenarios/w8-soak';
import { w9, w10 } from './scenarios/w9-w10';

const SCENARIOS: Scenario[] = [finalize, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, soak];

interface Options {
  ids: string[];
  mode: Mode;
  yes: boolean;
  quick: boolean;
  build: boolean;
  keep: boolean;
  list: boolean;
  durations: Partial<Durations>;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    ids: [],
    mode: 'real',
    yes: false,
    quick: false,
    build: true,
    keep: false,
    list: false,
    durations: {},
  };
  const number = (i: number) => {
    const v = Number(argv[i]);
    if (!(v > 0)) throw new Error(`${argv[i - 1] ?? ''} needs a positive number`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') options.mode = 'dry-run';
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--quick') options.quick = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--w1-seconds') options.durations.w1S = number(++i);
    else if (arg === '--w8-minutes') options.durations.w8Min = number(++i);
    else if (arg === '--soak-minutes') options.durations.soakMin = number(++i);
    else if (arg === '--preview-seconds') options.durations.previewS = number(++i);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.ids.push(arg);
  }
  return options;
}

function selectScenarios(ids: readonly string[]): Scenario[] {
  if (ids.length === 0) return SCENARIOS.filter((s) => !s.long);
  if (ids.some((id) => id.toLowerCase() === 'all')) return SCENARIOS;
  return ids.map((id) => {
    const found = SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase());
    if (!found) throw new Error(`unknown scenario ${id} (try --list)`);
    return found;
  });
}

interface MediaDevice {
  deviceId: string;
  kind: string;
  label: string;
}

const ENUMERATE = `(async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {}
  const list = await navigator.mediaDevices.enumerateDevices();
  return list.map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label }));
})()`;

/** The default output's name, from PipeWire (null when wpctl is missing). */
function defaultOutputName(): string | null {
  const result = spawnSync('wpctl', ['inspect', '@DEFAULT_AUDIO_SINK@'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return /node\.description = "([^"]*)"/.exec(result.stdout)?.[1] ?? null;
}

/**
 * The pattern's beeps must come out of the speakers so the room mic hears them. GNOME switches
 * the output to a USB headset when it is plugged in; then the room mic hears nothing (session 1
 * re-run: mic "sync" from noise) and unplugging it in W4 cuts the system-audio capture.
 */
async function requireSpeakerOutput(human: Human, devices: Devices): Promise<void> {
  const headset = devices.unplugMicLabel?.split(' ')[0];
  if (!headset) return;
  for (;;) {
    const output = defaultOutputName();
    if (!output?.includes(headset)) return;
    human.instruct('Sound output', [
      `The sound output is "${output}". Switch it to the built-in speakers:`,
      'Settings → Sound → Output Device → the built-in speakers (or the top-bar sound menu).',
      'Then press Enter.',
    ]);
    await human.enter();
  }
}

/** Chooses the camera, the room mic and the unpluggable mic (remembered between real runs). */
async function chooseDevices(
  human: Human,
  app: AppSession,
  file: string,
  mode: Mode,
): Promise<Devices> {
  const all = await app.evalIn<MediaDevice[]>('shell', ENUMERATE);
  const real = (d: MediaDevice) => !['default', 'communications'].includes(d.deviceId);
  const cameras = all.filter((d) => d.kind === 'videoinput' && real(d));
  const mics = all.filter((d) => d.kind === 'audioinput' && real(d));
  const saved = (await fs.readFile(file, 'utf8').then(JSON.parse, () => null)) as Devices | null;
  const byLabel = (list: MediaDevice[], label: string | null | undefined) =>
    list.findIndex((d) => label && d.label === label);
  const pick = async (
    question: string,
    list: MediaDevice[],
    preferred: number,
    allowNone: boolean,
  ): Promise<MediaDevice | null> => {
    const labels = [
      ...list.map((d) => d.label || d.deviceId.slice(0, 12)),
      ...(allowNone ? ['(none)'] : []),
    ];
    if (labels.length === 0) return null;
    const index = await human.choose(question, labels, Math.max(0, preferred));
    return list[index] ?? null;
  };
  const prefer = (list: MediaDevice[], savedLabel: string | null | undefined, pattern: RegExp) => {
    const s = byLabel(list, savedLabel);
    if (s >= 0) return s;
    const p = list.findIndex((d) => pattern.test(d.label));
    return p >= 0 ? p : 0;
  };
  const camera = await pick(
    'Camera for the scenarios',
    cameras,
    prefer(cameras, saved?.cameraLabel, /integrated|built-?in|webcam|hd/i),
    true,
  );
  const builtIn = mics.findIndex((d) =>
    /built-?in|internal|analog|digital mic|sof|hda/i.test(d.label),
  );
  const room = await pick(
    'Microphone that hears the speakers (W1, W2, W7, W8, soak) — the built-in mic is best',
    mics,
    // The built-in mic before a remembered one: a USB headset would break W4 (it gets unplugged).
    builtIn >= 0 ? builtIn : prefer(mics, saved?.roomMicLabel, /$^/),
    false,
  );
  // The room mic stays connected through the whole run, so it cannot be the one W4 unplugs.
  let unplug: MediaDevice | null;
  for (;;) {
    unplug = await pick(
      'Microphone you will unplug in W4 (the USB headset)',
      mics,
      prefer(mics, saved?.unplugMicLabel, mode === 'real' ? /usb|headset/i : /$^/),
      true,
    );
    if (unplug?.deviceId !== room?.deviceId || !unplug) break;
    // A dry run cannot pick again: it has one fake mic, so W4 has none to unplug.
    if (human.auto) {
      unplug = null;
      break;
    }
    human.info(
      'That is also the room mic. Pick another, or (none) to skip W4; or restart and pick the built-in mic for the room.',
    );
  }
  const devices: Devices = {
    cameraId: camera?.deviceId ?? null,
    cameraLabel: camera?.label ?? null,
    roomMicId: room?.deviceId ?? null,
    roomMicLabel: room?.label ?? null,
    unplugMicId: unplug?.deviceId ?? null,
    unplugMicLabel: unplug?.label ?? null,
  };
  await fs.writeFile(file, `${JSON.stringify(devices, null, 2)}\n`);
  return devices;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const scenarios = selectScenarios(options.ids);
  if (options.list) {
    for (const s of SCENARIOS) {
      console.log(`${s.id.padEnd(6)} ${s.title}${s.long ? ' (long; run by name)' : ''}`);
      console.log(`       human: ${s.humanActions.join('; ') || 'nothing'}`);
    }
    return;
  }
  const mode = options.mode;
  const human = new Human(mode === 'dry-run' || options.yes);
  const durations: Durations = {
    w1S: options.quick ? 20 : 60,
    w7S: options.quick ? 10 : 20,
    w8Min: options.quick ? 1 : 30,
    soakMin: options.quick ? 2 : 60,
    previewS: options.quick ? 20 : 300,
    ...options.durations,
  };

  if (mode === 'real' && process.env.XDG_SESSION_TYPE !== 'wayland') {
    const go = await human.yesNo(
      `This session is ${process.env.XDG_SESSION_TYPE ?? 'unknown'}, not Wayland. Continue anyway?`,
      false,
    );
    if (!go) return;
  }
  if (!existsSync(path.join(BIN_DIR, 'ffmpeg'))) {
    throw new Error('FFmpeg is missing: run `npm run fetch:ffmpeg` first');
  }
  if (options.build) {
    console.log('Building the app (electron-vite build)…');
    const build = spawnSync('npx', ['electron-vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('the build failed');
  } else if (!existsSync(MAIN)) {
    throw new Error('out/main/index.js is missing: build first or drop --no-build');
  }

  const startedAt = new Date();
  const runId = startedAt.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const base =
    mode === 'real'
      ? path.join(os.homedir(), '.cache', 'capture-studio-harness')
      : await fs.mkdtemp(path.join(os.tmpdir(), 'cs-harness-'));
  const runDir = path.join(base, 'runs', runId);
  const projectsDir = path.join(runDir, 'projects');
  const profileDir = path.join(base, 'profile');
  await fs.mkdir(projectsDir, { recursive: true });
  const appLog = path.join(runDir, 'app.log');
  const log = (text: string) => console.log(`  ${text}`);
  const launch = (env?: Record<string, string>) =>
    AppSession.launch({ mode, profileDir, logFile: appLog, ...(env ? { env } : {}) });

  console.log(
    `\nCapture Studio Wayland harness — ${mode === 'dry-run' ? 'DRY RUN (X11 test mode, no portal)' : 'real run'}`,
  );
  console.log(`run folder: ${runDir}`);
  const setup = await launch();
  let devices: Devices;
  try {
    devices = await chooseDevices(human, setup, path.join(base, 'devices.json'), mode);
  } finally {
    await setup.quit();
  }
  if (mode === 'real') await requireSpeakerOutput(human, devices);

  console.log('\nPlan:');
  for (const s of scenarios) {
    console.log(`  ${s.id.padEnd(6)} ${s.title}`);
    console.log(`         you: ${s.humanActions.join('; ') || 'nothing (automatic)'}`);
  }
  if (options.ids.length === 0) {
    console.log('  (W8 and soak are long: run them by name, e.g. `npm run test:soak`.)');
  }
  await human.enter(
    '\nPress Enter to start (Ctrl+C to quit; type "skip" + Enter during a prompt to give up on it)',
  );

  const ctx: Context = {
    mode,
    human,
    quick: options.quick,
    durations,
    runDir,
    profileDir,
    projectsDir,
    devices,
    launch,
    log,
  };
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.id}: ${scenario.title} ===`);
    const out: ScenarioOutput = { checks: [], notes: [], projects: [] };
    const began = Date.now();
    try {
      await scenario.run(ctx, out);
    } catch (error) {
      out.checks.push(errorCheck(scenario.requirements[0] ?? scenario.id, 'scenario run', error));
      console.error(error);
    }
    const result: ScenarioResult = {
      id: scenario.id,
      title: scenario.title,
      requirements: scenario.requirements,
      humanActions: scenario.humanActions,
      status: overallStatus(out.checks),
      checks: out.checks,
      notes: out.notes,
      projects: out.projects,
      startedAt: new Date(began).toISOString(),
      durationS: (Date.now() - began) / 1000,
    };
    results.push(result);
    for (const c of out.checks) {
      console.log(
        `  ${c.status.toUpperCase().padEnd(12)} ${c.requirement.padEnd(6)} ${c.name}${c.value ? `: ${c.value}` : ''}${c.limit ? ` (limit ${c.limit})` : ''}`,
      );
    }
    console.log(`→ ${scenario.id}: ${result.status.toUpperCase()}`);
  }

  const report: RunReport = {
    kind: 'capture-studio-wayland-verification',
    version: 1,
    mode,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    machine: machineInfo(),
    scenarios: results,
    totals: totals(results),
  };
  const written = await writeReport(report);
  human.close();
  console.log('\nSummary:');
  for (const r of results) console.log(`  ${r.id.padEnd(6)} ${r.status.toUpperCase()}`);
  console.log(`\nReport: ${written.md}\n        ${written.json}`);
  if (mode === 'dry-run' && !options.keep) await fs.rm(base, { recursive: true, force: true });
  else console.log(`Projects and app log: ${runDir}`);
  process.exitCode = results.some((r) => r.status === 'fail' || r.status === 'error') ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
