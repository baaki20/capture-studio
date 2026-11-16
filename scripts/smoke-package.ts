/**
 * Smoke test for the Windows and macOS packages in dist/ (P3 step 9; Linux has
 * smoke-linux-package.ts). Run after `npm run package:win` or `npm run package:mac`.
 *
 * Checks the unpacked app that electron-builder leaves next to the installer:
 * - the installer (NSIS .exe; dmg and zip) and the update metadata (latest.yml, latest-mac.yml);
 * - resources: app.asar, app-update.yml, licences, this target's FFmpeg and ffprobe (they run and
 *   report the pinned version) and the native helper with its crate notices;
 * - launch: the packaged app starts with a profile of its own, its log says it loaded the native
 *   helper and how the updater decided, and it is then stopped.
 *
 * Nothing is installed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const results: { ok: boolean; line: string }[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  results.push({ ok, line: `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}` });
}

interface Layout {
  key: string;
  resources: string;
  executable: string;
  exe: string;
  installers: RegExp[];
  feed: string;
  userData: string;
}

async function layout(): Promise<Layout> {
  const key = `${process.platform}-${process.arch}`;
  if (process.platform === 'win32') {
    const app = path.join(DIST, 'win-unpacked');
    return {
      key,
      resources: path.join(app, 'resources'),
      executable: path.join(app, 'Capture Studio.exe'),
      exe: '.exe',
      installers: [/^capture-studio-setup-.*\.exe$/],
      feed: 'latest.yml',
      userData: path.join(os.tmpdir(), 'cs-smoke-profile'),
    };
  }
  if (process.platform === 'darwin') {
    const dirs = (await fs.readdir(DIST)).filter((d) => d.startsWith('mac'));
    const dir = dirs[0];
    if (!dir) throw new Error('no dist/mac* folder');
    const bundle = path.join(DIST, dir, 'Capture Studio.app');
    return {
      key,
      resources: path.join(bundle, 'Contents', 'Resources'),
      executable: path.join(bundle, 'Contents', 'MacOS', 'Capture Studio'),
      exe: '',
      installers: [/^capture-studio-.*\.dmg$/, /^Capture Studio-.*-mac\.zip$|\.zip$/],
      feed: 'latest-mac.yml',
      userData: path.join(os.tmpdir(), 'cs-smoke-profile'),
    };
  }
  throw new Error('use smoke-linux-package.ts on Linux');
}

async function launch(l: Layout): Promise<string> {
  // A packaged build ignores CS_USER_DATA_DIR, so the app uses its normal profile; read its log
  // from there after a fresh start.
  const appData =
    process.platform === 'win32'
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
          'Capture Studio',
        )
      : path.join(os.homedir(), 'Library', 'Application Support', 'Capture Studio');
  const log = path.join(appData, 'logs', 'main.log');
  await fs.rm(log, { force: true });
  const child = spawn(l.executable, [], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  let text = '';
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    text = await fs.readFile(log, 'utf8').catch(() => '');
    if (text.includes('updates: ') && text.includes('native helper: ')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  } else {
    try {
      process.kill(-(child.pid ?? 0), 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  return text;
}

async function main(): Promise<void> {
  const l = await layout();
  const files = await fs.readdir(DIST);
  for (const pattern of l.installers) {
    const found = files.find((f) => pattern.test(f));
    record(`installer ${pattern.source}`, found !== undefined, found ?? 'missing');
  }
  record(`update feed ${l.feed}`, files.includes(l.feed));

  const required = [
    'app.asar',
    'app-update.yml',
    'LICENSE.txt',
    'licenses/FFMPEG-NOTICE.txt',
    'licenses/FFMPEG-SOURCE-OFFER.txt',
    `bin/${l.key}/LICENSE.txt`,
    `bin/${l.key}/BUILD-INFO.json`,
    `native/${l.key}/cs-native.node`,
    `native/${l.key}/NOTICES.txt`,
  ];
  const missing = required.filter((f) => !existsSync(path.join(l.resources, f)));
  record(
    'resources',
    missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : 'all present',
  );
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const file = path.join(l.resources, 'bin', l.key, `${tool}${l.exe}`);
    try {
      const first = execFileSync(file, ['-hide_banner', '-version'], { encoding: 'utf8' }).split(
        '\n',
      )[0];
      record(`${tool} runs`, true, first ?? '');
    } catch (error) {
      record(`${tool} runs`, false, error instanceof Error ? error.message : String(error));
    }
  }

  const log = await launch(l);
  const native = /native helper: ([^\n]+)/.exec(log)?.[1];
  record(
    'launch: native helper loaded',
    native !== undefined && !native.startsWith('not loaded'),
    native ?? 'no log line',
  );
  const updates = /updates: ([^\n]+)/.exec(log)?.[1];
  record('launch: updater decided', updates !== undefined, updates ?? 'no log line');

  for (const r of results) console.log(r.line);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${String(results.length - failed)}/${String(results.length)} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
