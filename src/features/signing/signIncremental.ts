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
 * Guards that keep the FR-013 claim honest rather than best-effort:
 *  - the placement must target page 1: placeholder-plain always attaches the
 *    widget to the FIRST page (its getPageRef reads /Kids[0]), so any other
 *    page index would put the signed field on the wrong page;
 *  - a certification (DocMDP "no changes") or FieldMDP-locked signature rejects
 *    up front (CertificationLockedError) — appending a field would break it;
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

  if (placement.pageIndex !== 0) {
    throw new Error(
      'A signature added to an already-signed PDF must be placed on page 1 — the ' +
        'incremental signer can only attach the signature field to the first page.',
    );
  }

  // Read page geometry WITHOUT mutating/saving the signed bytes (read-only load).
  const probe = await PDFDocument.load(signedPdf);

  const lock = modificationLock(probe);
  if (lock) {
    const { CertificationLockedError } = await import('./types');
    throw new CertificationLockedError(lock);
  }

  const page = probe.getPages()[placement.pageIndex];
  if (!page) throw new Error(`Signature targets a missing page (index ${placement.pageIndex}).`);

  // placeholder-plain splices the widget into the page's INLINE /Annots [...] with
  // string surgery; an indirect array (/Annots 12 0 R) would be mangled into a
  // malformed page dictionary or leave the widget unattached. Refuse up front.
  if (page.node.get(PDFName.of('Annots')) instanceof PDFRef) {
    throw new Error(
      "This signed PDF stores its page annotations indirectly, which the incremental " +
        'signer cannot update safely. The document was left unsigned.',
    );
  }

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
 * A human-readable reason if any existing signature's policy makes appending a new
 * signature field a disallowed modification, else null. Checked conservatively:
 *
 *  - DocMDP with /TransformParams /P 1 ("no changes allowed") — P of 2 (form-fill +
 *    sign) or 3 (+ annotate) permits an approval signature; missing /P defaults to 2
 *    per the PDF spec. Found via catalog /Perms or any signature's own /Reference.
 *  - FieldMDP (e.g. Acrobat's "lock fields after signing") — adding our field
 *    rewrites /Fields, a form modification the lock may disallow; we cannot prove
 *    the new field is permitted, so reject rather than risk breaking the signature.
 */
function modificationLock(doc: PDFDocument): string | null {
  for (const sig of allSignatureDicts(doc)) {
    const refs = sig.lookupMaybe(PDFName.of('Reference'), PDFArray);
    if (!refs) continue;
    for (let i = 0; i < refs.size(); i++) {
      const sigRef = refs.lookupMaybe(i, PDFDict);
      const method = sigRef?.lookupMaybe(PDFName.of('TransformMethod'), PDFName);
      if (method === PDFName.of('FieldMDP')) {
        return (
          'An existing signature on this PDF locks its form fields (FieldMDP). Adding a ' +
          'signature field could break that signature, so the document was not signed.'
        );
      }
      if (method === PDFName.of('DocMDP')) {
        const params = sigRef!.lookupMaybe(PDFName.of('TransformParams'), PDFDict);
        const p = params?.lookupMaybe(PDFName.of('P'), PDFNumber);
        if ((p?.asNumber() ?? 2) === 1) {
          return (
            'This PDF is certified with a “no changes allowed” policy. Adding any ' +
            'signature would break that certification, so it was not signed.'
          );
        }
      }
    }
  }
  return null;
}

/** The certification signature (catalog /Perms /DocMDP) plus every signed field's /V. */
function* allSignatureDicts(doc: PDFDocument): Generator<PDFDict> {
  const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  const certSig = perms?.lookupMaybe(PDFName.of('DocMDP'), PDFDict);
  if (certSig) yield certSig;

  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return;
  const stack: PDFDict[] = [];
  const seen = new Set<PDFDict>();
  const push = (arr: PDFArray) => {
    for (let i = 0; i < arr.size(); i++) {
      const d = arr.lookupMaybe(i, PDFDict);
      if (d) stack.push(d);
    }
  };
  push(fields);
  while (stack.length) {
    const field = stack.pop()!;
    if (seen.has(field)) continue; // cyclic /Parent–/Kids guard
    seen.add(field);
    const value = field.lookupMaybe(PDFName.of('V'), PDFDict);
    if (value?.lookupMaybe(PDFName.of('ByteRange'), PDFArray)) yield value;
    const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) push(kids);
  }
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
