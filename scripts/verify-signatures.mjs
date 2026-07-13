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
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('tests/signing/out');
const PY = process.env.PYTHON || 'python';
const VITEST_BIN = resolve('node_modules/vitest/vitest.mjs');

// shell:false + discrete argv so paths containing spaces (e.g. the user profile
// path) are passed intact on Windows.
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  return r.status ?? 1;
}

console.log('› Producing signed fixtures (vitest tests/signing)…');
if (run(process.execPath, [VITEST_BIN, 'run', 'tests/signing']) !== 0) {
  console.error('✗ signing tests failed');
  process.exit(1);
}

if (!existsSync(OUT)) {
  console.error(`✗ no output dir at ${OUT}`);
  process.exit(1);
}
const pdfs = readdirSync(OUT)
  .filter((f) => f.endsWith('.pdf'))
  .map((f) => resolve(OUT, f));
if (pdfs.length === 0) {
  console.error('✗ no signed PDFs to validate');
  process.exit(1);
}

console.log(`› Validating ${pdfs.length} signed PDF(s) with pyHanko…`);
process.exit(run(PY, [resolve('scripts/validate_pdf.py'), ...pdfs]));
