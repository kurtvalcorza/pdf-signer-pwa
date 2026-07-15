import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import type { PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword } from './cert';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { clampBox, normalizedBoxToPdfRect, type Rotation } from '../../lib/coords';

/**
 * Tier B — a subsequent cryptographic signature added as a BYTE-LEVEL INCREMENTAL
 * update (research R4). The already-signed bytes are never re-serialized, so
 * earlier signatures stay valid (FR-013 / SC-009).
 *
 * NOTE (known limitation): the incremental placeholder produces a visible widget
 * but not an image appearance.
 *
 * Two guards keep the FR-013 claim honest rather than best-effort:
 *  - a certification (DocMDP) signature with a "no changes" policy rejects up
 *    front (CertificationLockedError) — appending anything would break it;
 *  - after the placeholder is built, the update's rewritten AcroForm must still
 *    reference every pre-existing field. placeholder-plain re-finds the form by
 *    scanning for "/Type /AcroForm"; on producers that omit /Type (pdf-lib did,
 *    before signFirst started forcing it) the rewrite silently drops the earlier
 *    signature fields, so validators stop enumerating those signatures even
 *    though their bytes survive. We refuse to emit such a file.
 */
export async function signIncremental(
  signedPdf: Uint8Array,
  placement: PlacementInput,
  cert: Pkcs12,
): Promise<Uint8Array> {
  if (!verifyCertPassword(cert.p12Bytes, cert.password)) {
    const { BadPasswordError } = await import('./types');
    throw new BadPasswordError();
  }

  // Read page geometry WITHOUT mutating/saving the signed bytes (read-only load).
  const probe = await PDFDocument.load(signedPdf);

  if (isCertificationLocked(probe)) {
    const { CertificationLockedError } = await import('./types');
    throw new CertificationLockedError();
  }

  const page = probe.getPages()[placement.pageIndex];
  if (!page) throw new Error(`Signature targets a missing page (index ${placement.pageIndex}).`);
  const { width, height } = page.getSize();
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as Rotation;
  const box = clampBox({ nx: placement.nx, ny: placement.ny, nw: placement.nw, nh: placement.nh });
  const rect = normalizedBoxToPdfRect(box, { widthPt: width, heightPt: height, rotation });

  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: Buffer.from(signedPdf),
    reason: 'Digitally signed',
    contactInfo: '',
    name: 'Signer',
    location: '',
    widgetRect: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
  });

  assertFieldsPreserved(probe, withPlaceholder);

  const signer = new P12Signer(cert.p12Bytes, { passphrase: cert.password });
  const signed = await signpdf.sign(withPlaceholder, signer);
  return new Uint8Array(signed);
}

/**
 * True if the document carries a certification (DocMDP) signature whose
 * /TransformParams /P is 1 — "no changes allowed". P of 2 (form-fill + sign) or
 * 3 (+ annotate) permits appending an approval signature; a missing /P defaults
 * to 2 per the PDF spec.
 */
function isCertificationLocked(doc: PDFDocument): boolean {
  const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  const certSig = perms?.lookupMaybe(PDFName.of('DocMDP'), PDFDict);
  const refs = certSig?.lookupMaybe(PDFName.of('Reference'), PDFArray);
  if (!refs) return false;
  for (let i = 0; i < refs.size(); i++) {
    const sigRef = refs.lookupMaybe(i, PDFDict);
    if (sigRef?.lookupMaybe(PDFName.of('TransformMethod'), PDFName) !== PDFName.of('DocMDP')) {
      continue;
    }
    const params = sigRef.lookupMaybe(PDFName.of('TransformParams'), PDFDict);
    const p = params?.lookupMaybe(PDFName.of('P'), PDFNumber);
    if ((p?.asNumber() ?? 2) === 1) return true;
  }
  return false;
}

/**
 * The incremental update rewrites the active AcroForm. Every field the document
 * already had must still be referenced by that rewritten /Fields array — anything
 * less silently un-enumerates an existing signature. Throws if any field was lost.
 */
function assertFieldsPreserved(probe: PDFDocument, withPlaceholder: Buffer): void {
  const acroRef = probe.catalog.get(PDFName.of('AcroForm'));
  const acroDict = probe.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acroDict?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!(acroRef instanceof PDFRef) || !fields || fields.size() === 0) return;

  const existingRefs: string[] = [];
  for (let i = 0; i < fields.size(); i++) {
    const ref = fields.get(i);
    if (ref instanceof PDFRef) existingRefs.push(`${ref.objectNumber} ${ref.generationNumber} R`);
  }

  // The last definition of the AcroForm object in the file is the active one.
  const text = withPlaceholder.toString('latin1');
  const headerRe = new RegExp(`(?:^|\\n)${acroRef.objectNumber} ${acroRef.generationNumber} obj\\b`, 'g');
  let last = -1;
  for (let m = headerRe.exec(text); m; m = headerRe.exec(text)) last = m.index;
  if (last === -1) throw fieldsLost();
  const body = text.slice(last, text.indexOf('endobj', last));
  const fieldsMatch = /\/Fields\s*\[([^\]]*)\]/.exec(body);
  if (!fieldsMatch) throw fieldsLost();
  const rewritten = fieldsMatch[1];
  for (const ref of existingRefs) {
    if (!new RegExp(`(?:^|[^0-9])${ref.replace(/ /g, '\\s+')}(?![0-9])`).test(rewritten)) {
      throw fieldsLost();
    }
  }
}

function fieldsLost(): Error {
  return new Error(
    'The incremental update could not preserve the existing signature field(s) of this ' +
      'PDF, which would hide the earlier signature(s) from validators. The document was ' +
      'left unsigned.',
  );
}
