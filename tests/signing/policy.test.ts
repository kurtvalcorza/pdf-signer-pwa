import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import {
  assertFillWellFormed,
  checkFill,
  signIncremental,
  signIntoField,
} from '../../src/features/signing/signIncremental';
import {
  addIncrementalPlaceholder,
  reserveExistingObjectNumbers,
} from '../../src/features/signing/incrementalUpdate';
import { analyzeRevisions, loadRevision, refKey } from '../../src/features/signing/revisions';
import { BLOCK_MESSAGES } from '../../src/features/signing/signingPolicy';
import { loadPdf } from '../../src/features/viewer/loadPdf';
import {
  CertificationLockedError,
  type BlockReason,
  type CandidateField,
  type FieldIneligibleReason,
  type PlacementInput,
} from '../../src/features/signing/types';
import { makeSelfSignedP12 } from './fixtures/makeCert';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = resolve(HERE, 'fixtures/policy');
const OUT = resolve(HERE, 'out');
/** Outputs that MUST be reported as policy violations by the gate (scripts/verify-signatures.mjs). */
const OUT_VIOLATIONS = resolve(HERE, 'out-violations');

// 1x1 transparent PNG.
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const placement: PlacementInput = {
  imageBytes: PNG,
  format: 'png',
  pageIndex: 0,
  nx: 0.1,
  ny: 0.5,
  nw: 0.3,
  nh: 0.1,
};
const PASS = 'policy-pass';
const load = (name: string) => new Uint8Array(readFileSync(resolve(POLICY, name)));
const N = (s: string) => PDFName.of(s);

let cert: { p12Bytes: Uint8Array; password: string };
beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(OUT_VIOLATIONS, { recursive: true });
  cert = { p12Bytes: new Uint8Array(makeSelfSignedP12(PASS)), password: PASS };
}, 40000);

describe('counter-signing documents the app did not write', () => {
  // Pure append onto approval signatures; the gate then confirms policy with pyHanko.
  it.each(['approval.pdf', 'approval-xref-stream.pdf'])(
    'counter-signs %s without touching its bytes',
    async (name) => {
      const input = load(name);
      const out = await signIncremental(input, placement, cert);
      expect(Buffer.from(out.subarray(0, input.length))).toEqual(Buffer.from(input));
      writeFileSync(resolve(OUT, `policy-${name}`), out);
    },
    40000,
  );

  // Free placement appends a new field. R11: refused on every certified document, including
  // the ones that can be signed in a prepared field.
  it.each([
    'certified-p1.pdf',
    'certified-p2.pdf',
    'certified-p3.pdf',
    'certified-p2-xref-stream.pdf',
    'certified-p2-two-revisions.pdf',
    'fieldmdp-all.pdf',
    'certified-p2-empty-field.pdf',
    'certified-p3-empty-field.pdf',
  ])(
    'refuses %s',
    async (name) => {
      await expect(signIncremental(load(name), placement, cert)).rejects.toThrow(
        CertificationLockedError,
      );
    },
    40000,
  );

  it.each([
    ['certified-p1.pdf', 'certified-no-changes', /no changes allowed/],
    ['certified-p2.pdf', 'certified-no-empty-field', /certified/],
    ['fieldmdp-all.pdf', 'field-locked', /FieldMDP/],
  ] as const)('tells the user up front why %s cannot be signed', async (name, reason, text) => {
    const info = await loadPdf(load(name));
    expect(info.signing).toMatchObject({ kind: 'blocked', reason });
    expect(info.signing.kind === 'blocked' && info.signing.message).toMatch(text);
  });

  it('does not block an approval-signed PDF', async () => {
    const info = await loadPdf(load('approval.pdf'));
    expect(info.hasExistingSignature).toBe(true);
    expect(info.signing).toEqual({ kind: 'ok' });
  });
});

/** The eligible fields of a fill-only document, or a failed expectation. */
async function eligibleFields(bytes: Uint8Array): Promise<CandidateField[]> {
  const info = await loadPdf(bytes);
  expect(info.signing.kind).toBe('fill-only');
  return info.signing.kind === 'fill-only' ? info.signing.fields : [];
}

const serialized = (o: { toString(): string } | undefined) => o?.toString() ?? null;

describe('signing a certified PDF in a field its author prepared (spec 004, US1)', () => {
  it.each([
    'certified-p2-empty-field.pdf',
    'certified-p3-empty-field.pdf',
    'certified-p2-empty-field-xref-stream.pdf',
    'certified-p2-empty-field-rotated-page.pdf',
  ])(
    'fills %s and changes nothing else',
    async (name) => {
      const input = load(name);
      const fields = await eligibleFields(input);
      expect(fields.map((f) => f.name)).toEqual(['Approver']);
      const field = fields[0];
      expect(field).toMatchObject({ pageIndex: 0, rect: [72, 500, 272, 550], eligible: true });

      const out = await signIntoField(
        input,
        { imageBytes: PNG, format: 'png', fieldRef: field.ref },
        cert,
      );

      // The input is a byte prefix of the output.
      expect(out.length).toBeGreaterThan(input.length);
      expect(Buffer.from(out.subarray(0, input.length))).toEqual(Buffer.from(input));

      // Exactly one pre-existing object differs, and it is the field.
      const before = await loadRevision(input);
      const after = await loadRevision(out);
      const changed = [...before.objects.keys()].filter(
        (k) =>
          Buffer.compare(
            Buffer.from(before.objects.get(k)!),
            Buffer.from(after.objects.get(k)!),
          ) !== 0,
      );
      expect(changed).toEqual([refKey(field.ref)]);

      // The form and every page's /Annots are unchanged.
      expect(serialized(after.doc.catalog.lookup(N('AcroForm')))).toBe(
        serialized(before.doc.catalog.lookup(N('AcroForm'))),
      );
      const annots = (doc: PDFDocument) =>
        doc.getPages().map((p) => serialized(p.node.lookup(N('Annots'))));
      expect(annots(after.doc)).toEqual(annots(before.doc));
      expect(annots(after.doc)[0]).not.toBeNull();

      // The field now holds a new approval signature: no /Reference, so no DocMDP or FieldMDP.
      const ref = PDFRef.of(field.ref.objectNumber, field.ref.generationNumber);
      const filled = after.doc.context.lookup(ref, PDFDict);
      const valueRef = filled.get(N('V')) as PDFRef;
      expect(before.objects.has(refKey(valueRef))).toBe(false);
      const value = filled.lookup(N('V'), PDFDict);
      expect(value.lookup(N('ByteRange'), PDFArray).size()).toBe(4);
      expect(value.has(N('Reference'))).toBe(false);
      expect(filled.lookup(N('Rect'))!.toString()).toBe(
        before.doc.context.lookup(ref, PDFDict).lookup(N('Rect'))!.toString(),
      );

      // Once filled, the field is no longer offered, and nothing else became signable.
      const again = await loadPdf(out);
      expect(again.signing).toMatchObject({ kind: 'blocked', reason: 'certified-no-empty-field' });

      writeFileSync(resolve(OUT, `fill-${name}`), out);
    },
    40000,
  );

  it('refuses a field reference the document does not offer', async () => {
    const input = load('certified-p2-empty-field.pdf');
    const [field] = await eligibleFields(input);
    for (const fieldRef of [
      { objectNumber: 1, generationNumber: 0 },
      { objectNumber: field.ref.objectNumber, generationNumber: 7 },
      { objectNumber: 99999, generationNumber: 0 },
    ]) {
      await expect(
        signIntoField(input, { imageBytes: PNG, format: 'png', fieldRef }, cert),
      ).rejects.toThrow(CertificationLockedError);
    }
  }, 40000);

  it.each(['approval.pdf', 'unsigned.pdf', 'certified-p1.pdf', 'certified-p2.pdf'])(
    'has no field to fill on %s',
    async (name) => {
      await expect(
        signIntoField(
          load(name),
          { imageBytes: PNG, format: 'png', fieldRef: { objectNumber: 1, generationNumber: 0 } },
          cert,
        ),
      ).rejects.toThrow(CertificationLockedError);
    },
    40000,
  );

  it('offers both fields of a two-field form, in the document order', async () => {
    const fields = await eligibleFields(load('certified-p2-two-empty-fields.pdf'));
    expect(fields.map((f) => f.name)).toEqual(['Approver', 'Witness']);
    expect(fields.every((f) => f.box !== null && f.pageIndex === 0)).toBe(true);
  });

  it('refuses a widget with its own rotation (/MK /R), with that reason', async () => {
    const info = await loadPdf(load('certified-p2-empty-field-mk-rotation.pdf'));
    expect(info.signing).toMatchObject({ kind: 'blocked', reason: 'certified-no-eligible-field' });
    expect(info.signing.kind === 'blocked' && info.signing.ineligible).toMatchObject([
      { name: 'Approver', eligible: false, reason: 'rotated-widget' },
    ]);
  });
});

/**
 * Append one more revision that adds a /Square annotation to page 1: a change a certification
 * does not permit after it at P=2. Written by hand so the bytes before it are untouched.
 */
async function appendSquareRevision(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPages()[0];
  const text = Buffer.from(pdf).toString('latin1');
  const prev = Number([...text.matchAll(/startxref\s+(\d+)/g)].pop()![1]);
  let highest = 0;
  for (const m of text.matchAll(/(\d+)\s+\d+\s+obj\b/g)) highest = Math.max(highest, Number(m[1]));
  const annotNum = highest + 1;

  const annotsRaw = page.node.get(N('Annots'));
  const annots = page.node.lookup(N('Annots'), PDFArray);
  annots.push(PDFRef.of(annotNum));
  const rewritten =
    annotsRaw instanceof PDFRef
      ? { ref: annotsRaw, body: annots.toString() }
      : { ref: page.ref, body: page.node.toString() };

  let out = Buffer.from(pdf);
  const rows: string[] = [];
  const add = (num: number, gen: number, body: string) => {
    rows.push(
      `${num} 1\n${String(out.length + 1).padStart(10, '0')} ${String(gen).padStart(5, '0')} n `,
    );
    out = Buffer.concat([out, Buffer.from(`\n${num} ${gen} obj\n${body}\nendobj\n`, 'latin1')]);
  };
  add(rewritten.ref.objectNumber, rewritten.ref.generationNumber, rewritten.body);
  add(
    annotNum,
    0,
    `<< /Type /Annot /Subtype /Square /Rect [300 300 360 340] /F 4 /P ${page.ref.objectNumber} ${page.ref.generationNumber} R >>`,
  );
  const root = doc.context.trailerInfo.Root as PDFRef;
  const xref = out.length + 1;
  out = Buffer.concat([
    out,
    Buffer.from(
      `\nxref\n0 1\n0000000000 65535 f \n${rows.join('\n')}\ntrailer\n<< /Size ${annotNum + 1} ` +
        `/Root ${root.objectNumber} ${root.generationNumber} R /Prev ${prev} >>\n` +
        `startxref\n${xref}\n%%EOF`,
    ),
  ]);
  return new Uint8Array(out);
}

describe('negative controls for the gate (spec 004, FR-021)', () => {
  it('the append-a-field path, forced onto a certified PDF, is written for the gate to reject', async () => {
    const input = load('certified-p2-empty-field.pdf');
    const probe = await PDFDocument.load(input);
    reserveExistingObjectNumbers(input, probe);
    const withPlaceholder = addIncrementalPlaceholder(input, probe, {
      pageIndex: 0,
      widgetRect: [72, 300, 272, 350],
    });
    const signed = await signpdf.sign(
      withPlaceholder,
      new P12Signer(cert.p12Bytes, { passphrase: cert.password }),
    );
    expect(Buffer.from(signed.subarray(0, input.length))).toEqual(Buffer.from(input));
    writeFileSync(resolve(OUT_VIOLATIONS, 'forced-append-certified-p2-empty-field.pdf'), signed);

    // The app itself would not open that result for another signature either.
    const info = await loadPdf(new Uint8Array(signed));
    expect(info.signing).toMatchObject({ kind: 'blocked', reason: 'changed-after-certification' });
  }, 40000);

  it('a fill output with one more disallowed revision is written for the gate to reject', async () => {
    const input = load('certified-p2-empty-field.pdf');
    const [field] = await eligibleFields(input);
    const filled = await signIntoField(
      input,
      { imageBytes: PNG, format: 'png', fieldRef: field.ref },
      cert,
    );
    const tampered = await appendSquareRevision(filled);
    expect(Buffer.from(tampered.subarray(0, filled.length))).toEqual(Buffer.from(filled));
    writeFileSync(
      resolve(OUT_VIOLATIONS, 'fill-then-annotation-certified-p2-empty-field.pdf'),
      tampered,
    );

    const info = await loadPdf(tampered);
    expect(info.signing).toMatchObject({ kind: 'blocked', reason: 'changed-after-certification' });
  }, 40000);
});

describe('the fill check refuses an output that is not exactly one fill (FR-015)', () => {
  let input: Uint8Array;
  let output: Uint8Array;
  let approver: PDFRef;
  let witness: PDFRef;
  const asRef = (f: CandidateField) => PDFRef.of(f.ref.objectNumber, f.ref.generationNumber);

  beforeAll(async () => {
    input = load('certified-p2-two-empty-fields.pdf');
    const [first, second] = await eligibleFields(input);
    approver = asRef(first);
    witness = asRef(second);
    output = await signIntoField(
      input,
      { imageBytes: PNG, format: 'png', fieldRef: first.ref },
      cert,
    );
  }, 40000);

  const rejects = async (bad: Uint8Array, ref: PDFRef, reason: string | RegExp) => {
    expect(await checkFill(input, bad, ref)).toMatch(reason);
    await expect(assertFillWellFormed(input, bad, ref)).rejects.toThrow(
      /no signed file was produced/,
    );
  };

  it('accepts the real output', async () => {
    expect(await checkFill(input, output, approver)).toBeNull();
    await expect(assertFillWellFormed(input, output, approver)).resolves.toBeUndefined();
  });

  it('nothing-appended', async () => {
    await rejects(input, approver, /^nothing-appended$/);
  });

  it('input-bytes-changed', async () => {
    const bad = Uint8Array.from(output);
    bad[100] ^= 0x01;
    await rejects(bad, approver, /^input-bytes-changed$/);
  });

  it('another-field-changed: the output fills a field other than the one asked for', async () => {
    await rejects(output, witness, /^another-field-changed$/);
  });

  it('signature-declares-a-transform: the new signature carries a /Reference', async () => {
    // Same length, so every offset in the appended section still holds.
    const text = Buffer.from(output).toString('latin1');
    const at = text.lastIndexOf('/Reason (Digitally signed)');
    expect(at).toBeGreaterThan(input.length);
    const swapped = '/Reference [' + ' '.repeat('/Reason (Digitally signed)'.length - 13) + ']';
    const bad = new Uint8Array(
      Buffer.from(text.slice(0, at) + swapped + text.slice(at + swapped.length), 'latin1'),
    );
    expect(bad.length).toBe(output.length);
    await rejects(bad, approver, /^signature-declares-a-transform$/);
  });

  it('an object freed through the appended xref section', async () => {
    // Turn the object-0 row of the appended table into a second row for object 1 (the catalog),
    // marked free: same bytes otherwise.
    const text = Buffer.from(output).toString('latin1');
    const at = text.lastIndexOf('xref\n0 1\n');
    expect(at).toBeGreaterThan(input.length);
    const bad = new Uint8Array(
      Buffer.from(text.slice(0, at) + 'xref\n1 1\n' + text.slice(at + 9), 'latin1'),
    );
    await rejects(bad, approver, /^xref-free-entry:1$/);
  });

  it('a second fill on top of the first is checked against the first, not the original', async () => {
    const second = await signIntoField(
      output,
      {
        imageBytes: PNG,
        format: 'png',
        fieldRef: {
          objectNumber: witness.objectNumber,
          generationNumber: witness.generationNumber,
        },
      },
      cert,
    );
    expect(await checkFill(output, second, witness)).toBeNull();
    // Against the original input the same bytes are two fills, not one.
    expect(await checkFill(input, second, witness)).toMatch(/^changed-objects:/);
  }, 40000);
});

/** The trailer /Info object of the certified revision and of the whole file, serialized. */
async function infoAtCertificationAndEnd(bytes: Uint8Array): Promise<[string, string]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const analysis = await analyzeRevisions(doc, bytes);
  if (!analysis.ok) throw new Error(`not a chain of fills: ${analysis.reason}`);
  const info = async (end: number) => {
    const rev = await loadRevision(bytes, end);
    const ref = rev.doc.context.trailerInfo.Info;
    if (!(ref instanceof PDFRef)) throw new Error('no indirect /Info');
    return Buffer.from(rev.objects.get(refKey(ref))!).toString('latin1');
  };
  return [await info(analysis.ends[0]), await info(bytes.length)];
}

describe('signing as the second signer of a certified PDF (spec 004, US3)', () => {
  it('Approver, then Witness: the first fill leaves only Witness, the second leaves nothing (T034)', async () => {
    const input = load('certified-p2-two-empty-fields.pdf');
    const [approver] = await eligibleFields(input);
    expect(approver.name).toBe('Approver');
    const first = await signIntoField(
      input,
      { imageBytes: PNG, format: 'png', fieldRef: approver.ref },
      cert,
    );

    // The app's own fill is an accepted transition; the filled field is no longer offered.
    const remaining = await eligibleFields(first);
    expect(remaining.map((f) => f.name)).toEqual(['Witness']);
    const info = await loadPdf(first);
    expect(info.signing.kind === 'fill-only' && info.signing.ineligible).toEqual([]);

    const second = await signIntoField(
      first,
      { imageBytes: PNG, format: 'png', fieldRef: remaining[0].ref },
      cert,
    );
    expect(Buffer.from(first.subarray(0, input.length))).toEqual(Buffer.from(input));
    expect(second.length).toBeGreaterThan(first.length);
    expect(Buffer.from(second.subarray(0, first.length))).toEqual(Buffer.from(first));

    // Certification plus two fills, and no empty field left to offer.
    const doc = await PDFDocument.load(second, { updateMetadata: false });
    const analysis = await analyzeRevisions(doc, second);
    expect(analysis).toMatchObject({ ok: true });
    expect(analysis.ok && analysis.ends).toHaveLength(3);
    expect((await loadPdf(second)).signing).toMatchObject({
      kind: 'blocked',
      reason: 'certified-no-empty-field',
    });
    writeFileSync(resolve(OUT, 'fill-chain-two-fields.pdf'), second);
  }, 40000);

  // C1 (owner, 2026-11-16): a first fill by another tool that also rewrote the trailer /Info is
  // accepted. pyHanko wrote these fills; each fixture's /Info must really differ, or the case
  // would pass by accident (research.md F1).
  it.each([
    'certified-p2-two-empty-fields-signed-once.pdf',
    'certified-p2-two-empty-fields-signed-once-xref-stream.pdf',
  ])(
    '%s: a foreign first fill that rewrote /Info leaves Witness signable (T035, C1)',
    async (name) => {
      const input = load(name);
      const [atCertification, atEnd] = await infoAtCertificationAndEnd(input);
      expect(atEnd).not.toBe(atCertification);

      const fields = await eligibleFields(input);
      expect(fields.map((f) => f.name)).toEqual(['Witness']);
      const out = await signIntoField(
        input,
        { imageBytes: PNG, format: 'png', fieldRef: fields[0].ref },
        cert,
      );
      expect(Buffer.from(out.subarray(0, input.length))).toEqual(Buffer.from(input));
      expect((await loadPdf(out)).signing).toMatchObject({
        kind: 'blocked',
        reason: 'certified-no-empty-field',
      });
      writeFileSync(resolve(OUT, `fill-second-${name}`), out);
    },
    40000,
  );

  it('certified-p2-empty-field-signed-once.pdf: accepted under C1, but nothing is left to sign (T035)', async () => {
    const input = load('certified-p2-empty-field-signed-once.pdf');
    const [atCertification, atEnd] = await infoAtCertificationAndEnd(input);
    expect(atEnd).not.toBe(atCertification);
    expect((await loadPdf(input)).signing).toMatchObject({
      kind: 'blocked',
      reason: 'certified-no-empty-field',
    });
  });

  it.each(['certified-p3-annotation-then-fill.pdf', 'certified-p2-two-revisions.pdf'])(
    '%s: a revision that is not one fill refuses the document (T035)',
    async (name) => {
      const input = load(name);
      const { signing } = await loadPdf(input);
      expect(signing).toMatchObject({ kind: 'blocked', reason: 'changed-after-certification' });
      expect(signing.kind === 'blocked' && signing.message).toBe(
        BLOCK_MESSAGES['changed-after-certification'],
      );
      // Not even the still-empty Witness of the annotation fixture may be filled.
      const doc = await PDFDocument.load(input, { updateMetadata: false });
      const fields = doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('Fields'), PDFArray);
      for (let i = 0; i < fields.size(); i++) {
        const ref = fields.get(i) as PDFRef;
        await expect(
          signIntoField(
            input,
            {
              imageBytes: PNG,
              format: 'png',
              fieldRef: { objectNumber: ref.objectNumber, generationNumber: ref.generationNumber },
            },
            cert,
          ),
        ).rejects.toThrow(CertificationLockedError);
      }
    },
    40000,
  );
});

/**
 * Spec 004, User Story 2 (T028, FR-022): every refusal row of RFC 23-1 has a fixture and is
 * refused for its own reason, with its own message, and nothing is written. Row R11 (free
 * placement on a certified document) is the drawn-box refusal at the end.
 */
type Refusal = {
  row: string;
  fixture: string;
  reason: BlockReason;
  /** The per-field reason, for the rows that refuse one field (R3, R5, R6, R12-R16). */
  field?: [name: string, reason: FieldIneligibleReason];
};

const REFUSALS: Refusal[] = [
  { row: 'R1', fixture: 'certified-p1.pdf', reason: 'certified-no-changes' },
  { row: 'R2', fixture: 'certified-p2.pdf', reason: 'certified-no-empty-field' },
  {
    row: 'R3',
    fixture: 'certified-p2-empty-field-hidden.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Approver', 'not-visible'],
  },
  { row: 'R4', fixture: 'fieldmdp-all.pdf', reason: 'field-locked' },
  {
    row: 'R5',
    fixture: 'certified-p2-empty-field-lock.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Approver', 'locked'],
  },
  {
    row: 'R6',
    fixture: 'certified-p2-empty-field-sv.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Approver', 'seed-values'],
  },
  { row: 'R7', fixture: 'approval-unknown-transform.pdf', reason: 'unknown-policy' },
  { row: 'R8', fixture: 'certified-p2-perms-without-reference.pdf', reason: 'unknown-policy' },
  { row: 'R9', fixture: 'certified-p2-sigflags-1.pdf', reason: 'form-not-fillable' },
  { row: 'R9', fixture: 'certified-p2-need-appearances.pdf', reason: 'form-not-fillable' },
  { row: 'R10', fixture: 'certified-p2-xfa.pdf', reason: 'xfa-form' },
  {
    row: 'R12',
    fixture: 'certified-p2-empty-field-kid-widget.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Approver', 'separate-widget'],
  },
  {
    row: 'R13',
    fixture: 'certified-p2-duplicate-names.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Approver', 'bad-name'],
  },
  {
    row: 'R14',
    fixture: 'certified-p2-inherited-v.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Group.Approver', 'inherited-value'],
  },
  {
    row: 'R15',
    fixture: 'certified-p2-widget-two-pages.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Approver', 'on-several-pages'],
  },
  {
    row: 'R16',
    fixture: 'certified-p2-widget-oc.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Approver', 'optional-content'],
  },
  {
    row: 'R16',
    fixture: 'certified-p2-readonly-field.pdf',
    reason: 'certified-no-eligible-field',
    field: ['Approver', 'read-only'],
  },
  // R17: a field added after certification can only arrive in a later revision, and rule 5d
  // refuses that revision first, for the whole document. The field-level rule 5c is pinned on
  // the same fixture in tests/unit/revisions.test.ts.
  {
    row: 'R17',
    fixture: 'certified-p2-late-visible-field.pdf',
    reason: 'changed-after-certification',
  },
  {
    row: 'R18',
    fixture: 'certified-p2-later-annotation.pdf',
    reason: 'changed-after-certification',
  },
  { row: 'R18', fixture: 'certified-p2-two-revisions.pdf', reason: 'changed-after-certification' },
];

describe('every refusal row has a fixture, its own reason, and no output (spec 004, US2)', () => {
  it('covers R1-R10 and R12-R18', () => {
    const rows = new Set(REFUSALS.map((r) => r.row));
    const want = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18].map((n) => `R${n}`);
    expect([...rows].sort()).toEqual(want.sort());
  });

  it.each(REFUSALS.map((r) => [r.row, r.fixture, r] as const))(
    '%s: %s',
    async (_row, fixture, refusal) => {
      const input = load(fixture);
      const { signing } = await loadPdf(input);
      expect(signing).toMatchObject({ kind: 'blocked', reason: refusal.reason });
      if (signing.kind !== 'blocked') return;
      expect(signing.message).toBe(BLOCK_MESSAGES[refusal.reason]);
      if (refusal.field) {
        const [name, reason] = refusal.field;
        expect(signing.ineligible.find((f) => f.name === name)).toMatchObject({
          eligible: false,
          reason,
        });
      }

      // No output: neither path will write anything, for any field the document names.
      const refs = [
        ...signing.ineligible.map((f) => f.ref),
        { objectNumber: 1, generationNumber: 0 },
      ];
      for (const fieldRef of refs) {
        await expect(
          signIntoField(input, { imageBytes: PNG, format: 'png', fieldRef }, cert),
        ).rejects.toThrow(CertificationLockedError);
      }
      await expect(signIncremental(input, placement, cert)).rejects.toThrow(
        CertificationLockedError,
      );
    },
    40000,
  );

  // R11: a drawn box is refused on EVERY certified fixture, whether or not it has a field the
  // user could sign in instead.
  const certifiedFixtures = readdirSync(POLICY)
    .filter((f) => f.endsWith('.pdf'))
    .filter((f) => f.startsWith('certified-') || f === 'violates-p1.pdf')
    .sort();

  it('finds the certified fixtures', () => {
    expect(certifiedFixtures.length).toBeGreaterThan(50);
  });

  it.each(certifiedFixtures)(
    'R11: refuses free placement on %s',
    async (name) => {
      await expect(signIncremental(load(name), placement, cert)).rejects.toThrow(
        CertificationLockedError,
      );
    },
    40000,
  );
});
