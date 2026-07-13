import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import type { PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword } from './cert';
import { PDFDocument } from 'pdf-lib';
import { clampBox, normalizedBoxToPdfRect, type Rotation } from '../../lib/coords';

/**
 * Tier B — a subsequent cryptographic signature added as a BYTE-LEVEL INCREMENTAL
 * update (research R4). The already-signed bytes are never re-serialized, so
 * earlier signatures stay valid (FR-013 / SC-009).
 *
 * NOTE (known limitation): the incremental placeholder produces a visible widget
 * but not an image appearance. Also, when the FIRST signature was made by
 * `signFirst` (pdf-lib-built AcroForm), a subsequent `placeholder-plain` update
 * does not reliably re-find that AcroForm, so pyHanko may enumerate only the
 * latest signature. Plain+plain incremental multi-sign is fully verified (the
 * spike's signed-2: two intact+valid signatures, SC-009). Robust image-appearance
 * multi-signature is a follow-up. The single-signature image path (signFirst) is
 * the validated primary flow.
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

  const signer = new P12Signer(cert.p12Bytes, { passphrase: cert.password });
  const signed = await signpdf.sign(withPlaceholder, signer);
  return new Uint8Array(signed);
}
