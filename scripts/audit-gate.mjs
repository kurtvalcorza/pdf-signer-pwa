#!/usr/bin/env node
/**
 * Fails on a high or critical advisory in a production dependency.
 *
 * One exception is accepted, and it has to keep earning its place: crypto-js arrives through
 * @signpdf/placeholder-plain with no upstream fix, but the code path does not reach the app, so the
 * built bundle is checked for it. Run after `npm run build`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ACCEPTED = new Set([
  'crypto-js',
  'pdfkit',
  '@signpdf/placeholder-pdfkit010',
  '@signpdf/placeholder-plain',
]);
const CRYPTO_JS_MARKER = 'Malformed UTF-8 data'; // from crypto-js/core.js; survives minification
const ASSETS = 'dist/assets';

const audit = spawnSync('npm audit --omit=dev --json', {
  encoding: 'utf8',
  shell: true,
  maxBuffer: 64 * 1024 * 1024,
});
const { vulnerabilities, error } = JSON.parse(audit.stdout || '{}');
if (!vulnerabilities || error) {
  console.error('✗ npm audit produced no report', error ?? audit.stderr);
  process.exit(1);
}

const blocking = Object.values(vulnerabilities).filter(
  (v) => ['high', 'critical'].includes(v.severity) && !ACCEPTED.has(v.name),
);
for (const v of blocking) console.error(`✗ ${v.severity}: ${v.name}`);

if (!existsSync(ASSETS)) {
  console.error(`✗ ${ASSETS} is missing, so the accepted exception cannot be checked. Build first.`);
  process.exit(1);
}
const bundled = readdirSync(ASSETS).filter(
  (f) => f.endsWith('.js') && readFileSync(join(ASSETS, f), 'utf8').includes(CRYPTO_JS_MARKER),
);
for (const f of bundled) console.error(`✗ crypto-js reached the bundle: ${f}`);

if (blocking.length > 0 || bundled.length > 0) process.exit(1);
console.log('✓ no unaccepted high or critical production advisories');
