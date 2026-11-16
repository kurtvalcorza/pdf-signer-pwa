#!/usr/bin/env node
/**
 * Constitution Principle V gate.
 *
 * 1. Runs the signing tests to (re)produce signed PDFs under tests/signing/out/.
 * 2. Validates every produced PDF with pyHanko (scripts/validate_pdf.py): integrity AND policy.
 *    Signatures the app added INTO a prepared field of a certified PDF (fill-*.pdf) must also
 *    leave the certification at the FORM_FILLING level (spec 004, FR-020).
 * 3. Confirms the validator itself: real tampering and real policy violations are each caught
 *    for the right reason, and unsigned or corrupt files do not pass as tamper detection.
 *
 * Every list must be non-empty: an empty one would pass vacuously.
 *
 * Exits non-zero on any failure. Prerequisite: `pip install --require-hashes -r scripts/requirements-verify.txt`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const OUT = resolve('tests/signing/out');
const OUT_VIOLATIONS = resolve('tests/signing/out-violations');
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
rmSync(OUT_VIOLATIONS, { recursive: true, force: true });
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

// A fill output must NOT sit in the default list as well: the default mode would pass it
// without checking the certification's level.
const isFill = (file) => basename(file).startsWith('fill-');
const produced = pdfsIn(OUT);
const valid = produced.filter((f) => !isFill(f));
const fills = produced.filter(isFill);

if (valid.length === 0) {
  console.error('✗ no signed PDFs to validate');
  process.exit(1);
}
console.log(`› Validating ${valid.length} signed PDF(s) — expect VALID…`);
if (run(PY, [VALIDATOR, ...valid]) !== 0) process.exit(1);

if (fills.length === 0) {
  console.error('✗ no certified-field fill output to validate (FR-020 would pass vacuously)');
  process.exit(1);
}
console.log(
  `› Validating ${fills.length} certified-field fill(s) — expect VALID, certification at FORM_FILLING…`,
);
if (run(PY, [VALIDATOR, '--expect-certification-level', 'FORM_FILLING', ...fills]) !== 0) {
  process.exit(1);
}

// Assumption 1 on the INPUT side: every fixture the app is willing to sign into (classified
// fill-only by tests/signing/fixtureClassification.test.ts in this run) must itself pass the
// validator as it stands. An input the app accepts and the validator rejects is the failure
// this feature must never have (review finding R1).
const fillOnlyList = resolve(OUT, 'fill-only-inputs.json');
const fillOnly = existsSync(fillOnlyList) ? JSON.parse(readFileSync(fillOnlyList, 'utf8')) : [];
if (fillOnly.length === 0) {
  console.error('✗ no fill-only input recorded by the classification tests');
  process.exit(1);
}
console.log(`› Validating ${fillOnly.length} input(s) the app would sign into — expect VALID…`);
if (run(PY, [VALIDATOR, ...fillOnly.map((f) => resolve(POLICY, f))]) !== 0) process.exit(1);

const tampered = pdfsIn(TAMPERED);
if (tampered.length === 0) {
  console.error('✗ no tampered PDF to validate (SC-007 would pass vacuously)');
  process.exit(1);
}
console.log(`› Validating ${tampered.length} tampered PDF(s) — expect INVALID (SC-007)…`);
if (run(PY, [VALIDATOR, '--expect-invalid', ...tampered]) !== 0) process.exit(1);

// pyHanko's own approval signature after certification is also a violation: appending a new
// field is not permitted, which is why the app never appends one to a certified document
// (signingPolicy.ts). The later-revision fixtures are the shapes rule 5d refuses (spec 004).
console.log('› Policy violations must be detected with integrity intact…');
const violations = [
  'violates-p1.pdf',
  'certified-p2-two-revisions.pdf',
  'certified-p2-late-visible-field.pdf',
  'certified-p2-later-annotation.pdf',
  'certified-p3-later-annotation.pdf',
  'certified-p3-annotation-then-fill.pdf',
  // Changes made through the cross-reference data, under intact signatures (spec 004, R1).
  'certified-p2-xref-duplicate-object.pdf',
  'certified-p2-xref-free-entry.pdf',
  'certified-p2-xref-double-trailer.pdf',
].map((f) => resolve(POLICY, f));
if (run(PY, [VALIDATOR, '--expect-policy-violation', ...violations]) !== 0) process.exit(1);

// These the validator will not even read in strict mode; the app refuses them as well.
// They must never validate.
console.log('› Malformed cross-reference data must not validate…');
for (const f of [
  'certified-p2-xref-generation-bump.pdf',
  'certified-p2-xref-hybrid.pdf',
  // Single signed sections (review round 2): a repeated dictionary key, a wrong /Size, a
  // predictor the rows were not written with.
  'certified-p2-signed-xref-repeated-key-field.pdf',
  'certified-p2-signed-xref-repeated-key-root.pdf',
  'certified-p2-signed-xref-repeated-key-prev.pdf',
  'certified-p2-signed-xref-size-low.pdf',
  'certified-p2-signed-xref-size-short.pdf',
  'certified-p2-signed-xref-decode-parms.pdf',
]) {
  if (run(PY, [VALIDATOR, resolve(POLICY, f)]) === 0) {
    console.error(`✗ ${f} wrongly validated`);
    process.exit(1);
  }
}

// Negative controls written by the tests (FR-021): the append-a-field path forced onto a
// certified PDF, and a fill output with one more disallowed revision. If either passed, the
// FORM_FILLING result above would prove nothing.
const forced = pdfsIn(OUT_VIOLATIONS);
if (forced.length < 2) {
  console.error('✗ negative controls missing from tests/signing/out-violations (FR-021)');
  process.exit(1);
}
console.log(
  `› Validating ${forced.length} negative control(s) — expect POLICY VIOLATION (FR-021)…`,
);
if (run(PY, [VALIDATOR, '--expect-policy-violation', ...forced]) !== 0) process.exit(1);
// …and the level mode itself must reject them, not only the violation mode accept them.
for (const file of forced) {
  if (run(PY, [VALIDATOR, '--expect-certification-level', 'FORM_FILLING', file]) === 0) {
    console.error(`✗ ${file} wrongly passed as a form-filling change`);
    process.exit(1);
  }
}

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
