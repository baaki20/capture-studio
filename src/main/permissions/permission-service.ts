/**
 * macOS privacy permissions (P3 step 3, spec §2.1): what the app needs, their state, macOS's own
 * prompt where there is one, and the System Settings pane for each.
 *
 * - **Screen Recording** is required: recording the screen does not start while it is denied or
 *   restricted (`recordingBlocked`), and the reason is shown. Not asked yet is fine: macOS asks on
 *   the first capture. macOS has no prompt API for it, so the guidance opens System Settings.
 * - **Camera** and **microphone**: `askForMediaAccess` shows macOS's prompt once; after a refusal
 *   only System Settings can change it.
 * - **Input Monitoring**: the helper's listen-only click tap (cursor effects). The helper asks
 *   (`CGRequestListenEventAccess`); macOS applies the answer after a restart of the app.
 *
 * States are read again when the app gets focus (the user may come back from System Settings),
 * and a change refreshes the capability report. Elsewhere than macOS nothing applies.
 */
import type { PermissionKind, PermissionsReport } from '../../shared/ipc/contract';
import type { Logger } from '../../shared/logger';
import type { MacAccessStatus, MacPermissions } from '../capabilities/macos';

const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?';

/** The System Settings pane for each permission (fixed URLs; nothing else is opened). */
export const MAC_SETTINGS_URLS: Record<PermissionKind, string> = {
  screen: `${PRIVACY}Privacy_ScreenCapture`,
  camera: `${PRIVACY}Privacy_Camera`,
  microphone: `${PRIVACY}Privacy_Microphone`,
  inputMonitoring: `${PRIVACY}Privacy_ListenEvent`,
};

const PURPOSES: Record<PermissionKind, string> = {
  screen: 'Needed to record the screen or a window.',
  camera: 'Records your camera when you choose one.',
  microphone: 'Records your voice when you choose a microphone.',
  inputMonitoring:
    'Lets the cursor track include clicks, for click rings and auto-zoom. Takes effect after restarting Capture Studio.',
};

function statusOf(p: MacPermissions, kind: PermissionKind): MacAccessStatus {
  return kind === 'inputMonitoring' ? (p.inputMonitoring ?? 'unknown') : p[kind];
}

/** Why recording the screen cannot start, or null (not asked yet is fine: macOS asks). */
export function recordingBlockedReason(p: MacPermissions | null): string | null {
  if (!p) return null;
  if (p.screen === 'denied') {
    return 'Screen Recording is off for Capture Studio. Turn it on in System Settings → Privacy & Security → Screen Recording, then try again.';
  }
  if (p.screen === 'restricted') {
    return 'Screen Recording is blocked on this Mac (for example by a device policy).';
  }
  return null;
}

export function permissionsReport(p: MacPermissions | null): PermissionsReport {
  if (!p) return { applies: false, items: [], recordingBlocked: null };
  const kinds: PermissionKind[] = ['screen', 'camera', 'microphone'];
  // Input Monitoring only matters when the helper is there to use it.
  if (p.inputMonitoring !== undefined) kinds.push('inputMonitoring');
  return {
    applies: true,
    items: kinds.map((kind) => {
      const status = statusOf(p, kind);
      return {
        kind,
        status,
        purpose: PURPOSES[kind],
        required: kind === 'screen',
        canRequest:
          status !== 'granted' &&
          ((kind !== 'screen' && status === 'not-determined') ||
            (kind === 'inputMonitoring' && status === 'denied')),
      };
    }),
    recordingBlocked: recordingBlockedReason(p),
  };
}

export interface PermissionServiceDeps {
  /** Null where nothing applies (not macOS). */
  read: () => MacPermissions | null;
  /** `systemPreferences.askForMediaAccess`. */
  askForMediaAccess?: (kind: 'camera' | 'microphone') => Promise<boolean>;
  /** The helper's `inputAccess(true)`. */
  requestInputAccess?: () => boolean | null;
  /** `shell.openExternal`, only ever with `MAC_SETTINGS_URLS`. */
  openUrl: (url: string) => Promise<void>;
  /** A state changed (capabilities and the shell follow). */
  onChange: (permissions: MacPermissions | null, report: PermissionsReport) => void;
  logger: Logger;
}

export class PermissionService {
  private last: MacPermissions | null;

  constructor(private readonly deps: PermissionServiceDeps) {
    this.last = deps.read();
  }

  get permissions(): MacPermissions | null {
    return this.last;
  }

  /** The current report, read again; fires `onChange` when something changed. */
  recheck(): PermissionsReport {
    const next = this.deps.read();
    const changed = JSON.stringify(next) !== JSON.stringify(this.last);
    this.last = next;
    const report = permissionsReport(next);
    if (changed) {
      this.deps.logger.info(
        `permissions: ${report.items.map((i) => `${i.kind} ${i.status}`).join(', ')}`,
      );
      this.deps.onChange(next, report);
    }
    return report;
  }

  /** The report for the last read, without reading again. */
  recheckReport(): PermissionsReport {
    return permissionsReport(this.last);
  }

  /** Why recording the screen cannot start right now, or null. */
  recordingBlocked(): string | null {
    return recordingBlockedReason(this.deps.read());
  }

  /** macOS's own prompt where there is one; otherwise the pane in System Settings. */
  async request(kind: PermissionKind): Promise<PermissionsReport> {
    const item = permissionsReport(this.deps.read()).items.find((i) => i.kind === kind);
    if (!item) return this.recheck();
    if (!item.canRequest) {
      await this.openSettings(kind);
      return this.recheck();
    }
    if (kind === 'camera' || kind === 'microphone') {
      await this.deps.askForMediaAccess?.(kind).catch((error: unknown) => {
        this.deps.logger.warn(`permissions: asking for ${kind} failed`, error);
        return false;
      });
    } else if (kind === 'inputMonitoring') {
      this.deps.requestInputAccess?.();
    }
    return this.recheck();
  }

  async openSettings(kind: PermissionKind): Promise<boolean> {
    if (!this.last) return false;
    try {
      await this.deps.openUrl(MAC_SETTINGS_URLS[kind]);
      return true;
    } catch (error) {
      this.deps.logger.warn(`permissions: opening System Settings for ${kind} failed`, error);
      return false;
    }
  }
}
