/**
 * The signature fields pdf-lib sees, enumerated the way pyHanko's `enumerate_sig_fields` does
 * (pyhanko/pdf_utils/form_tools.py `enumerate_fields_in`), for the T8 cross-check in
 * scripts/verify-signatures.mjs (spec 004 T042, contracts/signature-gate.md).
 *
 * Walks /AcroForm /Fields and /Kids: an entry that is not a reference or not a dictionary is
 * skipped, a node without /T is a bare widget and skipped, /FT is inherited down the walked
 * path, and a node whose type is /Sig yields its fully qualified name. A reference seen twice on
 * one path throws, as pyHanko raises on a circular form tree.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';

const N = (s) => PDFName.of(s);

function text(obj) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return null;
}

/** Sorted fully qualified names of every signature field pdf-lib finds in `bytes`. */
export async function pdfLibSigFieldNames(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const ctx = doc.context;
  const acro = doc.catalog.lookup(N('AcroForm'));
  if (!(acro instanceof PDFDict)) return [];
  const fields = acro.lookup(N('Fields'));
  if (!(fields instanceof PDFArray)) return [];

  const names = [];
  const walk = (list, parentName, parents, seen) => {
    for (let i = 0; i < list.size(); i++) {
      const ref = list.get(i);
      if (!(ref instanceof PDFRef)) continue;
      if (seen.has(ref.toString())) throw new Error('Circular reference in form tree');
      const field = ctx.lookup(ref);
      if (!(field instanceof PDFDict)) continue;
      const own = text(field.lookup(N('T')));
      if (own === null) continue;
      const fq = parentName ? `${parentName}.${own}` : own;
      const path = [field, ...parents];
      let type;
      for (const node of path) {
        const ft = node.get(N('FT'));
        if (ft !== undefined) {
          type = ctx.lookup(ft);
          break;
        }
      }
      if (type === N('Sig')) names.push(fq);
      const kids = field.lookup(N('Kids'));
      if (kids instanceof PDFArray) walk(kids, fq, path, new Set([...seen, ref.toString()]));
    }
  };
  walk(fields, '', [], new Set());
  return names.sort();
}
