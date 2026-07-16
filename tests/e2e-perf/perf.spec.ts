import { test, expect, type Page } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T050 — performance benchmark against the plan's Performance Goals:
 *   - 60 fps drag/pinch placement on a mid-range Android
 *   - large-PDF responsiveness
 *   - signing a typical document in ~2 s (goal)
 *   - SC-001: open → place → export in under 60 s
 *
 * Method: production build, Pixel 7 device profile, CPU throttled 4x via CDP to
 * approximate a mid-range phone from a fast dev machine. Assertions are loose
 * guard-rails (catch a real stall, not run-to-run jitter); the numbers themselves
 * are printed and recorded in docs/perf.md.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, '../e2e/fixtures');
const LARGE_PDF = resolve(FIX, 'sample-large.pdf'); // 60 pages
const SIGNATURE_PNG = resolve(FIX, 'signature.png');
const CERT_P12 = resolve(FIX, 'e2e-cert.p12');
const CERT_PASSWORD = 'e2e-pass';

const CPU_THROTTLE = 4;
const results: Record<string, string> = {};

async function throttleCpu(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
}

async function openLargePdf(page: Page): Promise<number> {
  const t0 = Date.now();
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(LARGE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      return !!c && c.getBoundingClientRect().width > 0;
    },
    null,
    { timeout: 90_000 },
  );
  return Date.now() - t0;
}

test.afterAll(() => {
  console.log(
    `\n=== T050 performance (production build · Pixel 7 · ${CPU_THROTTLE}x CPU throttle) ===`,
  );
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(46)} ${v}`);
  console.log('');
});

test('large PDF (60 pages): open + first render', async ({ page }) => {
  await throttleCpu(page);
  await page.goto('/');
  const ms = await openLargePdf(page);
  results['large PDF (60pp) open + first render'] = `${ms} ms`;
  expect(ms).toBeLessThan(30_000);
});

test('placement drag stays smooth on a large PDF', async ({ page }) => {
  await throttleCpu(page);
  await page.goto('/');
  await openLargePdf(page);

  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  const sig = page.locator('img[alt="signature"]');
  await expect(sig).toBeVisible({ timeout: 15_000 });

  // Count animation frames while dragging: if the main thread stalls under the
  // pointermove → React re-render load, the rAF rate collapses.
  await page.evaluate(() => {
    (window as unknown as { __f: number }).__f = 0;
    const tick = () => {
      (window as unknown as { __f: number }).__f++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const box = (await sig.boundingBox())!;
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();

  const f0 = await page.evaluate(() => (window as unknown as { __f: number }).__f);
  const t0 = Date.now();
  for (let i = 1; i <= 60; i++) {
    await page.mouse.move(sx + i * 1.5, sy + Math.sin(i / 6) * 12);
  }
  const elapsed = Date.now() - t0;
  const f1 = await page.evaluate(() => (window as unknown as { __f: number }).__f);
  await page.mouse.up();

  const fps = (f1 - f0) / (elapsed / 1000);
  results[`drag fps (${CPU_THROTTLE}x throttled)`] = `${fps.toFixed(1)} fps over ${elapsed} ms`;
  // Loose guard-rail: a healthy drag is well above this; a real stall is far below.
  expect(fps).toBeGreaterThan(20);
});

test('sign + download a large PDF (SC-001 full flow)', async ({ page }) => {
  await throttleCpu(page);
  await page.goto('/');

  const tFlow = Date.now();
  await openLargePdf(page);
  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(CERT_P12);
  await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);

  const tSign = Date.now();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Sign & Download/ }).click(),
  ]);
  const signMs = Date.now() - tSign;
  const flowMs = Date.now() - tFlow;

  expect(download.suggestedFilename()).toMatch(/-signed\.pdf$/);
  results['sign + download (60pp, throttled)'] = `${signMs} ms`;
  results['full flow open→place→sign→download'] = `${flowMs} ms (SC-001 budget 60 s)`;

  expect(signMs).toBeLessThan(30_000);
  expect(flowMs).toBeLessThan(60_000); // SC-001
});
