import { test, expect } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = resolve(HERE, 'fixtures/sample.pdf');
const SIGNATURE_PNG = resolve(HERE, 'fixtures/signature.png');

test('US2: create a certificate in-app, then sign with it', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /Sign with a certificate/ }).click();

  // Create a certificate in-app.
  await page.getByRole('button', { name: /Create one/ }).click();
  await page.getByPlaceholder(/full name/i).fill('Kurt Valcorza');
  await page.getByPlaceholder('Certificate password').fill('my-pass');
  await page.getByRole('button', { name: /^Create certificate$/ }).click();
  await expect(page.getByText(/Certificate created/)).toBeVisible({ timeout: 15_000 });

  // The .p12 can be downloaded.
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Save \.p12/ }).click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.p12$/);

  // And we can sign the document with the freshly created cert.
  const [signed] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Sign & Download/ }).click(),
  ]);
  expect(signed.suggestedFilename()).toMatch(/-signed\.pdf$/);
});
