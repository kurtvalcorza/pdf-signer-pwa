import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIncremental } from '../../src/features/signing/signIncremental';
import { loadPdf } from '../../src/features/viewer/loadPdf';
import { CertificationLockedError, type PlacementInput } from '../../src/features/signing/types';
import { makeSelfSignedP12 } from './fixtures/makeCert';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = resolve(HERE, 'fixtures/policy');
const OUT = resolve(HERE, 'out');

// 1x1 transparent PNG.
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const placement: PlacementInput = {
  imageBytes: PNG,
  format: 'png',
  pageIndex: 0,
  nx: 0.1,
  ny: 0.5,
  nw: 0.3,
  nh: 0.1,
};
const PASS = 'policy-pass';
const load = (name: string) => new Uint8Array(readFileSync(resolve(POLICY, name)));

describe('counter-signing documents the app did not write', () => {
  let cert: { p12Bytes: Uint8Array; password: string };

  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    cert = { p12Bytes: new Uint8Array(makeSelfSignedP12(PASS)), password: PASS };
  }, 40000);

  // Pure append onto approval signatures; the gate then confirms policy with pyHanko.
  it.each(['approval.pdf', 'approval-xref-stream.pdf'])(
    'counter-signs %s without touching its bytes',
    async (name) => {
      const input = load(name);
      const out = await signIncremental(input, placement, cert);
      expect(Buffer.from(out.subarray(0, input.length))).toEqual(Buffer.from(input));
      writeFileSync(resolve(OUT, `policy-${name}`), out);
    },
    40000,
  );

  it.each([
    'certified-p1.pdf',
    'certified-p2.pdf',
    'certified-p3.pdf',
    'certified-p2-xref-stream.pdf',
    'certified-p2-two-revisions.pdf',
    'fieldmdp-all.pdf',
  ])(
    'refuses %s',
    async (name) => {
      await expect(signIncremental(load(name), placement, cert)).rejects.toThrow(
        CertificationLockedError,
      );
    },
    40000,
  );

  it.each([
    ['certified-p1.pdf', /no changes allowed/],
    ['certified-p2.pdf', /certified/],
    ['fieldmdp-all.pdf', /FieldMDP/],
  ])('tells the user up front why %s cannot be signed', async (name, reason) => {
    const info = await loadPdf(load(name));
    expect(info.signingBlock).toMatch(reason);
  });

  it('does not block an approval-signed PDF', async () => {
    const info = await loadPdf(load('approval.pdf'));
    expect(info.hasExistingSignature).toBe(true);
    expect(info.signingBlock).toBeNull();
  });
});
