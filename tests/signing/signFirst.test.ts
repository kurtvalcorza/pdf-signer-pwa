import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSelfSignedP12 } from './fixtures/makeCert';
import { signFirst } from '../../src/features/signing/signFirst';
import { BadPasswordError } from '../../src/features/signing/types';
import type { PlacementInput } from '../../src/features/signing/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
const PASS = 'test-pass';

const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const placement = (): PlacementInput => ({
  imageBytes: PNG,
  format: 'png',
  pageIndex: 0,
  nx: 0.15,
  ny: 0.62,
  nw: 0.4,
  nh: 0.1,
});

async function makeBasePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Sample document to sign', { x: 20, y: 360, size: 12, font });
  return doc.save();
}

describe('signFirst (Tier B — image-appearance signature)', () => {
  let p12: Buffer;
  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    p12 = makeSelfSignedP12(PASS);
  });

  it('produces a signed PDF with a signature field and image appearance', async () => {
    const base = await makeBasePdf();
    const signed = await signFirst(base, placement(), { p12Bytes: p12, password: PASS });
    writeFileSync(resolve(OUT, 'signed-first.pdf'), signed);

    const text = Buffer.from(signed).toString('latin1');
    expect(text).toContain('/ByteRange');
    expect(text).toContain('Adobe.PPKLite');
    expect(text).toContain('/Subtype /Form'); // the image appearance XObject
    expect(text).toContain('Digitally signed by'); // Adobe-style label
    expect(text).toContain('Test Signer'); // certificate common name
    expect(text).toContain('Date:'); // date line (on by default)
  }, 30000);

  it('omits the label and date when the user turns them off', async () => {
    const base = await makeBasePdf();
    const signed = await signFirst(base, placement(), { p12Bytes: p12, password: PASS }, {
      label: false,
      date: false,
    });
    const text = Buffer.from(signed).toString('latin1');
    expect(text).not.toContain('Digitally signed by');
    expect(text).not.toContain('Date:');
    expect(text).toContain('/ByteRange'); // still a valid signature, just image-only
  }, 30000);

  it('rejects a wrong password without producing output (FR-015)', async () => {
    const base = await makeBasePdf();
    await expect(
      signFirst(base, placement(), { p12Bytes: p12, password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(BadPasswordError);
  }, 30000);
});
