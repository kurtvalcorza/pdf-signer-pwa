import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, StandardFonts } from 'pdf-lib';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import type { PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword, getSignerCommonName } from './cert';
import {
  clampBox,
  containIn,
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
 * Windows-1252 high block (0x80–0x9F): Unicode code point → CP1252 byte. WinAnsiEncoding
 * renders these glyphs (smart quotes, dashes, €, …); their Unicode code points are > 0xFF,
 * so we must emit the raw CP1252 byte rather than the (truncated) code point.
 */
const CP1252_HIGH_BYTE: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** WinAnsi byte for a Unicode code point a StandardFont can render, else null. */
const winAnsiByte = (c: number): number | null =>
  (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) ? c : (CP1252_HIGH_BYTE[c] ?? null);

/**
 * Sanitize text to what a StandardFont (WinAnsiEncoding) can render, for glyph
 * measurement: printable ASCII, the Latin-1 supplement, and the CP1252 high block.
 * Anything else — CJK, emoji, control chars — becomes '?', so `widthOfTextAtSize`
 * never throws and the signer's name degrades gracefully instead of failing the sign.
 */
const toWinAnsi = (s: string): string =>
  Array.from(s, (ch) => (winAnsiByte(ch.codePointAt(0)!) === null ? '?' : ch)).join('');

/**
 * Encode text as a PDF literal-string body: each character becomes its WinAnsi byte
 * (unrenderable → '?'), with `\ ( )` escaped. Emitting the byte — not the JS code
 * point — is what keeps CP1252 punctuation from being truncated by pdf-lib's stream
 * serialization (which writes `charCodeAt & 0xff`).
 */
const escPdf = (s: string): string =>
  Array.from(s, (ch) => {
    const byte = winAnsiByte(ch.codePointAt(0)!) ?? 0x3f; // '?'
    const out = String.fromCharCode(byte);
    return byte === 0x5c || byte === 0x28 || byte === 0x29 ? `\\${out}` : out;
  }).join('');

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  // Local wall-clock time with an explicit UTC offset, so the appearance is
  // unambiguous across timezones (e.g. "2026.07.14 11:45 +08:00").
  const offMin = -d.getTimezoneOffset();
  const tz = `${offMin >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(offMin) / 60))}:${p(Math.abs(offMin) % 60)}`;
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${tz}`;
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

  // pdf-lib omits /Type on the AcroForm dict, but a later incremental counter-sign
  // (signIncremental → placeholder-plain) re-finds the form by scanning for
  // "/Type /AcroForm" as the dict's FIRST entry; without it the update rewrites
  // /Fields with only the new widget and this signature vanishes from validators.
  // Reorder the dict so /Type /AcroForm leads and /Fields follows.
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const acroEntries = acro.entries().filter(([k]) => k !== PDFName.of('Type'));
  for (const [k] of [...acro.entries()]) acro.delete(k);
  acro.set(PDFName.of('Type'), PDFName.of('AcroForm'));
  for (const [k, v] of acroEntries) acro.set(k, v);

  // Replace the widget's empty appearance (AP.N) with the composed image (+ text).
  const widget = lastWidget(doc, page);
  const apDict = widget.lookup(PDFName.of('AP'), PDFDict);

  const { content: apContent, resources } = await buildAppearance(
    doc,
    appearance.widthPt,
    appearance.heightPt,
    image,
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
  image: { ref: PDFRef; width: number; height: number },
  opts: { name: string | null; dateStr: string | null },
): Promise<{ content: string; resources: Record<string, unknown> }> {
  // Sanitize up front so glyph measurement and stream emission agree on encodable text.
  const lines: string[] = [];
  if (opts.name) lines.push('Digitally signed by', toWinAnsi(opts.name));
  if (opts.dateStr) lines.push(toWinAnsi(opts.dateStr));

  // Draw the image preserving its aspect ratio inside a region, centered — never stretched.
  const drawImg = (regionW: number, regionH: number, regionX: number, regionY: number) => {
    const fit = containIn(regionW, regionH, image.width, image.height);
    const x = (regionX + fit.dx).toFixed(2);
    const y = (regionY + fit.dy).toFixed(2);
    return `q ${fit.width.toFixed(2)} 0 0 ${fit.height.toFixed(2)} ${x} ${y} cm /Img Do Q`;
  };

  if (lines.length === 0) {
    return {
      content: drawImg(w, h, 0, 0),
      resources: { XObject: { Img: image.ref } },
    };
  }

  const helv = await doc.embedFont(StandardFonts.Helvetica);

  // Image on the left; text fills the rest with a small margin on each side.
  const regionW = w * 0.28;
  const regionH = h * 0.82;
  const regionX = w * 0.02;
  const regionY = h * 0.09;
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

  const parts = [drawImg(regionW, regionH, regionX, regionY)];
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
    resources: { XObject: { Img: image.ref }, Font: { FL: helv.ref } },
  };
}
