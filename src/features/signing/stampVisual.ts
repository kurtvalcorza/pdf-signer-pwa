import { PDFDocument, degrees } from 'pdf-lib';
import type { PlacementInput } from './types';
import { clampBox, containNormBox, normalizedBoxToDrawParams, type Rotation } from '../../lib/coords';

/**
 * Tier A — draw each signature image onto its target page as page content
 * (FR-006/008/009/010). No cryptography. Safe to call only before any signature
 * exists (page-content mutation invalidates signatures — Principle III / FR-014).
 *
 * All in-memory; no network (Principle I).
 */
export async function stampVisual(
  pdf: Uint8Array,
  placements: PlacementInput[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const pages = doc.getPages();

  for (const p of placements) {
    const page = pages[p.pageIndex];
    if (!page) {
      throw new Error(`Placement targets a missing page (index ${p.pageIndex}).`);
    }

    const box = clampBox({ nx: p.nx, ny: p.ny, nw: p.nw, nh: p.nh });
    const { width, height } = page.getSize();
    const rotation = (((page.getRotation().angle % 360) + 360) % 360) as Rotation;
    const geom = { widthPt: width, heightPt: height, rotation };

    const image =
      p.format === 'png'
        ? await doc.embedPng(p.imageBytes)
        : await doc.embedJpg(p.imageBytes);

    // Preserve the image's aspect ratio inside the placement box (matches the on-screen
    // `object-contain` preview) instead of stretching to fill it.
    const contained = containNormBox(box, geom, image.width, image.height);
    const draw = normalizedBoxToDrawParams(contained, geom);

    page.drawImage(image, {
      x: draw.x,
      y: draw.y,
      width: draw.width,
      height: draw.height,
      rotate: degrees(draw.rotate),
    });
  }

  return doc.save();
}
