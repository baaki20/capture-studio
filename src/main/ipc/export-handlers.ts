/**
 * Export channels (§4.3.11, step 19; R1.45–R1.47, R1.49): `export.target`,
 * `export.chooseOutput`, `export.start`, `export.cancel`, `export.reveal`, `export.open`, and the
 * `export.progress` / `export.done` / `export.error` events. (`export.probeEncoders` is served by
 * `core-handlers.ts`, which shares the cached probe with Diagnostics.)
 *
 * - The renderer never sends a path. The target is the file chosen in main's save dialog, or
 *   `<exportsDir>/<project name>.mp4`.
 * - An existing target is never replaced unless the start says `overwrite` or the user already
 *   confirmed it in the save dialog (R1.47); otherwise `export.start` answers `exists`.
 * - The export runs in the media utility on a snapshot: the editor's current document, or the
 *   saved project (R1.49). Offline media block it with a message (R1.29).
 * - Auto uses the probe-verified hardware encoder; the utility falls back to libx264 once and the
 *   `export.done` notice says so (§4.3.9, §9.4).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FfmpegEncoderReport } from '../../shared/capabilities/types';
import { newId } from '../../shared/ids';
import type { ExportOptions, InvokeResponse } from '../../shared/ipc/contract';
import type { JobResult } from '../../shared/ipc/media-utility';
import type { Logger } from '../../shared/logger';
import { audioSegments, videoTrackPlans } from '../../shared/project/render-plan';
import type { ProjectV1 } from '../../shared/project/schema';
import type { Settings } from '../../shared/settings/schema';
import type { RunJobOptions } from '../utility-host';
import type { IpcRouter } from './router';

export interface ExportHandlerDeps {
  router: Pick<IpcRouter, 'handle' | 'broadcast'>;
  /** The media utility's job runner. */
  runExport: (
    job: {
      kind: 'export';
      root: string;
      doc: ProjectV1;
      options: ExportOptions;
      hardwareEncoder: string | null;
      output: string;
      overwrite: boolean;
    },
    options: RunJobOptions,
  ) => Promise<JobResult<'export'>>;
  /** The project's folder, or null for an unknown id. */
  findRoot: (projectId: string) => Promise<string | null>;
  /** The saved document of a project folder, or null when unreadable. */
  readProject: (root: string) => Promise<ProjectV1 | null>;
  settings: () => Settings;
  /** The cached encoder probe (§1.4 `encode.ffmpeg.hw`). */
  probeEncoders: () => Promise<FfmpegEncoderReport>;
  /** Native save dialog parented to the calling window; the chosen path or null. */
  showSaveDialog: (options: { defaultPath: string; senderId: number }) => Promise<string | null>;
  showItemInFolder: (fullPath: string) => void;
  /** Resolves with an error message, or '' on success (Electron's `shell.openPath`). */
  openPath: (fullPath: string) => Promise<string>;
  logger: Logger;
  fileExists?: (fullPath: string) => Promise<boolean>;
  now?: () => number;
}

interface ChosenTarget {
  path: string;
  /** The save dialog already asked about replacing it. */
  overwriteConfirmed: boolean;
}

interface RunningExport {
  controller: AbortController;
  output: string;
}

/** A file name from a project name: no path separators or control characters. */
export function exportFileName(projectName: string): string {
  const cleaned = projectName
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\u0000-\u001f]/g, '-')
    .trim()
    .replace(/^\.+/, '');
  return `${cleaned || 'Export'}.mp4`;
}

/** Appends `.mp4` when the user typed a name without it. */
export function withMp4Extension(file: string): string {
  return path.extname(file).toLowerCase() === '.mp4' ? file : `${file}.mp4`;
}

/** Media that the export would read but that are offline (R1.29). */
export function offlineExportMedia(doc: ProjectV1): string[] {
  const offline = new Set<string>();
  for (const plan of videoTrackPlans(doc)) {
    for (const piece of plan.pieces) {
      if (piece.kind === 'clip' && piece.layer.offline) offline.add(piece.layer.mediaId);
    }
  }
  for (const segment of audioSegments(doc)) if (segment.offline) offline.add(segment.mediaId);
  return doc.media.filter((m) => offline.has(m.id)).map((m) => m.path);
}

/** Seconds left, from the fraction done and the time spent; null until it is meaningful. */
export function estimateEtaSec(fraction: number | null, elapsedMs: number): number | null {
  if (fraction === null || fraction < 0.01 || elapsedMs <= 0) return null;
  if (fraction >= 1) return 0;
  return ((elapsedMs / 1000) * (1 - fraction)) / fraction;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExportService {
  private readonly chosen = new Map<string, ChosenTarget>();
  private readonly running = new Map<string, RunningExport>();
  /** Finished exports, for reveal/open (jobId → output path). */
  private readonly finished = new Map<string, string>();
  private readonly fileExists: (fullPath: string) => Promise<boolean>;
  private readonly now: () => number;

  constructor(private readonly deps: ExportHandlerDeps) {
    this.fileExists =
      deps.fileExists ??
      ((file) =>
        fs.access(file).then(
          () => true,
          () => false,
        ));
    this.now = deps.now ?? (() => Date.now());
  }

  register(): void {
    const { router } = this.deps;
    router.handle('export.target', ({ projectId }) => this.target(projectId));
    router.handle('export.chooseOutput', ({ projectId }, context) =>
      this.choose(projectId, context.senderId),
    );
    router.handle('export.start', (request) => this.start(request));
    router.handle('export.cancel', ({ jobId }) => {
      this.cancel(jobId);
      return undefined;
    });
    router.handle('export.reveal', ({ jobId }) => {
      this.deps.showItemInFolder(this.finishedOutput(jobId));
      return undefined;
    });
    router.handle('export.open', async ({ jobId }) => {
      const error = await this.deps.openPath(this.finishedOutput(jobId));
      if (error) throw new Error(error);
      return undefined;
    });
  }

  /** Cancels every running export (app quit). */
  dispose(): void {
    for (const job of this.running.values()) job.controller.abort();
  }

  private finishedOutput(jobId: string): string {
    const output = this.finished.get(jobId);
    if (!output) throw new Error('That export has not finished.');
    return output;
  }

  private async load(
    projectId: string,
    doc?: ProjectV1,
  ): Promise<{ root: string; doc: ProjectV1 }> {
    const root = await this.deps.findRoot(projectId);
    if (!root) throw new Error(`Project ${projectId} was not found.`);
    if (doc) {
      if (doc.id !== projectId) throw new Error('The document does not belong to this project.');
      return { root, doc };
    }
    const saved = await this.deps.readProject(root);
    if (!saved) throw new Error('The project file cannot be read.');
    return { root, doc: saved };
  }

  private defaultTarget(doc: ProjectV1): string {
    return path.join(this.deps.settings().exportsDir, exportFileName(doc.name));
  }

  private currentTarget(projectId: string, doc: ProjectV1): ChosenTarget {
    return (
      this.chosen.get(projectId) ?? { path: this.defaultTarget(doc), overwriteConfirmed: false }
    );
  }

  async target(projectId: string): Promise<InvokeResponse<'export.target'>> {
    const { doc } = await this.load(projectId);
    const target = this.currentTarget(projectId, doc);
    return { path: target.path, exists: await this.fileExists(target.path) };
  }

  async choose(
    projectId: string,
    senderId: number,
  ): Promise<InvokeResponse<'export.chooseOutput'>> {
    const { doc } = await this.load(projectId);
    const current = this.currentTarget(projectId, doc);
    await fs.mkdir(path.dirname(current.path), { recursive: true }).catch(() => undefined);
    const picked = await this.deps.showSaveDialog({ defaultPath: current.path, senderId });
    if (!picked) return null;
    const file = withMp4Extension(path.resolve(picked));
    const exists = await this.fileExists(file);
    // The dialog confirmed replacing the exact file it returned (not one we added .mp4 to).
    this.chosen.set(projectId, { path: file, overwriteConfirmed: exists && file === picked });
    return { path: file, exists };
  }

  async start(request: {
    projectId: string;
    options: ExportOptions;
    doc?: ProjectV1 | undefined;
    overwrite?: boolean | undefined;
  }): Promise<InvokeResponse<'export.start'>> {
    const { root, doc } = await this.load(request.projectId, request.doc);
    const target = this.currentTarget(request.projectId, doc);
    const output = target.path;
    const reply = (
      status: 'exists' | 'blocked',
      message: string | null,
    ): InvokeResponse<'export.start'> => ({ jobId: null, status, path: output, message });

    const offline = offlineExportMedia(doc);
    if (offline.length > 0) {
      return reply(
        'blocked',
        `Media is missing or unreadable: ${offline.join(', ')}. Relink it or remove its clips before exporting.`,
      );
    }
    if ([...this.running.values()].some((job) => job.output === output)) {
      return reply('blocked', `An export to ${path.basename(output)} is already running.`);
    }
    const overwrite = request.overwrite === true || target.overwriteConfirmed;
    if (!overwrite && (await this.fileExists(output))) {
      return reply('exists', `${path.basename(output)} already exists.`);
    }

    let hardwareEncoder: string | null = null;
    if (request.options.encoder === 'auto') {
      try {
        hardwareEncoder = (await this.deps.probeEncoders()).hardware;
      } catch (error) {
        this.deps.logger.warn('export: encoder probe failed; using libx264', error);
      }
    }

    const jobId = newId('job');
    const controller = new AbortController();
    this.running.set(jobId, { controller, output });
    void this.run(jobId, controller, {
      kind: 'export',
      root,
      doc,
      options: request.options,
      hardwareEncoder,
      output,
      overwrite,
    });
    return { jobId, status: 'started', path: output, message: null };
  }

  cancel(jobId: string): void {
    this.running.get(jobId)?.controller.abort();
  }

  private async run(
    jobId: string,
    controller: AbortController,
    job: Parameters<ExportHandlerDeps['runExport']>[0],
  ): Promise<void> {
    const { router, logger } = this.deps;
    let startedAt = this.now();
    let last = 0;
    try {
      const result = await this.deps.runExport(job, {
        signal: controller.signal,
        onProgress: (fraction) => {
          // A hardware fallback restarts from 0: restart the ETA clock too.
          if (fraction !== null && fraction + 0.05 < last) startedAt = this.now();
          if (fraction !== null) last = fraction;
          router.broadcast('export.progress', {
            jobId,
            fraction,
            etaSec: estimateEtaSec(fraction, this.now() - startedAt),
          });
        },
      });
      this.finished.set(jobId, result.output);
      const notice = result.fallback
        ? `The hardware encoder (${result.fallback.from}) failed, so the video was encoded in software (libx264).`
        : null;
      logger.info(
        `export ${jobId}: ${result.output} (${result.encoder}, ${String(result.sizeBytes)} bytes, ${(result.elapsedMs / 1000).toFixed(1)} s)`,
      );
      router.broadcast('export.done', {
        jobId,
        outputName: path.basename(result.output),
        outputPath: result.output,
        encoder: result.encoder,
        notice,
      });
    } catch (error) {
      const cancelled =
        controller.signal.aborted || (error as { cancelled?: unknown }).cancelled === true;
      if (!cancelled) logger.error(`export ${jobId} failed`, error);
      router.broadcast('export.error', {
        jobId,
        message: cancelled ? 'Export cancelled.' : errorMessage(error),
        cancelled,
      });
    } finally {
      this.running.delete(jobId);
    }
  }
}

export function registerExportHandlers(deps: ExportHandlerDeps): ExportService {
  const service = new ExportService(deps);
  service.register();
  return service;
}
