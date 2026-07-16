import { defineConfig, devices } from '@playwright/test';

// Performance benchmark (T050). Runs against the PRODUCTION build — dev-server
// timings are not representative. Kept out of the default `e2e` run and out of CI:
// timings on shared runners are noisy, so this is an on-demand measurement
// (`npm run perf`) with deliberately loose guard-rails, not a tight gate.
const PORT = 4183;

export default defineConfig({
  testDir: './tests/e2e-perf',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 180_000,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: 'android-chrome', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'npm run preview',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
