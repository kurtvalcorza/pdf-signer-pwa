import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// The shell is CJS (electron/package.json → commonjs). require('electron') outside the Electron
// runtime returns a path string, so importing these modules is safe as long as the electron-using
// functions aren't called — we only assert the pure constants/logic here.
const require = createRequire(import.meta.url);
const { APP_SCHEME_PRIVILEGES, resolveWithinDist } = require('../../electron/protocol.js');
const { ALLOWED_SCHEMES, REPO_URL } = require('../../electron/network.js');
const paths = require('../../electron/paths.js');
const { loadBuildMetadata } = require('../../electron/buildmeta.js');
import { writeFileSync, mkdtempSync as _mkdtemp } from 'node:fs';

function writeBuildInfo(engineDaysOld: number, buildDaysOld = 0): string {
  const dir = _mkdtemp(join(tmpdir(), 'buildinfo-'));
  const file = join(dir, 'build-info.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: '1.2.3',
      buildDate: new Date(Date.now() - buildDaysOld * 86_400_000).toISOString(),
      engineVersion: '43.1.1',
      engineDate: new Date(Date.now() - engineDaysOld * 86_400_000).toISOString(),
      commit: 'deadbeefcafe',
      selfUpdates: false,
    }),
  );
  return file;
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('electron shell — scheme privileges (trap #1)', () => {
  it('registers the app: scheme WITHOUT any truthy bypassCSP', () => {
    // Asserted against the registration value itself — the only reliable detection. bypassCSP: true
    // would silently exempt app:-served resources from connect-src 'none' (Principle I breach).
    expect(APP_SCHEME_PRIVILEGES.bypassCSP).toBeFalsy();
    expect(APP_SCHEME_PRIVILEGES).toMatchObject({ standard: true, secure: true, supportFetchAPI: true });
  });
});

describe('electron shell — network allow-list', () => {
  it('allows only app:/blob:/data: and nothing remote', () => {
    expect([...ALLOWED_SCHEMES].sort()).toEqual(['app:', 'blob:', 'data:']);
    expect(ALLOWED_SCHEMES.has('https:')).toBe(false);
    expect(ALLOWED_SCHEMES.has('http:')).toBe(false);
    expect(ALLOWED_SCHEMES.has('ws:')).toBe(false);
  });
  it('pins the openExternal carve-out to the exact repo URL', () => {
    expect(REPO_URL).toBe('https://github.com/kurtvalcorza/pdf-signer-pwa');
  });
});

describe('electron shell — portable data resolution (traps #2)', () => {
  it('resolves adjacent to PORTABLE_EXECUTABLE_DIR (Windows portable), not a temp extraction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portable-'));
    try {
      process.env.PORTABLE_EXECUTABLE_DIR = dir;
      delete process.env.APPIMAGE;
      const r = paths.resolvePortableData();
      expect(r.mode).toBe('adjacent');
      expect(r.userData).toBe(join(dir, 'pdf-signer-data'));
      expect(r.persistenceEnabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves adjacent to dirname(APPIMAGE) on Linux', () => {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    process.env.APPIMAGE = '/home/user/Apps/PDF-Signer.AppImage';
    const r = paths.resolveAdjacentDir();
    expect(r.mode).toBe('adjacent');
    expect(r.adjacentDir).toBe('/home/user/Apps');
  });

  it('falls back to Electron default (dev) when neither env var is set — never the OS data dir', () => {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    delete process.env.APPIMAGE;
    const r = paths.resolvePortableData();
    expect(r.mode).toBe('default');
    expect(r.userData).toBeNull(); // main leaves Electron's default in place; nothing relocated
  });
});

describe('electron shell — staleness (US3): isStale derives from engineDate, not buildDate', () => {
  it('is stale when the engine is older than the 180-day threshold', () => {
    process.env.PDFSIGNER_BUILD_INFO = writeBuildInfo(200);
    expect(loadBuildMetadata().isStale).toBe(true);
  });
  it('is NOT stale when the engine is fresh', () => {
    process.env.PDFSIGNER_BUILD_INFO = writeBuildInfo(10);
    expect(loadBuildMetadata().isStale).toBe(false);
  });
  it('a fresh buildDate does NOT silence a stale engine (regression guard, FR-015a)', () => {
    process.env.PDFSIGNER_BUILD_INFO = writeBuildInfo(365, 0); // old engine, brand-new rebuild
    const m = loadBuildMetadata();
    expect(m.isStale).toBe(true);
    expect(m.buildAgeInDays).toBeLessThan(2); // build IS fresh…
    expect(m.engineAgeInDays).toBeGreaterThan(300); // …but the engine is not
  });
  it('returns null when no build-info exists (dev run) rather than crashing', () => {
    process.env.PDFSIGNER_BUILD_INFO = join(tmpdir(), 'does-not-exist-build-info.json');
    expect(loadBuildMetadata()).toBeNull();
  });
});

describe('electron shell — app: scheme path safety (resolveWithinDist)', () => {
  const withDist = (fn: (dir: string) => Promise<void> | void) => async () => {
    const dir = _mkdtemp(join(tmpdir(), 'dist-'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('serves a real file inside dist', withDist(async (dir) => {
    const r = await resolveWithinDist(dir, '/index.html');
    expect(r.status).toBe('ok');
  }));

  it('refuses lexical `..` traversal', withDist(async (dir) => {
    expect((await resolveWithinDist(dir, '/../../secret')).status).toBe('forbidden');
  }));

  it('reports missing for unknown routes (→ SPA fallback)', withDist(async (dir) => {
    expect((await resolveWithinDist(dir, '/some/client/route')).status).toBe('missing');
  }));

  it('refuses a symlink that ESCAPES dist (realpath, not lexical)', withDist(async (dir) => {
    const { symlinkSync, writeFileSync: wf } = await import('node:fs');
    const outside = _mkdtemp(join(tmpdir(), 'outside-'));
    wf(join(outside, 'secret.txt'), 'top secret');
    let made = false;
    try {
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'evil')); // may fail on Windows non-admin
      made = true;
    } catch {
      /* environment can't create symlinks — the lexical/traversal cases still cover the guard */
    }
    if (made) expect((await resolveWithinDist(dir, '/evil')).status).toBe('forbidden');
    rmSync(outside, { recursive: true, force: true });
  }));
});

describe('electron shell — data-directory single-instance lock', () => {
  it('acquires a fresh lock and releases it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-'));
    try {
      const a = paths.acquireDirLock(dir);
      expect(a.ok).toBe(true);
      a.release();
      const b = paths.acquireDirLock(dir); // released → re-acquirable
      expect(b.ok).toBe(true);
      b.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a STALE lock left by a dead process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-stale-'));
    try {
      // A PID that is essentially certain to be dead.
      writeFileSync(join(dir, '.instance-lock'), '999999');
      const a = paths.acquireDirLock(dir);
      expect(a.ok).toBe(true); // stale → reclaimed
      a.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defers when a LIVE other process holds the lock', async () => {
    const { spawn } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'lock-live-'));
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(dir, '.instance-lock'), String(sleeper.pid)); // held by a live process
      const a = paths.acquireDirLock(dir);
      expect(a.ok).toBe(false); // another live instance owns the folder → defer
    } finally {
      sleeper.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
