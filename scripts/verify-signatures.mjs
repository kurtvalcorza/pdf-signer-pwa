#!/usr/bin/env node
/**
 * Constitution Principle V gate.
 *
 * 1. Runs the signing tests to (re)produce signed PDFs under tests/signing/out/.
 * 2. Validates every produced PDF with pyHanko (scripts/validate_pdf.py).
 *
 * Exits non-zero if signing tests fail or any signature is not intact + valid.
 * pyHanko is a dev prerequisite: `pip install pyhanko`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('tests/signing/out');
const TAMPERED = resolve('tests/signing/tampered');
const PY = process.env.PYTHON || 'python';
const VITEST_BIN = resolve('node_modules/vitest/vitest.mjs');
const VALIDATOR = resolve('scripts/validate_pdf.py');

// shell:false + discrete argv so paths containing spaces (e.g. the user profile
// path) are passed intact on Windows.
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  return r.status ?? 1;
}

// Start from a clean slate so only current-run artifacts are validated.
rmSync(OUT, { recursive: true, force: true });
rmSync(TAMPERED, { recursive: true, force: true });

console.log('› Producing signed fixtures (vitest tests/signing)…');
if (run(process.execPath, [VITEST_BIN, 'run', 'tests/signing']) !== 0) {
  console.error('✗ signing tests failed');
  process.exit(1);
}

function pdfsIn(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.pdf'))
        .map((f) => resolve(dir, f))
    : [];
}

const valid = pdfsIn(OUT);
if (valid.length === 0) {
  console.error('✗ no signed PDFs to validate');
  process.exit(1);
}
console.log(`› Validating ${valid.length} signed PDF(s) — expect VALID…`);
if (run(PY, [VALIDATOR, ...valid]) !== 0) process.exit(1);

const tampered = pdfsIn(TAMPERED);
if (tampered.length > 0) {
  console.log(`› Validating ${tampered.length} tampered PDF(s) — expect INVALID (SC-007)…`);
  if (run(PY, [VALIDATOR, '--expect-invalid', ...tampered]) !== 0) process.exit(1);
}

console.log('✓ signature gate passed');
process.exit(0);
