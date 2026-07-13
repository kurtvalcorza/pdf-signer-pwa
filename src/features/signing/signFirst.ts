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
  /** Show a "Date: …" line in the appearance. Default true. */
  date?: boolean;
  /** Override the display name; defaults to the certificate's common name. */
  displayName?: string;
}

const escPdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
  const showDate = opts.date !== false;
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

  const { content: apContent, resources } = await buildAppearance(doc, rect.w, rect.h, image.ref, {
    name: showLabel ? signerName : null,
    dateStr: showDate ? `Date: ${formatDate(new Date())}` : null,
  });
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

interface AppearanceLine {
  text: string;
  bold: boolean;
}

/**
 * Compose the signature appearance. With no label and no date, the image fills the
 * box. Otherwise: image on the left, and a vertical stack of text lines on the right
 * ("Digitally signed by" / {name} / "Date: …") — the Adobe-style layout. Each line
 * is optional, so the user can turn the label and/or date off.
 */
async function buildAppearance(
  doc: PDFDocument,
  w: number,
  h: number,
  imageRef: PDFRef,
  opts: { name: string | null; dateStr: string | null },
): Promise<{ content: string; resources: Record<string, unknown> }> {
  const lines: AppearanceLine[] = [];
  if (opts.name) {
    lines.push({ text: 'Digitally signed by', bold: false });
    lines.push({ text: opts.name, bold: true });
  }
  if (opts.dateStr) lines.push({ text: opts.dateStr, bold: false });

  if (lines.length === 0) {
    return {
      content: `q ${w} 0 0 ${h} 0 0 cm /Img Do Q`,
      resources: { XObject: { Img: imageRef } },
    };
  }

  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Image left ~40%, text right.
  const imgW = w * 0.38;
  const imgH = h * 0.82;
  const imgX = w * 0.02;
  const imgY = h * 0.09;
  const textX = w * 0.44;
  const maxTextW = w * 0.54;

  // Size the bold (name) line to fit, then the smaller lines proportionally.
  const nameLine = lines.find((l) => l.bold);
  let sName = Math.min(h * 0.3, 16);
  if (nameLine) {
    while (sName > 5 && bold.widthOfTextAtSize(nameLine.text, sName) > maxTextW) sName -= 0.5;
  }
  let sSmall = Math.min(sName * 0.72, h * 0.22);
  const longestSmall = lines
    .filter((l) => !l.bold)
    .reduce((m, l) => (l.text.length > m.length ? l.text : m), '');
  while (sSmall > 4 && helv.widthOfTextAtSize(longestSmall, sSmall) > maxTextW) sSmall -= 0.5;

  const sizeOf = (l: AppearanceLine) => (l.bold ? sName : sSmall);
  const gap = h * 0.06;
  const totalH = lines.reduce((a, l) => a + sizeOf(l), 0) + gap * (lines.length - 1);

  const parts = [`q ${imgW} 0 0 ${imgH} ${imgX} ${imgY} cm /Img Do Q`];
  let top = (h + totalH) / 2; // vertically centered text block
  for (const l of lines) {
    const s = sizeOf(l);
    const baseline = top - s * 0.8;
    const font = l.bold ? '/FN' : '/FL';
    const color = l.bold ? '0.1 0.1 0.1' : '0.35 0.35 0.35';
    parts.push(
      `BT ${font} ${s.toFixed(2)} Tf ${color} rg ${textX.toFixed(2)} ${baseline.toFixed(2)} Td (${escPdf(l.text)}) Tj ET`,
    );
    top -= s + gap;
  }

  return {
    content: parts.join('\n'),
    resources: { XObject: { Img: imageRef }, Font: { FL: helv.ref, FN: bold.ref } },
  };
}
