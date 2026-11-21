import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MAIN = resolve(ROOT, 'electron/main.js');
const FIX = resolve(ROOT, 'tests/e2e/fixtures');
const CERT_PASSWORD = 'e2e-pass';
const CERTIFIED_PDF = resolve(ROOT, 'tests/signing/fixtures/policy/certified-p2-empty-field.pdf');
const VALIDATOR = resolve(ROOT, 'scripts/validate_pdf.py');
// PYTHON env for cross-platform (Windows: `python`; Linux/CI: `python3` or a venv path).
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

/** Waits for main's 'done' sentinel in the test-only download dir; returns the saved PDF path. */
async function waitForDownload(downloadDir: string): Promise<string | undefined> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const done = readdirSync(downloadDir).find((f) => f.endsWith('.pdf.done'));
    if (done) return join(downloadDir, done.replace(/\.done$/, ''));
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

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

    await page
      .locator('input[type="file"][accept=".pdf"]')
      .setInputFiles(resolve(FIX, 'sample.pdf'));
    // The <canvas> is in the DOM, half-transparent, before pdf.js draws; aria-busy="false" is the
    // app's signal that the page is painted and the overlay/field outlines can appear (issue #51).
    await page
      .locator('canvas[aria-busy="false"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });

    await page
      .locator('input[type="file"][accept="image/png,image/jpeg"]')
      .setInputFiles(resolve(FIX, 'signature.png'));
    await page.locator('img[alt="signature"]').waitFor({ state: 'visible', timeout: 10_000 });

    await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
    await page
      .locator('input[type="file"][accept=".p12,.pfx"]')
      .setInputFiles(resolve(FIX, 'e2e-cert.p12'));
    await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);
    await page.getByRole('button', { name: /Sign & Download/ }).click();

    // Wait for the download to fully complete (sentinel written by main on 'done').
    const saved = await waitForDownload(downloadDir);
    expect(saved, 'a signed PDF was downloaded').toBeTruthy();
    expect(existsSync(saved!) && statSync(saved!).size > 0).toBe(true);

    // FR-010 gate — pyHanko must validate THIS artifact's output.
    const out = execFileSync(PYTHON, [VALIDATOR, saved!], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out, out).toContain('RESULT: PASS');

    // Portable state: data dir is beside the "artifact", nothing leaked to %APPDATA%.
    expect(existsSync(join(portableDir, 'pdf-signer-data'))).toBe(true);
    const appData = process.env.APPDATA;
    if (appData) {
      const leaked =
        existsSync(join(appData, 'pdf-signer-pwa')) || existsSync(join(appData, 'PDF Signer'));
      expect(leaked, 'no state leaked to %APPDATA%').toBe(false);
    }
  } finally {
    await app.close();
    rmSync(portableDir, { recursive: true, force: true });
    rmSync(downloadDir, { recursive: true, force: true });
  }
});

/**
 * Spec 004 T039: the desktop shell signs a certified PDF in the field its author prepared, and
 * the saved file is classed as form filling by the validator's certified-field mode. Same flow
 * and checks as tests/e2e/us7-certified-field.spec.ts, earned again on this distribution
 * (Principle V). Without pyHanko the validator step is skipped and annotated, unless
 * REQUIRE_PYHANKO=1 (set in CI by T038), where a missing validator fails the test.
 */
test('desktop: signs a certified PDF in its prepared field, classed as form filling', async () => {
  const testInfo = test.info();
  // Its own data dir, so this run neither reads nor writes the shared per-user app data.
  const portableDir = mkdtempSync(join(tmpdir(), 'pdfsigner-portable-'));
  const downloadDir = mkdtempSync(join(tmpdir(), 'pdfsigner-dl-'));
  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      PDFSIGNER_HEADLESS: '1',
      PORTABLE_EXECUTABLE_DIR: portableDir,
      PDFSIGNER_E2E_DOWNLOAD_DIR: downloadDir,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(CERTIFIED_PDF);
    // The <canvas> is in the DOM, half-transparent, before pdf.js draws; aria-busy="false" is the
    // app's signal that the page is painted and the overlay/field outlines can appear (issue #51).
    await page
      .locator('canvas[aria-busy="false"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });

    // The app says what kind of document this is and offers the prepared field, not picked.
    await expect(
      page.getByText(
        'This PDF is certified. It can only be signed in one of the signature fields its author prepared.',
      ),
    ).toBeVisible();
    const outline = page.getByTestId('field-outline');
    await expect(outline).toHaveCount(1, { timeout: 15_000 });
    await expect(outline).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('field-option')).toHaveText(
      'Field name set by the document: "Approver" (page 1)',
    );

    // Adding the image places nothing, and signing waits until the field is picked.
    await page
      .locator('input[type="file"][accept="image/png,image/jpeg"]')
      .setInputFiles(resolve(FIX, 'signature.png'));
    await expect(page.getByRole('button', { name: /Clean up background/ })).toBeEnabled({
      timeout: 10_000,
    });
    await expect(page.locator('img[alt="signature"]')).toHaveCount(0);
    const openCertSheet = page.getByRole('button', { name: /Sign with a digital certificate/ });
    await expect(openCertSheet).toBeDisabled();

    await outline.click();
    await expect(outline).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('img[alt="signature"]')).toBeVisible();

    await expect(openCertSheet).toBeEnabled();
    await openCertSheet.click();
    await page
      .locator('input[type="file"][accept=".p12,.pfx"]')
      .setInputFiles(resolve(FIX, 'e2e-cert.p12'));
    await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);
    await page.getByRole('button', { name: /Sign & Download/ }).click();

    const saved = await waitForDownload(downloadDir);
    expect(saved, 'a signed PDF was downloaded').toBeTruthy();

    // The app states what it did, and makes no claim about the certification.
    await expect(
      page.getByText(
        "Signed in the existing field 'Approver'. No other part of the document was changed.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(/still certified|certification preserved|remains valid/i),
    ).toHaveCount(0);

    // The input is a byte prefix of the saved file, which now carries two signatures.
    const input = readFileSync(CERTIFIED_PDF);
    const signed = readFileSync(saved!);
    expect(signed.length).toBeGreaterThan(input.length);
    expect(signed.subarray(0, input.length).equals(input)).toBe(true);
    expect((signed.toString('latin1').match(/\/ByteRange/g) ?? []).length).toBe(2);

    // The pinned validator: both signatures pass, and everything after the certification is
    // classed as form filling.
    const hasValidator = spawnSync(PYTHON, ['-c', 'import pyhanko'], { shell: false }).status === 0;
    if (!hasValidator) {
      expect(
        process.env.REQUIRE_PYHANKO,
        'pyHanko is required here but is not installed (scripts/requirements-verify.txt)',
      ).toBeFalsy();
      testInfo.annotations.push({
        type: 'validator-not-run',
        description: 'pyHanko is not installed, so the saved file was not validated in this run.',
      });
      return;
    }
    const result = spawnSync(
      PYTHON,
      [VALIDATOR, '--expect-certification-level', 'FORM_FILLING', saved!],
      { cwd: ROOT, shell: false, encoding: 'utf8' },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
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
test('desktop: the renderer is sandboxed and page script has no Node', async () => {
  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: { ...process.env, PDFSIGNER_HEADLESS: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const seen = await page.evaluate(() => ({
      sandboxed: (window as unknown as { desktopShell: { sandboxed: boolean } }).desktopShell
        .sandboxed,
      bridgeKeys: Object.keys((window as unknown as { desktopShell: object }).desktopShell).sort(),
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    }));
    expect(seen).toEqual({
      sandboxed: true,
      bridgeKeys: ['mode', 'persistenceEnabled', 'sandboxed'],
      require: 'undefined',
      process: 'undefined',
    });
  } finally {
    await app.close();
  }
});

test('desktop: layer-5 no-phone-home switches are set (not just crashReporter absent)', async () => {
  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: { ...process.env, PDFSIGNER_HEADLESS: '1' },
  });
  try {
    await app.firstWindow();
    // A build-time/runtime assertion: a live run that happens to make no request proves nothing about
    // whether these are set. Read them directly from the command line (network-policy.md § layer 5).
    const set = await app.evaluate(({ app: a }) =>
      [
        'disable-background-networking',
        'disable-component-update',
        'disable-domain-reliability',
        'disable-breakpad',
        'no-proxy-server',
      ].map((s) => a.commandLine.hasSwitch(s)),
    );
    expect(set).toEqual([true, true, true, true, true]);
  } finally {
    await app.close();
  }
});

test('desktop: a remote https request is cancelled by webRequest, not CSP (layer 2)', async () => {
  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: { ...process.env, PDFSIGNER_HEADLESS: '1' },
  });
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
