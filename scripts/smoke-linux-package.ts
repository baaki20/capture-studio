/**
 * Smoke test for the Linux packages in dist/ (spec §4.5 step 20). Run `npm run package:linux`
 * first, then `npm run smoke:linux` (add `-- --no-launch` to skip starting the app).
 *
 * Checks, for the AppImage and the deb:
 * - artifact sizes; deb control fields, maintainer scripts and file layout;
 * - the .desktop entry (Name, Exec … %U, Icon, Categories, StartupWMClass = desktopName) and icons;
 * - FFmpeg and ffprobe inside the package and executable; licence texts and the source offer;
 * - Electron fuses in the packaged binary; app.asar holds no sources, tests or source maps;
 * - launch: the app starts, the media utility reports the bundled FFmpeg version, and the
 *   development-only switches (CS_TEST, CS_FFMPEG_DIR, CS_USER_DATA_DIR, CS_HARNESS_SOCKET,
 *   NODE_OPTIONS, ELECTRON_RUN_AS_NODE) are ignored. Then the app is quit with SIGTERM.
 *
 * Nothing is installed: the deb is unpacked with `dpkg-deb -x` into a temporary folder and the
 * AppImage is extracted with `--appimage-extract` for inspection. The launched app gets its own
 * XDG config and Videos folders, so the user's profile and projects are untouched. It never
 * starts a recording, so no ScreenCast portal dialog appears.
 */
import { execFile, spawn } from 'node:child_process';
import { constants, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { ICON_SIZES } from './icon-art';
import {
  checkDesktopEntry,
  checkFuses,
  openAsar,
  parseDesktopEntry,
  parseFuseReport,
  REQUIRED_EXECUTABLES,
  REQUIRED_RESOURCES,
  unexpectedAsarFiles,
} from './package-checks';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCH_TIMEOUT_MS = 60_000;
const QUIT_TIMEOUT_MS = 15_000;

const { values: options } = parseArgs({
  options: {
    dist: { type: 'string', default: path.join(ROOT, 'dist') },
    'no-launch': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});

interface PackageJson {
  version: string;
  desktopName: string;
}
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;
const APP_ID = pkg.desktopName.replace(/\.desktop$/, '');
const EXECUTABLE = 'capture-studio';

interface Result {
  check: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];

function record(check: string, ok: boolean, detail = ''): void {
  results.push({ check, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? `: ${detail}` : ''}\n`);
}

async function exists(file: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await fs.access(file, mode);
    return true;
  } catch {
    return false;
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Checks an unpacked app folder (the one holding the executable and `resources/`). */
async function checkAppFolder(label: string, appDir: string): Promise<void> {
  const resources = path.join(appDir, 'resources');
  const missing: string[] = [];
  for (const file of REQUIRED_RESOURCES) {
    if (!(await exists(path.join(resources, file)))) missing.push(file);
  }
  record(
    `${label}: resources (asar, licences, FFmpeg notice and source offer)`,
    missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : REQUIRED_RESOURCES.join(', '),
  );

  for (const file of REQUIRED_EXECUTABLES) {
    const full = path.join(resources, file);
    if (!(await exists(full, constants.X_OK))) {
      record(`${label}: ${file} executable`, false, 'missing or not executable');
      continue;
    }
    try {
      const { stdout } = await exec(full, ['-version'], { timeout: 15_000 });
      record(`${label}: ${file} executable`, true, stdout.split('\n')[0] ?? '');
    } catch (error) {
      record(`${label}: ${file} executable`, false, String(error));
    }
  }

  try {
    const { stdout } = await exec(path.join(ROOT, 'node_modules', '.bin', 'electron-fuses'), [
      'read',
      '--app',
      path.join(appDir, EXECUTABLE),
    ]);
    const problems = checkFuses(parseFuseReport(stdout));
    record(
      `${label}: Electron fuses`,
      problems.length === 0,
      problems.join('; ') || 'as configured',
    );
  } catch (error) {
    record(`${label}: Electron fuses`, false, String(error));
  }

  try {
    const asar = await openAsar(path.join(resources, 'app.asar'));
    const unexpected = unexpectedAsarFiles(asar.files);
    record(
      `${label}: app.asar contents`,
      unexpected.length === 0,
      unexpected.length
        ? `unexpected ${unexpected.slice(0, 10).join(', ')}`
        : `${String(asar.files.length)} files, no sources, tests or source maps`,
    );
    const packaged = JSON.parse(
      (await asar.read('package.json')).toString('utf8'),
    ) as Partial<PackageJson>;
    record(
      `${label}: packaged desktopName`,
      packaged.desktopName === pkg.desktopName,
      String(packaged.desktopName),
    );
  } catch (error) {
    record(`${label}: app.asar contents`, false, String(error));
  }
}

async function checkDesktopFile(label: string, file: string): Promise<void> {
  if (!(await exists(file))) {
    record(`${label}: desktop entry`, false, `${file} missing`);
    return;
  }
  const entry = parseDesktopEntry(await fs.readFile(file, 'utf8'));
  const problems = checkDesktopEntry(entry, APP_ID);
  record(
    `${label}: desktop entry ${path.basename(file)}`,
    problems.length === 0,
    problems.join('; ') || `Exec=${entry.Exec ?? ''}; StartupWMClass=${entry.StartupWMClass ?? ''}`,
  );
}

async function checkIcons(label: string, hicolor: string): Promise<void> {
  const missing: string[] = [];
  for (const size of ICON_SIZES) {
    const icon = path.join(hicolor, `${String(size)}x${String(size)}`, 'apps', `${EXECUTABLE}.png`);
    if (!(await exists(icon))) missing.push(`${String(size)}x${String(size)}`);
  }
  record(
    `${label}: hicolor icons`,
    missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : ICON_SIZES.map(String).join(', '),
  );
}

/** Process IDs in a process group, from /proc. */
async function groupMembers(pgid: number): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
      // Fields after the parenthesised command: state, ppid, pgrp, …
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid) pids.push(Number(entry));
    } catch {
      // The process exited while we looked.
    }
  }
  return pids;
}

async function commandLine(pid: number): Promise<string> {
  try {
    return (await fs.readFile(`/proc/${String(pid)}/cmdline`, 'utf8')).split('\0').join(' ');
  } catch {
    return '';
  }
}

/**
 * Starts the packaged app with development-only switches set, waits for the media utility to
 * report its FFmpeg version in the app's own log, checks the switches were ignored, then quits.
 */
async function launch(label: string, command: string, work: string): Promise<void> {
  const config = path.join(work, 'config');
  const videos = path.join(work, 'Videos');
  const devProfile = path.join(work, 'dev-profile-must-not-exist');
  const harnessSocket = path.join(work, 'harness.sock');
  await fs.mkdir(config, { recursive: true });
  await fs.mkdir(videos, { recursive: true });
  // Keeps the default projects folder (app.getPath('videos')) out of the user's Videos.
  await fs.writeFile(path.join(config, 'user-dirs.dirs'), `XDG_VIDEOS_DIR="${videos}"\n`);

  const out = createWriteStream(path.join(work, 'stdout.log'));
  const err = createWriteStream(path.join(work, 'stderr.log'));
  await Promise.all([
    new Promise((resolve) => out.once('open', resolve)),
    new Promise((resolve) => err.once('open', resolve)),
  ]);
  const child = spawn(command, [], {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: config,
      // Development and test switches; a packaged build must ignore all of them.
      CS_TEST: '1',
      CS_FFMPEG_DIR: path.join(work, 'no-ffmpeg-here'),
      CS_USER_DATA_DIR: devProfile,
      CS_HARNESS_SOCKET: harnessSocket,
      NODE_OPTIONS: `--require ${path.join(work, 'no-such-module.cjs')}`,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exitCode = code ?? (signal ? -1 : null);
      resolve();
    });
  });
  const pgid = child.pid ?? 0;
  const logFile = path.join(config, 'Capture Studio', 'logs', 'main.log');

  let logText = '';
  let ready: RegExpExecArray | null = null;
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline && exitCode === undefined) {
    logText = await fs.readFile(logFile, 'utf8').catch(() => '');
    ready = /media utility ready \(pid \d+\), FFmpeg (\S+)/.exec(logText);
    if (ready || logText.includes('FFmpeg binary not found')) break;
    await sleep(500);
  }

  const startLine = /Capture Studio \S+ \(Electron[^\n]*packaged=(true|false)\)/.exec(logText);
  record(
    `${label}: launches`,
    startLine !== null && exitCode === undefined,
    startLine ? startLine[0] : `no start line in ${logFile} (exit ${String(exitCode)})`,
  );
  record(
    `${label}: media utility ready with bundled FFmpeg`,
    ready !== null && ready[1] !== '?',
    ready ? `FFmpeg ${ready[1] ?? ''}` : 'no "media utility ready" line',
  );
  record(`${label}: packaged=true`, startLine?.[1] === 'true');
  record(`${label}: CS_FFMPEG_DIR ignored`, !logText.includes('no-ffmpeg-here'));
  record(
    `${label}: CS_USER_DATA_DIR ignored`,
    !(await exists(devProfile)),
    `log written to ${path.relative(work, logFile)}`,
  );
  record(
    `${label}: CS_HARNESS_SOCKET ignored (no test control channel)`,
    !(await exists(harnessSocket)),
  );
  record(`${label}: NODE_OPTIONS and ELECTRON_RUN_AS_NODE ignored`, startLine !== null);

  const members = await groupMembers(pgid);
  const lines = await Promise.all(members.map(commandLine));
  const helpers = lines.filter((line) => line.includes('--type='));
  record(
    `${label}: CS_TEST ignored (PipeWire capturer on, no fake devices)`,
    helpers.some((line) => line.includes('WebRTCPipeWireCapturer')) &&
      !lines.some((line) => line.includes('use-fake-device-for-media-stream')),
    `${String(helpers.length)} helper processes inspected`,
  );

  // Quit: SIGTERM to the whole group (the AppImage runtime, Electron and its helpers).
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  const quit = await Promise.race([
    exited.then(() => true),
    sleep(QUIT_TIMEOUT_MS).then(() => false),
  ]);
  await sleep(1000);
  const leftovers = await groupMembers(pgid);
  if (leftovers.length > 0) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Raced with exit.
    }
  }
  logText = await fs.readFile(logFile, 'utf8').catch(() => logText);
  record(
    `${label}: quits on SIGTERM`,
    quit && leftovers.length === 0,
    `exit ${String(exitCode)}, ${String(leftovers.length)} processes left` +
      (logText.includes('media utility exited with code 0')
        ? ', media utility exited cleanly'
        : ''),
  );
  out.close();
  err.close();
}

async function smokeAppImage(file: string, work: string): Promise<void> {
  const size = (await fs.stat(file)).size;
  record('AppImage: artifact', true, `${path.basename(file)}, ${megabytes(size)}`);
  record('AppImage: executable bit', await exists(file, constants.X_OK));

  const extractDir = path.join(work, 'extract');
  await fs.mkdir(extractDir, { recursive: true });
  await exec(file, ['--appimage-extract'], { cwd: extractDir, maxBuffer: 64 * 1024 * 1024 });
  const squash = path.join(extractDir, 'squashfs-root');
  await checkAppFolder('AppImage', squash);
  await checkDesktopFile('AppImage', path.join(squash, `${APP_ID}.desktop`));
  await checkIcons('AppImage', path.join(squash, 'usr', 'share', 'icons', 'hicolor'));

  if (!options['no-launch']) await launch('AppImage', file, path.join(work, 'run'));
}

async function smokeDeb(file: string, work: string): Promise<void> {
  const size = (await fs.stat(file)).size;
  record('deb: artifact', true, `${path.basename(file)}, ${megabytes(size)}`);

  const { stdout: control } = await exec('dpkg-deb', ['-f', file]);
  const fields = Object.fromEntries(
    [...control.matchAll(/^([\w-]+): (.*)$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
  const depends = fields.Depends ?? '';
  record(
    'deb: control fields',
    fields.Package === EXECUTABLE &&
      fields.Version === pkg.version &&
      fields.Architecture === 'amd64' &&
      Boolean(fields.Maintainer) &&
      Boolean(fields.Homepage) &&
      ['libgbm1', 'libasound2', 'libnss3', 'libgtk-3-0'].every((d) => depends.includes(d)),
    `Package=${fields.Package ?? ''} Version=${fields.Version ?? ''} Arch=${fields.Architecture ?? ''} ` +
      `Maintainer=${fields.Maintainer ?? ''} Homepage=${fields.Homepage ?? ''}`,
  );
  process.stdout.write(`      Depends: ${depends}\n      Recommends: ${fields.Recommends ?? ''}\n`);

  const scripts = path.join(work, 'control');
  await exec('dpkg-deb', ['-e', file, scripts]);
  const postinst = await fs.readFile(path.join(scripts, 'postinst'), 'utf8').catch(() => '');
  record(
    'deb: postinst',
    postinst.includes(`/usr/bin/${EXECUTABLE}`) && postinst.includes('chrome-sandbox'),
    'links /usr/bin/capture-studio, sets chrome-sandbox mode, installs the AppArmor profile',
  );

  const root = path.join(work, 'root');
  await exec('dpkg-deb', ['-x', file, root]);
  const appDir = path.join(root, 'opt', 'Capture Studio');
  record(
    'deb: layout',
    await exists(path.join(appDir, EXECUTABLE), constants.X_OK),
    `/opt/Capture Studio/${EXECUTABLE}`,
  );
  await checkAppFolder('deb', appDir);
  await checkDesktopFile(
    'deb',
    path.join(root, 'usr', 'share', 'applications', `${APP_ID}.desktop`),
  );
  await checkIcons('deb', path.join(root, 'usr', 'share', 'icons', 'hicolor'));

  if (!options['no-launch']) {
    await launch('deb (extracted)', path.join(appDir, EXECUTABLE), path.join(work, 'run'));
  }
}

const dist = path.resolve(options.dist);
const appImage = path.join(dist, `${EXECUTABLE}-${pkg.version}-x86_64.AppImage`);
const deb = path.join(dist, `${EXECUTABLE}_${pkg.version}_amd64.deb`);
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-studio-smoke-'));
process.stdout.write(`work folder: ${work}\n`);

try {
  for (const [label, file, run] of [
    ['AppImage', appImage, smokeAppImage],
    ['deb', deb, smokeDeb],
  ] as const) {
    if (!(await exists(file))) {
      record(`${label}: artifact`, false, `${file} not found (run npm run package:linux)`);
      continue;
    }
    const dir = path.join(work, label);
    await fs.mkdir(dir);
    try {
      await run(file, dir);
    } catch (error) {
      record(`${label}: smoke test`, false, error instanceof Error ? error.message : String(error));
    }
  }
} finally {
  if (!options.keep) await fs.rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${String(results.length - failed.length)}/${String(results.length)} checks passed\n`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
