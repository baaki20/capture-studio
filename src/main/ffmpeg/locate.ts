/**
 * Resolves the bundled FFmpeg and ffprobe (§1.10).
 *
 * - Development: `<app root>/resources/bin/<platform>-<arch>/`, filled by `npm run fetch:ffmpeg`.
 * - Packaged: `<process.resourcesPath>/bin/<platform>-<arch>/`, shipped by electron-builder as
 *   `extraResources`.
 *
 * Main only resolves paths; FFmpeg itself runs in the media utility process.
 */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { err, ok, type Result } from '../../shared/result';

export interface FfmpegLocation {
  platformKey: string;
  dir: string;
  ffmpeg: string;
  ffprobe: string;
}

export interface LocateFfmpegOptions {
  isPackaged: boolean;
  /** `process.resourcesPath` in a packaged app. */
  resourcesPath: string;
  /** `app.getAppPath()`: the project root in development. */
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** `CS_FFMPEG_DIR` overrides the folder in development and tests (ignored when packaged). */
  env?: Partial<Record<string, string>>;
}

export function ffmpegPlatformKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

export function resolveFfmpegPaths(options: LocateFfmpegOptions): FfmpegLocation {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformKey = ffmpegPlatformKey(platform, arch);
  const override = options.isPackaged ? undefined : options.env?.CS_FFMPEG_DIR;
  const dir =
    override ??
    (options.isPackaged
      ? path.join(options.resourcesPath, 'bin', platformKey)
      : path.join(options.appPath, 'resources', 'bin', platformKey));
  const exe = platform === 'win32' ? '.exe' : '';
  return {
    platformKey,
    dir,
    ffmpeg: path.join(dir, `ffmpeg${exe}`),
    ffprobe: path.join(dir, `ffprobe${exe}`),
  };
}

/** Resolves the paths and checks both binaries exist and are executable. */
export async function locateFfmpeg(options: LocateFfmpegOptions): Promise<Result<FfmpegLocation>> {
  const location = resolveFfmpegPaths(options);
  const mode = (options.platform ?? process.platform) === 'win32' ? constants.F_OK : constants.X_OK;
  for (const binary of [location.ffmpeg, location.ffprobe]) {
    try {
      await fs.access(binary, mode);
    } catch {
      const hint = options.isPackaged
        ? 'the installation is incomplete'
        : 'run `npm run fetch:ffmpeg`';
      return err(new Error(`FFmpeg binary not found or not executable: ${binary} (${hint})`));
    }
  }
  return ok(location);
}
