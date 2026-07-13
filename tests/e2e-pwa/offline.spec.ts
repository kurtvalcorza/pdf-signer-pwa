import { test, expect } from '@playwright/test';

test('US3: installable manifest + icons, and works fully offline after first load', async ({
  page,
  context,
}) => {
  await page.goto('/');

  // Manifest is linked and valid for installation.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const mResp = await page.request.get('/manifest.webmanifest');
  expect(mResp.ok()).toBeTruthy();
  const manifest = await mResp.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

  // Every icon resolves as a PNG.
  for (const ic of manifest.icons as Array<{ src: string }>) {
    const r = await page.request.get(ic.src);
    expect(r.ok(), ic.src).toBeTruthy();
    expect(r.headers()['content-type']).toContain('png');
  }

  // Wait for the service worker to control the page (precache installed).
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 30_000,
  });

  // Go offline and reload — the app shell must still load and work.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: /Open PDF/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/No document open/)).toBeVisible();
});
