import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

// `vite preview` ignores vercel.json, so the other offline test cannot see its effect. This serves the
// production build with those header rules applied, because a CSP header on sw.js or a worker governs
// that script: it stops precaching and worker WASM, which a meta tag never does.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = resolve(ROOT, 'dist');
const { headers: RULES } = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const WASM_WORKER =
  "WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]))" +
  ".then(() => postMessage('ok'), (e) => postMessage('blocked: ' + e.message));";

const headersFor = (path: string) =>
  Object.fromEntries(
    RULES.filter((r) => new RegExp(`^${r.source}$`).test(path)).flatMap((r) =>
      r.headers.map((h) => [h.key, h.value]),
    ),
  );

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    // Served from under assets/, as the bundled pdf.js worker is.
    if (path === '/assets/wasm-probe.js') {
      res.writeHead(200, { ...headersFor(path), 'Content-Type': 'text/javascript' });
      res.end(WASM_WORKER);
      return;
    }
    const file = resolve(DIST, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      ...headersFor(path),
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => server.close());

test('deployment headers: documents are protected without stopping offline or worker WASM', async ({
  page,
  context,
  request,
}) => {
  const document = await request.get(`${origin}/`);
  expect(document.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  const worker = await request.get(`${origin}/sw.js`);
  expect(worker.headers()['content-security-policy']).toBeUndefined();
  expect(worker.headers()['x-content-type-options']).toBe('nosniff');

  await page.goto(`${origin}/`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  const wasm = await page.evaluate(
    () =>
      new Promise((done) => {
        const probe = new Worker('/assets/wasm-probe.js');
        probe.onmessage = (e) => done(e.data);
      }),
  );
  expect(wasm).toBe('ok');

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();
});
