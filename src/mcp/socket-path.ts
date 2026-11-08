/**
 * Where the running app's automation socket is: `CS_AUTOMATION_SOCKET` when set (development
 * profiles with `CS_USER_DATA_DIR`), else the default user-data folder Electron uses for
 * "Capture Studio" plus `automation/automation.sock`, or on Windows the named pipe derived from
 * that folder (`shared/automation/protocol.ts`).
 */
import os from 'node:os';
import path from 'node:path';
import {
  AUTOMATION_DIR_NAME,
  AUTOMATION_SOCKET_NAME,
  automationPipeName,
} from '../shared/automation/protocol';

export const SOCKET_ENV = 'CS_AUTOMATION_SOCKET';
/** `productName` in package.json: Electron names the user-data folder after it. */
const APP_FOLDER = 'Capture Studio';

export function defaultUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_FOLDER);
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() ? env.APPDATA : path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, APP_FOLDER);
  }
  const config = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(config, APP_FOLDER);
}

export function automationSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const explicit = env[SOCKET_ENV]?.trim();
  if (explicit) return explicit;
  if (platform === 'win32') return automationPipeName(defaultUserDataDir(env, platform, home));
  return path.join(
    defaultUserDataDir(env, platform, home),
    AUTOMATION_DIR_NAME,
    AUTOMATION_SOCKET_NAME,
  );
}
