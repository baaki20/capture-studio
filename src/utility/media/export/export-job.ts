/**
 * The export job (§4.3.9, R1.46, R1.47): builds the graph, writes the filter script and mask PNGs
 * to a private temp folder, runs FFmpeg into a temp file next to the target, and renames it into
 * place only on success. Cancel (`q`, then SIGKILL after 5 s) and failures delete the temp file,
 * so the target path never holds a partial export. If the utility exits mid-export (app quit),
 * an exit hook deletes the temp files of the exports still running; main sweeps what a crash
 * leaves (`export-handlers.ts`).
 *
 * A hardware encoder that fails is retried once with libx264; the result says so, so the user
 * can be told (§4.3.9, §9.4).
 */
import { randomBytes } from 'node:crypto';
import { promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportTempName } from '../../../shared/export/temp-name';
import type { ExportOptions } from '../../../shared/ipc/contract';
import type { JobResult } from '../../../shared/ipc/media-utility';
import type { ProjectV1 } from '../../../shared/project/schema';
import { timelineDurationUs } from '../../../shared/project/timeline-ops';
import type { Logger } from '../../../shared/logger';
import { silentLogger } from '../../../shared/logger';
import { runFfmpeg, type FfmpegRunError } from '../ffmpeg-runner';
import { fileSize } from '../fs-utils';
import { probeMedia } from '../probe';
import {
  buildExportGraph,
  resolveExportSettings,
  type ExportSettings,
  type MediaColor,
} from './graph-builder';
import { writeMaskPng } from './mask-png';

export type ExportJobResult = JobResult<'export'>;

export interface ExportJobOptions {
  ffmpegPath: string;
  /** For the colour tags of video media; without it every video is taken as BT.709. */
  ffprobePath?: string;
  /** The project folder. */
  root: string;
  doc: ProjectV1;
  options: ExportOptions;
  /** Probe-verified hardware encoder for `encoder: 'auto'`, or null. */
  hardwareEncoder: string | null;
  output: string;
  /** Replace an existing file at `output` (the user confirmed). */
  overwrite: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number | null) => void;
  logger?: Logger;
  /** No progress for this long fails the attempt (default 60 s). */
  stallTimeoutMs?: number;
  /** Parent of the private work folder (default `os.tmpdir()`). */
  tempDir?: string;
  now?: () => number;
}

export const DEFAULT_STALL_TIMEOUT_MS = 60_000;

export class ExportError extends Error {
  constructor(
    readonly code: 'invalid' | 'offline' | 'exists' | 'cancelled' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** The temp output: hidden, next to the target (same filesystem, so the rename is atomic). */
export function tempOutputPath(output: string, token: string): string {
  return path.join(path.dirname(output), exportTempName(path.basename(output), token));
}

/** Temp outputs and work folders of the exports running in this process. */
const activeTemps = new Set<string>();
let exitHookInstalled = false;

/**
 * Deletes the temp outputs (and work folders) of running exports, synchronously. Runs on process exit: the utility
 * exits on app quit (`process.exit` after `shutdown`) without waiting for the cancelled export's
 * own cleanup. FFmpeg may still hold the file open; unlinking it is enough.
 */
export function removeActiveExportTempsSync(): string[] {
  const removed: string[] = [];
  for (const file of activeTemps) {
    try {
      rmSync(file, { recursive: true, force: true });
      removed.push(file);
    } catch {
      // Best effort: main sweeps leftovers.
    }
  }
  activeTemps.clear();
  return removed;
}

function trackTemp(file: string): void {
  activeTemps.add(file);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => removeActiveExportTempsSync());
}

function describeFailure(error: FfmpegRunError): string {
  switch (error.kind) {
    case 'cancelled':
      return 'cancelled';
    case 'spawn-failed':
      return error.message.startsWith('FFmpeg ')
        ? error.message
        : `FFmpeg could not start: ${error.message}`;
    case 'failed': {
      const tail = error.stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      return tail || `FFmpeg exited with ${String(error.exitCode ?? error.signal)}`;
    }
  }
}

/** Colour tags of the project's video files (unreadable files are skipped). */
async function probeColors(
  ffprobePath: string,
  root: string,
  doc: ProjectV1,
  signal?: AbortSignal,
): Promise<Map<string, MediaColor>> {
  const colors = new Map<string, MediaColor>();
  await Promise.all(
    doc.media
      .filter((m) => m.kind === 'video')
      .map(async (m) => {
        const probe = await probeMedia(ffprobePath, path.join(root, m.path), {
          ...(signal ? { signal } : {}),
        });
        const video = probe.ok ? probe.value.streams.find((s) => s.codecType === 'video') : null;
        if (video)
          colors.set(m.id, { matrix: video.colorSpace ?? null, range: video.colorRange ?? null });
      }),
  );
  return colors;
}

export async function runExportJob(options: ExportJobOptions): Promise<ExportJobResult> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const { doc, root, output } = options;

  if (!path.isAbsolute(output))
    throw new ExportError('invalid', 'The output path must be absolute.');
  if (!options.overwrite && (await exists(output))) {
    throw new ExportError('exists', `${path.basename(output)} already exists.`);
  }

  const work = await fs.mkdtemp(path.join(options.tempDir ?? os.tmpdir(), 'cs-export-'));
  const temp = tempOutputPath(output, randomBytes(4).toString('hex'));
  trackTemp(temp);
  trackTemp(work);
  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    const mediaColor = options.ffprobePath
      ? await probeColors(options.ffprobePath, root, doc, options.signal)
      : undefined;

    const attempt = async (
      settings: ExportSettings,
    ): Promise<{ ok: true } | { ok: false; error: FfmpegRunError }> => {
      const built = buildExportGraph({
        doc,
        projectRoot: root,
        settings,
        outputPath: temp,
        filterScriptPath: path.join(work, 'graph.txt'),
        maskDir: work,
        ...(mediaColor ? { mediaColor } : {}),
      });
      if (!built.ok) {
        throw new ExportError(
          built.error.code === 'offline' ? 'offline' : 'invalid',
          built.error.message,
        );
      }
      const graph = built.value;
      // Media must be readable (R1.29): a clear message instead of an FFmpeg error.
      const missing: string[] = [];
      for (const input of graph.inputs) {
        if (input.kind === 'media' && !(await exists(input.path)))
          missing.push(path.relative(root, input.path));
      }
      if (missing.length > 0) {
        throw new ExportError(
          'offline',
          `Media is missing: ${missing.join(', ')}. Relink it or remove its clips before exporting.`,
        );
      }
      await fs.writeFile(path.join(work, 'graph.txt'), graph.filterScriptText);
      await Promise.all(graph.masks.map((m) => writeMaskPng(m.path, m.mask, m.width, m.height)));
      logger.info(
        `export: ${String(settings.width)}x${String(settings.height)}@${String(settings.fps)} ${settings.encoder} ${settings.quality} → ${output}`,
      );
      // Watchdog: no advance for this long means FFmpeg is stuck. Only an advance counts: FFmpeg's
      // main thread keeps writing progress blocks on schedule while its decode, filter or encode
      // threads are deadlocked, with the same `out_time` and `frame` each time.
      const stall = new AbortController();
      const stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
      let stallTimer = setTimeout(() => stall.abort(), stallMs);
      let reachedUs = -1;
      let reachedFrame = -1;
      try {
        const result = await runFfmpeg({
          ffmpegPath: options.ffmpegPath,
          args: graph.args,
          durationUs: graph.expectedDurationUs,
          onProgress: (p) => {
            const advanced =
              p.done || (p.outTimeUs ?? -1) > reachedUs || (p.frame ?? -1) > reachedFrame;
            reachedUs = Math.max(reachedUs, p.outTimeUs ?? -1);
            reachedFrame = Math.max(reachedFrame, p.frame ?? -1);
            if (advanced) {
              clearTimeout(stallTimer);
              stallTimer = setTimeout(() => stall.abort(), stallMs);
            }
            options.onProgress?.(p.fraction);
          },
          signal: options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal,
          removeOnFailure: [temp],
        });
        if (!result.ok && stall.signal.aborted && !options.signal?.aborted) {
          const seconds = String(Math.round(stallMs / 1000));
          return {
            ok: false,
            error: { kind: 'spawn-failed', message: `FFmpeg stopped responding for ${seconds} s` },
          };
        }
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      } finally {
        clearTimeout(stallTimer);
      }
    };

    const settings = resolveExportSettings(doc, options.options, options.hardwareEncoder);
    let encoder = settings.encoder;
    let fallback: ExportJobResult['fallback'] = null;
    let run = await attempt(settings);
    if (!run.ok && run.error.kind !== 'cancelled' && settings.encoder !== 'libx264') {
      const reason = describeFailure(run.error);
      logger.warn(`export: ${settings.encoder} failed (${reason}); retrying with libx264`);
      fallback = { from: settings.encoder, reason };
      encoder = 'libx264';
      options.onProgress?.(0);
      run = await attempt({ ...settings, encoder: 'libx264' });
    }
    if (!run.ok) {
      if (run.error.kind === 'cancelled') throw new ExportError('cancelled', 'cancelled');
      throw new ExportError('failed', `Export failed: ${describeFailure(run.error)}`);
    }

    // The file may have appeared while exporting; never replace it without confirmation.
    if (!options.overwrite && (await exists(output))) {
      throw new ExportError('exists', `${path.basename(output)} already exists.`);
    }
    await fs.rename(temp, output);
    return {
      output,
      encoder,
      fallback,
      durationUs: timelineDurationUs(doc),
      sizeBytes: await fileSize(output),
      elapsedMs: Math.max(0, now() - startedAt),
    };
  } finally {
    await fs.rm(temp, { force: true });
    activeTemps.delete(temp);
    await fs.rm(work, { recursive: true, force: true });
    activeTemps.delete(work);
  }
}
