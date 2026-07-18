import { defineConfig } from '@playwright/test';

/**
 * Desktop (Electron) E2E — drives the PACKAGED-shape shell (electron/main.js against the real
 * dist/) through Playwright's Electron support. No webServer: each test launches Electron itself
 * via `_electron.launch`. Evidence is per-distribution and NOT inherited from the web run
 * (Principle V) — this suite re-earns the gate against the desktop artifact.
 *
 * Prereqs: `npm run build` (produces dist/) before running.
 */
export default defineConfig({
  testDir: './tests/e2e-desktop',
  globalSetup: './tests/e2e/global-setup.ts', // regenerates fixtures (incl. the gitignored .p12)
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
});
