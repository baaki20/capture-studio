import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../../src/main/capabilities/detect';
import { buildDiagnosticsReport, formatDiagnosticsText } from '../../src/main/diagnostics';
import { CAPABILITY_KEYS } from '../../src/shared/capabilities/types';
import { CLI_ACTIONS } from '../../src/shared/ipc/actions';
import { DiagnosticsReportSchema } from '../../src/shared/ipc/contract';

describe('Diagnostics report (R1.1, R1.4)', async () => {
  const capabilities = await detectCapabilities({
    platform: 'linux',
    env: {
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_CURRENT_DESKTOP: 'GNOME',
    },
    ozonePlatform: 'wayland',
    secrets: { persistent: true, backend: 'gnome_libsecret', reason: null },
    encoders: null,
    exec: () => Promise.resolve({ code: 0, stdout: '', stderr: '', error: null }),
  });
  const report = buildDiagnosticsReport({
    capabilities,
    versions: { app: '0.1.0', electron: '45.0.0', chrome: '156', node: '24', ffmpeg: 'n9.0.2' },
    paths: {
      ffmpeg: '/r/bin/ffmpeg',
      ffprobe: '/r/bin/ffprobe',
      logFile: '/u/logs/main.log',
      userData: '/u',
      projectsDir: '/v/Capture Studio',
    },
    ffmpegError: null,
    encoders: null,
    secrets: { persistent: true, backend: 'gnome_libsecret', reason: null },
    launch: { isPackaged: true, execPath: '/usr/bin/capture-studio', appPath: '/x' },
  });

  it('matches the contract and offers a command per action, no portal button', () => {
    expect(DiagnosticsReportSchema.parse(report)).toEqual(report);
    expect(report.shortcuts.map((s) => s.action)).toEqual([...CLI_ACTIONS]);
    expect(report.shortcuts[0]).toEqual({
      action: 'new-recording',
      label: 'New recording',
      command: '/usr/bin/capture-studio --action new-recording',
    });
    expect(report.canRegisterGlobalShortcuts).toBe(false);
  });

  it('formats a copyable text report with every capability, path and command', () => {
    const text = formatDiagnosticsText(report);
    for (const key of CAPABILITY_KEYS) expect(text).toContain(`  ${key}: `);
    expect(text).toContain('FFmpeg: n9.0.2');
    expect(text).toContain('log:      /u/logs/main.log');
    expect(text).toContain('ffmpeg:   /r/bin/ffmpeg');
    expect(text).toContain('/usr/bin/capture-studio --action toggle-pause');
    expect(text).toContain('Electron 45.0.0');
  });
});
