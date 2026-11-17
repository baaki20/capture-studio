/**
 * Loads the native helper (`cs-native`, plan D7; `native/cs-native/`): an N-API module, so one
 * build works in every Electron of that platform and architecture.
 *
 * - Development: `<app root>/resources/native/<platform>-<arch>/cs-native.node`, built by
 *   `npm run build:native`.
 * - Packaged: `<process.resourcesPath>/native/<platform>-<arch>/cs-native.node`.
 * - `CS_NATIVE_DIR` overrides the folder in development and tests (ignored when packaged).
 *
 * The helper is optional (spec §1.2): a missing or broken build gives a reason, and the features
 * that use it fall back (cursor positions by polling, no clicks; no window list).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** A top-level window as the helper reports it. */
export interface NativeWindow {
  id: string;
  title: string;
  app: string;
  pid: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The module's exports (`native/cs-native/src/lib.rs`). */
export interface NativeHelper {
  backend(): 'x11' | 'win32' | 'macos' | 'unsupported';
  coordinateSpace(): 'physical' | 'dip';
  monotonicUs(): number;
  /** Batches of `[tUs, x, y, action, button]` samples; an empty batch ends the loop. */
  startCursor(rateHz: number, callback: (batch: number[]) => void): { clicks: boolean };
  stopCursor(): void;
  listWindows(): NativeWindow[];
  foregroundWindow(): NativeWindow | null;
  injectPointer(action: 'move' | 'press' | 'release', x: number, y: number, button?: number): void;
  /** macOS Input Monitoring (P3 step 3); with `prompt`, asks for it. Null elsewhere. */
  inputAccess(prompt?: boolean): boolean | null;
}

export interface NativeHelperOptions {
  isPackaged: boolean;
  /** `process.resourcesPath` in a packaged app. */
  resourcesPath: string;
  /** `app.getAppPath()`: the project root in development. */
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Partial<Record<string, string>>;
}

export function nativeHelperPath(options: NativeHelperOptions): string {
  const platform = options.platform ?? process.platform;
  const key = `${platform}-${options.arch ?? process.arch}`;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const override = options.isPackaged ? undefined : options.env?.CS_NATIVE_DIR;
  if (override) return p.join(override, 'cs-native.node');
  return options.isPackaged
    ? p.join(options.resourcesPath, 'native', key, 'cs-native.node')
    : p.join(options.appPath, 'resources', 'native', key, 'cs-native.node');
}

export type NativeHelperLoad = { helper: NativeHelper } | { helper: null; reason: string };

/** Loads the helper, or says why not. Never throws. */
export function loadNativeHelper(
  options: NativeHelperOptions,
  load: (file: string) => unknown = createRequire(import.meta.url),
  exists: (file: string) => boolean = existsSync,
): NativeHelperLoad {
  const file = nativeHelperPath(options);
  if (!exists(file)) {
    return {
      helper: null,
      reason: options.isPackaged
        ? 'The native helper is not part of this build.'
        : 'The native helper is not built (npm run build:native).',
    };
  }
  try {
    const helper = load(file) as NativeHelper;
    if (typeof helper.startCursor !== 'function') {
      return { helper: null, reason: 'The native helper is incomplete.' };
    }
    return { helper };
  } catch (error) {
    return {
      helper: null,
      reason: `The native helper could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
