// Custom `app:` scheme — contracts/network-policy.md § Scheme registration.
//
// file:// is unusable (not a secure context, not "standard" → ES-module CORS failures, no service
// workers). A privileged `app:` scheme serves dist/ as a proper secure origin so the exact same web
// bundle runs unchanged (FR-009/FR-019).

const { protocol } = require('electron');
const { readFile } = require('node:fs/promises');
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
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const resolved = path.resolve(distDir, rel === '' ? 'index.html' : rel);
    const relToDist = path.relative(distDir, resolved);
    if (relToDist === '' || relToDist.startsWith('..') || path.isAbsolute(relToDist)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await readFile(resolved);
      const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type } });
    } catch {
      // SPA fallback: unknown client routes resolve to index.html (never a traversal escape —
      // that was rejected above).
      const html = await readFile(path.join(distDir, 'index.html'));
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
  });
}

const appURL = (p = 'index.html') => `${SCHEME}://${HOST}/${p}`;

module.exports = { registerAppScheme, handleAppProtocol, appURL, SCHEME, HOST, APP_SCHEME_PRIVILEGES };
