// Runtime network locks (layer 2 + navigation locks) — contracts/network-policy.md.
//
// ⚠ These cover the Chromium SESSION only. Node's fetch/http/net in the MAIN process bypass
// webRequest entirely — layer 3 (the eslint import allow-list) is what guards that, and layer 6
// (the external monitored-network gate) is the actual proof. This file is not sufficient alone.

const { shell } = require('electron');

// The one exact URL the shipped app may hand to the OS browser (src/components/GitHubLink.tsx).
// Allow-listed by EXACT STRING, never by pattern/origin — a runtime-assembled URL or "any https"
// would be a general-purpose exfiltration primitive that bypasses every layer above.
const REPO_URL = 'https://github.com/kurtvalcorza/pdf-signer-pwa';

// Schemes a renderer/session request may use. Everything else is cancelled unconditionally.
// blob: is the signed-PDF download (blocking it makes signing silently produce no file — R10).
const ALLOWED_SCHEMES = new Set(['app:', 'blob:', 'data:']);

/**
 * Install the session-level and window-level locks. `ses` is a Session (defaultSession).
 * `getWindow` returns the current BrowserWindow (for scoping, unused here but kept for clarity).
 */
function installNetworkLocks(ses) {
  // Layer 2 — cancel every session request whose scheme is not allow-listed.
  ses.webRequest.onBeforeRequest((details, callback) => {
    let scheme;
    try {
      scheme = new URL(details.url).protocol;
    } catch {
      return callback({ cancel: true });
    }
    callback({ cancel: !ALLOWED_SCHEMES.has(scheme) });
  });
}

/**
 * Apply per-window navigation locks: no navigation outside app:, and no popup/new window may reach
 * a remote origin. The ONE carve-out hands the exact repo URL to the OS browser (a separate process,
 * outside this app's session/policy) so the shipped "View source" link is not silently dead (FR-020).
 */
function lockWindow(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Deny the in-app window in ALL cases; for THIS one exact URL, additionally hand it to the OS.
    if (url === REPO_URL) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

module.exports = { installNetworkLocks, lockWindow, REPO_URL, ALLOWED_SCHEMES };
