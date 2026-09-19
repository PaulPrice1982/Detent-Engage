import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { createBrotliCompress, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Static asset serving.
 *
 * Deliberately minimal and deliberately paranoid. The API is the product's
 * security surface; this exists so a browser pointed at the service gets a page
 * rather than a JSON 404. It serves only from directories the caller names, it
 * never follows a path out of them, and it never guesses a content type it does
 * not recognise.
 *
 * Audit PERF-6: every page view on every tenant site re-downloaded the loader
 * script, the panel and the logo. No compression, no ETag, no conditional
 * requests, no content-hashed filenames, with a comment conceding the point
 * ("correctness over bandwidth until there is a build hash"). There is now a
 * build hash, derived from the file's size and mtime, so:
 *
 *   - a content-hashed request (`loader.abc123.js`) is served `immutable` for a
 *     year, because the name changes when the bytes do;
 *   - everything else gets a strong ETag and answers a conditional request with
 *     304, so a repeat view costs a round trip and no body;
 *   - `panel.html` and anything under an API path stay `no-store`. The panel
 *     carries the tenant's disclosure and consent wording, and a cached copy of
 *     those is a compliance problem rather than a saving;
 *   - Brotli, then gzip, for compressible types.
 */
export interface StaticMount {
  /** URL prefix, e.g. `/widget`. Use `''` to mount at the root. */
  readonly prefix: string;
  /** Absolute directory on disk. */
  readonly dir: string;
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Types worth compressing. Images and fonts are already compressed. */
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.map']);

/** Never cached, whatever the request. */
const NEVER_CACHE = new Set(['panel.html', 'install.html', 'console.html']);

const YEAR_SECONDS = 31_536_000;

/**
 * Strip a content hash from a filename, returning the real file to serve.
 *
 * `loader.a1b2c3d4.js` resolves to `loader.js`. The hash is not looked up
 * anywhere: its only job is to make the URL change when the content does, so
 * the response can be `immutable` without a deploy ever serving stale bytes.
 */
export function stripContentHash(fileName: string): { name: string; hashed: boolean } {
  const match = /^(.*)\.([0-9a-f]{8,32})(\.[^.]+)$/.exec(fileName);
  if (!match) return { name: fileName, hashed: false };
  return { name: `${match[1]}${match[3]}`, hashed: true };
}

/**
 * Resolves a URL path against a mount, or returns undefined if it does not
 * belong to that mount or tries to escape it.
 */
export function resolveStaticPath(mount: StaticMount, urlPath: string): string | undefined {
  if (mount.prefix && !urlPath.startsWith(mount.prefix + '/') && urlPath !== mount.prefix) {
    return undefined;
  }
  let relative = urlPath.slice(mount.prefix.length);
  if (relative === '' || relative === '/') relative = '/index.html';

  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return undefined;
  }
  // A NUL byte truncates a path in some syscalls; refuse rather than normalise.
  if (decoded.includes('\0')) return undefined;

  // Reject any parent-directory segment outright, before normalising.
  //
  // Normalising an absolute path silently *clamps* a traversal at the root,
  // `/../secrets` becomes `/secrets`, which then joins to a real file inside the
  // mount. That is safe but surprising, and a security surface should not rely
  // on a surprise. No browser sends `..` in a legitimate asset request, so
  // refusing costs nothing and makes the guarantee readable: a served path is
  // exactly the path that was asked for.
  if (decoded.split(/[\\/]/).includes('..')) return undefined;

  const normalised = normalize(decoded);

  const full = join(mount.dir, normalised);
  // Belt and braces: the joined path must still sit inside the mount.
  if (full !== mount.dir && !full.startsWith(mount.dir.endsWith(sep) ? mount.dir : mount.dir + sep)) {
    return undefined;
  }
  return full;
}

/** A strong validator derived from the file's identity on disk. */
export function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

export function cacheControlFor(fileName: string, hashed: boolean): string {
  if (NEVER_CACHE.has(fileName)) return 'no-store';
  if (hashed) return `public, max-age=${YEAR_SECONDS}, immutable`;
  // Revalidate every time, but answer with 304 when nothing changed. A loader
  // script that a tenant embeds on every page is worth one conditional request.
  return 'public, max-age=0, must-revalidate';
}

function negotiateEncoding(header: string | undefined, extension: string): 'br' | 'gzip' | undefined {
  if (!header || !COMPRESSIBLE.has(extension)) return undefined;
  const accepted = header.toLowerCase();
  if (accepted.includes('br')) return 'br';
  if (accepted.includes('gzip')) return 'gzip';
  return undefined;
}

/**
 * Attempts to serve a static file. Returns true if it wrote a response.
 *
 * Only GET and HEAD are served: a static directory must never be reachable by a
 * method that implies a state change, even though nothing here writes.
 */
export async function serveStatic(
  mounts: readonly StaticMount[],
  request: IncomingMessage,
  response: ServerResponse,
  baseHeaders: Readonly<Record<string, string>>,
): Promise<boolean> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;

  const urlPath = new URL(request.url ?? '/', 'http://localhost').pathname;

  for (const mount of mounts) {
    const requested = resolveStaticPath(mount, urlPath);
    if (!requested) continue;

    const lastSlash = requested.lastIndexOf(sep);
    const directory = requested.slice(0, lastSlash + 1);
    const { name: bareName, hashed } = stripContentHash(requested.slice(lastSlash + 1));
    const file = `${directory}${bareName}`;

    const extension = extname(file).toLowerCase();
    const type = TYPES[extension];
    if (!type) continue;

    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      continue;
    }

    const etag = etagFor(size, mtimeMs);
    const cacheControl = cacheControlFor(bareName, hashed);

    const headers: Record<string, string> = {
      ...baseHeaders,
      'content-type': type,
      'cache-control': cacheControl,
      etag,
      'last-modified': new Date(mtimeMs).toUTCString(),
    };

    // Conditional request. A matching validator means the client already has
    // these exact bytes, so the body is not worth sending again.
    const ifNoneMatch = request.headers['if-none-match'];
    if (cacheControl !== 'no-store' && ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
      response.writeHead(304, headers).end();
      return true;
    }

    const encoding = negotiateEncoding(request.headers['accept-encoding'] as string | undefined, extension);
    if (encoding) {
      headers['content-encoding'] = encoding;
      // Content-length no longer describes the body once it is compressed, and
      // caches must key on the encoding.
      headers['vary'] = headers['vary'] ? `${headers['vary']}, accept-encoding` : 'accept-encoding';
    } else {
      headers['content-length'] = String(size);
    }

    if (method === 'HEAD') {
      response.writeHead(200, headers).end();
      return true;
    }

    response.writeHead(200, headers);
    const source = createReadStream(file);
    if (!encoding) {
      source.pipe(response);
      return true;
    }
    const compressor = encoding === 'br' ? createBrotliCompress() : createGzip();
    // Awaited so a failed compression closes the response rather than hanging
    // the connection until the request timeout fires.
    await pipeline(source, compressor, response).catch(() => {
      if (!response.writableEnded) response.end();
    });
    return true;
  }
  return false;
}

export { join as joinPath };
