import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, StandardFonts } from 'pdf-lib';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import type { PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword, getSignerCommonName } from './cert';
import { clampBox, normalizedBoxToPdfRect, type Rotation } from '../../lib/coords';

export interface SignFirstOptions {
  /** Show "Digitally signed by {name}" text beside the image (Adobe-style). Default true. */
  label?: boolean;
  /** Override the display name; defaults to the certificate's common name. */
  displayName?: string;
}

const escPdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

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
  opts: SignFirstOptions = {},
): Promise<Uint8Array> {
  if (!verifyCertPassword(cert.p12Bytes, cert.password)) {
    // typed error so the UI can report a wrong password without producing output.
    const { BadPasswordError } = await import('./types');
    throw new BadPasswordError();
  }

  const showLabel = opts.label !== false;
  const signerName =
    opts.displayName ?? getSignerCommonName(cert.p12Bytes, cert.password) ?? 'Signer';

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

  // Replace the widget's empty appearance (AP.N) with the composed image (+ text).
  const widget = lastWidget(doc, page);
  const apDict = widget.lookup(PDFName.of('AP'), PDFDict);

  const { content: apContent, resources } = await buildAppearance(
    doc,
    rect.w,
    rect.h,
    image.ref,
    showLabel ? signerName : null,
  );
  const apStream = doc.context.stream(apContent, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, rect.w, rect.h],
    Resources: resources,
  } as Parameters<typeof doc.context.stream>[1]);
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

/**
 * Compose the signature appearance. Without a name: the image fills the box.
 * With a name: image on the left, "Digitally signed by / {name}" on the right
 * (the Adobe-style layout).
 */
async function buildAppearance(
  doc: PDFDocument,
  w: number,
  h: number,
  imageRef: PDFRef,
  name: string | null,
): Promise<{ content: string; resources: Record<string, unknown> }> {
  if (!name) {
    return {
      content: `q ${w} 0 0 ${h} 0 0 cm /Img Do Q`,
      resources: { XObject: { Img: imageRef } },
    };
  }

  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Image occupies the left ~40%; text the right.
  const imgW = w * 0.38;
  const imgH = h * 0.82;
  const imgX = w * 0.02;
  const imgY = h * 0.09;
  const textX = w * 0.44;
  const maxTextW = w * 0.54;

  let sName = Math.min(h * 0.34, 18);
  while (sName > 5 && bold.widthOfTextAtSize(name, sName) > maxTextW) sName -= 0.5;
  const sLabel = Math.min(sName * 0.72, h * 0.24);

  const content = [
    `q ${imgW} 0 0 ${imgH} ${imgX} ${imgY} cm /Img Do Q`,
    `BT /FL ${sLabel.toFixed(2)} Tf 0.35 0.35 0.35 rg ${textX.toFixed(2)} ${(h * 0.6).toFixed(2)} Td (${escPdf('Digitally signed by')}) Tj ET`,
    `BT /FN ${sName.toFixed(2)} Tf 0.1 0.1 0.1 rg ${textX.toFixed(2)} ${(h * 0.28).toFixed(2)} Td (${escPdf(name)}) Tj ET`,
  ].join('\n');

  return {
    content,
    resources: { XObject: { Img: imageRef }, Font: { FL: helv.ref, FN: bold.ref } },
  };
}
