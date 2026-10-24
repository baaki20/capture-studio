/**
 * Runs FFmpeg jobs in the media utility process (§1.3, §4.3.9 step 7).
 *
 * - Progress comes from `-progress pipe:1` and is reported as `out_time_us / duration`.
 * - Cancel writes `q` to stdin (FFmpeg finishes the container cleanly), then SIGKILLs after 5 s.
 * - Output files named in `removeOnFailure` are deleted after a cancel or failure, so no partial
 *   file is left behind (R1.47).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { err, ok, type Result } from '../../shared/result';

export interface FfmpegProgress {
  /** Output time reached, in µs, or null if FFmpeg has not reported one yet. */
  outTimeUs: number | null;
  /** 0–1 when the expected duration is known. */
  fraction: number | null;
  /** Encoding speed relative to real time (`1.5` = 1.5×). */
  speed: number | null;
  frame: number | null;
  /** True for the final block (`progress=end`). */
  done: boolean;
  /** Every key of the progress block, verbatim. */
  raw: Record<string, string>;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value === 'N/A') return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** `HH:MM:SS.micro` → µs. */
function parseOutTime(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-)?(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
  if (!m) return null;
  const [, sign, h, mi, s, frac = ''] = m;
  const micros = Number(frac.padEnd(6, '0').slice(0, 6));
  const us = ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1_000_000 + micros;
  return sign ? -us : us;
}

/**
 * Returns a function that accepts stdout chunks of `-progress pipe:1` output and calls
 * `onProgress` once per completed block (each block ends with `progress=continue|end`).
 */
export function createProgressParser(
  durationUs: number | undefined,
  onProgress: (progress: FfmpegProgress) => void,
): (chunk: string) => void {
  let buffer = '';
  let block: Record<string, string> = {};

  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      block[key] = value;
      if (key !== 'progress') continue;

      const outTimeUs = parseNumber(block.out_time_us) ?? parseOutTime(block.out_time);
      const done = value === 'end';
      let fraction: number | null = null;
      if (done) fraction = 1;
      else if (outTimeUs !== null && durationUs !== undefined && durationUs > 0) {
        fraction = Math.min(Math.max(outTimeUs / durationUs, 0), 1);
      }
      const speedText = block.speed?.replace(/x$/, '');
      onProgress({
        outTimeUs,
        fraction,
        speed: parseNumber(speedText),
        frame: parseNumber(block.frame),
        done,
        raw: block,
      });
      block = {};
    }
  };
}

export type FfmpegRunError =
  | { kind: 'cancelled' }
  | { kind: 'spawn-failed'; message: string }
  | { kind: 'failed'; exitCode: number | null; signal: NodeJS.Signals | null; stderrTail: string };

export interface RunFfmpegOptions {
  ffmpegPath: string;
  /** Arguments after the runner's own global options (`-hide_banner -nostats -progress pipe:1`). */
  args: readonly string[];
  /** Expected output duration, for `fraction`. */
  durationUs?: number;
  onProgress?: (progress: FfmpegProgress) => void;
  signal?: AbortSignal;
  cwd?: string;
  /** Time between the `q` request and SIGKILL. Default 5000 ms. */
  killTimeoutMs?: number;
  /** Files to delete when the run is cancelled or fails. */
  removeOnFailure?: readonly string[];
  /** For tests. */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

const STDERR_TAIL_BYTES = 64 * 1024;
export const RUNNER_GLOBAL_ARGS = ['-hide_banner', '-nostats', '-progress', 'pipe:1'] as const;

export async function runFfmpeg(
  options: RunFfmpegOptions,
): Promise<Result<{ stderrTail: string }, FfmpegRunError>> {
  const result = await runOnce(options);
  if (!result.ok && options.removeOnFailure) {
    await Promise.all(options.removeOnFailure.map((file) => fs.rm(file, { force: true })));
  }
  return result;
}

function runOnce(
  options: RunFfmpegOptions,
): Promise<Result<{ stderrTail: string }, FfmpegRunError>> {
  if (options.signal?.aborted) return Promise.resolve(err({ kind: 'cancelled' }));
  const spawnFn = options.spawnImpl ?? spawn;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(options.ffmpegPath, [...RUNNER_GLOBAL_ARGS, ...options.args], {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve(err({ kind: 'spawn-failed', message: String(error) }));
      return;
    }

    let stderrTail = '';
    let cancelled = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const parse = createProgressParser(options.durationUs, (p) => options.onProgress?.(p));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => parse(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // Writing `q` after FFmpeg exited raises EPIPE; that is expected.
    child.stdin?.on('error', () => undefined);

    const onAbort = (): void => {
      if (cancelled || settled) return;
      cancelled = true;
      child.stdin?.write('q');
      child.stdin?.end();
      killTimer = setTimeout(() => child.kill('SIGKILL'), options.killTimeoutMs ?? 5000);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (value: Result<{ stderrTail: string }, FfmpegRunError>): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };

    child.on('error', (error) => finish(err({ kind: 'spawn-failed', message: error.message })));
    child.on('close', (exitCode, signal) => {
      if (cancelled) finish(err({ kind: 'cancelled' }));
      else if (exitCode === 0) finish(ok({ stderrTail }));
      else finish(err({ kind: 'failed', exitCode, signal, stderrTail }));
    });
  });
}

/**
 * Arguments that pass a filter graph from a script file (§1.10): `-/filter_complex` on FFmpeg 7.1
 * and later, `-filter_complex_script` before that. Unknown versions (git master builds) are
 * assumed to be recent.
 */
export function filterComplexScriptArgs(
  version: { major: number; minor: number } | null,
  scriptPath: string,
): string[] {
  const modern =
    version === null || version.major > 7 || (version.major === 7 && version.minor >= 1);
  return modern ? ['-/filter_complex', scriptPath] : ['-filter_complex_script', scriptPath];
}
