import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = resolve(HERE, 'fixtures/sample.pdf');
const SIGNATURE_PNG = resolve(HERE, 'fixtures/signature.png');
const CERT_P12 = resolve(HERE, 'fixtures/e2e-cert.p12');
const CERT_PASSWORD = 'e2e-pass';

test('US2: sign a placed signature with a .p12 and download a signed PDF', async ({ page }) => {
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

  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  // Enter the certificate flow.
  await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(CERT_P12);
  await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);

  // Sign & download.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Sign & Download/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-signed\.pdf$/);

  const out = readFileSync((await download.path())!);
  const text = out.toString('latin1');
  expect(text.slice(0, 5)).toBe('%PDF-');
  // The output is a real digital signature.
  expect(text).toContain('/ByteRange');
  expect(text).toContain('Adobe.PPKLite');

  expect(external, `unexpected external requests: ${external.join(', ')}`).toEqual([]);
});

test('US2: a wrong certificate password shows an error and produces no download', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(CERT_P12);
  await page.getByPlaceholder('Certificate password').fill('definitely-wrong');
  await page.getByRole('button', { name: /Sign & Download/ }).click();

  await expect(page.getByText(/Incorrect certificate password/)).toBeVisible({ timeout: 10_000 });
});
