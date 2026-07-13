import { describe, it, expect } from 'vitest';
import { generateSelfSignedP12, extractPublicCertDer } from '../../src/features/signing/generateCert';
import { verifyCertPassword, getSignerCommonName } from '../../src/features/signing/cert';

describe('generateSelfSignedP12', () => {
  it('creates a usable .p12 whose password unlocks and whose CN matches', () => {
    const { p12Bytes, certDer } = generateSelfSignedP12('Kurt Valcorza', 'secret', 2);
    expect(p12Bytes.length).toBeGreaterThan(500);
    expect(verifyCertPassword(p12Bytes, 'secret')).toBe(true);
    expect(verifyCertPassword(p12Bytes, 'wrong')).toBe(false);
    expect(getSignerCommonName(p12Bytes, 'secret')).toBe('Kurt Valcorza');
    // Public cert is DER (starts with a SEQUENCE tag 0x30).
    expect(certDer[0]).toBe(0x30);
  });

  it('extracts the public certificate from a generated .p12', () => {
    const { p12Bytes } = generateSelfSignedP12('Jane Doe', 'pw', 1);
    const der = extractPublicCertDer(p12Bytes, 'pw');
    expect(der[0]).toBe(0x30);
    expect(der.length).toBeGreaterThan(200);
  });
});
