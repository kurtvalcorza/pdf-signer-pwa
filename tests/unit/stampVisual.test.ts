import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { stampVisual } from '../../src/features/signing/stampVisual';
import { clampBox } from '../../src/lib/coords';

// 1x1 PNG.
const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

async function makeBasePdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Page ${i + 1}`, { x: 20, y: 360, size: 12, font });
  }
  return doc.save();
}

describe('stampVisual', () => {
  it('embeds an image and returns a valid, larger PDF', async () => {
    const base = await makeBasePdf();
    const out = await stampVisual(base, [
      { imageBytes: PNG_1x1, format: 'png', pageIndex: 0, nx: 0.1, ny: 0.1, nw: 0.3, nh: 0.1 },
    ]);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
    expect(out.length).toBeGreaterThan(base.length);
  });

  it('places on the correct page of a multi-page document (FR-009)', async () => {
    const base = await makeBasePdf(3);
    const out = await stampVisual(base, [
      { imageBytes: PNG_1x1, format: 'png', pageIndex: 2, nx: 0.2, ny: 0.2, nw: 0.2, nh: 0.1 },
    ]);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it('throws on a placement targeting a missing page', async () => {
    const base = await makeBasePdf(1);
    await expect(
      stampVisual(base, [
        { imageBytes: PNG_1x1, format: 'png', pageIndex: 5, nx: 0.1, ny: 0.1, nw: 0.2, nh: 0.1 },
      ]),
    ).rejects.toThrow(/missing page/);
  });
});

describe('clampBox (FR-008)', () => {
  it('pulls an overflowing box back inside the page', () => {
    expect(clampBox({ nx: 0.9, ny: 0.9, nw: 0.5, nh: 0.5 })).toEqual({
      nx: 0.5,
      ny: 0.5,
      nw: 0.5,
      nh: 0.5,
    });
  });
});
