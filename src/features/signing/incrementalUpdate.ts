import {
  PDFObject,
  PDFKitReferenceMock,
  removeTrailingNewLine,
  ANNOTATION_FLAGS,
  SIG_FLAGS,
  DEFAULT_SIGNATURE_LENGTH,
  DEFAULT_BYTE_RANGE_PLACEHOLDER,
  SUBFILTER_ADOBE_PKCS7_DETACHED,
} from '@signpdf/utils';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';

export interface IncrementalPlaceholderOptions {
  pageIndex: number;
  /** [x1, y1, x2, y2] in PDF points, already rotation-compensated. */
  widgetRect: [number, number, number, number];
  reason?: string;
  signatureLength?: number;
}

/**
 * Append a signature-field placeholder to an already-signed PDF as a byte-level
 * incremental update, ready for @signpdf's `sign()` to fill in.
 *
 * Unlike @signpdf/placeholder-plain — which re-parses the file with string
 * surgery (first page only, inline /Annots only, classic xref tables only, and
 * an AcroForm findable only via a leading "/Type /AcroForm") — every document
 * read here comes from pdf-lib's parsed object graph (`probe`), so this works
 * on any page, PDFs with xref streams / object streams, indirect /Annots or
 * /Fields arrays, and AcroForm dicts from any producer. Only the NEW versions
 * of the touched objects are appended; the original bytes are never rewritten,
 * so existing signatures keep validating (FR-013).
 *
 * The appended cross-reference section is a classic table whose /Prev points at
 * the file's previous startxref — a hybrid readers accept even when the earlier
 * section is an xref stream.
 */
export function addIncrementalPlaceholder(
  signedPdf: Uint8Array,
  probe: PDFDocument,
  opts: IncrementalPlaceholderOptions,
): Buffer {
  const { pageIndex, widgetRect } = opts;
  const reason = opts.reason ?? 'Digitally signed';
  const signatureLength = opts.signatureLength ?? DEFAULT_SIGNATURE_LENGTH;

  const page = probe.getPages()[pageIndex];
  if (!page) throw new Error(`Signature targets a missing page (index ${pageIndex}).`);
  const ctx = probe.context;
  const rootRef = ctx.trailerInfo.Root;
  if (!(rootRef instanceof PDFRef)) {
    throw new Error('This PDF has no document catalog reference; it cannot be counter-signed.');
  }

  let out = removeTrailingNewLine(Buffer.from(signedPdf));
  const prevXref = lastStartXref(out);

  let nextObj = ctx.largestObjectNumber + 1;
  const added = new Map<number, number>(); // object number → byte offset of its header

  const append = (objNum: number, body: string): void => {
    added.set(objNum, out.length + 1);
    out = Buffer.concat([
      out,
      Buffer.from(`\n${objNum} 0 obj\n`),
      Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n'),
    ]);
  };

  // --- 1. Signature dictionary + widget (serialized with @signpdf's converter so
  // the /ByteRange and /Contents placeholders are exactly what sign() rewrites). ---
  const existingFieldRefs = acroFormFieldRefs(probe);
  const sigNum = nextObj++;
  append(
    sigNum,
    PDFObject.convert({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
      ByteRange: [
        0,
        DEFAULT_BYTE_RANGE_PLACEHOLDER,
        DEFAULT_BYTE_RANGE_PLACEHOLDER,
        DEFAULT_BYTE_RANGE_PLACEHOLDER,
      ],
      Contents: Buffer.from(String.fromCharCode(0).repeat(signatureLength)),
      Reason: new String(reason),
      M: new Date(),
    }),
  );
  const widgetNum = nextObj++;
  append(
    widgetNum,
    PDFObject.convert({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: widgetRect,
      V: new PDFKitReferenceMock(sigNum),
      T: new String(uniqueFieldName(probe, existingFieldRefs.length)),
      F: ANNOTATION_FLAGS.PRINT,
      P: new PDFKitReferenceMock(page.ref.objectNumber),
    }),
  );
  const widgetRef = PDFRef.of(widgetNum);

  // --- 2. AcroForm: merge the new field into the EXISTING form, preserving every
  // entry (/DR, /DA, …) and every existing field, wherever the form/fields live. ---
  const acroRaw = probe.catalog.get(PDFName.of('AcroForm'));
  if (acroRaw instanceof PDFRef) {
    const acroDict = probe.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const fieldsRaw = acroDict.get(PDFName.of('Fields'));
    acroDict.set(PDFName.of('SigFlags'), ctx.obj(SIG_FLAGS.SIGNATURES_EXIST | SIG_FLAGS.APPEND_ONLY));
    if (fieldsRaw instanceof PDFRef) {
      // /Fields is its own indirect array — update just that object.
      const arr = acroDict.lookup(PDFName.of('Fields'), PDFArray);
      arr.push(widgetRef);
      append(acroRaw.objectNumber, acroDict.toString());
      append(fieldsRaw.objectNumber, arr.toString());
    } else {
      const arr = fieldsRaw instanceof PDFArray ? fieldsRaw : ctx.obj([]);
      arr.push(widgetRef);
      acroDict.set(PDFName.of('Fields'), arr);
      append(acroRaw.objectNumber, acroDict.toString());
    }
  } else if (acroRaw instanceof PDFDict) {
    // AcroForm inline in the catalog — the catalog object itself must be rewritten.
    const arr = acroRaw.get(PDFName.of('Fields'));
    const fields = arr instanceof PDFArray ? arr : ctx.obj([]);
    fields.push(widgetRef);
    acroRaw.set(PDFName.of('Fields'), fields);
    acroRaw.set(PDFName.of('SigFlags'), ctx.obj(SIG_FLAGS.SIGNATURES_EXIST | SIG_FLAGS.APPEND_ONLY));
    append(rootRef.objectNumber, probe.catalog.toString());
  } else {
    // No form yet (possible when signature detection fell back to a byte scan):
    // create one and point the rewritten catalog at it.
    const acroNum = nextObj++;
    append(
      acroNum,
      PDFObject.convert({
        Type: 'AcroForm',
        SigFlags: SIG_FLAGS.SIGNATURES_EXIST | SIG_FLAGS.APPEND_ONLY,
        Fields: [new PDFKitReferenceMock(widgetNum)],
      }),
    );
    probe.catalog.set(PDFName.of('AcroForm'), PDFRef.of(acroNum));
    append(rootRef.objectNumber, probe.catalog.toString());
  }

  // --- 3. Attach the widget to the TARGET page's /Annots (inline or indirect). ---
  const annotsRaw = page.node.get(PDFName.of('Annots'));
  if (annotsRaw instanceof PDFRef) {
    const arr = page.node.lookup(PDFName.of('Annots'), PDFArray);
    arr.push(widgetRef);
    append(annotsRaw.objectNumber, arr.toString());
  } else {
    const arr = annotsRaw instanceof PDFArray ? annotsRaw : ctx.obj([]);
    arr.push(widgetRef);
    page.node.set(PDFName.of('Annots'), arr);
    append(page.ref.objectNumber, page.node.toString());
  }

  // --- 4. Classic cross-reference table + trailer for the appended objects. ---
  const xrefOffset = out.length + 1;
  const entries = [...added.entries()].sort((a, b) => a[0] - b[0]);
  const sections = ['0 1\n0000000000 65535 f '];
  for (const [objNum, offset] of entries) {
    sections.push(`${objNum} 1\n${String(offset).padStart(10, '0')} 00000 n `);
  }
  const infoRef = ctx.trailerInfo.Info;
  const trailer =
    '<<\n' +
    `/Size ${nextObj}\n` +
    `/Root ${rootRef.objectNumber} ${rootRef.generationNumber} R\n` +
    (infoRef instanceof PDFRef
      ? `/Info ${infoRef.objectNumber} ${infoRef.generationNumber} R\n`
      : '') +
    `/Prev ${prevXref}\n` +
    '>>';
  out = Buffer.concat([
    out,
    Buffer.from(`\nxref\n${sections.join('\n')}\ntrailer\n${trailer}\nstartxref\n${xrefOffset}\n%%EOF`),
  ]);
  return out;
}

/** Byte offset of the file's last cross-reference section (its `startxref` value). */
function lastStartXref(pdf: Buffer): number {
  const tail = pdf.subarray(Math.max(0, pdf.length - 2048)).toString('latin1');
  const matches = [...tail.matchAll(/startxref\s+(\d+)/g)];
  if (matches.length === 0) {
    throw new Error('This PDF has no cross-reference trailer; it cannot be counter-signed.');
  }
  return Number(matches[matches.length - 1][1]);
}

/** Root-level field refs of the document's AcroForm (empty when there is no form). */
export function acroFormFieldRefs(probe: PDFDocument): PDFRef[] {
  const acro = probe.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return [];
  const refs: PDFRef[] = [];
  for (let i = 0; i < fields.size(); i++) {
    const ref = fields.get(i);
    if (ref instanceof PDFRef) refs.push(ref);
  }
  return refs;
}

/** "SignatureN" not colliding with any existing field's /T. */
function uniqueFieldName(probe: PDFDocument, fieldCount: number): string {
  const taken = new Set<string>();
  const acro = probe.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (fields) {
    for (let i = 0; i < fields.size(); i++) {
      const t = fields.lookupMaybe(i, PDFDict)?.get(PDFName.of('T'));
      if (t) taken.add(t.toString());
    }
  }
  for (let n = fieldCount + 1; ; n++) {
    const name = `Signature${n}`;
    if (!taken.has(`(${name})`) && !taken.has(name)) return name;
  }
}
