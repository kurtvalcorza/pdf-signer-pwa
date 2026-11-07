import { test, expect, type Page } from '@playwright/test';
import { basename, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeSelfSignedP12 } from '../signing/fixtures/makeCert';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = resolve(HERE, 'fixtures/sample.pdf');
const SIGNATURE_PNG = resolve(HERE, 'fixtures/signature.png');
const PASSWORD = 'e2e-pass';

const TMP = mkdtempSync(join(tmpdir(), 'pdf-signer-e2e-'));
const CERT_A = join(TMP, 'cert-a.p12');
const CERT_B = join(TMP, 'cert-b.p12');
writeFileSync(CERT_A, makeSelfSignedP12(PASSWORD, 'Signer A'));
writeFileSync(CERT_B, makeSelfSignedP12(PASSWORD, 'Signer B'));

async function openCertSheet(page: Page) {
  await page.goto('/');
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
}

const rememberBox = (page: Page) => page.getByRole('checkbox', { name: /Remember this certificate/ });

async function pickAndSign(page: Page, file: string | null, remember: boolean) {
  if (file) {
    await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(file);
    // Picking is async and withdraws consent when it lands, so wait for it before ticking the box.
    await expect(page.getByRole('button', { name: basename(file) })).toBeVisible();
  }
  if (remember) await rememberBox(page).check();
  await page.getByPlaceholder('Certificate password').fill(PASSWORD);
  await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Sign & Download/ }).click(),
  ]);
}

/** The label actually stored in IndexedDB, read independently of the app's UI. */
function storedLabel(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((done, fail) => {
        const open = indexedDB.open('keyval-store');
        open.onerror = () => fail(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db
            .transaction('keyval')
            .objectStore('keyval')
            .get('pdf-signer:remembered-certificate');
          get.onerror = () => fail(get.error);
          get.onsuccess = () => {
            db.close();
            done((get.result as { label: string } | undefined)?.label ?? null);
          };
        };
      }),
  );
}

test('SEC-05: a certificate chosen after a remembered one needs its own opt-in', async ({ page }) => {
  await openCertSheet(page);
  await pickAndSign(page, CERT_A, true);
  await expect.poll(() => storedLabel(page)).toBe('cert-a.p12');

  await openCertSheet(page);
  await expect(page.getByRole('button', { name: /cert-a\.p12/ })).toBeVisible();
  await expect(rememberBox(page)).toBeChecked();

  // Choosing B withdraws the consent given for A.
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(CERT_B);
  await expect(page.getByRole('button', { name: /cert-b\.p12/ })).toBeVisible();
  await expect(rememberBox(page)).not.toBeChecked();

  await pickAndSign(page, null, false);
  expect(await storedLabel(page)).toBe('cert-a.p12');

  // An explicit opt-in for B replaces it.
  await openCertSheet(page);
  await pickAndSign(page, CERT_B, true);
  await expect.poll(() => storedLabel(page)).toBe('cert-b.p12');
});

test('SEC-04: a failed removal is shown and never reported as forgotten', async ({ page }) => {
  await openCertSheet(page);
  await pickAndSign(page, CERT_A, true);
  await expect.poll(() => storedLabel(page)).toBe('cert-a.p12');

  await openCertSheet(page);
  await expect(page.getByRole('button', { name: /cert-a\.p12/ })).toBeVisible();
  await page.evaluate(() => {
    IDBObjectStore.prototype.delete = () => {
      throw new DOMException('denied', 'InvalidStateError');
    };
  });

  await page.getByRole('button', { name: 'Forget' }).click();
  await expect(page.getByRole('alert')).toContainText(/could not be removed/);
  await expect(page.getByRole('button', { name: /cert-a\.p12/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forget' })).toBeVisible();
  expect(await storedLabel(page)).toBe('cert-a.p12');
});

test('unticking remember on the stored certificate removes it after signing', async ({ page }) => {
  await openCertSheet(page);
  await pickAndSign(page, CERT_A, true);
  await expect.poll(() => storedLabel(page)).toBe('cert-a.p12');

  await openCertSheet(page);
  await expect(rememberBox(page)).toBeChecked();
  await rememberBox(page).uncheck();
  await expect(page.getByText('Signing will remove it from this device.')).toBeVisible();
  await pickAndSign(page, null, false);
  await expect.poll(() => storedLabel(page)).toBeNull();

  await openCertSheet(page);
  await expect(page.getByRole('button', { name: /Choose certificate/ })).toBeVisible();
});

test('opening and closing the create panel leaves the stored certificate alone', async ({ page }) => {
  await openCertSheet(page);
  await pickAndSign(page, CERT_A, true);
  await expect.poll(() => storedLabel(page)).toBe('cert-a.p12');

  await openCertSheet(page);
  await expect(rememberBox(page)).toBeChecked();
  await page.getByRole('button', { name: /Create one/ }).click();
  await page.getByRole('button', { name: /Use an existing certificate/ }).click();
  await expect(rememberBox(page)).toBeChecked();

  await pickAndSign(page, null, false);
  expect(await storedLabel(page)).toBe('cert-a.p12');
});

test('a certificate created while another is stored needs its own opt-in', async ({ page }) => {
  await openCertSheet(page);
  await pickAndSign(page, CERT_A, true);
  await expect.poll(() => storedLabel(page)).toBe('cert-a.p12');

  await openCertSheet(page);
  await page.getByRole('button', { name: /Create one/ }).click();
  await page.getByPlaceholder(/full name/i).fill('New Signer');
  await page.getByPlaceholder('Certificate password').fill('a-long-enough-password');
  await page.getByRole('button', { name: 'Create certificate' }).click();
  await expect(page.getByText(/Certificate created/)).toBeVisible();
  await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Sign & Download/ }).click(),
  ]);
  expect(await storedLabel(page)).toBe('cert-a.p12');
});

test('the stored certificate stays forgettable after choosing another', async ({ page }) => {
  await openCertSheet(page);
  await pickAndSign(page, CERT_A, true);
  await expect.poll(() => storedLabel(page)).toBe('cert-a.p12');

  await openCertSheet(page);
  await expect(page.getByRole('button', { name: /cert-a\.p12/ })).toBeVisible();
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(CERT_B);
  await expect(page.getByRole('button', { name: /cert-b\.p12/ })).toBeVisible();

  await page.getByRole('button', { name: 'Forget saved certificate' }).click();
  await expect.poll(() => storedLabel(page)).toBeNull();
  await expect(page.getByRole('button', { name: /cert-b\.p12/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Forget/ })).toHaveCount(0);
});

test('SEC-04: a working Forget really removes the record', async ({ page }) => {
  await openCertSheet(page);
  await pickAndSign(page, CERT_A, true);
  await expect.poll(() => storedLabel(page)).toBe('cert-a.p12');

  await openCertSheet(page);
  await page.getByRole('button', { name: 'Forget' }).click();
  await expect(page.getByRole('button', { name: /Choose certificate/ })).toBeVisible();
  expect(await storedLabel(page)).toBeNull();
});
