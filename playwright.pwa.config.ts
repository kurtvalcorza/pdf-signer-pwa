import { defineConfig, devices } from '@playwright/test';

// Offline/installability tests need the PRODUCTION build (service worker + precache),
// so this config serves `dist/` via `vite preview` rather than the dev server.
const PORT = 4183;

export default defineConfig({
  testDir: './tests/e2e-pwa',
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: 'android-chrome', use: { ...devices['Pixel 7'] } }],
  // Build before running this config (see the `e2e:pwa` npm script); preview serves dist/.
  webServer: {
    command: 'npm run preview',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
