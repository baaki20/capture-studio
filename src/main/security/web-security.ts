/**
 * Security baseline for every window (§1.3): sandboxed renderers with context isolation, no
 * navigation away from the app, no new windows, no webviews, no permission grants by default,
 * and external links only for `https:` and `mailto:`.
 */
import { pathToFileURL } from 'node:url';
import { app, session, shell, type WebContents, type WebPreferences } from 'electron';
import type { Logger } from '../../shared/logger';

/** webPreferences every window must use. Callers add only `preload`. */
export function secureWebPreferences(preload?: string): WebPreferences {
  return {
    ...(preload ? { preload } : {}),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    devTools: !app.isPackaged,
  };
}

const EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:']);

export function isSafeExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * True when `url` belongs to the app itself: the Vite dev server in development, or the
 * packaged renderer folder.
 */
export function isAppUrl(
  url: string,
  appOrigins: { devServerUrl?: string; rendererDir: string },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (appOrigins.devServerUrl) {
    return parsed.origin === new URL(appOrigins.devServerUrl).origin;
  }
  if (parsed.protocol !== 'file:') return false;
  const rendererPath = pathToFileURL(appOrigins.rendererDir).pathname.replace(/\/?$/, '/');
  return parsed.pathname.startsWith(rendererPath);
}

function guardWebContents(
  contents: WebContents,
  appOrigins: { devServerUrl?: string; rendererDir: string },
  logger: Logger,
): void {
  const blockNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url, appOrigins)) return;
    event.preventDefault();
    logger.warn(`security: blocked navigation to ${url}`);
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  };
  contents.on('will-navigate', blockNavigation);
  contents.on('will-redirect', blockNavigation);
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('security: blocked webview');
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    else logger.warn(`security: blocked window.open(${url})`);
    return { action: 'deny' };
  });
}

/** Call once before any window is created. */
export function installSecurityGuards(
  appOrigins: { devServerUrl?: string; rendererDir: string },
  logger: Logger,
): void {
  app.on('web-contents-created', (_event, contents) =>
    guardWebContents(contents, appOrigins, logger),
  );

  // Deny every permission except media capture for webContents granted with `allowMediaCapture`
  // (the capture engine window, step 9; camera and mic previews in the shell, step 11).
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (isMediaCaptureAllowed(contents.id, permission, details.requestingUrl, appOrigins)) {
      callback(true);
      return;
    }
    logger.warn(`security: denied permission request "${permission}"`);
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    contents ? isMediaCaptureAllowed(contents.id, permission, requestingOrigin, appOrigins) : false,
  );
}

/** webContents ids that may capture camera and microphone, and whether also the screen. */
const mediaCaptureGrants = new Map<number, { display: boolean }>();

/**
 * Lets one window's webContents capture camera and mic (`media`), and with `display` also the
 * screen (`display-capture`, which `getUserMedia` with a desktop source id asks for). Only the
 * capture engine gets `display`. Returns a function that revokes the grant.
 */
export function allowMediaCapture(
  contents: { id: number },
  options: { display: boolean } = { display: true },
): () => void {
  mediaCaptureGrants.set(contents.id, { display: options.display });
  return () => {
    mediaCaptureGrants.delete(contents.id);
  };
}

/** The permission decision for media capture (pure, exported for tests). */
export function isMediaCaptureAllowed(
  webContentsId: number,
  permission: string,
  requestingUrl: string,
  appOrigins: { devServerUrl?: string; rendererDir: string },
): boolean {
  const grant = mediaCaptureGrants.get(webContentsId);
  if (!grant) return false;
  if (permission !== 'media' && !(permission === 'display-capture' && grant.display)) return false;
  // Permission checks pass an origin ("file:///" for packaged pages), requests the full URL.
  if (isAppUrl(requestingUrl, appOrigins)) return true;
  if (appOrigins.devServerUrl) return false;
  return requestingUrl === 'file://' || requestingUrl === 'file:///';
}
