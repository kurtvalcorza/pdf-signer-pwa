import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { signIncremental, signIntoField } from '../../src/features/signing/signIncremental';
import {
  addIncrementalPlaceholder,
  reserveExistingObjectNumbers,
} from '../../src/features/signing/incrementalUpdate';
import { loadRevision, refKey } from '../../src/features/signing/revisions';
import { loadPdf } from '../../src/features/viewer/loadPdf';
import {
  CertificationLockedError,
  type CandidateField,
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
