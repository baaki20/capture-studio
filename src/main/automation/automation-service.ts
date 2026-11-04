/**
 * What each automation socket method does (`shared/automation/protocol.ts`). Dependencies are
 * injected so this runs in unit tests without Electron.
 *
 * - Reads (`project.get`, dry runs, silence analysis) use the open editor's live document, or the
 *   saved file when the project is not open; they never open a window.
 * - Edits, undo/redo and frame captures go to the project's editor (`EditorLinks`), opening it
 *   when needed, so the user sees each change and can undo it.
 * - Exports use `ExportService` like the editor's dialog does, with the editor's live document
 *   when it is open (what you see is what you export) and main's default output path.
 */
import {
  AUTOMATION_PROTOCOL_VERSION,
  type AutomationParams,
  type AutomationResult,
} from '../../shared/automation/protocol';
import type { ExportOptions, InvokeResponse } from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';
import { describeChange } from '../../shared/project/change-summary';
import { parsePeaks } from '../../shared/project/peaks';
import type { Project } from '../../shared/project/schema';
import { quietRangesOnTimeline, quietWindows, type UsRange } from '../../shared/project/silence';
import { applyOpsWithPatches } from '../../shared/project/timeline-ops';
import { isTrackAudible } from '../../shared/project/render-plan';
import type { ExportJobEvent } from '../ipc/export-handlers';
import type { LibraryEntry } from '../projects/library';
import { AutomationFailure, type AutomationHandlers } from './automation-server';
import { EditorLinkError, type EditorLink } from './editor-link';
type ExportStatus = AutomationResult<'export.status'>;

/** Finished export records kept for `export.status`. */
const MAX_TRACKED_EXPORTS = 50;

export interface AutomationServiceDeps {
  appVersion: string;
  listProjects(): Promise<LibraryEntry[]>;
  /** Project ids with an open editor window. */
  openProjects(): string[];
  /** The saved project, or null when it does not exist or cannot be read. */
  readProject(projectId: string): Promise<{ doc: Project; readOnly: boolean } | null>;
  editors: {
    live(projectId: string): EditorLink | null;
    ensure(projectId: string): Promise<EditorLink>;
  };
  /** The waveform peaks cache file of an audio media (`EditorMedia.assetFile`). */
  peaksFile(
    projectId: string,
    mediaId: string,
  ): Promise<{ status: 'ready' | 'pending' | 'unavailable'; path: string | null }>;
  readFile(path: string): Promise<ArrayBuffer>;
  exports: {
    start(request: {
      projectId: string;
      options: ExportOptions;
      doc?: Project;
      overwrite?: boolean;
    }): Promise<InvokeResponse<'export.start'>>;
    cancel(jobId: string): void;
    onJobEvent(listener: (event: ExportJobEvent) => void): () => void;
  };
  logger: Logger;
}

/** Turns editor-link failures into protocol errors. */
async function viaEditor<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof EditorLinkError) {
      throw new AutomationFailure(error.code, error.message, error.details);
    }
    throw error;
  }
}

export class AutomationService {
  private readonly exportsById = new Map<string, ExportStatus>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: AutomationServiceDeps) {
    this.unsubscribe = deps.exports.onJobEvent((event) => this.onJobEvent(event));
  }

  dispose(): void {
    this.unsubscribe();
  }

  readonly handlers: AutomationHandlers = {
    hello: () =>
      Promise.resolve({
        app: 'capture-studio' as const,
        appVersion: this.deps.appVersion,
        protocolVersion: AUTOMATION_PROTOCOL_VERSION,
      }),

    'projects.list': async () => {
      const open = new Set(this.deps.openProjects());
      const entries = await this.deps.listProjects();
      return {
        projects: entries.map((e) => ({
          id: e.id,
          name: e.name,
          createdAt: e.createdAt,
          durationUs: e.durationUs,
          state: e.state,
          open: open.has(e.id),
        })),
      };
    },

    'project.get': async ({ projectId }) => {
      const current = await this.current(projectId);
      return {
        doc: current.doc,
        version: current.version,
        live: current.live,
        readOnly: current.readOnly,
      };
    },

    'project.edit': async ({ projectId, label, ops, dryRun, ifVersion }) => {
      if (dryRun) {
        const current = await this.current(projectId);
        if (ifVersion !== undefined && ifVersion !== current.version) {
          throw new AutomationFailure('conflict', 'the project changed since it was read');
        }
        const trial = applyOpsWithPatches(current.doc, ops);
        if (!trial.ok) {
          throw new AutomationFailure('op-failed', trial.error.message, {
            opCode: trial.error.code,
            index: trial.error.index,
          });
        }
        return {
          applied: false,
          version: current.version,
          change: describeChange(current.doc, trial.value.doc),
          undoLabel: null,
        };
      }
      await this.editable(projectId);
      return viaEditor(async () => {
        const link = await this.deps.editors.ensure(projectId);
        return link.command('apply', {
          label,
          ops,
          ...(ifVersion !== undefined ? { ifVersion } : {}),
        });
      });
    },

    'project.undo': ({ projectId }) => this.historyStep(projectId, 'undo'),
    'project.redo': ({ projectId }) => this.historyStep(projectId, 'redo'),

    'audio.silences': (params) => this.silences(params),

    'preview.frame': async ({ projectId, atUs, maxWidth }) => {
      await this.editable(projectId);
      return viaEditor(async () => {
        const link = await this.deps.editors.ensure(projectId);
        return link.command('capture', { atUs, maxWidth });
      });
    },

    'export.start': async ({ projectId, options, overwrite }) => {
      await this.editable(projectId);
      const link = this.deps.editors.live(projectId);
      const doc = link ? (await viaEditor(() => link.command('snapshot', {}))).doc : undefined;
      let result: InvokeResponse<'export.start'>;
      try {
        result = await this.deps.exports.start({
          projectId,
          options,
          ...(doc ? { doc } : {}),
          ...(overwrite ? { overwrite } : {}),
        });
      } catch (error) {
        throw new AutomationFailure(
          'export-failed',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (result.status === 'started' && result.jobId) {
        this.track({
          jobId: result.jobId,
          projectId,
          state: 'running',
          fraction: 0,
          etaSec: null,
          outputPath: result.path,
          message: null,
        });
      }
      return result;
    },

    'export.status': ({ jobId }) => {
      const status = this.exportsById.get(jobId);
      if (!status) {
        return Promise.reject(new AutomationFailure('unknown-job', `no export ${jobId}`));
      }
      return Promise.resolve({ ...status });
    },

    'export.cancel': ({ jobId }) => {
      const status = this.exportsById.get(jobId);
      if (status?.state !== 'running') return Promise.resolve({ cancelled: false });
      this.deps.exports.cancel(jobId);
      return Promise.resolve({ cancelled: true });
    },
  };

  /** The live editor document if open, else the saved one (refusing recordings in progress). */
  private async current(
    projectId: string,
  ): Promise<{ doc: Project; version: number; live: boolean; readOnly: boolean }> {
    const link = this.deps.editors.live(projectId);
    if (link) {
      const snapshot = await viaEditor(() => link.command('snapshot', {}));
      return { ...snapshot, live: true };
    }
    const saved = await this.saved(projectId);
    return { doc: saved.doc, version: 0, live: false, readOnly: saved.readOnly };
  }

  private async saved(projectId: string): Promise<{ doc: Project; readOnly: boolean }> {
    const saved = await this.deps.readProject(projectId);
    if (!saved) throw new AutomationFailure('unknown-project', `no project ${projectId}`);
    const state = saved.doc.recording?.state;
    if (state === 'recording' || state === 'finalizing') {
      throw new AutomationFailure('recording', 'this project is still being recorded');
    }
    return saved;
  }

  /** Refuses unknown, recording and read-only projects before opening an editor for them. */
  private async editable(projectId: string): Promise<void> {
    if (this.deps.editors.live(projectId)) return;
    const saved = await this.saved(projectId);
    if (saved.readOnly) {
      throw new AutomationFailure('read-only', 'this project was made by a newer version');
    }
  }

  private async historyStep(
    projectId: string,
    direction: 'undo' | 'redo',
  ): Promise<AutomationResult<'project.undo'>> {
    const link = this.deps.editors.live(projectId);
    if (!link) {
      // A closed editor has no history: nothing to undo or redo.
      const saved = await this.saved(projectId);
      return { done: false, label: null, version: 0, change: describeChange(saved.doc, saved.doc) };
    }
    return viaEditor(() => link.command(direction, {}));
  }

  private async silences({
    projectId,
    thresholdDb,
    minDurationUs,
    padUs,
  }: AutomationParams<'audio.silences'>): Promise<AutomationResult<'audio.silences'>> {
    const current = await this.current(projectId);
    const { doc } = current;
    const audible = new Set<string>();
    for (const track of doc.timeline.tracks) {
      if (track.type === 'audio' && isTrackAudible(doc, track)) {
        for (const clip of track.clips) audible.add(clip.mediaId);
      }
    }
    const quiet = new Map<string, UsRange[]>();
    const missing: string[] = [];
    let pending = false;
    for (const mediaId of audible) {
      const file = await this.deps.peaksFile(projectId, mediaId);
      if (file.status === 'ready' && file.path) {
        const peaks = parsePeaks(await this.deps.readFile(file.path));
        quiet.set(mediaId, quietWindows(peaks, thresholdDb));
      } else {
        if (file.status === 'pending') pending = true;
        missing.push(mediaId);
      }
    }
    if (pending) {
      throw new AutomationFailure(
        'not-ready',
        'waveform data is still being generated for this project; try again in a few seconds',
      );
    }
    return {
      ranges: quietRangesOnTimeline(doc, quiet, { minDurationUs, padUs }),
      version: current.version,
      missingMediaIds: missing,
    };
  }

  private track(status: ExportStatus): void {
    this.exportsById.set(status.jobId, status);
    if (this.exportsById.size <= MAX_TRACKED_EXPORTS) return;
    for (const [jobId, old] of this.exportsById) {
      if (old.state !== 'running') {
        this.exportsById.delete(jobId);
        break;
      }
    }
  }

  private onJobEvent(event: ExportJobEvent): void {
    const status = this.exportsById.get(event.jobId);
    if (!status) return;
    switch (event.type) {
      case 'progress':
        if (event.fraction !== null) status.fraction = Math.min(1, Math.max(0, event.fraction));
        status.etaSec = event.etaSec;
        break;
      case 'done':
        status.state = 'done';
        status.fraction = 1;
        status.etaSec = 0;
        status.outputPath = event.outputPath;
        status.message = event.notice;
        break;
      case 'error':
        status.state = event.cancelled ? 'cancelled' : 'failed';
        status.etaSec = null;
        status.message = event.message;
        break;
    }
  }
}
