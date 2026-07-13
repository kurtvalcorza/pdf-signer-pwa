import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import type { PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword } from './cert';
import { clampBox, normalizedBoxToPdfRect, type Rotation } from '../../lib/coords';

/**
 * Tier B — first cryptographic signature (research R3; contracts/signing-engine.md).
 *
 * The placed image becomes the APPEARANCE of a visible signature field: we let
 * @signpdf build the field/widget/placeholder, then replace the widget's empty
 * appearance stream (AP.N) with a form XObject that draws the embedded image.
 * The result is a clickable, verifiable signature whose face is the image
 * (FR-011/012).
 *
 * Precondition: any Tier-A visual stamps must already be baked into `pdf` — no
 * page-content mutation happens after the placeholder (FR-014 / Principle III).
 */
export async function signFirst(
  pdf: Uint8Array,
  placement: PlacementInput,
  cert: Pkcs12,
): Promise<Uint8Array> {
  if (!verifyCertPassword(cert.p12Bytes, cert.password)) {
    // typed error so the UI can report a wrong password without producing output.
    const { BadPasswordError } = await import('./types');
    throw new BadPasswordError();
  }

  const doc = await PDFDocument.load(pdf);
  const page = doc.getPages()[placement.pageIndex];
  if (!page) throw new Error(`Signature targets a missing page (index ${placement.pageIndex}).`);

  const { width, height } = page.getSize();
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as Rotation;
  const box = clampBox({ nx: placement.nx, ny: placement.ny, nw: placement.nw, nh: placement.nh });
  const rect = normalizedBoxToPdfRect(box, { widthPt: width, heightPt: height, rotation });
  const widgetRect: [number, number, number, number] = [
    rect.x,
    rect.y,
    rect.x + rect.w,
    rect.y + rect.h,
  ];

  // Embed the image as an XObject we can reference from the appearance stream.
  const image =
    placement.format === 'png'
      ? await doc.embedPng(placement.imageBytes)
      : await doc.embedJpg(placement.imageBytes);

  // Build field + widget + ByteRange/Contents placeholder (empty appearance).
  pdflibAddPlaceholder({
    pdfDoc: doc,
    pdfPage: page,
    reason: 'Digitally signed',
    contactInfo: '',
    name: 'Signer',
    location: '',
    widgetRect,
  });

  // Replace the widget's empty appearance (AP.N) with one that draws the image.
  const widget = lastWidget(doc, page);
  const apDict = widget.lookup(PDFName.of('AP'), PDFDict);
  const apContent = `q ${rect.w} 0 0 ${rect.h} 0 0 cm /Img Do Q`;
  const apStream = doc.context.stream(apContent, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, rect.w, rect.h],
    Resources: { XObject: { Img: image.ref } },
  });
  apDict.set(PDFName.of('N'), doc.context.register(apStream));

  // Save with a cross-reference table (no object streams — required for signing).
  const withPlaceholder = await doc.save({ useObjectStreams: false });

  const signer = new P12Signer(cert.p12Bytes, { passphrase: cert.password });
  const signed = await signpdf.sign(Buffer.from(withPlaceholder), signer);
  return new Uint8Array(signed);
}

/** The signature widget @signpdf just appended is the last annotation on the page. */
function lastWidget(doc: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number]): PDFDict {
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
  const ref = annots.get(annots.size() - 1) as PDFRef;
  return doc.context.lookup(ref, PDFDict);
}
