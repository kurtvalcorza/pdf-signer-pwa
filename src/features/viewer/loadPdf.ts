import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';

export interface LoadedPdf {
  bytes: Uint8Array;
  pageCount: number;
  hasExistingSignature: boolean;
}

/**
 * Load a PDF's bytes and basic structure. Rejects encrypted PDFs (edge case) and
 * flags an existing signature so the UI can warn about invalidation (FR-017).
 * All in-memory; no network (Principle I).
 */
export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    if (err instanceof Error && /encrypt/i.test(err.message)) {
      throw new Error('This PDF is password-protected and cannot be signed. Remove its password first.');
    }
    throw new Error('This file could not be read as a PDF.');
  }

  return {
    bytes,
    pageCount: doc.getPageCount(),
    hasExistingSignature: detectSignature(doc, bytes),
  };
}

/**
 * True if the document has an applied signature (so the UI can warn that stamping
 * would invalidate it — FR-017). A PDF signature is always an AcroForm field whose
 * value (`/V`) is a signature dictionary carrying a `/ByteRange`, so we inspect the
 * parsed structure rather than scanning raw bytes — a byte scan false-positives on an
 * incidental `/ByteRange [...]` in page text or a comment. If the structure can't be
 * walked, fall back to the recall-safe byte heuristic rather than risk missing a real
 * signature (a missed warning is the harmful failure).
 */
function detectSignature(doc: PDFDocument, bytes: Uint8Array): boolean {
  try {
    return hasSignatureField(doc);
  } catch {
    return /\/ByteRange\s*\[\s*\d+\s+\d+\s+\d+\s+\d+/.test(new TextDecoder('latin1').decode(bytes));
  }
}

/** Walk the AcroForm fields (and their kids) for a signed signature field. */
function hasSignatureField(doc: PDFDocument): boolean {
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return false;

  const stack: PDFDict[] = [];
  const push = (arr: PDFArray) => {
    for (let i = 0; i < arr.size(); i++) {
      const d = arr.lookupMaybe(i, PDFDict);
      if (d) stack.push(d);
    }
  };
  push(fields);

  const seen = new Set<PDFDict>();
  while (stack.length) {
    const field = stack.pop()!;
    if (seen.has(field)) continue; // guard against cyclic /Parent–/Kids references
    seen.add(field);

    // A *signed* field has /V = signature dict with /ByteRange. Empty (placeholder)
    // signature fields have no such /V and must not trigger the warning.
    const value = field.lookupMaybe(PDFName.of('V'), PDFDict);
    if (value?.lookupMaybe(PDFName.of('ByteRange'), PDFArray)) return true;

    const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) push(kids);
  }
  return false;
}
