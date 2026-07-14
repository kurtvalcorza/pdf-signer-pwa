import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { loadPdf } from '../../src/features/viewer/loadPdf';
import { signFirst } from '../../src/features/signing/signFirst';
import { makeSelfSignedP12 } from '../signing/fixtures/makeCert';
import type { PlacementInput } from '../../src/features/signing/types';

const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const placement = (): PlacementInput => ({
  imageBytes: PNG, format: 'png', pageIndex: 0, nx: 0.15, ny: 0.62, nw: 0.4, nh: 0.1,
});

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

  it('flags a genuinely signed PDF (AcroForm signature field with a /ByteRange value)', async () => {
    const p12 = makeSelfSignedP12('test-pass');
    const signed = await signFirst(await makePdf(), placement(), {
      p12Bytes: p12,
      password: 'test-pass',
    });
    expect((await loadPdf(signed)).hasExistingSignature).toBe(true);
  }, 30000);

  it('does NOT flag an incidental /ByteRange array in page text or a comment', async () => {
    // Structural detection means a bare "/ByteRange [0 840 2000 960]" that isn't part of
    // a signature dictionary no longer false-positives.
    const bytes = injectAfterHeader(await makePdf(), '/ByteRange [0 840 2000 960]');
    expect((await loadPdf(bytes)).hasExistingSignature).toBe(false);
  });
  it('rejects a file that cannot be read as a PDF', async () => {
    await expect(loadPdf(Uint8Array.from([1, 2, 3, 4]))).rejects.toThrow(/could not be read/);
  });
});
