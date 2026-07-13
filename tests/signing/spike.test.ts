import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSelfSignedP12 } from './fixtures/makeCert';
import { signVisible } from '../../src/features/signing/spike';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
const PASS = 'test-pass';

async function makeBasePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Sample document to sign', { x: 20, y: 360, size: 12, font });
  // Signing requires a cross-reference table (no compressed object streams).
  const bytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}

describe('T018 signing spike', () => {
  let p12: Buffer;

  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    p12 = makeSelfSignedP12(PASS);
  });

  it('produces a visible signature with a ByteRange (single sig)', async () => {
    const base = await makeBasePdf();
    const signed = await signVisible(base, p12, PASS, {
      widgetRect: [40, 40, 240, 110],
      reason: 'First signature',
    });
    writeFileSync(resolve(OUT, 'signed-1.pdf'), signed);

    const text = signed.toString('latin1');
    expect(text).toContain('/ByteRange');
    expect(text).toContain('Adobe.PPKLite');
    expect(text).toContain('adbe.pkcs7.detached');
  }, 30000);

  it('adds a second incremental signature (multi-sig)', async () => {
    const base = await makeBasePdf();
    const first = await signVisible(base, p12, PASS, {
      widgetRect: [40, 40, 240, 110],
      reason: 'First',
    });
    const second = await signVisible(first, p12, PASS, {
      widgetRect: [40, 130, 240, 200],
      reason: 'Second',
    });
    writeFileSync(resolve(OUT, 'signed-2.pdf'), second);

    const byteRanges = (second.toString('latin1').match(/\/ByteRange/g) ?? []).length;
    expect(byteRanges).toBeGreaterThanOrEqual(2);
    // The incremental update appends; the original first-signature bytes must survive.
    expect(second.length).toBeGreaterThan(first.length);
  }, 30000);
});
