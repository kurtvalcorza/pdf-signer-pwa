// Custom `app:` scheme — contracts/network-policy.md § Scheme registration.
//
// file:// is unusable (not a secure context, not "standard" → ES-module CORS failures, no service
// workers). A privileged `app:` scheme serves dist/ as a proper secure origin so the exact same web
// bundle runs unchanged (FR-009/FR-019).

const { protocol } = require('electron');
const { readFile, realpath } = require('node:fs/promises');
const path = require('node:path');

const SCHEME = 'app';
const HOST = 'local';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// The exact privileges registered for the scheme. Exported so a test can assert DIRECTLY that
// `bypassCSP` is absent — the only reliable check (trap #1): a `bypassCSP: true` leaves the CSP meta
// tag untouched and is scheme-scoped, so neither reading the tag nor a connect-src probe detects it.
const APP_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true };

/**
 * Register the scheme as privileged. MUST run SYNCHRONOUSLY at startup, BEFORE the `ready` event,
 * exactly once — wiring it inside app.whenReady() silently drops standard/secure/supportFetchAPI and
 * breaks relative assets, the Fetch API, and IndexedDB in the PACKAGED build only.
 */
function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);
}

/**
 * Serve `dist/` over the scheme. Every path is resolved against the dist root and REJECTED if it
 * escapes (`..`, absolute, symlink) — otherwise `app://local/../../<file>` turns the scheme into a
 * host-file disclosure primitive. Registered inside app.whenReady().
 */
function handleAppProtocol(distDir) {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const r = await resolveWithinDist(distDir, pathname);
    if (r.status === 'forbidden') return new Response('forbidden', { status: 403 });
    if (r.status === 'ok') {
      try {
        const data = await readFile(r.realPath);
        const type = MIME[path.extname(r.realPath).toLowerCase()] || 'application/octet-stream';
        return new Response(data, { headers: { 'content-type': type } });
      } catch {
        // e.g. the path resolved to the dist dir itself (EISDIR) — fall through to the SPA index.
      }
    }
    // 'missing' or a directory → SPA fallback: unknown client routes resolve to index.html.
    const html = await readFile(path.join(distDir, 'index.html'));
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  });
}

/**
 * Resolve a request pathname to a real file WITHIN `distDir`, or refuse it. Two layers:
 *   1. lexical containment (rejects `../…`, absolute paths);
 *   2. **realpath** containment — a symlink under dist/ could pass the lexical check while pointing
 *      outside, so we compare symlink-resolved paths. Without this, `app://` becomes a host-file
 *      disclosure primitive.
 * Returns `{ status: 'ok', realPath }` | `{ status: 'forbidden' }` | `{ status: 'missing' }`
 * (missing → the caller serves the SPA index). Exported for unit testing.
 */
async function resolveWithinDist(distDir, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = path.resolve(distDir, rel === '' ? 'index.html' : rel);
  const relLex = path.relative(distDir, resolved);
  if (relLex.startsWith('..') || path.isAbsolute(relLex)) return { status: 'forbidden' };
  let real, root;
  try {
    [real, root] = await Promise.all([realpath(resolved), realpath(distDir)]);
  } catch (e) {
    return e && e.code === 'ENOENT' ? { status: 'missing' } : { status: 'forbidden' };
  }
  const relReal = path.relative(root, real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) return { status: 'forbidden' };
  return { status: 'ok', realPath: real };
}

const appURL = (p = 'index.html') => `${SCHEME}://${HOST}/${p}`;

module.exports = {
  registerAppScheme,
  handleAppProtocol,
  resolveWithinDist,
  appURL,
  SCHEME,
  HOST,
  APP_SCHEME_PRIVILEGES,
};
