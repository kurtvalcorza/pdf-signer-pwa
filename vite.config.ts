import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// See specs/001-pdf-signer/research.md (R5, R9, R11) for the rationale behind
// node polyfills (Buffer for node-forge/@signpdf), the PWA precache strategy,
// and the strict CSP.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ include: ['buffer', 'process', 'stream', 'util'] }),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false, // served from public/manifest.webmanifest
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,wasm}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  server: { port: Number(process.env.PORT) || 5190 },
  worker: { format: 'es' },
  test: {
    // Signing + coordinate logic run in Node; component tests opt into jsdom per-file.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
