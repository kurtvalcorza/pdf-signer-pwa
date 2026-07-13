import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { generateSelfSignedP12, extractPublicCertDer } from '../../src/features/signing/generateCert';
import { verifyCertPassword, getSignerCommonName } from '../../src/features/signing/cert';

function parseCert(der: Uint8Array): forge.pki.Certificate {
  let bin = '';
  for (let i = 0; i < der.length; i++) bin += String.fromCharCode(der[i]);
  return forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(bin)));
}

describe('generateSelfSignedP12', () => {
  it('creates a usable .p12 whose password unlocks and whose CN matches', () => {
    const { p12Bytes, certDer } = generateSelfSignedP12({ commonName: 'Kurt Valcorza' }, 'secret', 2);
    expect(p12Bytes.length).toBeGreaterThan(500);
    expect(verifyCertPassword(p12Bytes, 'secret')).toBe(true);
    expect(verifyCertPassword(p12Bytes, 'wrong')).toBe(false);
    expect(getSignerCommonName(p12Bytes, 'secret')).toBe('Kurt Valcorza');
    expect(certDer[0]).toBe(0x30); // DER SEQUENCE
  });

  it('includes organization, unit and email in the subject', () => {
    const { certDer } = generateSelfSignedP12(
      {
        commonName: 'Kurt Valcorza',
        organization: 'Acab AI',
        organizationalUnit: 'Engineering',
        email: 'kgvalc@gmail.com',
      },
      'pw',
    );
    const cert = parseCert(certDer);
    expect(cert.subject.getField('CN')?.value).toBe('Kurt Valcorza');
    expect(cert.subject.getField('O')?.value).toBe('Acab AI');
    expect(cert.subject.getField('OU')?.value).toBe('Engineering');
    expect(cert.subject.getField({ name: 'emailAddress' })?.value).toBe('kgvalc@gmail.com');
    // Email is also present as a subjectAltName.
    const san = cert.getExtension('subjectAltName') as { altNames?: Array<{ value: string }> };
    expect(san?.altNames?.some((a) => a.value === 'kgvalc@gmail.com')).toBe(true);
  });

  it('extracts the public certificate from a generated .p12', () => {
    const { p12Bytes } = generateSelfSignedP12({ commonName: 'Jane Doe' }, 'pw', 1);
    const der = extractPublicCertDer(p12Bytes, 'pw');
    expect(der[0]).toBe(0x30);
    expect(der.length).toBeGreaterThan(200);
  });
});
