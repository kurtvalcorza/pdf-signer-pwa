// Per-distribution gate (Principle V): drive the PACKAGED portable .exe — not the unpackaged shell —
// through a real .p12 sign and validate with pyHanko. This exercises asar packing and the real
// portable-path resolution the unpackaged E2E cannot. Usage: node electron/verify-packaged.mjs
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIX = resolve(ROOT, 'tests/e2e/fixtures');
const CERT_PASSWORD = 'e2e-pass';

// The portable .exe is a self-extracting stub that re-launches a child process, so Playwright cannot
// attach to it. Drive the win-unpacked build — the actual asar-packed Electron app (same bits the
// stub extracts and runs), which proves asar packing + the packaged app itself.
const exe = resolve(ROOT, 'release/win-unpacked/PDF Signer.exe');
if (!existsSync(exe)) {
  console.error('No win-unpacked build. Run: npm run build:desktop');
  process.exit(1);
}
execFileSync(process.execPath, [resolve(ROOT, 'scripts/make-e2e-fixtures.mjs')], { stdio: 'inherit' });

const downloadDir = mkdtempSync(join(tmpdir(), 'pdfsigner-pkg-dl-'));
const portableDir = mkdtempSync(join(tmpdir(), 'pdfsigner-pkg-portable-'));
console.log(`[pkg] launching packaged (asar) artifact: ${exe}`);
const app = await electron.launch({
  executablePath: exe,
  env: {
    ...process.env,
    PDFSIGNER_HEADLESS: '1',
    PDFSIGNER_E2E_DOWNLOAD_DIR: downloadDir,
    PORTABLE_EXECUTABLE_DIR: portableDir, // exercise adjacent-mode data resolution on the real build
  },
});

let failed = null;
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  console.log('[pkg] window title:', await page.title());

  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(resolve(FIX, 'sample.pdf'));
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 25_000 });
  await page
    .locator('input[type="file"][accept="image/png,image/jpeg"]')
    .setInputFiles(resolve(FIX, 'signature.png'));
  await page.locator('img[alt="signature"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: /Sign with a digital certificate/ }).click();
  await page.locator('input[type="file"][accept=".p12,.pfx"]').setInputFiles(resolve(FIX, 'e2e-cert.p12'));
  await page.getByPlaceholder('Certificate password').fill(CERT_PASSWORD);
  await page.getByRole('button', { name: /Sign & Download/ }).click();

  const deadline = Date.now() + 40_000;
  let saved;
  while (Date.now() < deadline) {
    const done = readdirSync(downloadDir).find((f) => f.endsWith('.pdf.done'));
    if (done) {
      saved = join(downloadDir, done.replace(/\.done$/, ''));
      break;
    }
    await sleep(250);
  }
  if (!saved || !existsSync(saved) || statSync(saved).size === 0) {
    throw new Error('packaged artifact produced no signed PDF');
  }
  console.log(`[pkg] signed PDF: ${saved} (${statSync(saved).size} bytes)`);
  const out = execFileSync('python', [resolve(ROOT, 'scripts/validate_pdf.py'), saved], { encoding: 'utf8' });
  if (!out.includes('RESULT: PASS')) throw new Error('pyHanko did not PASS:\n' + out);
  console.log('[pkg] pyHanko RESULT: PASS — packaged artifact signs a valid PDF.');
} catch (e) {
  failed = e;
} finally {
  await app.close();
  rmSync(downloadDir, { recursive: true, force: true });
  rmSync(portableDir, { recursive: true, force: true });
}

if (failed) {
  console.error('[pkg] FAILED:', failed.message);
  process.exit(1);
}
