/**
 * Child processes of the media utility (FFmpeg, `pw-record`) die with it.
 *
 * An orphaned FFmpeg keeps a file open, burns CPU and, if it hung, never ends: one export
 * outlived the tests that spawned it by 34 hours. Three layers cover the ways the parent can go:
 * - **Clean exit** (`process.exit`, the event loop draining, a SIGTERM handler finishing): every
 *   live child is SIGKILLed synchronously in `process.on('exit')`.
 * - **Signals and loss of the parent link**: `installChildReaper` (the utility's entry point)
 *   turns SIGTERM, SIGINT and `disconnect` into a bounded graceful shutdown followed by exit.
 * - **Crash or SIGKILL of the parent**, where no JavaScript runs: on Linux each child is started
 *   through `setpriv --pdeathsig KILL`, which sets `PR_SET_PDEATHSIG` and then execs the real
 *   program (same pid, same stdio, same exit status), so the kernel kills it when its parent
 *   dies. Without `setpriv` a small `sh` watchdog per child polls the parent instead (every
 *   0.5 s) and kills the child once it is reparented.
 */
import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** How children are tied to the parent's death. */
export type DeathSignalMode = 'setpriv' | 'watchdog' | 'none';

const live = new Set<ChildProcess>();
let exitHookInstalled = false;
let probedMode: DeathSignalMode | null = null;
let forcedMode: DeathSignalMode | null = null;

/**
 * The watchdog script: `$1` is the parent pid, `$2` the child pid. It ends quietly when the
 * child is gone and kills it when the watchdog itself has been reparented, which happens exactly
 * when the parent died (a zombie parent still answers `kill -0`, so the pid alone is not
 * enough). `/proc/<pid>/stat` field 4 is the ppid; the comm field of `sh` holds no spaces.
 */
const WATCHDOG_SCRIPT = [
  'while :; do',
  '  read -r _ _ _ ppid _ < /proc/$$/stat || break',
  '  [ "$ppid" = "$1" ] || break',
  '  kill -0 "$2" 2>/dev/null || exit 0',
  '  sleep 0.5 2>/dev/null || sleep 1',
  'done',
  'kill -9 "$2" 2>/dev/null',
].join('\n');

function probeMode(): DeathSignalMode {
  if (process.platform !== 'linux') return 'none';
  const probe = spawnSync('setpriv', ['--pdeathsig', 'KILL', '--', 'true'], {
    stdio: 'ignore',
    timeout: 5000,
  });
  if (probe.status === 0) return 'setpriv';
  const sh = spawnSync('sh', ['-c', 'test -r /proc/$$/stat'], { stdio: 'ignore', timeout: 5000 });
  return sh.status === 0 ? 'watchdog' : 'none';
}

/** The mode in use on this machine (probed once). */
export function deathSignalMode(): DeathSignalMode {
  probedMode ??= probeMode();
  return forcedMode ?? probedMode;
}

/** For tests: force a mode (`null` returns to the probed one). */
export function setDeathSignalMode(mode: DeathSignalMode | null): void {
  forcedMode = mode;
}

function killNow(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/** SIGKILLs every live child synchronously. Safe to call from `process.on('exit')`. */
export function killAllChildren(): void {
  for (const child of live) killNow(child);
  live.clear();
}

/** Children started through `spawnChild` that have not exited yet. */
export function liveChildren(): readonly ChildProcess[] {
  return [...live];
}

function track(child: ChildProcess): void {
  if (child.pid === undefined) return;
  live.add(child);
  child.once('exit', () => live.delete(child));
  child.once('error', () => live.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', killAllChildren);
  }
}

function startWatchdog(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const watchdog = nodeSpawn(
    'sh',
    ['-c', WATCHDOG_SCRIPT, 'cs-watchdog', String(process.pid), String(child.pid)],
    { stdio: 'ignore', windowsHide: true },
  );
  watchdog.on('error', () => undefined);
  // The watchdog must not outlive a child that ended normally: its pid could be reused.
  child.once('exit', () => killNow(watchdog));
  // It holds no work of ours, so it never keeps the event loop alive.
  watchdog.unref();
  track(watchdog);
}

/**
 * Whether `command` names an executable (a path, or a name found on `PATH`). A missing program
 * is spawned directly, so it still fails with Node's ENOENT `error` event instead of an exit
 * status from `setpriv`.
 */
function isExecutable(command: string, options: SpawnOptions): boolean {
  const candidates = command.includes('/')
    ? [path.resolve(String(options.cwd ?? '.'), command)]
    : (options.env?.PATH ?? process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command));
  return candidates.some((file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * `spawn` for long-running media children: tracked, killed on exit, and tied to the parent's
 * death (see the module comment). `spawnImpl` replaces `child_process.spawn` (tests); a
 * replaced spawn is still tracked but not wrapped.
 */
export function spawnChild(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  spawnImpl?: SpawnFn,
): ChildProcess {
  if (spawnImpl) {
    const child = spawnImpl(command, args, options);
    track(child);
    return child;
  }
  let mode = deathSignalMode();
  if (mode !== 'none' && !isExecutable(command, options)) mode = 'none';
  const child =
    mode === 'setpriv'
      ? nodeSpawn('setpriv', ['--pdeathsig', 'KILL', '--', command, ...args], options)
      : nodeSpawn(command, [...args], options);
  track(child);
  if (mode === 'watchdog') startWatchdog(child);
  return child;
}

/**
 * For the utility's entry point: SIGTERM, SIGINT and loss of the parent link run `shutdown`
 * (flush writers, stop captures) for at most `graceMs`, then exit, which kills what is left.
 */
export function installChildReaper(shutdown: () => Promise<void>, graceMs = 3000): void {
  let exiting = false;
  const stop = (): void => {
    if (exiting) return;
    exiting = true;
    const timer = setTimeout(() => process.exit(0), graceMs);
    void shutdown()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        process.exit(0);
      });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('disconnect', stop);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', killAllChildren);
  }
}
