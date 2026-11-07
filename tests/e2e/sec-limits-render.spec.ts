import { test, expect, type Page } from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, mkdtempSync, openSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = resolve(HERE, 'fixtures/sample.pdf');
const LARGE_PDF = resolve(HERE, 'fixtures/sample-large.pdf');
const pdfInput = (page: Page) => page.locator('input[type="file"][accept=".pdf"]');
const canvas = (page: Page) => page.locator('canvas');
const settled = (page: Page) => expect(canvas(page)).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });

function sparseFile(name: string, bytes: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'pdf-signer-limits-')), name);
  const fd = openSync(path, 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
  return path;
}

/** Fingerprint of what is actually on the canvas. */
const painted = (page: Page) =>
  canvas(page).evaluate((c: HTMLCanvasElement) => {
    const data = c.toDataURL();
    let hash = 0;
    for (let i = 0; i < data.length; i++) hash = (hash * 31 + data.charCodeAt(i)) | 0;
    return `${data.length}:${hash}`;
  });

test('SEC-09: rapid navigation ends on the requested page, fully painted', async ({ page }) => {
  await page.goto('/');
  await pdfInput(page).setInputFiles(LARGE_PDF);
  await settled(page);

  const next = page.getByRole('button', { name: /Next/ });
  await next.evaluate((b: HTMLButtonElement) => {
    for (let i = 0; i < 6; i++) b.click();
  });
  await settled(page);
  await expect(page.getByText('Page 7 / 60')).toBeVisible();
  await expect(canvas(page)).toHaveAttribute('aria-label', /^Page 7 of 60/);
  const afterRapid = await painted(page);

  // The same page reached one careful step at a time must look identical.
  await page.getByRole('button', { name: /Prev/ }).click();
  await settled(page);
  expect(await painted(page)).not.toBe(afterRapid);
  await next.click();
  await settled(page);
  expect(await painted(page)).toBe(afterRapid);
  await expect(page.getByText(/same canvas/)).toHaveCount(0);
});

test('SEC-09: placement and signing are unavailable until the page is painted', async ({ page }) => {
  await page.goto('/');
  await pdfInput(page).setInputFiles(LARGE_PDF);
  await settled(page);

  // Read synchronously after the click, before the worker can possibly have rendered the new page.
  const during = await page.evaluate(() => {
    const button = (name: string) =>
      [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(name))!;
    button('Next').click();
    return new Promise<{ add: boolean; busy: string | null }>((done) =>
      requestAnimationFrame(() =>
        done({
          add: button('Add signature').disabled,
          busy: document.querySelector('canvas')!.getAttribute('aria-busy'),
        }),
      ),
    );
  });
  expect(during).toEqual({ add: true, busy: 'true' });

  await settled(page);
  await expect(page.getByRole('button', { name: 'Add signature' })).toBeEnabled();
});

test('SEC-09: when a document is replaced mid-load, the newest one wins', async ({ page }) => {
  await page.goto('/');
  await pdfInput(page).setInputFiles(LARGE_PDF);
  await pdfInput(page).setInputFiles(SAMPLE_PDF);
  await settled(page);
  await expect(canvas(page)).toHaveAttribute('aria-label', /of sample\.pdf$/);
  await expect(page.getByText('Page 1 / 2')).toBeVisible();
});

test('SEC-08: an oversized PDF is refused before it is read', async ({ page }) => {
  await page.goto('/');
  await pdfInput(page).setInputFiles(sparseFile('huge.pdf', 100 * 1024 * 1024 + 1));
  await expect(page.getByText(/This PDF is too large\. The limit is 100 MB\./)).toBeVisible();
  await expect(canvas(page)).toHaveCount(0);
});

test('SEC-08: an oversized certificate is refused', async ({ page }) => {
  await page.goto('/');
  await pdfInput(page).setInputFiles(SAMPLE_PDF);
  await settled(page);
  await page
    .locator('input[type="file"][accept="image/png,image/jpeg"]')
    .setInputFiles(resolve(HERE, 'fixtures/signature.png'));
  await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
  await page
    .locator('input[type="file"][accept=".p12,.pfx"]')
    .setInputFiles(sparseFile('huge.p12', 1024 * 1024 + 1));
  await expect(page.getByRole('alert')).toContainText(/too large/);
  await expect(page.getByRole('button', { name: /Choose certificate/ })).toBeVisible();
});
