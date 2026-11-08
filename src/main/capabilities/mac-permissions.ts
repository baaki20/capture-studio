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

export function readMacPermissions(prefs: SystemPreferencesLike): MacPermissions {
  return {
    screen: status(prefs.getMediaAccessStatus('screen')),
    camera: status(prefs.getMediaAccessStatus('camera')),
    microphone: status(prefs.getMediaAccessStatus('microphone')),
    accessibility: prefs.isTrustedAccessibilityClient(false),
  };
}
