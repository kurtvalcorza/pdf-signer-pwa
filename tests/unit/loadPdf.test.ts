import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { loadPdf } from '../../src/features/viewer/loadPdf';

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  return doc.save();
}

/** Inject a raw token after the PDF header as a comment (parsers ignore % lines). */
function injectAfterHeader(bytes: Uint8Array, token: string): Uint8Array {
  const s = Buffer.from(bytes).toString('latin1');
  const idx = s.indexOf('\n') + 1;
  const out = s.slice(0, idx) + `%${token}\n` + s.slice(idx);
  return Uint8Array.from(Buffer.from(out, 'latin1'));
}

describe('loadPdf — existing-signature detection', () => {
  it('does not flag a plain unsigned PDF', async () => {
    expect((await loadPdf(await makePdf())).hasExistingSignature).toBe(false);
  });

  it('flags a signature that omits /Type and /SubFilter (only a /ByteRange array)', async () => {
    // Mirrors a minimal signature dict: /ByteRange with four integers, no /SubFilter.
    const bytes = injectAfterHeader(await makePdf(), '/ByteRange [0 840 2000 960]');
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(true);
  });

  it('does not flag a bare /ByteRange token without the four-integer array', async () => {
    const bytes = injectAfterHeader(await makePdf(), 'see /ByteRange [ in the spec');
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(false);
  });
});
