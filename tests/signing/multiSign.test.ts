import { describe, it, expect, beforeAll } from 'vitest';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSelfSignedP12 } from './fixtures/makeCert';
import { signFirst } from '../../src/features/signing/signFirst';
import { signIncremental } from '../../src/features/signing/signIncremental';
import { loadPdf } from '../../src/features/viewer/loadPdf';
import { CertificationLockedError, type PlacementInput } from '../../src/features/signing/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
const TAMPERED = resolve(HERE, 'tampered');
const PASS = 'test-pass';

const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const at = (ny: number): PlacementInput => ({
  imageBytes: PNG,
  format: 'png',
  pageIndex: 0,
  nx: 0.15,
  ny,
  nw: 0.35,
  nh: 0.1,
});

async function makeBasePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Sample document to sign', { x: 20, y: 360, size: 12, font });
  return doc.save();
}

/** Object refs listed by the ACTIVE (= last-written) AcroForm's /Fields array. */
function activeFieldsRefs(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString('latin1');
  const acroRef = /\/AcroForm\s+(\d+)\s+(\d+)\s+R/.exec(text);
  if (!acroRef) return [];
  const headerRe = new RegExp(`(?:^|\\n)${acroRef[1]} ${acroRef[2]} obj\\b`, 'g');
  let last = -1;
  for (let m = headerRe.exec(text); m; m = headerRe.exec(text)) last = m.index;
  if (last === -1) return [];
  const body = text.slice(last, text.indexOf('endobj', last));
  const fields = /\/Fields\s*\[([^\]]*)\]/.exec(body);
  return fields ? (fields[1].match(/\d+\s+\d+\s+R/g) ?? []) : [];
}

/**
 * A structurally "already-signed" PDF built directly with pdf-lib primitives: a
 * signature field whose /V carries /ByteRange + /Contents (not cryptographically
 * valid — these tests exercise the guards, which never verify the existing CMS).
 */
async function makeFakeSignedPdf(opts: {
  acroFormType: boolean;
  docMdpP?: number;
  fieldMdp?: boolean;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const ctx = doc.context;

  const sigDict = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 100, 200, 50],
    Contents: PDFHexString.of('00'.repeat(16)),
  });
  if (opts.docMdpP !== undefined) {
    sigDict.set(
      PDFName.of('Reference'),
      ctx.obj([
        ctx.obj({
          Type: 'SigRef',
          TransformMethod: 'DocMDP',
          TransformParams: ctx.obj({ Type: 'TransformParams', P: opts.docMdpP, V: '1.2' }),
        }),
      ]),
    );
  }
  if (opts.fieldMdp) {
    sigDict.set(
      PDFName.of('Reference'),
      ctx.obj([
        ctx.obj({
          Type: 'SigRef',
          TransformMethod: 'FieldMDP',
          TransformParams: ctx.obj({ Type: 'TransformParams', Action: 'All', V: '1.2' }),
        }),
      ]),
    );
  }
  const sigRef = ctx.register(sigDict);

  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [20, 20, 120, 60],
    V: sigRef,
    T: PDFString.of('OldSig'),
    F: 4,
    P: page.ref,
  });
  const widgetRef = ctx.register(widget);
  page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));

  const acro = ctx.obj({});
  if (opts.acroFormType) acro.set(PDFName.of('Type'), PDFName.of('AcroForm'));
  acro.set(PDFName.of('Fields'), ctx.obj([widgetRef]));
  acro.set(PDFName.of('SigFlags'), ctx.obj(3));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acro));

  if (opts.docMdpP !== undefined) {
    doc.catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: sigRef }));
  }
  return doc.save({ useObjectStreams: false });
}

describe('multi-signature (incremental)', () => {
  let p12: Buffer;
  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    mkdirSync(TAMPERED, { recursive: true });
    p12 = makeSelfSignedP12(PASS);
  });

  it('appends a second signature incrementally (byte-level, no re-serialization)', async () => {
    const base = await makeBasePdf();
    const cert = { p12Bytes: p12, password: PASS };
    const first = await signFirst(base, at(0.62), cert);
    const second = await signIncremental(first, at(0.42), cert);

    const byteRanges = (Buffer.from(second).toString('latin1').match(/\/ByteRange/g) ?? []).length;
    expect(byteRanges).toBeGreaterThanOrEqual(2);
    // Incremental append only grows the file — the earlier signed bytes are preserved.
    expect(second.length).toBeGreaterThan(first.length);
    expect(Buffer.from(second.subarray(0, first.length))).toEqual(Buffer.from(first));

    // BOTH signature fields must be referenced by the active (last-written) AcroForm —
    // otherwise validators stop enumerating the first signature even though its bytes
    // survive. The update rewrites the form, so parse the final /Fields array.
    expect(activeFieldsRefs(second)).toHaveLength(2);

    // Give the pyHanko gate (verify:signatures) this combo to validate: it must see
    // two intact+valid signatures, not one.
    writeFileSync(resolve(OUT, 'signed-counter.pdf'), second);
  }, 40000);

  // The app routes certificate-signing of an already-signed PDF through signIncremental
  // (App.signWithCert), so a later signer never invalidates an earlier one (FR-013/SC-009).
  it('counter-signs a PDF someone else already signed without invalidating theirs', async () => {
    const base = await makeBasePdf();
    const cert = { p12Bytes: p12, password: PASS };
    // A PDF already signed by another person.
    const othersSigned = await signFirst(base, at(0.62), cert);
    // loadPdf must flag it as signed — that's the condition that routes the app to the
    // incremental (non-invalidating) path instead of signFirst/stampVisual.
    expect((await loadPdf(othersSigned)).hasExistingSignature).toBe(true);

    // Our app's already-signed path appends our signature incrementally on top.
    const counterSigned = await signIncremental(othersSigned, at(0.42), cert);

    // The earlier signer's bytes are preserved byte-for-byte → their signature stays intact.
    expect(Buffer.from(counterSigned.subarray(0, othersSigned.length))).toEqual(
      Buffer.from(othersSigned),
    );
    // Both signatures are present; the file only grew (pure append).
    const byteRanges = (Buffer.from(counterSigned).toString('latin1').match(/\/ByteRange/g) ?? [])
      .length;
    expect(byteRanges).toBeGreaterThanOrEqual(2);
    expect(counterSigned.length).toBeGreaterThan(othersSigned.length);
    // …and both fields stay enumerable via the active AcroForm.
    expect(activeFieldsRefs(counterSigned)).toHaveLength(2);
  }, 40000);

  // FR-013 honesty guards: refuse to emit a file whose earlier signatures would stop
  // being enumerated, rather than claiming a non-invalidating counter-sign.
  it('rejects a signed PDF whose AcroForm the incremental update cannot re-find', async () => {
    // Simulate a legacy/foreign producer: signature field present, but the AcroForm
    // dict lacks /Type /AcroForm (as pdf-lib emitted before signFirst forced it).
    const bytes = await makeFakeSignedPdf({ acroFormType: false });
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(true);
    await expect(
      signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS }),
    ).rejects.toThrow(/could not preserve the existing signature field/);
  }, 40000);

  it('rejects a certification-locked PDF (DocMDP "no changes", P=1)', async () => {
    const bytes = await makeFakeSignedPdf({ acroFormType: true, docMdpP: 1 });
    await expect(
      signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS }),
    ).rejects.toThrow(CertificationLockedError);
  }, 40000);

  it('counter-signs a certified PDF that permits signing (DocMDP P=2)', async () => {
    const bytes = await makeFakeSignedPdf({ acroFormType: true, docMdpP: 2 });
    const out = await signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS });
    // Pure append; the pre-existing field is still enumerated alongside the new one.
    expect(Buffer.from(out.subarray(0, bytes.length))).toEqual(Buffer.from(bytes));
    expect(activeFieldsRefs(out)).toHaveLength(2);
  }, 40000);

  it('rejects a FieldMDP-locked PDF (e.g. "lock all fields after signing")', async () => {
    // Adding our field rewrites /Fields — a form modification the lock may disallow;
    // we can't prove it's permitted, so the guard must refuse conservatively.
    const bytes = await makeFakeSignedPdf({ acroFormType: true, fieldMdp: true });
    await expect(
      signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS }),
    ).rejects.toThrow(CertificationLockedError);
  }, 40000);

  it('rejects a counter-signature placed on any page but the first', async () => {
    // placeholder-plain always attaches the widget to /Kids[0]; a page-2 placement
    // would silently land the signed field on page 1 with page-2 coordinates.
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([300, 400]);
    const base = await doc.save();
    const signed = await signFirst(base, at(0.62), { p12Bytes: p12, password: PASS });
    await expect(
      signIncremental(signed, { ...at(0.42), pageIndex: 1 }, { p12Bytes: p12, password: PASS }),
    ).rejects.toThrow(/placed on page 1/);
  }, 40000);

  it('writes a tampered copy for the gate to reject (SC-007)', async () => {
    const base = await makeBasePdf();
    const first = await signFirst(base, at(0.62), { p12Bytes: p12, password: PASS });
    const tampered = Uint8Array.from(first);
    // Flip a byte within the first ByteRange segment (document body) to break integrity.
    const i = Math.floor(tampered.length * 0.2);
    tampered[i] = tampered[i] ^ 0xff;
    writeFileSync(resolve(TAMPERED, 'tampered.pdf'), tampered);
    expect(tampered.length).toBe(first.length);
  }, 30000);
});
