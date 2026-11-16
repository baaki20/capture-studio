/**
 * Capability detection entry point (§1.4). Builds the `CapabilityReport` for the current
 * platform, keeps the latest one, and tells listeners when it changes (`caps.changed`).
 */
import { execFile } from 'node:child_process';
import {
  available,
  CAPABILITY_KEYS,
  unavailable,
  type Capability,
  type CapabilityKey,
  type CapabilityMap,
  type CapabilityReport,
  type FfmpegEncoderReport,
} from '../../shared/capabilities/types';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import type { NativeHelperStatus, SecretsStatusLike } from './common';
import { detectLinuxCapabilities, type ExecFn, type ExecResult } from './linux';
import { detectMacCapabilities, type MacPermissions } from './macos';
import { detectWindowsCapabilities } from './windows';

export type { ExecFn, ExecResult } from './linux';

/** Runs a program without a shell; never rejects. */
export const defaultExec: ExecFn = (file, args, options = {}) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      file,
      args,
      { timeout: options.timeoutMs ?? 5000, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, error: null });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        resolve({
          code,
          stdout,
          stderr,
          // A non-zero exit is not a spawn error.
          error: code === null ? String(error.code ?? error.message) : null,
        });
      },
    );
  });

export interface DetectOptions {
  platform: NodeJS.Platform;
  env: Partial<Record<string, string>>;
  /** Linux only: what Electron runs on. */
  ozonePlatform: 'wayland' | 'x11' | null;
  /** `os.release()`; Windows and macOS read their version from it. */
  osRelease?: string;
  /** macOS only: privacy permission states (null before they are read). */
  macPermissions?: MacPermissions | null;
  /** P3 step 4: the native helper, when main tried to load it. */
  nativeHelper?: NativeHelperStatus | null;
  secrets: SecretsStatusLike | null;
  encoders: FfmpegEncoderReport | null;
  exec?: ExecFn;
  now?: () => Date;
}

function placeholderCapabilities(platform: NodeJS.Platform): CapabilityMap {
  const map = {} as CapabilityMap;
  for (const key of CAPABILITY_KEYS) map[key] = unavailable(`Not supported on ${platform}.`);
  map['capture.screen.source'] = available('desktopCapturer');
  map['audio.mic'] = available('getUserMedia');
  map['video.camera'] = available('getUserMedia');
  return map;
}

async function detectPlatformCapabilities(
  options: DetectOptions,
  exec: ExecFn,
): Promise<CapabilityMap> {
  const { secrets, encoders } = options;
  const osRelease = options.osRelease ?? '';
  switch (options.platform) {
    case 'linux':
      return detectLinuxCapabilities({
        env: options.env,
        ozonePlatform: options.ozonePlatform ?? 'x11',
        secrets,
        encoders,
        exec,
        nativeHelper: options.nativeHelper ?? null,
      });
    case 'win32':
      return detectWindowsCapabilities({
        osRelease,
        secrets,
        encoders,
        nativeHelper: options.nativeHelper ?? null,
      });
    case 'darwin':
      return detectMacCapabilities({
        osRelease,
        permissions: options.macPermissions ?? null,
        secrets,
        encoders,
        nativeHelper: options.nativeHelper ?? null,
      });
    default:
      return placeholderCapabilities(options.platform);
  }
}

export async function detectCapabilities(options: DetectOptions): Promise<CapabilityReport> {
  const exec = options.exec ?? defaultExec;
  const linux = options.platform === 'linux';
  const capabilities = await detectPlatformCapabilities(options, exec);

  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    platform: options.platform,
    session: {
      type: linux ? (options.env.XDG_SESSION_TYPE ?? null) : null,
      desktop: linux ? (options.env.XDG_CURRENT_DESKTOP ?? null) : null,
      ozonePlatform: linux ? options.ozonePlatform : null,
    },
    capabilities,
  };
}

export type CapabilityListener = (report: CapabilityReport) => void;

/**
 * Holds the current report. Inputs that arrive later (the secrets backend, the media utility's
 * encoder probe, the engine's WebCodecs probe) are fed in and trigger a refresh.
 */
export class CapabilityService {
  private report: CapabilityReport | null = null;
  private readonly listeners = new Set<CapabilityListener>();
  private readonly overrides = new Map<CapabilityKey, Capability>();
  private refreshing: Promise<CapabilityReport> | null = null;

  constructor(
    private options: DetectOptions,
    private readonly logger: Logger = silentLogger,
  ) {}

  current(): CapabilityReport | null {
    return this.report;
  }

  /** The latest state of one key; `unavailable` before the first detection. */
  get(key: CapabilityKey): Capability {
    return (
      this.report?.capabilities[key] ?? unavailable('Capabilities have not been detected yet.')
    );
  }

  onChange(listener: CapabilityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs detection again (coalescing concurrent calls) and notifies listeners. */
  refresh(): Promise<CapabilityReport> {
    this.refreshing ??= this.detect().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  setEncoderReport(encoders: FfmpegEncoderReport | null): Promise<CapabilityReport> {
    this.options = { ...this.options, encoders };
    return this.refresh();
  }

  setSecretsStatus(secrets: SecretsStatusLike | null): Promise<CapabilityReport> {
    this.options = { ...this.options, secrets };
    return this.refresh();
  }

  /** macOS: permission states change while the app runs (System Settings). */
  setMacPermissions(macPermissions: MacPermissions | null): Promise<CapabilityReport> {
    this.options = { ...this.options, macPermissions };
    return this.refresh();
  }

  /** For results only a renderer can measure (for example `encode.webcodecs.hw` in the engine). */
  setOverride(key: CapabilityKey, capability: Capability | null): Promise<CapabilityReport> {
    if (capability) this.overrides.set(key, capability);
    else this.overrides.delete(key);
    return this.refresh();
  }

  private async detect(): Promise<CapabilityReport> {
    const report = await detectCapabilities(this.options);
    for (const [key, capability] of this.overrides) report.capabilities[key] = capability;
    this.report = report;
    const summary = CAPABILITY_KEYS.filter((k) => report.capabilities[k].state !== 'available');
    this.logger.info(`capabilities: not available: ${summary.join(', ') || 'none'}`);
    for (const listener of this.listeners) {
      try {
        listener(report);
      } catch (error) {
        this.logger.error('capabilities: listener failed', error);
      }
    }
    return report;
  }
}
