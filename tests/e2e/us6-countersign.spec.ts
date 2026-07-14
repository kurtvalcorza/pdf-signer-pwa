import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = resolve(HERE, 'fixtures/sample.pdf');
const SIGNATURE_PNG = resolve(HERE, 'fixtures/signature.png');
const CERT_P12 = resolve(HERE, 'fixtures/e2e-cert.p12');
const CERT_PASSWORD = 'e2e-pass';

async function signWithCert(page: import('@playwright/test').Page) {
  // Clear first so re-selecting the same file path still fires a change event.
  const imgInput = page.locator('input[type="file"][accept="image/png,image/jpeg"]');
  await imgInput.setInputFiles([]);
  await imgInput.setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(CERT_P12);
  await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Sign & Download/ }).click(),
  ]);
  return download;
}

test('counter-signing an already-signed PDF preserves the earlier signature (no invalidation)', async ({
  page,
}, testInfo) => {
  await page.goto('/');

  // First person signs the document.
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
  const firstDownload = await signWithCert(page);
  const signed1Path = testInfo.outputPath('signed-1.pdf');
  await firstDownload.saveAs(signed1Path);
  const signed1 = readFileSync(signed1Path);
  expect(signed1.toString('latin1')).toContain('/ByteRange');

  // Re-open that signed PDF: the app must detect it and warn honestly about invalidation,
  // pointing to the certificate path as the non-invalidating option.
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(signed1Path);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/already signed/)).toBeVisible();
  await expect(page.getByText(/without altering the signed pages/)).toBeVisible();

  // Second person counter-signs via the certificate path (routes to the incremental signer).
  const secondDownload = await signWithCert(page);
  const signed2Path = testInfo.outputPath('signed-2.pdf');
  await secondDownload.saveAs(signed2Path);
  const signed2 = readFileSync(signed2Path);

  // The decisive check: the first signature's bytes are preserved verbatim (pure append),
  // so its cryptographic seal remains intact. Both signatures are present.
  expect(signed2.length).toBeGreaterThan(signed1.length);
  expect(signed2.subarray(0, signed1.length).equals(signed1)).toBe(true);
  const byteRanges = (signed2.toString('latin1').match(/\/ByteRange/g) ?? []).length;
  expect(byteRanges).toBeGreaterThanOrEqual(2);
});
