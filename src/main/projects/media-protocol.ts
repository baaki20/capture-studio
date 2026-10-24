/**
 * The `cs-media://` protocol (§1.3, §4.3.10, R1.52).
 *
 * `cs-media://<projectId>/<relative path>` is resolved against the registered root folder of
 * that project. Only regular files whose `realpath` stays inside the root's `realpath` are
 * served, so `..`, encoded separators and symlinks that point outside are refused. Single
 * `Range` requests are supported (media elements and demuxers seek with them).
 */
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Logger } from '../../shared/logger';
import { silentLogger } from '../../shared/logger';
import { MEDIA_SCHEME } from '../../shared/security/csp';

export { MEDIA_SCHEME };

/** Pass to `protocol.registerSchemesAsPrivileged` before `app` is ready. */
export const MEDIA_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true,
} as const;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.peaks': 'application/octet-stream',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Project id → root folder. Ids are matched case-insensitively because `cs-media` is a standard
 * scheme and URL hosts are lower-cased.
 */
export class ProjectRootRegistry {
  private readonly roots = new Map<string, string>();

  register(projectId: string, root: string): void {
    this.roots.set(projectId.toLowerCase(), path.resolve(root));
  }

  unregister(projectId: string): void {
    this.roots.delete(projectId.toLowerCase());
  }

  resolve(projectId: string): string | null {
    return this.roots.get(projectId.toLowerCase()) ?? null;
  }
}

/** Builds the URL for a file inside a project (each path segment is percent-encoded). */
export function mediaUrl(projectId: string, relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean).map(encodeURIComponent);
  return `${MEDIA_SCHEME}://${encodeURIComponent(projectId.toLowerCase())}/${segments.join('/')}`;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single-range `Range` header against a file size. Returns null to serve the whole file
 * (no header, another unit, or several ranges) and 'unsatisfiable' for a range past the end.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, startText = '', endText = ''] = m;
  if (startText === '' && endText === '') return null;

  if (startText === '') {
    // Suffix range: the last N bytes.
    const length = Number(endText);
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(startText);
  if (start >= size) return 'unsatisfiable';
  const end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

export interface MediaPathError {
  status: 400 | 403 | 404;
  reason: string;
}

function isInside(root: string, target: string): boolean {
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Maps a `cs-media://` URL to a real file path inside its project, or explains the refusal. */
export async function resolveMediaPath(
  registry: ProjectRootRegistry,
  url: string,
): Promise<{ ok: true; path: string; size: number } | { ok: false; error: MediaPathError }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: { status: 400, reason: 'malformed URL' } };
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) {
    return { ok: false, error: { status: 400, reason: 'wrong scheme' } };
  }

  let projectId: string;
  try {
    projectId = decodeURIComponent(parsed.hostname);
  } catch {
    return { ok: false, error: { status: 400, reason: 'malformed project id' } };
  }
  const root = registry.resolve(projectId);
  if (!root) return { ok: false, error: { status: 404, reason: `unknown project ${projectId}` } };

  const segments: string[] = [];
  for (const raw of parsed.pathname.split('/')) {
    if (raw === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return { ok: false, error: { status: 400, reason: 'malformed path' } };
    }
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) {
      return {
        ok: false,
        error: { status: 403, reason: `forbidden path segment ${JSON.stringify(segment)}` },
      };
    }
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, error: { status: 404, reason: 'no file' } };

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fs.realpath(root);
    realTarget = await fs.realpath(path.join(realRoot, ...segments));
  } catch {
    return { ok: false, error: { status: 404, reason: 'not found' } };
  }
  if (!isInside(realRoot, realTarget)) {
    return { ok: false, error: { status: 403, reason: 'path leaves the project folder' } };
  }
  const stat = await fs.stat(realTarget).catch(() => null);
  if (!stat?.isFile()) return { ok: false, error: { status: 404, reason: 'not a file' } };
  return { ok: true, path: realTarget, size: stat.size };
}

export interface MediaHandlerOptions {
  registry: ProjectRootRegistry;
  logger?: Logger;
  /**
   * Origins of the app's own pages. A matching `Origin` header is echoed in
   * `Access-Control-Allow-Origin`, so CORS-mode `fetch` (the editor's demuxers) can read files.
   */
  allowedOrigins?: readonly string[];
}

/** Creates the handler for `protocol.handle(MEDIA_SCHEME, handler)`. */
export function createMediaHandler(
  options: MediaHandlerOptions,
): (request: Request) => Promise<Response> {
  const logger = options.logger ?? silentLogger;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  return async (request) => {
    const headers = new Headers({
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    const origin = request.headers.get('Origin');
    if (origin && allowedOrigins.has(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
      headers.set('Vary', 'Origin');
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers.set('Allow', 'GET, HEAD');
      return new Response(null, { status: 405, headers });
    }

    const resolved = await resolveMediaPath(options.registry, request.url);
    if (!resolved.ok) {
      if (resolved.error.status === 403) {
        logger.warn(`cs-media: refused ${request.url}: ${resolved.error.reason}`);
      }
      return new Response(null, { status: resolved.error.status, headers });
    }

    const { size } = resolved;
    headers.set('Content-Type', mimeTypeFor(resolved.path));
    headers.set('Accept-Ranges', 'bytes');

    const range = parseRange(request.headers.get('Range'), size);
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${String(size)}`);
      return new Response(null, { status: 416, headers });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    headers.set('Content-Length', String(length));
    if (range)
      headers.set('Content-Range', `bytes ${String(start)}-${String(end)}/${String(size)}`);
    const status = range ? 206 : 200;

    if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers });
    const body = Readable.toWeb(createReadStream(resolved.path, { start, end })) as ReadableStream;
    return new Response(body, { status, headers });
  };
}
