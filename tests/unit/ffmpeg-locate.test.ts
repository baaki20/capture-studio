import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpegPlatformKey, locateFfmpeg, resolveFfmpegPaths } from '../../src/main/ffmpeg/locate';

describe('ffmpeg/locate', () => {
  it('uses resources/bin/<platform>-<arch> in development', () => {
    const loc = resolveFfmpegPaths({
      isPackaged: false,
      resourcesPath: '/opt/app/resources',
      appPath: '/src/capture-studio',
      platform: 'linux',
      arch: 'x64',
    });
    expect(loc).toEqual({
      platformKey: 'linux-x64',
      dir: path.join('/src/capture-studio', 'resources', 'bin', 'linux-x64'),
      ffmpeg: path.join('/src/capture-studio', 'resources', 'bin', 'linux-x64', 'ffmpeg'),
      ffprobe: path.join('/src/capture-studio', 'resources', 'bin', 'linux-x64', 'ffprobe'),
    });
  });

  it('uses process.resourcesPath/bin when packaged, with .exe on Windows', () => {
    const loc = resolveFfmpegPaths({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\Capture Studio\\resources',
      appPath: 'ignored',
      platform: 'win32',
      arch: 'x64',
    });
    expect(loc.dir).toBe(
      path.join('C:\\Program Files\\Capture Studio\\resources', 'bin', 'win32-x64'),
    );
    expect(loc.ffmpeg.endsWith('ffmpeg.exe')).toBe(true);
    expect(ffmpegPlatformKey('darwin', 'arm64')).toBe('darwin-arm64');
  });

  it('honours CS_FFMPEG_DIR only in development', () => {
    const base = {
      resourcesPath: '/r',
      appPath: '/a',
      platform: 'linux' as const,
      arch: 'x64',
      env: { CS_FFMPEG_DIR: '/custom' },
    };
    expect(resolveFfmpegPaths({ ...base, isPackaged: false }).dir).toBe('/custom');
    expect(resolveFfmpegPaths({ ...base, isPackaged: true }).dir).toBe(
      path.join('/r', 'bin', 'linux-x64'),
    );
  });

  it('fails with a hint when the binaries are missing or not executable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-locate-'));
    try {
      const result = await locateFfmpeg({
        isPackaged: false,
        resourcesPath: '',
        appPath: '',
        env: { CS_FFMPEG_DIR: dir },
      });
      expect(!result.ok && result.error.message).toMatch(/fetch:ffmpeg/);

      if (process.platform !== 'win32') {
        await fs.writeFile(path.join(dir, 'ffmpeg'), '', { mode: 0o644 });
        await fs.writeFile(path.join(dir, 'ffprobe'), '', { mode: 0o755 });
        expect(
          (
            await locateFfmpeg({
              isPackaged: false,
              resourcesPath: '',
              appPath: '',
              env: { CS_FFMPEG_DIR: dir },
            })
          ).ok,
        ).toBe(false);
        await fs.chmod(path.join(dir, 'ffmpeg'), 0o755);
        expect(
          (
            await locateFfmpeg({
              isPackaged: false,
              resourcesPath: '',
              appPath: '',
              env: { CS_FFMPEG_DIR: dir },
            })
          ).ok,
        ).toBe(true);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
