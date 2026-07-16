import {
  PDFObject,
  PDFAbstractReference,
  ANNOTATION_FLAGS,
  SIG_FLAGS,
  DEFAULT_SIGNATURE_LENGTH,
  DEFAULT_BYTE_RANGE_PLACEHOLDER,
  SUBFILTER_ADOBE_PKCS7_DETACHED,
} from '@signpdf/utils';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';

/**
 * An indirect reference `N g R` for `PDFObject.convert`. `PDFKitReferenceMock`
 * always serializes generation 0, which is wrong for objects (e.g. the target
 * page) whose real generation is non-zero — a `/P N 0 R` would then point at a
 * missing object. This carries the true generation.
 */
class Ref extends PDFAbstractReference {
  constructor(
    private readonly num: number,
    private readonly gen = 0,
  ) {
    super();
  }
  toString(): string {
    return `${this.num} ${this.gen} R`;
  }
}

export interface IncrementalPlaceholderOptions {
  pageIndex: number;
  /** [x1, y1, x2, y2] in PDF points, already rotation-compensated. */
  widgetRect: [number, number, number, number];
  reason?: string;
  signatureLength?: number;
  appearanceRef?: PDFRef;
  originalLargestObjectNumber?: number;
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

  // NEVER mutate the original bytes: the prior signature's /ByteRange may cover them
  // (trailing newlines included), so trimming would break that signature's digest even
  // though the structural re-parse still passes. We only ever append; the "\n" that
  // `append` writes before each object is the separator from the original content.
  let out = Buffer.from(signedPdf);
  const prevXref = lastStartXref(out);

  const originalLargest = opts.originalLargestObjectNumber ?? ctx.largestObjectNumber;
  let nextObj = ctx.largestObjectNumber + 1;
  // object number → { byte offset of its header, generation }.
  const added = new Map<number, { offset: number; gen: number }>();

  // Appending a NEW version of an existing object must reuse that object's number AND
  // generation — a reader resolves "N g R" and would ignore an "N 0 obj" replacement when
  // g != 0. New objects (sig/widget/new form) are allocated at generation 0.
  const append = (objNum: number, gen: number, body: string): void => {
    added.set(objNum, { offset: out.length + 1, gen });
    out = Buffer.concat([
      out,
      Buffer.from(`\n${objNum} ${gen} obj\n`),
      Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n'),
    ]);
  };

  // --- 0. Any newly embedded appearance resources (image/font) created on the probe.
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref.objectNumber > originalLargest) {
      append(ref.objectNumber, ref.generationNumber, obj.toString());
    }
  }

  // --- 1. Signature dictionary + widget (serialized with @signpdf's converter so
  // the /ByteRange and /Contents placeholders are exactly what sign() rewrites). ---
  const existingFieldRefs = acroFormFieldRefs(probe);
  const sigNum = nextObj++;
  append(
    sigNum,
    0,
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
    0,
    PDFObject.convert({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: widgetRect,
      V: new Ref(sigNum),
      T: new String(uniqueFieldName(probe, existingFieldRefs.length)),
      F: ANNOTATION_FLAGS.PRINT,
      // /P must carry the page's REAL generation, or it points at a missing object.
      P: new Ref(page.ref.objectNumber, page.ref.generationNumber),
      ...(opts.appearanceRef
        ? {
            AP: {
              N: new Ref(opts.appearanceRef.objectNumber, opts.appearanceRef.generationNumber),
            },
          }
        : {}),
    }),
  );
  const widgetRef = PDFRef.of(widgetNum);

  // --- 2. AcroForm: merge the new field into the EXISTING form, preserving every
  // entry (/DR, /DA, …) and every existing field, wherever the form/fields live. ---
  const acroRaw = probe.catalog.get(PDFName.of('AcroForm'));
  if (acroRaw instanceof PDFRef) {
    const acroDict = probe.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const fieldsRaw = acroDict.get(PDFName.of('Fields'));
    acroDict.set(
      PDFName.of('SigFlags'),
      ctx.obj(SIG_FLAGS.SIGNATURES_EXIST | SIG_FLAGS.APPEND_ONLY),
    );
    if (fieldsRaw instanceof PDFRef) {
      // /Fields is its own indirect array — update just that object.
      const arr = acroDict.lookup(PDFName.of('Fields'), PDFArray);
      arr.push(widgetRef);
      append(acroRaw.objectNumber, acroRaw.generationNumber, acroDict.toString());
      append(fieldsRaw.objectNumber, fieldsRaw.generationNumber, arr.toString());
    } else {
      const arr = fieldsRaw instanceof PDFArray ? fieldsRaw : ctx.obj([]);
      arr.push(widgetRef);
      acroDict.set(PDFName.of('Fields'), arr);
      append(acroRaw.objectNumber, acroRaw.generationNumber, acroDict.toString());
    }
  } else if (acroRaw instanceof PDFDict) {
    // AcroForm inline in the catalog — the catalog object itself must be rewritten.
    const fieldsRaw = acroRaw.get(PDFName.of('Fields'));
    acroRaw.set(
      PDFName.of('SigFlags'),
      ctx.obj(SIG_FLAGS.SIGNATURES_EXIST | SIG_FLAGS.APPEND_ONLY),
    );
    if (fieldsRaw instanceof PDFRef) {
      // /Fields is an indirect array even though the form is inline — update that
      // object in place, don't discard it (it holds every existing field).
      const arr = acroRaw.lookup(PDFName.of('Fields'), PDFArray);
      arr.push(widgetRef);
      append(rootRef.objectNumber, rootRef.generationNumber, probe.catalog.toString());
      append(fieldsRaw.objectNumber, fieldsRaw.generationNumber, arr.toString());
    } else {
      const arr = fieldsRaw instanceof PDFArray ? fieldsRaw : ctx.obj([]);
      arr.push(widgetRef);
      acroRaw.set(PDFName.of('Fields'), arr);
      append(rootRef.objectNumber, rootRef.generationNumber, probe.catalog.toString());
    }
  } else {
    // No form yet (possible when signature detection fell back to a byte scan):
    // create one and point the rewritten catalog at it.
    const acroNum = nextObj++;
    append(
      acroNum,
      0,
      PDFObject.convert({
        Type: 'AcroForm',
        SigFlags: SIG_FLAGS.SIGNATURES_EXIST | SIG_FLAGS.APPEND_ONLY,
        Fields: [new Ref(widgetNum)],
      }),
    );
    probe.catalog.set(PDFName.of('AcroForm'), PDFRef.of(acroNum));
    append(rootRef.objectNumber, rootRef.generationNumber, probe.catalog.toString());
  }

  // --- 3. Attach the widget to the TARGET page's /Annots (inline or indirect). ---
  const annotsRaw = page.node.get(PDFName.of('Annots'));
  if (annotsRaw instanceof PDFRef) {
    // A terminal widget field may share ONE indirect array as both the AcroForm
    // /Fields and the page /Annots. If step 2 already appended that object, the
    // widget is in it — pushing again here would duplicate it (and trip the guard).
    if (!added.has(annotsRaw.objectNumber)) {
      const arr = page.node.lookup(PDFName.of('Annots'), PDFArray);
      arr.push(widgetRef);
      append(annotsRaw.objectNumber, annotsRaw.generationNumber, arr.toString());
    }
  } else {
    const arr = annotsRaw instanceof PDFArray ? annotsRaw : ctx.obj([]);
    arr.push(widgetRef);
    page.node.set(PDFName.of('Annots'), arr);
    append(page.ref.objectNumber, page.ref.generationNumber, page.node.toString());
  }

  // --- 4. Classic cross-reference table + trailer for the appended objects. ---
  const xrefOffset = out.length + 1;
  const entries = [...added.entries()].sort((a, b) => a[0] - b[0]);
  const sections = ['0 1\n0000000000 65535 f '];
  for (const [objNum, { offset, gen }] of entries) {
    sections.push(
      `${objNum} 1\n${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} n `,
    );
  }
  // Carry /Info and /ID forward from the file's PREVIOUS trailer, read from the bytes
  // themselves — not from pdf-lib's trailerInfo, which fabricates an /Info object when
  // the original had none (that would emit a dangling reference). Dropping /ID would
  // also break PDF/A and other conformance validators on the counter-signed output.
  const prev = previousTrailerEntries(out, prevXref);
  const trailer =
    '<<\n' +
    `/Size ${nextObj}\n` +
    `/Root ${rootRef.objectNumber} ${rootRef.generationNumber} R\n` +
    (prev.info ? `/Info ${prev.info}\n` : '') +
    (prev.id ? `/ID ${prev.id}\n` : '') +
    `/Prev ${prevXref}\n` +
    '>>';
  out = Buffer.concat([
    out,
    Buffer.from(
      `\nxref\n${sections.join('\n')}\ntrailer\n${trailer}\nstartxref\n${xrefOffset}\n%%EOF`,
    ),
  ]);
  return out;
}

/**
 * The `/Info` reference and `/ID` array of the file's previous trailer, read verbatim
 * from the bytes at `prevXref`. Handles both a classic `trailer << … >>` and an
 * xref-stream object (`N g obj << /Type /XRef … >>`). Missing entries come back
 * undefined, so we never emit a `/Info`/`/ID` the original didn't have.
 */
function previousTrailerEntries(pdf: Buffer, prevXref: number): { info?: string; id?: string } {
  const from = pdf.subarray(prevXref).toString('latin1');
  // A classic section starts with the `xref` keyword; its trailer dict follows the
  // `trailer` keyword. An xref stream is a plain object whose own dict we read.
  const dictSource = from.trimStart().startsWith('xref')
    ? from.slice(from.indexOf('trailer') + 'trailer'.length)
    : from;
  const dict = firstDictText(dictSource);
  return {
    info: /\/Info\s+(\d+\s+\d+\s+R)/.exec(dict)?.[1],
    id: /\/ID\s*(\[[^\]]*\])/.exec(dict)?.[1],
  };
}

/** The first balanced `<< … >>` dictionary in `s` (empty string if none). */
function firstDictText(s: string): string {
  const start = s.indexOf('<<');
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < s.length - 1; i++) {
    if (s[i] === '<' && s[i + 1] === '<') {
      depth++;
      i++;
    } else if (s[i] === '>' && s[i + 1] === '>') {
      depth--;
      i++;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return '';
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
