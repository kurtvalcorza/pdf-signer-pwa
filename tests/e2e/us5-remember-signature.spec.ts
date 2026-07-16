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

  // Checking the box only starts an async IndexedDB write; reloading immediately can
  // race it (this is what failed on CI). "Use saved signature" renders only after the
  // save resolves, so wait for that signal — not a sleep — before reloading.
  const useSaved = page.getByRole('button', { name: /Use saved signature/ });
  await expect(useSaved).toBeVisible();

  // Persisted across a full reload (fresh session, no in-memory state).
  await page.reload();
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });

  // The saved signature can be placed without re-uploading.
  await expect(useSaved).toBeVisible();
  await useSaved.click();
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  // Forget removes it; the control disappears.
  await page.getByRole('button', { name: /^Forget$/ }).click();
  await expect(useSaved).toBeHidden();

  expect(external, `unexpected external requests: ${external.join(', ')}`).toEqual([]);
});

test('cleaning the background of a remembered signature drops the stale saved copy', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(SAMPLE_PDF);
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(SIGNATURE_PNG);
  await expect(page.locator('img[alt="signature"]')).toBeVisible({ timeout: 10_000 });

  // Opt in to remember, then clean the background of that same signature.
  const remember = page.getByRole('checkbox', { name: /Remember this signature/ });
  await remember.check();
  await expect(page.getByRole('button', { name: /Use saved signature/ })).toBeVisible();

  await page.getByRole('button', { name: /Clean up background/ }).click();
  await page.locator('input[type="range"]').fill('180');
  await page.getByRole('button', { name: /Use cleaned/ }).click();

  // The saved copy referred to the pre-cleanup bytes, so it's dropped — re-opt-in required,
  // and no stale image lingers to be restored later.
  await expect(remember).not.toBeChecked();
  await expect(page.getByRole('button', { name: /Use saved signature/ })).toBeHidden();
});
