#!/usr/bin/env node
/**
 * Constitution Principle V gate.
 *
 * 1. Runs the signing tests to (re)produce signed PDFs under tests/signing/out/.
 * 2. Validates every produced PDF with pyHanko (scripts/validate_pdf.py): integrity AND policy.
 * 3. Confirms the validator itself: real tampering and a real policy violation are each caught
 *    for the right reason, and unsigned or corrupt files do not pass as tamper detection.
 *
 * Exits non-zero on any failure. Prerequisite: `pip install -r scripts/requirements-verify.txt`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT = resolve('tests/signing/out');
const TAMPERED = resolve('tests/signing/tampered');
const POLICY = resolve('tests/signing/fixtures/policy');
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
if (tampered.length === 0) {
  console.error('✗ no tampered PDF to validate (SC-007 would pass vacuously)');
  process.exit(1);
}
console.log(`› Validating ${tampered.length} tampered PDF(s) — expect INVALID (SC-007)…`);
if (run(PY, [VALIDATOR, '--expect-invalid', ...tampered]) !== 0) process.exit(1);

// pyHanko's own approval signature after certification is also a violation: appending a new
// field is not permitted, which is why the app refuses certified documents (signingPolicy.ts).
console.log('› Policy violations must be detected with integrity intact…');
const violations = ['violates-p1.pdf', 'certified-p2-two-revisions.pdf'].map((f) => resolve(POLICY, f));
if (run(PY, [VALIDATOR, '--expect-policy-violation', ...violations]) !== 0) process.exit(1);

// The negative modes must REJECT these: neither carries a signature to detect tampering in.
console.log('› Unsigned and corrupt files must not count as tamper detection…');
const scratch = mkdtempSync(join(tmpdir(), 'pdf-signer-gate-'));
const corrupt = join(scratch, 'corrupt.pdf');
writeFileSync(corrupt, 'this is not a pdf');
for (const file of [resolve(POLICY, 'unsigned.pdf'), corrupt]) {
  if (run(PY, [VALIDATOR, '--expect-invalid', file]) === 0) {
    console.error(`✗ ${file} wrongly passed as tamper detection`);
    process.exit(1);
  }
}
rmSync(scratch, { recursive: true, force: true });

console.log('✓ signature gate passed');
process.exit(0);
