/**
 * Settings → Diagnostics (R1.1, R1.4, R1.51): the report the shell shows, and the plain-text
 * version "Copy report" puts on the clipboard.
 */
import {
  CAPABILITY_KEYS,
  type CapabilityReport,
  type FfmpegEncoderReport,
} from '../shared/capabilities/types';
import { CLI_ACTION_LABELS, CLI_ACTIONS } from '../shared/ipc/actions';
import type { DiagnosticsReport } from '../shared/ipc/contract';
import { buildActionCommand, type LaunchCommandContext } from './cli';

export interface DiagnosticsInputs {
  capabilities: CapabilityReport;
  versions: DiagnosticsReport['versions'];
  paths: DiagnosticsReport['paths'];
  ffmpegError: string | null;
  encoders: FfmpegEncoderReport | null;
  secrets: DiagnosticsReport['secrets'];
  launch: LaunchCommandContext;
}

export function buildDiagnosticsReport(inputs: DiagnosticsInputs): DiagnosticsReport {
  return {
    capabilities: inputs.capabilities,
    versions: inputs.versions,
    paths: inputs.paths,
    ffmpegError: inputs.ffmpegError,
    encoders: inputs.encoders,
    secrets: inputs.secrets,
    shortcuts: CLI_ACTIONS.map((action) => ({
      action,
      label: CLI_ACTION_LABELS[action],
      command: buildActionCommand(action, inputs.launch),
    })),
    // Phase 1 ships only the CLI fallback (§9.8); portal registration is not offered anywhere yet.
    canRegisterGlobalShortcuts: false,
  };
}

export function formatDiagnosticsText(report: DiagnosticsReport): string {
  const { versions, paths, capabilities: caps } = report;
  const lines = [
    'Capture Studio diagnostics',
    `Generated: ${caps.generatedAt}`,
    '',
    `App ${versions.app} · Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`,
    `FFmpeg: ${versions.ffmpeg ?? `unavailable (${report.ffmpegError ?? 'unknown'})`}`,
    `Platform: ${caps.platform}, session ${caps.session.type ?? '-'}, desktop ${caps.session.desktop ?? '-'}, ozone ${caps.session.ozonePlatform ?? '-'}`,
    `Secrets backend: ${report.secrets.backend} (${report.secrets.persistent ? 'persistent' : 'session only'})`,
    '',
    'Paths',
    `  ffmpeg:   ${paths.ffmpeg ?? '-'}`,
    `  ffprobe:  ${paths.ffprobe ?? '-'}`,
    `  log:      ${paths.logFile}`,
    `  userData: ${paths.userData}`,
    `  projects: ${paths.projectsDir}`,
    '',
    'Encoders',
  ];
  if (report.encoders) {
    for (const e of report.encoders.encoders) {
      lines.push(
        `  ${e.name} (${e.kind}): ${e.works ? 'works' : e.listed ? `fails: ${e.error ?? '?'}` : 'not in build'}`,
      );
    }
    lines.push(
      `  selected: hardware ${report.encoders.hardware ?? 'none'}, software ${report.encoders.software ?? 'none'}`,
    );
  } else {
    lines.push('  not probed yet');
  }
  lines.push('', 'Capabilities');
  for (const key of CAPABILITY_KEYS) {
    const c = caps.capabilities[key];
    lines.push(
      `  ${key}: ${c.state}${c.strategy ? ` [${c.strategy}]` : ''}${c.reason ? ` — ${c.reason}` : ''}`,
    );
  }
  lines.push('', 'Shortcut commands (GNOME Settings → Keyboard → Custom Shortcuts)');
  for (const s of report.shortcuts) lines.push(`  ${s.label}: ${s.command}`);
  return lines.join('\n') + '\n';
}
