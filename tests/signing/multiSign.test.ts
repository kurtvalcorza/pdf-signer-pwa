import { describe, it, expect, beforeAll } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
  degrees,
} from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSelfSignedP12 } from './fixtures/makeCert';
import { signFirst } from '../../src/features/signing/signFirst';
import { signIncremental } from '../../src/features/signing/signIncremental';
import { reserveExistingObjectNumbers } from '../../src/features/signing/incrementalUpdate';
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

/**
 * Object refs listed by the ACTIVE AcroForm's /Fields array, resolved the way a
 * validator resolves them — by re-parsing the file (pdf-lib follows the incremental
 * xref chain, object streams included), not by scanning raw text.
 */
async function activeFieldsRefs(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf);
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  const refs: string[] = [];
  for (let i = 0; fields && i < fields.size(); i++) {
    const r = fields.get(i);
    if (r instanceof PDFRef) refs.push(String(r));
  }
  return refs;
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
  /** Store the page's /Annots as an indirect object (/Annots N 0 R) instead of inline. */
  indirectAnnots?: boolean;
  /** Save with cross-reference + object streams (as many foreign producers do). */
  objectStreams?: boolean;
  /** Keep /AcroForm inline in the catalog (not an indirect object). */
  inlineAcroForm?: boolean;
  /** Store /Fields as its own indirect array object (/Fields N 0 R). */
  indirectFields?: boolean;
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
  const annots = ctx.obj([widgetRef]);
  page.node.set(PDFName.of('Annots'), opts.indirectAnnots ? ctx.register(annots) : annots);

  const acro = ctx.obj({});
  if (opts.acroFormType) acro.set(PDFName.of('Type'), PDFName.of('AcroForm'));
  const fieldsArr = ctx.obj([widgetRef]);
  acro.set(PDFName.of('Fields'), opts.indirectFields ? ctx.register(fieldsArr) : fieldsArr);
  acro.set(PDFName.of('SigFlags'), ctx.obj(3));
  doc.catalog.set(PDFName.of('AcroForm'), opts.inlineAcroForm ? acro : ctx.register(acro));

  if (opts.docMdpP !== undefined) {
    doc.catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: sigRef }));
  }
  return doc.save({ useObjectStreams: opts.objectStreams ?? false });
}

/**
 * Assemble a signed PDF from raw object bodies (contiguously numbered from 1) with a
 * classic xref table; offsets are computed as objects are emitted. Used for shapes
 * pdf-lib can't produce (non-zero generations, a trailer /ID, shared arrays).
 */
function buildRawSignedPdf(
  objs: { num: number; gen: number; body: string }[],
  opts: { id?: string } = {},
): Uint8Array {
  const size = Math.max(...objs.map((o) => o.num)) + 1;
  let pdf = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  for (const o of objs) {
    offsets.set(o.num, Buffer.byteLength(pdf, 'latin1'));
    pdf += `${o.num} ${o.gen} obj\n${o.body}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    const o = objs.find((x) => x.num === n);
    pdf += o
      ? `${String(offsets.get(n)).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n \n`
      : '0000000000 65535 f \n';
  }
  pdf += `trailer\n<< /Size ${size} /Root 1 0 R${opts.id ? ` /ID ${opts.id}` : ''} >>\n`;
  pdf += `startxref\n${xrefAt}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

const SIG_BODY =
  '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ' +
  `/ByteRange [0 100 200 50] /Contents <${'00'.repeat(16)}> >>`;

/** A signed PDF whose PAGE object carries generation 1 (referenced as "3 1 R"). */
function makeGen1SignedPdf(id?: string): Uint8Array {
  return buildRawSignedPdf(
    [
      { num: 1, gen: 0, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>' },
      { num: 2, gen: 0, body: '<< /Type /Pages /Kids [3 1 R] /Count 1 >>' },
      {
        num: 3,
        gen: 1,
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Annots [4 0 R] >>',
      },
      {
        num: 4,
        gen: 0,
        body:
          '<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [20 20 120 60] ' +
          '/V 5 0 R /T (OldSig) /F 4 /P 3 1 R >>',
      },
      { num: 5, gen: 0, body: SIG_BODY },
      { num: 6, gen: 0, body: '<< /Type /AcroForm /Fields [4 0 R] /SigFlags 3 >>' },
    ],
    { id },
  );
}

/**
 * A signed PDF where object 7 is the SAME indirect array for both the AcroForm
 * /Fields and the page /Annots (a terminal widget field is both field and annotation).
 */
function makeSharedFieldsAnnotsPdf(): Uint8Array {
  return buildRawSignedPdf([
    { num: 1, gen: 0, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>' },
    { num: 2, gen: 0, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      num: 3,
      gen: 0,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Annots 7 0 R >>',
    },
    {
      num: 4,
      gen: 0,
      body:
        '<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [20 20 120 60] ' +
        '/V 5 0 R /T (OldSig) /F 4 /P 3 0 R >>',
    },
    { num: 5, gen: 0, body: SIG_BODY },
    { num: 6, gen: 0, body: '<< /Type /AcroForm /Fields 7 0 R /SigFlags 3 >>' },
    { num: 7, gen: 0, body: '[4 0 R]' },
  ]);
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

    const byteRanges = (
      Buffer.from(second)
        .toString('latin1')
        .match(/\/ByteRange/g) ?? []
    ).length;
    expect(byteRanges).toBeGreaterThanOrEqual(2);
    // Incremental append only grows the file — the earlier signed bytes are preserved.
    expect(second.length).toBeGreaterThan(first.length);
    expect(Buffer.from(second.subarray(0, first.length))).toEqual(Buffer.from(first));

    // BOTH signature fields must be referenced by the active (last-written) AcroForm —
    // otherwise validators stop enumerating the first signature even though its bytes
    // survive. The update rewrites the form, so parse the final /Fields array.
    expect(await activeFieldsRefs(second)).toHaveLength(2);

    // Give the pyHanko gate (verify:signatures) this combo to validate: it must see
    // two intact+valid signatures, not one.
    writeFileSync(resolve(OUT, 'signed-counter.pdf'), second);
  }, 40000);

  // The app routes certificate-signing of an already-signed PDF through signIncremental
  // (App.signWithCert), so a later signer never invalidates an earlier one (FR-013/SC-009).
  it('adds an image appearance to the appended counter-signature field', async () => {
    const cert = { p12Bytes: p12, password: PASS };
    const first = await signFirst(await makeBasePdf(), at(0.18), cert);

    const out = await signIncremental(first, at(0.42), cert);
    const doc = await PDFDocument.load(out);
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    const appended = fields.lookup(fields.size() - 1, PDFDict);
    const ap = appended.lookup(PDFName.of('AP'), PDFDict);
    const normal = ap.get(PDFName.of('N'));

    expect(normal).toBeInstanceOf(PDFRef);
    const normalStream = doc.context.lookup(normal as PDFRef) as PDFRawStream;
    expect(normalStream.getContentsString()).toContain('/Img Do');

    // Hand this appearance-bearing counter-sign to the pyHanko gate (verify:signatures):
    // both signatures must remain intact + valid even though the new one carries an
    // embedded image appearance (the appended resources are covered by its ByteRange,
    // and the prior signed bytes are untouched).
    writeFileSync(resolve(OUT, 'signed-counter-appearance.pdf'), out);
  });

  it('honors appearance options for appended counter-signatures', async () => {
    const cert = { p12Bytes: p12, password: PASS };
    const first = await signFirst(await makeBasePdf(), at(0.18), cert, {
      label: false,
      date: false,
    });

    const out = await signIncremental(first, at(0.42), cert, { label: false, date: false });
    const text = Buffer.from(out).toString('latin1');

    expect(text).toContain('/Img Do');
    expect(text).not.toContain('Digitally signed by');
    expect(text).not.toContain('Date:');
  });

  it('keeps the appended appearance upright on rotated pages', async () => {
    const cert = { p12Bytes: p12, password: PASS };
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    page.setRotation(degrees(90));
    const first = await signFirst(await doc.save(), at(0.18), cert);

    const out = await signIncremental(first, at(0.42), cert);
    const text = Buffer.from(out).toString('latin1');

    expect(text).toContain('/Matrix [ 0 1 -1 0');
  });

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
    const byteRanges = (
      Buffer.from(counterSigned)
        .toString('latin1')
        .match(/\/ByteRange/g) ?? []
    ).length;
    expect(byteRanges).toBeGreaterThanOrEqual(2);
    expect(counterSigned.length).toBeGreaterThan(othersSigned.length);
    // …and both fields stay enumerable via the active AcroForm.
    expect(await activeFieldsRefs(counterSigned)).toHaveLength(2);
  }, 40000);

  // The update is built from pdf-lib's parsed graph, so producer quirks that broke
  // the old string-surgery path (placeholder-plain) now counter-sign correctly.
  it('counter-signs a legacy PDF whose AcroForm lacks /Type (old signFirst output)', async () => {
    const bytes = await makeFakeSignedPdf({ acroFormType: false });
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(true);
    const out = await signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS });
    expect(Buffer.from(out.subarray(0, bytes.length))).toEqual(Buffer.from(bytes));
    expect(await activeFieldsRefs(out)).toHaveLength(2);
  }, 40000);

  it('preserves original bytes exactly when the signed revision ends in a newline', async () => {
    // Some producers end the signed revision with LF/CRLF after %%EOF, and the prior
    // signature's /ByteRange can cover those bytes. Trimming them (as removeTrailingNewLine
    // did) would break that signature's digest, so the update must append without touching
    // a single original byte.
    const cert = { p12Bytes: p12, password: PASS };
    const signed = await signFirst(await makeBasePdf(), at(0.62), cert);
    const withNewline = Buffer.concat([Buffer.from(signed), Buffer.from('\r\n')]);
    expect((await loadPdf(withNewline)).hasExistingSignature).toBe(true);

    const out = await signIncremental(withNewline, at(0.42), cert);
    // Every original byte — the trailing CRLF included — is preserved verbatim.
    expect(Buffer.from(out.subarray(0, withNewline.length))).toEqual(withNewline);
    expect(await activeFieldsRefs(out)).toHaveLength(2);
  }, 40000);

  it('counter-signs when an existing object has a non-zero generation', async () => {
    // The target page is object "3 1 obj" (generation 1). If the update redefined it as
    // "3 0 obj", readers would keep resolving "3 1 R" and drop the new widget — the
    // re-parse guard would then reject. Success proves generations are carried through.
    const bytes = makeGen1SignedPdf();
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(true);
    const out = await signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS });
    expect(Buffer.from(out.subarray(0, bytes.length))).toEqual(Buffer.from(bytes));

    // Navigate the way a validator does: AcroForm → new field → its /P — and require
    // that /P resolves to the gen-1 page object (not a phantom "3 0 R"). This is what
    // associates the counter-signature with the intended page.
    const reparsed = await PDFDocument.load(out);
    const acro = reparsed.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    expect(fields.size()).toBe(2);
    const newField = fields.lookup(fields.size() - 1, PDFDict);
    const parentRef = newField.get(PDFName.of('P'));
    expect(parentRef).toBeInstanceOf(PDFRef);
    expect(String(parentRef)).toBe('3 1 R');
    // …and that ref actually resolves to the page (index 0) in the tree.
    expect(reparsed.getPages()[0].ref).toBe(parentRef);
  }, 40000);

  it('counter-signs when /Fields and page /Annots share one indirect array', async () => {
    // Object 7 is both the AcroForm /Fields and the page /Annots. The widget must be
    // added to it exactly once, not twice (which would trip the well-formedness guard).
    const bytes = makeSharedFieldsAnnotsPdf();
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(true);
    const out = await signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS });
    expect(Buffer.from(out.subarray(0, bytes.length))).toEqual(Buffer.from(bytes));
    // Exactly one field was added (2 total), and the shared array is not double-counted.
    expect(await activeFieldsRefs(out)).toHaveLength(2);
  }, 40000);

  it('preserves the trailer /ID of the signed PDF in the appended trailer', async () => {
    const id = '[<0123456789ABCDEF0123456789ABCDEF> <FEDCBA9876543210FEDCBA9876543210>]';
    const bytes = makeGen1SignedPdf(id);
    const out = await signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS });
    // The appended (now-active) trailer must carry the same /ID forward.
    const text = Buffer.from(out).toString('latin1');
    const lastTrailer = text.slice(text.lastIndexOf('trailer'));
    expect(lastTrailer).toContain(`/ID ${id}`);
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
    expect(await activeFieldsRefs(out)).toHaveLength(2);
  }, 40000);

  it('rejects a FieldMDP-locked PDF (e.g. "lock all fields after signing")', async () => {
    // Adding our field rewrites /Fields — a form modification the lock may disallow;
    // we can't prove it's permitted, so the guard must refuse conservatively.
    const bytes = await makeFakeSignedPdf({ acroFormType: true, fieldMdp: true });
    await expect(
      signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS }),
    ).rejects.toThrow(CertificationLockedError);
  }, 40000);

  it('counter-signs a PDF whose page /Annots array is stored indirectly', async () => {
    const bytes = await makeFakeSignedPdf({ acroFormType: true, indirectAnnots: true });
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(true);
    const out = await signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS });
    expect(Buffer.from(out.subarray(0, bytes.length))).toEqual(Buffer.from(bytes));
    expect(await activeFieldsRefs(out)).toHaveLength(2);
  }, 40000);

  it('counter-signs a PDF with an inline AcroForm whose /Fields is indirect', async () => {
    // Inline /AcroForm in the catalog, but /Fields is its own indirect array — the
    // existing fields must be preserved, not replaced with a fresh empty array.
    const bytes = await makeFakeSignedPdf({
      acroFormType: true,
      inlineAcroForm: true,
      indirectFields: true,
    });
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(true);
    const out = await signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS });
    expect(Buffer.from(out.subarray(0, bytes.length))).toEqual(Buffer.from(bytes));
    expect(await activeFieldsRefs(out)).toHaveLength(2);
  }, 40000);

  it('counter-signs a PDF saved with cross-reference/object streams', async () => {
    // Foreign producers often save with xref streams; the old string-surgery path
    // could not even parse these ("structure isn't supported").
    const bytes = await makeFakeSignedPdf({ acroFormType: true, objectStreams: true });
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(true);
    const out = await signIncremental(bytes, at(0.42), { p12Bytes: p12, password: PASS });
    expect(Buffer.from(out.subarray(0, bytes.length))).toEqual(Buffer.from(bytes));
    expect(await activeFieldsRefs(out)).toHaveLength(2);

    // Guard the container-clobber bug directly. In a compressed file the only real
    // `N g obj` headers are the object-stream (/Type /ObjStm) and cross-reference-stream
    // (/Type /XRef) containers; the catalog, page, AcroForm and the earlier signature all
    // live INSIDE the ObjStm. If the counter-sign reuses one of those container numbers
    // for a brand-new object (image/appearance/sig/widget), the ObjStm is overwritten and
    // every object it held stops resolving via the xref — Acrobat then reports "Expected a
    // dict object" against the EARLIER signature. pdf-lib resolves by byte-scanning headers
    // rather than following the xref, so `activeFieldsRefs` above cannot see this: only a
    // header-number collision between the base file and the appended revision can. See
    // reserveExistingObjectNumbers in incrementalUpdate.ts.
    const headerNums = (buf: Uint8Array): Set<number> => {
      const s = Buffer.from(buf).toString('latin1');
      const nums = new Set<number>();
      for (const m of s.matchAll(/(?:^|\n)(\d+) \d+ obj/g)) nums.add(Number(m[1]));
      return nums;
    };
    const baseHeaders = headerNums(bytes);
    const appendedHeaders = headerNums(out.subarray(bytes.length));
    const clobbered = [...appendedHeaders].filter((n) => baseHeaders.has(n));
    expect(clobbered).toEqual([]);
  }, 40000);

  it('counter-signs on a page other than the first (widget lands on that page)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([300, 400]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.getPages()[0].drawText('two-page document', { x: 20, y: 360, size: 12, font });
    const base = await doc.save();
    const cert = { p12Bytes: p12, password: PASS };
    const signed = await signFirst(base, at(0.62), cert);

    const out = await signIncremental(signed, { ...at(0.42), pageIndex: 1 }, cert);

    // Pure append; the first signature's bytes are untouched; both fields enumerable.
    expect(Buffer.from(out.subarray(0, signed.length))).toEqual(Buffer.from(signed));
    expect(await activeFieldsRefs(out)).toHaveLength(2);

    // The new widget is attached to PAGE 2's /Annots (the whole point of the fix).
    const reparsed = await PDFDocument.load(out);
    const fieldRefs = await activeFieldsRefs(out);
    const p2Annots = reparsed.getPages()[1].node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const p2Refs: string[] = [];
    for (let i = 0; p2Annots && i < p2Annots.size(); i++) {
      p2Refs.push(String(p2Annots.get(i)));
    }
    expect(fieldRefs.some((r) => p2Refs.includes(r))).toBe(true);

    // Feed the gate this combo too: both signatures must validate.
    writeFileSync(resolve(OUT, 'signed-counter-page2.pdf'), out);
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

describe('reserveExistingObjectNumbers (untrusted-bytes hardening)', () => {
  // The floor scan runs on attacker-controllable PDF bytes; these guard the two ways it
  // could go wrong — a real container header it must NOT miss, and a bogus one it must
  // NOT trust (Codex, PR #9).
  const base = async () => {
    const doc = await PDFDocument.create();
    doc.addPage([10, 10]);
    return doc;
  };
  const bytesOf = (s: string, minLen = 0) =>
    new TextEncoder().encode(s.padEnd(minLen, ' '));

  it('counts a header whose tokens are separated by a % comment (PDF whitespace)', async () => {
    const probe = await base();
    const start = probe.context.largestObjectNumber;
    const target = start + 5;
    // `N 0 %comment\nobj` is a header pdf-lib parses; a whitespace-only scan would miss it.
    reserveExistingObjectNumbers(bytesOf(`%PDF-1.7\n${target} 0 %inline comment\nobj\n<< >>\nendobj\n`, 300), probe);
    expect(probe.context.largestObjectNumber).toBe(target);
  });

  it('rejects an implausible object number that would exhaust safe integers', async () => {
    const probe = await base();
    const start = probe.context.largestObjectNumber;
    const real = start + 7;
    // A crafted MAX_SAFE_INTEGER header passes Number.isSafeInteger but must be dropped:
    // taking it as the floor would saturate nextRef()'s `+= 1` and duplicate object numbers.
    const doc = bytesOf(`%PDF-1.7\n9007199254740991 0 obj\n<< >>\nendobj\n${real} 0 obj\n<< >>\nendobj\n`, 300);
    reserveExistingObjectNumbers(doc, probe);
    // The huge number (> file length) is ignored; the plausible one sets the floor.
    expect(probe.context.largestObjectNumber).toBe(real);
    expect(probe.context.largestObjectNumber).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
