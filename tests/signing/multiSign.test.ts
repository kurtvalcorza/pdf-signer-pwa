import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSelfSignedP12 } from './fixtures/makeCert';
import { signFirst } from '../../src/features/signing/signFirst';
import { signIncremental } from '../../src/features/signing/signIncremental';
import type { PlacementInput } from '../../src/features/signing/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
const TAMPERED = resolve(HERE, 'tampered');
const PASS = 'test-pass';

const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const at = (ny: number): PlacementInput => ({
  imageBytes: PNG,
  format: 'png',
  pageIndex: 0,
  nx: 0.15,
  ny,
  nw: 0.35,
  nh: 0.1,
});

async function makeBasePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Sample document to sign', { x: 20, y: 360, size: 12, font });
  return doc.save();
}

describe('multi-signature (incremental)', () => {
  let p12: Buffer;
  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    mkdirSync(TAMPERED, { recursive: true });
    p12 = makeSelfSignedP12(PASS);
  });

  // NOTE: SC-009 (a 2nd signature leaves the 1st valid) is verified end-to-end by
  // the SPIKE's plain+plain path (tests/signing/spike.test.ts → signed-2: two
  // intact+valid signatures). Here we only assert the structural incremental append;
  // pyHanko may enumerate only the latest sig on the signFirst+incremental combo
  // (see signIncremental.ts known-limitation note).
  it('appends a second signature incrementally (byte-level, no re-serialization)', async () => {
    const base = await makeBasePdf();
    const cert = { p12Bytes: p12, password: PASS };
    const first = await signFirst(base, at(0.62), cert);
    const second = await signIncremental(first, at(0.42), cert);

    const byteRanges = (Buffer.from(second).toString('latin1').match(/\/ByteRange/g) ?? []).length;
    expect(byteRanges).toBeGreaterThanOrEqual(2);
    // Incremental append only grows the file — the earlier signed bytes are preserved.
    expect(second.length).toBeGreaterThan(first.length);
    expect(Buffer.from(second.subarray(0, first.length))).toEqual(Buffer.from(first));
  }, 40000);

  it('writes a tampered copy for the gate to reject (SC-007)', async () => {
    const base = await makeBasePdf();
    const first = await signFirst(base, at(0.62), { p12Bytes: p12, password: PASS });
    const tampered = Uint8Array.from(first);
    // Flip a byte within the first ByteRange segment (document body) to break integrity.
    const i = Math.floor(tampered.length * 0.2);
    tampered[i] = tampered[i] ^ 0xff;
    writeFileSync(resolve(TAMPERED, 'tampered.pdf'), tampered);
    expect(tampered.length).toBe(first.length);
  }, 30000);
});
