import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { loadPdf } from '../../src/features/viewer/loadPdf';
import { signFirst } from '../../src/features/signing/signFirst';
import { makeSelfSignedP12 } from '../signing/fixtures/makeCert';
import type { PlacementInput } from '../../src/features/signing/types';
import { MAX_FORM_NODES } from '../../src/features/signing/revisions';

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

  it('classifies an unsigned PDF and an app-signed PDF as freely signable', async () => {
    expect((await loadPdf(await makePdf())).signing).toEqual({ kind: 'ok' });
    const p12 = makeSelfSignedP12('test-pass');
    const signed = await signFirst(await makePdf(), placement(), {
      p12Bytes: p12,
      password: 'test-pass',
    });
    expect((await loadPdf(signed)).signing).toEqual({ kind: 'ok' });
  }, 30000);

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

const POLICY = resolve(dirname(fileURLToPath(import.meta.url)), '../signing/fixtures/policy');
const N = (s: string) => PDFName.of(s);

/** A policy fixture, changed by `change` and written out again as a whole new file. */
async function rewritten(name: string, change: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(resolve(POLICY, name))), {
    updateMetadata: false,
  });
  change(doc);
  return doc.save({ useObjectStreams: false });
}

const topFields = (doc: PDFDocument) =>
  doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('Fields'), PDFArray);

const addFillers = (doc: PDFDocument, count: number) => {
  for (let k = 0; k < count; k++) {
    topFields(doc).push(doc.context.register(doc.context.obj({ FT: 'Tx', T: `Filler${k}` })));
  }
};

describe('loadPdf — forms the signing policy cannot check (spec 004, T029)', () => {
  it(`refuses a certified PDF with more than ${MAX_FORM_NODES} form nodes`, async () => {
    const bytes = await rewritten('certified-p2-empty-field.pdf', (d) =>
      addFillers(d, MAX_FORM_NODES),
    );
    expect((await loadPdf(bytes)).signing).toMatchObject({
      kind: 'blocked',
      reason: 'too-many-fields',
    });
  });

  it('leaves an uncertified PDF with that many form nodes freely signable (FR-005)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.catalog.set(N('AcroForm'), doc.context.obj({ Fields: [] }));
    addFillers(doc, MAX_FORM_NODES);
    expect((await loadPdf(await doc.save())).signing).toEqual({ kind: 'ok' });
  });

  it('refuses a cyclic /Kids as unreadable-policy', async () => {
    const bytes = await rewritten('certified-p2-inherited-v.pdf', (doc) => {
      const fields = topFields(doc);
      for (let i = 0; i < fields.size(); i++) {
        const kids = fields.lookup(i, PDFDict).lookup(N('Kids'));
        if (kids instanceof PDFArray) kids.push(fields.get(i));
      }
    });
    expect((await loadPdf(bytes)).signing).toMatchObject({
      kind: 'blocked',
      reason: 'unreadable-policy',
    });
  });

  // A /V that is not a dictionary is pinned in tests/unit/revisions.test.ts on the fixture's
  // own bytes: rewriting the whole file here would break the byte ranges and refuse it anyway.
  it('refuses a signature policy that fails to parse as unreadable-policy', async () => {
    // The certification's /Reference is not an array: classification throws inside, and the
    // result is a refusal with the "could not be read" message, not an exception.
    const bytes = await rewritten('certified-p2-empty-field.pdf', (doc) => {
      const sig = doc.catalog.lookup(N('Perms'), PDFDict).lookup(N('DocMDP'), PDFDict);
      sig.set(N('Reference'), PDFNumber.of(7));
    });
    const { signing } = await loadPdf(bytes);
    expect(signing).toMatchObject({ kind: 'blocked', reason: 'unreadable-policy' });
    expect(signing.kind === 'blocked' && signing.message).toMatch(/could not be read/);
  });
});
