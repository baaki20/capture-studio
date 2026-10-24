/**
 * Handlers for the channels steps 6–8 provide: capabilities, settings, diagnostics and the
 * encoder probe. Recording, library, project, export and recovery handlers are registered by
 * their own modules in later steps.
 */
import type { FfmpegEncoderReport } from '../../shared/capabilities/types';
import type { CapabilityService } from '../capabilities/detect';
import {
  buildDiagnosticsReport,
  formatDiagnosticsText,
  type DiagnosticsInputs,
} from '../diagnostics';
import type { SettingsStore } from '../settings/store';
import type { IpcRouter } from './router';

export interface CoreHandlerDeps {
  router: IpcRouter;
  capabilities: CapabilityService;
  settings: SettingsStore;
  /** Everything Diagnostics needs besides the capability report. */
  diagnostics: () => Omit<DiagnosticsInputs, 'capabilities'>;
  /** Cached or freshly run FFmpeg encoder probe. */
  probeEncoders: () => Promise<FfmpegEncoderReport>;
  writeClipboard: (text: string) => void | Promise<void>;
}

export function registerCoreHandlers(deps: CoreHandlerDeps): void {
  const { router, capabilities } = deps;
  const currentCaps = async () => capabilities.current() ?? (await capabilities.refresh());
  const report = async () =>
    buildDiagnosticsReport({ ...deps.diagnostics(), capabilities: await currentCaps() });

  router.handle('caps.get', currentCaps);
  router.handle('caps.refresh', () => capabilities.refresh());

  router.handle('settings.get', () => deps.settings.get());
  router.handle('settings.patch', (patch) => deps.settings.patch(patch));

  router.handle('diag.get', report);
  router.handle('diag.copyReport', async () => {
    const text = formatDiagnosticsText(await report());
    await deps.writeClipboard(text);
    return { text };
  });

  router.handle('export.probeEncoders', () => deps.probeEncoders());
}
