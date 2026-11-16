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

/**
 * Spec 004, User Story 2 (T033): a certified PDF that cannot be signed here says why, in the
 * exact words of contracts/signing-classification.md, and offers no way to sign it. Choosing a
 * signature image anyway (straight into the file input, past the disabled button) places nothing
 * and enables nothing.
 */
const POLICY = resolve(HERE, '../signing/fixtures/policy');
const REFUSED: Array<{ fixture: string; message: string; ineligible?: string }> = [
  {
    // R1 (the existing message).
    fixture: 'certified-p1.pdf',
    message:
      'This PDF is certified with a “no changes allowed” policy. Adding any signature ' +
      'would break that certification, so it cannot be signed here.',
  },
  {
    // R2, with the "ask the sender" sentence (FR-018).
    fixture: 'certified-p2.pdf',
    message:
      'This PDF is certified and has no empty signature field to sign. Ask the sender for a ' +
      'version that includes a signature field for you.',
  },
  {
    // R3 (R12): the one field is listed, greyed, with its reason.
    fixture: 'certified-p2-empty-field-kid-widget.pdf',
    message:
      'This PDF is certified, and none of its empty signature fields can be signed here. The ' +
      'reasons are listed below.',
    ineligible:
      // No page: the field itself is not the object a page lists.
      'Field name set by the document: "Approver". This field’s box is stored as a ' +
      'separate object, which this app cannot sign safely.',
  },
  {
    // R18.
    fixture: 'certified-p2-later-annotation.pdf',
    message:
      'This PDF was changed after it was certified in a way this app cannot check, so it ' +
      'cannot be signed here.',
  },
];

for (const { fixture, message, ineligible } of REFUSED) {
  test(`${fixture} says why it cannot be signed and offers no way to sign it`, async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(resolve(POLICY, fixture));
    await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
    // The sign controls are also disabled while the page renders; wait for it to settle so the
    // disabled checks below prove the refusal, not the render.
    await expect(page.locator('canvas')).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });

    const refusal = page.getByTestId('signing-refusal');
    await expect(refusal).toHaveText(message);
    await expect(page.getByTestId('field-outline')).toHaveCount(0);
    await expect(page.getByTestId('field-option')).toHaveCount(0);
    if (ineligible) {
      await expect(page.getByTestId('field-ineligible')).toHaveText([ineligible]);
    } else {
      await expect(page.getByTestId('field-ineligible')).toHaveCount(0);
    }

    const addSignature = page.getByRole('button', { name: 'Add signature', exact: true });
    const openCertSheet = page.getByRole('button', { name: /Sign with a digital certificate/ });
    await expect(addSignature).toBeDisabled();
    await expect(openCertSheet).toBeDisabled();

    await page
      .locator('input[type="file"][accept="image/png,image/jpeg"]')
      .setInputFiles(SIGNATURE_PNG);
    await expect(page.getByRole('button', { name: /Clean up background/ })).toBeEnabled({
      timeout: 10_000,
    });
    await expect(page.locator('img[alt="signature"]')).toHaveCount(0);
    await expect(openCertSheet).toBeDisabled();
    // The refusal is not a passing error: it is still there after the image was chosen.
    await expect(refusal).toHaveText(message);
    await expect(page.getByText(/\bvalid\b|still certified|certification preserved/i)).toHaveCount(
      0,
    );
  });
}

test('an uncertified, approval-signed PDF still offers free placement (D7)', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('input[type="file"][accept=".pdf"]')
    .setInputFiles(resolve(POLICY, 'approval.pdf'));
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('signing-refusal')).toHaveCount(0);
  await expect(page.getByTestId('field-list')).toHaveCount(0);

  await page
    .locator('input[type="file"][accept="image/png,image/jpeg"]')
    .setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /Sign with a digital certificate/ })).toBeEnabled();
});

/**
 * Spec 004 T030 (threat T9, research.md R7): the fixture's signature field carries JavaScript
 * actions (tests/unit/renderPage.test.ts shows pdf.js reports them). Opening and showing it runs
 * none: no dialog, and pdf.js's scripting sandbox is never fetched.
 */
test("a field's JavaScript actions do not run when the page is shown", async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const sandbox: string[] = [];
  page.on('request', (request) => {
    if (/sandbox/i.test(request.url())) sandbox.push(request.url());
  });

  await page.goto('/');
  await page
    .locator('input[type="file"][accept=".pdf"]')
    .setInputFiles(resolve(POLICY, 'certified-p2-empty-field-aa-javascript.pdf'));
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
  const outline = page.getByTestId('field-outline');
  await expect(outline).toHaveCount(1);
  // Enter the field's box, which is what its /E action is bound to in a scripting viewer.
  await outline.hover();
  await outline.click();
  await expect(outline).toHaveAttribute('aria-pressed', 'true');

  expect(dialogs).toEqual([]);
  expect(sandbox).toEqual([]);
});
