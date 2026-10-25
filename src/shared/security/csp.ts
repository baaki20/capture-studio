/**
 * Content-Security-Policy for every app window (§1.3: strict CSP, no remote content).
 *
 * Production pages load only their own bundled scripts and styles. The dev variant adds what the
 * Vite dev server needs (HMR websocket, React Refresh preamble) and is never used in a packaged
 * build.
 *
 * Images may also come from `cs-media:` (project thumbnails, §4.3.10), which serves only files
 * inside registered project folders. The editor's demuxers, waveform and thumbnail loaders
 * `fetch` project files with Range requests from the same scheme (§4.3.8), so `connect-src`
 * allows it too. Scripts and frames never come from it.
 */
/** The project media scheme (`main/projects/media-protocol.ts` registers it). */
export const MEDIA_SCHEME = 'cs-media';

export interface CspOptions {
  /** Vite dev-server origin, for example `http://localhost:5173`. Omit for production. */
  devServerOrigin?: string;
}

export function buildCsp(options: CspOptions = {}): string {
  const dev = options.devServerOrigin;
  const devWs = dev ? dev.replace(/^http/, 'ws') : undefined;

  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': ["'self'", ...(dev ? ["'unsafe-inline'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', `${MEDIA_SCHEME}:`],
    'font-src': ["'self'"],
    'media-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", ...(dev && devWs ? [dev, devWs] : []), `${MEDIA_SCHEME}:`],
    'worker-src': ["'self'", 'blob:'],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}
