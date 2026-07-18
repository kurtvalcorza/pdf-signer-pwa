// Portable data-directory resolution — contracts/portable-paths.md (FR-011/011a/011b/012/013).
//
// The whole point: Electron's default userData is %APPDATA% / ~/.config, which SURVIVES deleting
// the artifact and would leave a remembered certificate on a machine the user believed clean. We
// relocate userData to a folder ADJACENT to the artifact, resolved from the packaging env vars —
// NEVER from process.execPath/__dirname (those point into a temp extraction / squashfs mount, R3).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DATA_DIR_NAME = 'pdf-signer-data';

/**
 * Resolve where the app's own state should live, from the packaging env vars only.
 * Returns { mode, adjacentDir | null }:
 *   - 'adjacent'  : PORTABLE_EXECUTABLE_DIR (Windows) or dirname(APPIMAGE) (Linux) is set.
 *   - 'default'   : unpackaged dev run (neither set) — Electron's default userData; never shipped.
 * `mode: 'ephemeral'` is decided later, only if the adjacent dir is not writable.
 */
function resolveAdjacentDir() {
  const win = process.env.PORTABLE_EXECUTABLE_DIR; // set by electron-builder's portable target
  const appimage = process.env.APPIMAGE; // set by the AppImage runtime (absolute path of the file)
  if (win) return { mode: 'adjacent', adjacentDir: win };
  if (appimage) return { mode: 'adjacent', adjacentDir: path.dirname(appimage) };
  return { mode: 'default', adjacentDir: null };
}

/** True if `dir` (created if needed) can be written to. */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide the final data location. MUST be called before app.whenReady() so app.setPath('userData')
 * takes effect for IndexedDB (idb-keyval → certStore.ts follows automatically; FR-009 stays clean).
 *
 * Returns { mode, userData, persistenceEnabled, adjacentDir }:
 *   - adjacent + writable  → mode 'adjacent',  userData = <adjacent>/pdf-signer-data, persistence ON
 *   - adjacent + read-only → mode 'ephemeral', userData = throwaway temp, persistence OFF (not merely
 *                            relocated — the shell must never call save*, so nothing is written)
 *   - unpackaged (dev)     → mode 'default',   userData = Electron default
 *
 * MUST NOT fall back to the OS per-user data dir in adjacent/ephemeral mode (that residue is the whole
 * thing this feature avoids — SC-005/SC-011).
 */
function resolvePortableData() {
  const { mode, adjacentDir } = resolveAdjacentDir();

  // Test-only: force read-only-media (ephemeral) mode, since making a dir truly non-writable is not
  // portable across CI OSes. Never set in a shipped build.
  if (process.env.PDFSIGNER_FORCE_EPHEMERAL === '1') {
    const ephemeral = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signer-ephemeral-'));
    return { mode: 'ephemeral', userData: ephemeral, persistenceEnabled: false, adjacentDir };
  }

  if (mode === 'default') {
    return { mode: 'default', userData: null, persistenceEnabled: true, adjacentDir: null };
  }

  const dataDir = path.join(adjacentDir, DATA_DIR_NAME);
  if (isWritable(dataDir)) {
    return { mode: 'adjacent', userData: dataDir, persistenceEnabled: true, adjacentDir };
  }

  // Read-only media: give Electron a throwaway temp userData for its OWN cache only, and DISABLE
  // opt-in persistence (enforced by the shell never reaching save*). Deleted on quit.
  const ephemeral = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signer-ephemeral-'));
  return { mode: 'ephemeral', userData: ephemeral, persistenceEnabled: false, adjacentDir };
}

/**
 * Data-directory-scoped single-instance lock (spec § Edge Cases): a second copy launched from the
 * SAME folder must defer, while copies in DIFFERENT folders run independently — so the lock lives in
 * the data dir, NOT keyed by appId (Electron's global lock would make all copies defer). A stale lock
 * from a crashed instance is reclaimed, never fatal.
 *
 * Returns `{ ok, release }`. `ok:false` means another LIVE instance owns this folder. Pure fs (no
 * Electron), so it is unit-testable.
 */
function acquireDirLock(dir) {
  if (!dir) return { ok: true, release: () => {} };
  const lockPath = path.join(dir, '.instance-lock');
  const release = () => {
    try {
      if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.rmSync(lockPath, { force: true });
    } catch {
      /* already gone */
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(lockPath, 'wx'); // exclusive create — fails if the lock exists
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true, release };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = 0;
      try {
        holder = Number(fs.readFileSync(lockPath, 'utf8').trim());
      } catch {
        /* race — retry */
      }
      if (holder && holder !== process.pid && isAlive(holder)) return { ok: false, release: () => {} };
      try {
        fs.rmSync(lockPath, { force: true }); // stale (crashed holder) — reclaim and retry
      } catch {
        /* retry */
      }
    }
  }
  return { ok: false, release: () => {} };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not signalable
  }
}

module.exports = { resolvePortableData, resolveAdjacentDir, isWritable, acquireDirLock, DATA_DIR_NAME };
