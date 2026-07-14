import { test, expect } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = resolve(HERE, 'fixtures/sample.pdf');
const SIGNATURE_PNG = resolve(HERE, 'fixtures/signature.png');

test('US: opt-in remember signature persists across a reload and can be reused, then forgotten', async ({
  page,
}) => {
  // SC-003: nothing may leave the device even with persistence on.
  const external: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    const host = new URL(url).hostname;
    if (host && host !== 'localhost' && host !== '127.0.0.1') external.push(url);
  });

  await page.goto('/');
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });

  // Add a signature; the remember checkbox appears only once one is selected.
  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  const remember = page.getByRole('checkbox', { name: /Remember this signature/ });
  await expect(remember).toBeVisible();
  await remember.check();

  // Persisted across a full reload (fresh session, no in-memory state).
  await page.reload();
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });

  // The saved signature can be placed without re-uploading.
  const useSaved = page.getByRole('button', { name: /Use saved signature/ });
  await expect(useSaved).toBeVisible();
  await useSaved.click();
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  // Forget removes it; the control disappears.
  await page.getByRole('button', { name: /^Forget$/ }).click();
  await expect(useSaved).toBeHidden();

  expect(external, `unexpected external requests: ${external.join(', ')}`).toEqual([]);
});
