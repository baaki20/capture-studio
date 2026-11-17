/**
 * Creates the permission service for this platform (P3 step 3) and its IPC. On macOS it reads
 * `systemPreferences` and the helper's Input Monitoring check. Elsewhere nothing applies, unless
 * an end-to-end test describes a Mac with `CS_TEST_MAC_PERMISSIONS` (an unpackaged build in test
 * mode only): then the states are that description, prompts grant, and System Settings is never
 * opened.
 */
import type { Logger } from '../../shared/logger';
import type { IpcRouter } from '../ipc/router';
import type { MacAccessStatus, MacPermissions } from '../capabilities/macos';
import { readMacPermissions, type SystemPreferencesLike } from '../capabilities/mac-permissions';
import type { NativeHelper } from '../native/cs-native';
import { PermissionService } from './permission-service';

const STATUSES: readonly MacAccessStatus[] = [
  'not-determined',
  'granted',
  'denied',
  'restricted',
  'unknown',
];

/** `CS_TEST_MAC_PERMISSIONS`: `{"screen":"denied",…}`; null when absent or malformed. */
export function parseFakeMacPermissions(text: string | null): MacPermissions | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const pick = (key: string, fallback: MacAccessStatus): MacAccessStatus =>
    STATUSES.includes(v[key] as MacAccessStatus) ? (v[key] as MacAccessStatus) : fallback;
  return {
    screen: pick('screen', 'granted'),
    camera: pick('camera', 'granted'),
    microphone: pick('microphone', 'granted'),
    accessibility: v.accessibility === true,
    ...(v.inputMonitoring === undefined
      ? {}
      : { inputMonitoring: pick('inputMonitoring', 'unknown') }),
  };
}

export interface CreatePermissionsDeps {
  platform: NodeJS.Platform;
  /** Test mode only: a described Mac (`parseFakeMacPermissions`). */
  fake: MacPermissions | null;
  systemPreferences: SystemPreferencesLike & {
    askForMediaAccess(kind: 'camera' | 'microphone'): Promise<boolean>;
  };
  helper: NativeHelper | null;
  openExternal: (url: string) => Promise<void>;
  onChange: (permissions: MacPermissions | null) => void;
  logger: Logger;
  router: Pick<IpcRouter, 'handle' | 'broadcast'>;
}

export function createPermissions(deps: CreatePermissionsDeps): PermissionService {
  let service: PermissionService;
  const onChange = (permissions: MacPermissions | null) => {
    deps.onChange(permissions);
    deps.router.broadcast('perms.changed', service.recheckReport());
  };
  if (deps.fake) {
    const state: MacPermissions = { ...deps.fake };
    const grant = (kind: 'camera' | 'microphone' | 'inputMonitoring') => {
      if (state[kind] === 'not-determined' || kind === 'inputMonitoring') state[kind] = 'granted';
    };
    deps.logger.info('permissions: test mode, a described Mac');
    service = new PermissionService({
      read: () => ({ ...state }),
      askForMediaAccess: (kind) => {
        grant(kind);
        return Promise.resolve(state[kind] === 'granted');
      },
      requestInputAccess: () => {
        grant('inputMonitoring');
        return true;
      },
      openUrl: (url) => {
        deps.logger.info(`permissions (test): would open ${url}`);
        return Promise.resolve();
      },
      onChange: (p) => onChange(p),
      logger: deps.logger,
    });
  } else if (deps.platform === 'darwin') {
    const inputAccess = deps.helper ? () => deps.helper?.inputAccess(false) ?? null : undefined;
    service = new PermissionService({
      read: () => readMacPermissions(deps.systemPreferences, inputAccess),
      askForMediaAccess: (kind) => deps.systemPreferences.askForMediaAccess(kind),
      requestInputAccess: () => deps.helper?.inputAccess(true) ?? null,
      openUrl: deps.openExternal,
      onChange: (p) => onChange(p),
      logger: deps.logger,
    });
  } else {
    service = new PermissionService({
      read: () => null,
      openUrl: () => Promise.resolve(),
      onChange: () => undefined,
      logger: deps.logger,
    });
  }
  deps.router.handle('perms.get', () => service.recheck());
  deps.router.handle('perms.request', ({ kind }) => service.request(kind));
  deps.router.handle('perms.openSettings', async ({ kind }) => ({
    opened: await service.openSettings(kind),
  }));
  return service;
}
