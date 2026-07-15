import { test, expect } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = resolve(HERE, 'fixtures/sample.pdf');
const SIGNATURE_PNG = resolve(HERE, 'fixtures/signature.png');

test('US4: clean a signature background in-browser, then it stays placed', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });

  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  // The just-added signature is selected, so cleanup is available.
  await page.getByRole('button', { name: /Clean up background/ }).click();
  await expect(page.getByText(/Clean up signature/)).toBeVisible();
  await expect(page.locator('input[type="range"]')).toBeVisible();

  // Adjust threshold and apply.
  await page.locator('input[type="range"]').fill('180');
  await page.getByRole('button', { name: /Use cleaned/ }).click();

  // Back on the main controls, the signature is still placed.
  await expect(page.getByRole('button', { name: /Stamp image & Download/ })).toBeVisible();
  await expect(page.locator('img[alt="signature"]')).toBeVisible();
});
