import { test, expect } from '@playwright/test';

/**
 * T041 (spec 004, research.md F3): open a cap-size certified PDF in the production web build and
 * time until the certified notice (the classification) is shown.
 *
 * Opt-in: skipped unless T041_DIR names a directory holding cap-one-stream.pdf and
 * cap-many-pages.pdf from tests/e2e-perf/t041/make_cap_pdf.py. Run with
 *   npm run build && T041_DIR=<dir> npx playwright test --config playwright.perf.config.ts t041-cap
 */
const BENCH = process.env.T041_DIR;
const NOTICE =
  'This PDF is certified. It can only be signed in one of the signature fields its author prepared.';
const results: string[] = [];

test.describe('T041 classification at the cap', () => {
  test.skip(!BENCH, 'set T041_DIR to run the T041 measurement');

  for (const shape of ['cap-one-stream', 'cap-many-pages']) {
    for (const throttle of [1, 4]) {
      test(`${shape} x${throttle}`, async ({ page }) => {
        test.setTimeout(900_000);
        const times: number[] = [];
        const runs = throttle === 1 ? 3 : 1;
        for (let i = 0; i < runs; i++) {
          await page.goto('/');
          if (throttle > 1) {
            const client = await page.context().newCDPSession(page);
            await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
          }
          const t0 = Date.now();
          await page
            .locator('input[type="file"][accept=".pdf"]')
            .setInputFiles(`${BENCH}/${shape}.pdf`);
          await expect(page.getByText(NOTICE)).toBeVisible({ timeout: 800_000 });
          times.push(Date.now() - t0);
        }
        results.push(`${shape} cpu-x${throttle} ms=${JSON.stringify(times)}`);
      });
    }
  }

  test.afterAll(() => {
    if (results.length) console.log('\nT041 ' + results.join('\nT041 '));
  });
});
