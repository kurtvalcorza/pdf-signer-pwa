// Portable data-directory resolution — contracts/portable-paths.md (FR-011/011a/011b/012/013).
//
// The whole point: Electron's default userData is %APPDATA% / ~/.config, which SURVIVES deleting
// the artifact and would leave a remembered certificate on a machine the user believed clean. We
// relocate userData to a folder ADJACENT to the artifact, resolved from the packaging env vars —
// NEVER from process.execPath/__dirname (those point into a temp extraction / squashfs mount, R3).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

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

const LOCK_HEARTBEAT_MS = 30_000; // the holder refreshes the lock's mtime this often
const LOCK_STALE_MS = 120_000; // no refresh for this long: the holder is gone, whatever the PID says
const LOCK_GRACE_MS = 5_000; // an unreadable lock this new is being written, or its reclaim is live
const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 25;

/** The lock's contents and age, or null if it is gone. Also reads a v0.1.0 bare-PID lock. */
function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    let fields = null;
    try {
      fields = JSON.parse(raw);
    } catch {
      /* empty or partly written */
    }
    return {
      raw,
      pid: Number(fields?.pid ?? raw.trim()) || 0,
      nonce: fields?.nonce ?? null,
      ageMs,
    };
  } catch {
    return null;
  }
}

/**
 * A PID alone cannot prove ownership: PIDs are reused, so a dead instance can look alive. The
 * heartbeat settles that case. An unparseable lock is usually a racing writer, so it gets a grace
 * period instead of being taken as stale.
 */
function isStale(lock) {
  if (!lock.pid) return lock.ageMs > LOCK_GRACE_MS;
  if (lock.pid === process.pid) return true;
  return !isAlive(lock.pid) || lock.ageMs > LOCK_STALE_MS;
}

/**
 * Remove a lock judged stale. An exclusive mkdir is the mutex (atomic, and unlike hard links it works
 * on the FAT media portable builds run from). The lock is re-read inside it, and it can only be
 * replaced by being removed first, which only the mutex holder does, so a fresh owner's lock can
 * never be deleted by a process that judged the old one stale.
 */
function reclaimStale(lockPath, observedRaw) {
  const mutex = `${lockPath}.reclaim`;
  try {
    fs.mkdirSync(mutex);
  } catch {
    try {
      // Left behind by a crash mid-reclaim. Only clears it; this attempt still backs off.
      if (Date.now() - fs.statSync(mutex).mtimeMs > LOCK_GRACE_MS) fs.rmdirSync(mutex);
    } catch {
      /* another process got there first */
    }
    return;
  }
  try {
    if (readLock(lockPath)?.raw === observedRaw) fs.rmSync(lockPath, { force: true });
  } finally {
    fs.rmdirSync(mutex);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  const nonce = randomUUID();
  fs.mkdirSync(dir, { recursive: true });

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // exclusive create — fails if the lock exists
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      fs.closeSync(fd);
      return { ok: true, release: holdLock(lockPath, nonce) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const lock = readLock(lockPath);
    if (lock && !isStale(lock)) return { ok: false, release: () => {} };
    if (lock) reclaimStale(lockPath, lock.raw);
    sleepSync(LOCK_RETRY_MS);
  }
  return { ok: false, release: () => {} };
}

/** Keep the lock fresh while we own it; returns the release that removes only OUR lock. */
function holdLock(lockPath, nonce) {
  const owned = () => readLock(lockPath)?.nonce === nonce;
  const beat = setInterval(() => {
    try {
      if (owned()) fs.utimesSync(lockPath, new Date(), new Date());
    } catch {
      /* the next beat retries; a long failure lets another instance reclaim, which is safe */
    }
  }, LOCK_HEARTBEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    try {
      if (owned()) fs.rmSync(lockPath, { force: true });
    } catch {
      /* already gone */
    }
  };
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
