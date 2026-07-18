import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MAIN = resolve(ROOT, 'electron/main.js');
const FIX = resolve(ROOT, 'tests/e2e/fixtures');
const CERT_PASSWORD = 'e2e-pass';

/**
 * Drive the real desktop shell through a .p12 sign and validate the output with pyHanko — the
 * per-distribution FR-010 gate (Principle V: NOT inherited from the web run). Also proves the
 * portable data dir lands beside the "artifact" (PORTABLE_EXECUTABLE_DIR), not in %APPDATA%.
 */
test('desktop: signs a PDF that pyHanko validates, and keeps state adjacent', async () => {
  const portableDir = mkdtempSync(join(tmpdir(), 'pdfsigner-portable-'));
  const downloadDir = mkdtempSync(join(tmpdir(), 'pdfsigner-dl-'));

  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      PDFSIGNER_HEADLESS: '1',
      PORTABLE_EXECUTABLE_DIR: portableDir, // pretend we are the portable .exe running from here
      PDFSIGNER_E2E_DOWNLOAD_DIR: downloadDir, // test-only capture (unpackaged → hook allowed)
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveTitle(/PDF Signer/);

    await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(resolve(FIX, 'sample.pdf'));
    await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 20_000 });

    await page
      .locator('input[type="file"][accept="image/png,image/jpeg"]')
      .setInputFiles(resolve(FIX, 'signature.png'));
    await page.locator('img[alt="signature"]').waitFor({ state: 'visible', timeout: 10_000 });

    await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
    await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(resolve(FIX, 'e2e-cert.p12'));
    await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);
    await page.getByRole('button', { name: /Sign & Download/ }).click();

    // Wait for the download to fully complete (sentinel written by main on 'done').
    const deadline = Date.now() + 30_000;
    let saved: string | undefined;
    while (Date.now() < deadline) {
      const done = readdirSync(downloadDir).find((f) => f.endsWith('.pdf.done'));
      if (done) {
        saved = join(downloadDir, done.replace(/\.done$/, ''));
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(saved, 'a signed PDF was downloaded').toBeTruthy();
    expect(existsSync(saved!) && statSync(saved!).size > 0).toBe(true);

    // FR-010 gate — pyHanko must validate THIS artifact's output. PYTHON env for cross-platform
    // (Windows: `python`; Linux/CI: `python3` or a venv path).
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const out = execFileSync(python, [resolve(ROOT, 'scripts/validate_pdf.py'), saved!], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out, out).toContain('RESULT: PASS');

    // Portable state: data dir is beside the "artifact", nothing leaked to %APPDATA%.
    expect(existsSync(join(portableDir, 'pdf-signer-data'))).toBe(true);
    const appData = process.env.APPDATA;
    if (appData) {
      const leaked = existsSync(join(appData, 'pdf-signer-pwa')) || existsSync(join(appData, 'PDF Signer'));
      expect(leaked, 'no state leaked to %APPDATA%').toBe(false);
    }
  } finally {
    await app.close();
    rmSync(portableDir, { recursive: true, force: true });
    rmSync(downloadDir, { recursive: true, force: true });
  }
});

/**
 * Layer 2 (Chromium session denial): a renderer request to a remote https origin is cancelled by
 * the webRequest lock — ISOLATED from CSP. A renderer `fetch('https://…')` is the wrong probe: the
 * page's `connect-src 'none'` blocks it first, so the assertion passes even if `installNetworkLocks`
 * is broken (layer 1 masking layer 2 — the exact trap from the spec, T015 step 3). Instead we issue a
 * MAIN-process session request (`session.fetch`), which the page CSP does not govern, so only the
 * webRequest cancellation can stop it.
 */
test('desktop: layer-5 no-phone-home switches are set (not just crashReporter absent)', async () => {
  const app = await electron.launch({ args: [MAIN], cwd: ROOT, env: { ...process.env, PDFSIGNER_HEADLESS: '1' } });
  try {
    await app.firstWindow();
    // A build-time/runtime assertion: a live run that happens to make no request proves nothing about
    // whether these are set. Read them directly from the command line (network-policy.md § layer 5).
    const set = await app.evaluate(({ app: a }) =>
      ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'disable-breakpad'].map(
        (s) => a.commandLine.hasSwitch(s),
      ),
    );
    expect(set).toEqual([true, true, true, true]);
  } finally {
    await app.close();
  }
});

test('desktop: a remote https request is cancelled by webRequest, not CSP (layer 2)', async () => {
  const app = await electron.launch({ args: [MAIN], cwd: ROOT, env: { ...process.env, PDFSIGNER_HEADLESS: '1' } });
  try {
    await app.firstWindow(); // ensure whenReady ran (installNetworkLocks is installed)
    const rejected = await app.evaluate(async ({ session }) => {
      try {
        await session.defaultSession.fetch('https://example.com/ping');
        return false; // reached the network — the webRequest lock failed
      } catch {
        return true; // cancelled by onBeforeRequest (no page CSP involved here)
      }
    });
    expect(rejected).toBe(true);
  } finally {
    await app.close();
  }
});
