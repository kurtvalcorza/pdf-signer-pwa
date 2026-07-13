import { PDFDocument } from 'pdf-lib';

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
    hasExistingSignature: detectSignature(bytes),
  };
}

/**
 * Cheap byte-level check for an existing signature dictionary. A bare `/ByteRange`
 * is too loose (it appears in unrelated content and false-positives), so require an
 * actual signature dictionary: a `/Type /Sig` object, or a `/ByteRange` paired with
 * a recognised signature sub-filter (PKCS#7 / CAdES).
 */
function detectSignature(bytes: Uint8Array): boolean {
  const text = new TextDecoder('latin1').decode(bytes);
  if (text.includes('/Type /Sig') || text.includes('/Type/Sig')) return true;
  return (
    /\/ByteRange\s*\[/.test(text) &&
    /\/SubFilter\s*\/(adbe\.pkcs7|ETSI\.CAdES)/i.test(text)
  );
}
