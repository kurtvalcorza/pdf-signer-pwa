import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MAIN = resolve(ROOT, 'electron/main.js');

/**
 * US3 — the packaged app's own disclosures render in the RUNNING app (not a doc scan). The about /
 * no-self-update surface is UNCONDITIONAL; the staleness notice appears only under a stale-metadata
 * fixture (T026a). These surfaces are desktop-only (injected by the preload, never in the web bundle).
 */

async function launch(buildInfoPath?: string) {
  return electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: {
      ...process.env,
      PDFSIGNER_HEADLESS: '1',
      ...(buildInfoPath ? { PDFSIGNER_BUILD_INFO: buildInfoPath } : {}),
    },
  });
}

test('US3: the about / no-self-update surface renders unconditionally', async () => {
  // Fresh engine (age 0) — the staleness notice must NOT show, but the about surface must.
  const dir = mkdtempSync(join(tmpdir(), 'us3-fresh-'));
  const fresh = join(dir, 'build-info.json');
  writeFileSync(
    fresh,
    JSON.stringify({
      version: '9.9.9',
      buildDate: new Date().toISOString(),
      engineVersion: '43.1.1',
      engineDate: new Date().toISOString(), // 0 days old
      commit: 'abc123def456',
      selfUpdates: false,
    }),
  );
  const app = await launch(fresh);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#desktop-about-button')).toBeVisible({ timeout: 10_000 });
    // Fresh build: no staleness notice.
    await expect(page.locator('#desktop-staleness-notice')).toHaveCount(0);

    await page.locator('#desktop-about-button').click();
    const panel = page.locator('#desktop-about-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('does not update itself');
    await expect(panel).toContainText('9.9.9'); // version from the fixture
    await expect(page.locator('#desktop-data-location')).toBeVisible(); // FR-013 data location
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-011b: read-only media disables opt-in persistence and tells the user', async () => {
  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: { ...process.env, PDFSIGNER_HEADLESS: '1', PDFSIGNER_FORCE_EPHEMERAL: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    // The shell reports persistence unavailable…
    const enabled = await page.evaluate(
      () => (window as unknown as { desktopShell?: { persistenceEnabled?: boolean } }).desktopShell?.persistenceEnabled,
    );
    expect(enabled).toBe(false);
    // …the user is told (FR-011b visibility)…
    await expect(page.locator('#desktop-readonly-notice')).toBeVisible({ timeout: 10_000 });
    // …and the signature "remember" affordance is not offered.
    await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(resolve(ROOT, 'tests/e2e/fixtures/sample.pdf'));
    await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page
      .locator('input[type="file"][accept="image/png,image/jpeg"]')
      .setInputFiles(resolve(ROOT, 'tests/e2e/fixtures/signature.png'));
    await page.locator('img[alt="signature"]').waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.getByText(/Remember this signature/)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('US3: the staleness notice appears under a stale-metadata fixture', async () => {
  // Engine older than the 180-day threshold — the passive notice must appear.
  const dir = mkdtempSync(join(tmpdir(), 'us3-stale-'));
  const stale = join(dir, 'build-info.json');
  const oneYearAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
  writeFileSync(
    stale,
    JSON.stringify({
      version: '0.1.0',
      buildDate: new Date().toISOString(), // FRESH build date — must NOT silence the notice
      engineVersion: '43.1.1',
      engineDate: oneYearAgo,
      commit: 'abc123def456',
      selfUpdates: false,
    }),
  );
  const app = await launch(stale);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const notice = page.locator('#desktop-staleness-notice');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText(/no longer\s+receives security updates/);
    // A fresh buildDate must not have silenced it — proves isStale derives from engineDate.
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
