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
      PDFSIGNER_E2E_DOWNLOAD_DIR: downloadDir, // test-only: capture the download without a dialog
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

    // FR-010 gate — pyHanko must validate THIS artifact's output.
    const out = execFileSync('python', [resolve(ROOT, 'scripts/validate_pdf.py'), saved!], {
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
 * the webRequest lock. blob:/data:/app: remain allowed (proven by the sign+download test above).
 */
test('desktop: a remote https request from the renderer is blocked (layer 2)', async () => {
  const app = await electron.launch({ args: [MAIN], cwd: ROOT, env: { ...process.env, PDFSIGNER_HEADLESS: '1' } });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const blocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/ping', { mode: 'no-cors' });
        return false; // reached the network — lock failed
      } catch {
        return true; // request did not complete — cancelled by CSP and/or webRequest
      }
    });
    expect(blocked).toBe(true);
  } finally {
    await app.close();
  }
});
