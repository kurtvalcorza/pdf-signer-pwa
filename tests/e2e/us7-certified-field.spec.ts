import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec 004, User Story 1: a certified PDF is signed in the field its author prepared.
 *
 * The fixture is pyHanko's (scripts/make_policy_fixtures.py): certified at DocMDP P=2 with one
 * empty signature field, "Approver". The download is then checked by the pinned validator, which
 * must class the change as form filling. That check needs the gate's Python toolchain
 * (scripts/requirements-verify.txt); CI wiring is task T038, which sets REQUIRE_PYHANKO=1 so a
 * missing validator fails instead of being skipped.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CERTIFIED_PDF = resolve(HERE, '../signing/fixtures/policy/certified-p2-empty-field.pdf');
const SIGNATURE_PNG = resolve(HERE, 'fixtures/signature.png');
const CERT_P12 = resolve(HERE, 'fixtures/e2e-cert.p12');
const CERT_PASSWORD = 'e2e-pass';
const VALIDATOR = resolve(HERE, '../../scripts/validate_pdf.py');
const PYTHON = process.env.PYTHON || 'python';

test('a certified PDF is signed in the field its author prepared, and nowhere else', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(CERTIFIED_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });

  // The app says what kind of document this is and offers the prepared field, not picked.
  await expect(
    page.getByText(
      'This PDF is certified. It can only be signed in one of the signature fields its author prepared.',
    ),
  ).toBeVisible();
  const outline = page.getByTestId('field-outline');
  await expect(outline).toHaveCount(1);
  await expect(outline).toHaveAttribute('aria-pressed', 'false');
  const option = page.getByTestId('field-option');
  await expect(option).toHaveText('Field name set by the document: "Approver" (page 1)');
  await expect(option).toHaveAttribute('aria-pressed', 'false');

  // Adding a signature image does not place it anywhere: there is no free placement, nothing
  // is pre-selected, and signing is not available until the user picks the field.
  await page
    .locator('input[type="file"][accept="image/png,image/jpeg"]')
    .setInputFiles(SIGNATURE_PNG);
  await expect(page.getByRole('button', { name: /Clean up background/ })).toBeEnabled({
    timeout: 10_000,
  });
  await expect(page.locator('img[alt="signature"]')).toHaveCount(0);
  const openCertSheet = page.getByRole('button', { name: /Sign with a digital certificate/ });
  await expect(openCertSheet).toBeDisabled();
  await expect(outline).toHaveAttribute('aria-pressed', 'false');

  // Pick the field on the page; the stamp preview sits inside its box.
  await outline.click();
  await expect(outline).toHaveAttribute('aria-pressed', 'true');
  await expect(option).toHaveAttribute('aria-pressed', 'true');
  const stamp = page.locator('img[alt="signature"]');
  await expect(stamp).toBeVisible();
  const fieldBox = (await outline.boundingBox())!;
  const stampBox = (await stamp.boundingBox())!;
  expect(stampBox.x).toBeGreaterThanOrEqual(fieldBox.x - 0.5);
  expect(stampBox.y).toBeGreaterThanOrEqual(fieldBox.y - 0.5);
  expect(stampBox.x + stampBox.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width + 0.5);
  expect(stampBox.y + stampBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height + 0.5);

  // Sign with the certificate and download.
  await expect(openCertSheet).toBeEnabled();
  await openCertSheet.click();
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(CERT_P12);
  await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Sign & Download/ }).click(),
  ]);
  const signedPath = testInfo.outputPath('certified-field-signed.pdf');
  await download.saveAs(signedPath);

  // The app states what it did, and makes no claim about the certification.
  await expect(
    page.getByText(
      "Signed in the existing field 'Approver'. No other part of the document was changed.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/still certified|certification preserved|remains valid/i),
  ).toHaveCount(0);

  // The input is a byte prefix of the download, which now carries two signatures.
  const input = readFileSync(CERTIFIED_PDF);
  const signed = readFileSync(signedPath);
  expect(signed.length).toBeGreaterThan(input.length);
  expect(signed.subarray(0, input.length).equals(input)).toBe(true);
  expect((signed.toString('latin1').match(/\/ByteRange/g) ?? []).length).toBe(2);

  // The pinned validator: both signatures pass integrity and policy, and everything after the
  // certification is classed as form filling.
  const hasValidator = spawnSync(PYTHON, ['-c', 'import pyhanko'], { shell: false }).status === 0;
  if (!hasValidator) {
    expect(
      process.env.REQUIRE_PYHANKO,
      'pyHanko is required here but is not installed (scripts/requirements-verify.txt)',
    ).toBeFalsy();
    testInfo.annotations.push({
      type: 'validator-not-run',
      description: 'pyHanko is not installed, so the download was not validated in this run.',
    });
    return;
  }
  const result = spawnSync(
    PYTHON,
    [VALIDATOR, '--expect-certification-level', 'FORM_FILLING', signedPath],
    { shell: false, encoding: 'utf8' },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
