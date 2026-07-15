import { test, expect } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = resolve(HERE, 'fixtures/sample.pdf');
const SIGNATURE_PNG = resolve(HERE, 'fixtures/signature.png');
const CERT_P12 = resolve(HERE, 'fixtures/e2e-cert.p12');
const CERT_PASSWORD = 'e2e-pass';

test('US1: open a PDF, place a signature, sign & download — on-device, no external network', async ({
  page,
}) => {
  // SC-003: capture any request that leaves the local origin.
  const external: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    // blob:/data: are same-origin, in-memory URLs (the signature preview + the
    // download blob) — not network egress.
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    const host = new URL(url).hostname;
    if (host && host !== 'localhost' && host !== '127.0.0.1') external.push(url);
  });

  await page.goto('/');
  await expect(page).toHaveTitle(/PDF Signer/);

  // Open the sample PDF via the hidden file input.
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);

  // The page renders to a canvas.
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });

  // SC-006: the document dominates the viewport (majority of width on mobile).
  const box = await canvas.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.width / viewport!.width).toBeGreaterThan(0.5);

  // Add a signature image; an overlay appears over the page.
  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  // Sign with the certificate → a signed PDF is produced client-side.
  await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(CERT_P12);
  await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Sign & Download/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-signed\.pdf$/);

  const outPath = await download.path();
  const out = readFileSync(outPath!);
  // Valid, cryptographically signed PDF, larger than the source.
  expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(out.toString('latin1')).toContain('/ByteRange');
  expect(out.length).toBeGreaterThan(statSync(SAMPLE_PDF).size);

  // SC-003: nothing left the device.
  expect(external, `unexpected external requests: ${external.join(', ')}`).toEqual([]);
});
