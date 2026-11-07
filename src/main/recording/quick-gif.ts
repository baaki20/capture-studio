/**
 * The quick-GIF workflow (P2): when "After recording" is "Export a GIF", the finished recording
 * is exported with the "Small GIF" preset to the exports folder and shown in the file manager.
 * An existing file of the same name is never replaced: the editor opens instead.
 */
import { EXPORT_PRESETS } from '../../shared/export/formats';
import type { ExportOptions, InvokeResponse } from '../../shared/ipc/contract';
import type { ExportJobEvent } from '../ipc/export-handlers';

export interface QuickGifDeps {
  exports: {
    start(request: {
      projectId: string;
      options: ExportOptions;
    }): Promise<InvokeResponse<'export.start'>>;
    onJobEvent(listener: (event: ExportJobEvent) => void): () => void;
  };
  showItemInFolder: (fullPath: string) => void;
}

/** The options of the "Small GIF" preset. */
export function quickGifOptions(): ExportOptions {
  const preset = EXPORT_PRESETS.find((p) => p.id === 'small-gif');
  if (!preset) throw new Error('the Small GIF preset is missing');
  return { ...preset.options, encoder: 'software' };
}

/**
 * Exports `projectId` as a Small GIF and reveals it. Resolves with the GIF's path, or rejects
 * with why it could not be made.
 */
export async function exportQuickGif(deps: QuickGifDeps, projectId: string): Promise<string> {
  const events: ExportJobEvent[] = [];
  let wake: (() => void) | null = null;
  const off = deps.exports.onJobEvent((event) => {
    events.push(event);
    wake?.();
  });
  try {
    const started = await deps.exports.start({ projectId, options: quickGifOptions() });
    if (started.status === 'exists') throw new Error(`${started.path} already exists.`);
    if (started.status !== 'started' || !started.jobId) {
      throw new Error(started.message ?? 'The GIF export could not start.');
    }
    const jobId = started.jobId;
    for (;;) {
      const event = events.find((e) => e.jobId === jobId && e.type !== 'progress');
      if (event?.type === 'done') {
        deps.showItemInFolder(event.outputPath);
        return event.outputPath;
      }
      if (event?.type === 'error') throw new Error(event.message);
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    off();
  }
}
