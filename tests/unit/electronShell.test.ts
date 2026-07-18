import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// The shell is CJS (electron/package.json → commonjs). require('electron') outside the Electron
// runtime returns a path string, so importing these modules is safe as long as the electron-using
// functions aren't called — we only assert the pure constants/logic here.
const require = createRequire(import.meta.url);
const { APP_SCHEME_PRIVILEGES } = require('../../electron/protocol.js');
const { ALLOWED_SCHEMES, REPO_URL } = require('../../electron/network.js');
const paths = require('../../electron/paths.js');

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
