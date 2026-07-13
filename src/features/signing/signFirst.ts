import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, StandardFonts } from 'pdf-lib';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import type { PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword, getSignerCommonName } from './cert';
import {
  clampBox,
  normalizedBoxToPdfRect,
  appearanceLayout,
  type Rotation,
} from '../../lib/coords';

export interface SignFirstOptions {
  /** Show "Digitally signed by {name}" text beside the image (Adobe-style). Default true. */
  label?: boolean;
  /** Show a "Date: …" line in the appearance. Default true. */
  date?: boolean;
  /** Override the display name; defaults to the certificate's common name. */
  displayName?: string;
}

/**
 * Restrict text to code points a StandardFont (WinAnsi) can encode and that survive
 * pdf-lib's byte-truncating stream serialization: printable ASCII and the Latin-1
 * supplement (0xA0–0xFF, where WinAnsi matches Unicode). Everything else — CJK,
 * emoji, control chars — becomes '?', so a signer whose common name contains such
 * characters gets a safe placeholder instead of a corrupted appearance stream.
 */
const toWinAnsi = (s: string): string =>
  Array.from(s, (ch) => {
    const c = ch.codePointAt(0)!;
    return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) ? ch : '?';
  }).join('');

const escPdf = (s: string) =>
  toWinAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

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
  const geom = { widthPt: width, heightPt: height, rotation };
  const rect = normalizedBoxToPdfRect(box, geom);
  const widgetRect: [number, number, number, number] = [
    rect.x,
    rect.y,
    rect.x + rect.w,
    rect.y + rect.h,
  ];
  // Content is composed upright in this box; a /Matrix pre-rotation keeps it upright
  // on rotated pages (the widget /Rect above rotates with the page).
  const appearance = appearanceLayout(box, geom);

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
    appearance.widthPt,
    appearance.heightPt,
    image.ref,
    {
      name: showLabel ? signerName : null,
      dateStr: showDate ? `Date: ${formatDate(new Date())}` : null,
    },
  );
  const apStream = doc.context.stream(apContent, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, appearance.widthPt, appearance.heightPt],
    Matrix: appearance.matrix,
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
 * Compose the signature appearance. With no label and no date, the image fills the
 * box. Otherwise: image on the left, and a vertical stack of uniform text lines on
 * the right ("Digitally signed by" / {name} / "Date: …") — Adobe-style. All lines
 * share one font/size/colour, and the size is fitted to the widest line and the box
 * height so nothing clips. Each line is optional (user can turn label/date off).
 */
async function buildAppearance(
  doc: PDFDocument,
  w: number,
  h: number,
  imageRef: PDFRef,
  opts: { name: string | null; dateStr: string | null },
): Promise<{ content: string; resources: Record<string, unknown> }> {
  // Sanitize up front so glyph measurement and stream emission agree on encodable text.
  const lines: string[] = [];
  if (opts.name) lines.push('Digitally signed by', toWinAnsi(opts.name));
  if (opts.dateStr) lines.push(toWinAnsi(opts.dateStr));

  if (lines.length === 0) {
    return {
      content: `q ${w} 0 0 ${h} 0 0 cm /Img Do Q`,
      resources: { XObject: { Img: imageRef } },
    };
  }

  const helv = await doc.embedFont(StandardFonts.Helvetica);

  // Image on the left; text fills the rest with a small margin on each side.
  const imgW = w * 0.28;
  const imgH = h * 0.82;
  const imgX = w * 0.02;
  const imgY = h * 0.09;
  const textX = w * 0.34;
  const maxTextW = w * 0.64; // textX + maxTextW ≈ 0.98·w

  const n = lines.length;
  const gapFrac = 0.4; // gap = size · gapFrac
  // Fit to the widest line (measured in real points) …
  const widest = Math.max(...lines.map((t) => helv.widthOfTextAtSize(t, 100) / 100));
  const sizeByWidth = maxTextW / widest;
  // … and to the available height for n lines + gaps.
  const sizeByHeight = (h * 0.86) / (n + (n - 1) * gapFrac);
  const s = Math.max(4, Math.min(sizeByWidth, sizeByHeight, 13));

  const gap = s * gapFrac;
  const totalH = s * n + gap * (n - 1);

  const parts = [`q ${imgW} 0 0 ${imgH} ${imgX} ${imgY} cm /Img Do Q`];
  let top = (h + totalH) / 2; // vertically centered block
  for (const text of lines) {
    const baseline = top - s * 0.8;
    parts.push(
      `BT /FL ${s.toFixed(2)} Tf 0.2 0.2 0.2 rg ${textX.toFixed(2)} ${baseline.toFixed(2)} Td (${escPdf(text)}) Tj ET`,
    );
    top -= s + gap;
  }

  return {
    content: parts.join('\n'),
    resources: { XObject: { Img: imageRef }, Font: { FL: helv.ref } },
  };
}
