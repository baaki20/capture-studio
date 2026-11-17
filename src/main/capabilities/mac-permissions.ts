/**
 * Reads the macOS privacy (TCC) permission states for the capability report. Reading never shows
 * a prompt: `isTrustedAccessibilityClient(false)` only asks, it does not open the dialog.
 */
import type { MacAccessStatus, MacPermissions } from './macos';

export interface SystemPreferencesLike {
  getMediaAccessStatus(mediaType: 'microphone' | 'camera' | 'screen'): string;
  isTrustedAccessibilityClient(prompt: boolean): boolean;
}

const STATUSES: readonly MacAccessStatus[] = [
  'not-determined',
  'granted',
  'denied',
  'restricted',
  'unknown',
];

function status(value: string): MacAccessStatus {
  return (STATUSES as readonly string[]).includes(value) ? (value as MacAccessStatus) : 'unknown';
}

/**
 * `inputAccess` is the helper's Input Monitoring check (P3 step 3); macOS only says granted or
 * not, so "not" reads as denied. Without the helper it is left out.
 */
export function readMacPermissions(
  prefs: SystemPreferencesLike,
  inputAccess?: () => boolean | null,
): MacPermissions {
  const input = inputAccess?.() ?? null;
  return {
    screen: status(prefs.getMediaAccessStatus('screen')),
    camera: status(prefs.getMediaAccessStatus('camera')),
    microphone: status(prefs.getMediaAccessStatus('microphone')),
    accessibility: prefs.isTrustedAccessibilityClient(false),
    ...(input === null ? {} : { inputMonitoring: input ? 'granted' : 'denied' }),
  };
}
