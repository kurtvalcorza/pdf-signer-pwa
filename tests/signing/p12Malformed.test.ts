import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { generateSelfSignedP12 } from '../../src/features/signing/generateCert';
import { loadP12, verifyCertPassword } from '../../src/features/signing/cert';
import { BadPasswordError, MalformedCertificateError } from '../../src/features/signing/types';

const toBytes = (bin: string): Uint8Array => Uint8Array.from(bin, (c) => c.charCodeAt(0));
const toDerBytes = (a: forge.asn1.Asn1): Uint8Array => toBytes(forge.asn1.toDer(a).getBytes());

function keyAndCert() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'Fixture' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { privateKey: keys.privateKey, cert };
}

/**
 * GHSA-jc66-7q78-782g: with zero iterations RFC 7292 B.2 does no hashing, so the derived MAC
 * key is the constant 0x03 diversifier and is independent of the password. This builds an
 * unencrypted PFX whose MAC uses that key: forge <= 1.4.0 accepts it under ANY password.
 */
function pfxWithZeroIterationMac(): Uint8Array {
  const { privateKey, cert } = keyAndCert();
  const pfx = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], null as unknown as string, {
    useMac: false,
  });
  const authSafe = (pfx.value as forge.asn1.Asn1[])[1];
  const content = ((authSafe.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0];
  const hmac = forge.hmac.create();
  hmac.start('sha1', '\x03'.repeat(20));
  hmac.update(content.value as string);

  const { Class, Type, create } = forge.asn1;
  const sha1Oid = forge.asn1.oidToDer(forge.pki.oids.sha1).getBytes();
  const macData = create(Class.UNIVERSAL, Type.SEQUENCE, true, [
    create(Class.UNIVERSAL, Type.SEQUENCE, true, [
      create(Class.UNIVERSAL, Type.SEQUENCE, true, [
        create(Class.UNIVERSAL, Type.OID, false, sha1Oid),
        create(Class.UNIVERSAL, Type.NULL, false, ''),
      ]),
      create(Class.UNIVERSAL, Type.OCTETSTRING, false, hmac.digest().getBytes()),
    ]),
    create(Class.UNIVERSAL, Type.OCTETSTRING, false, 'saltsalt'),
    create(Class.UNIVERSAL, Type.INTEGER, false, '\x00'),
  ]);
  (pfx.value as forge.asn1.Asn1[]).push(macData);
  return toDerBytes(pfx);
}

describe('malformed PKCS#12 inputs (SEC-01)', () => {
  it('rejects a zero-iteration MAC under any password, as malformed not mistyped', () => {
    const p12 = pfxWithZeroIterationMac();
    for (const pw of ['', 'wrong', 'anything']) {
      expect(() => loadP12(p12, pw)).toThrow(MalformedCertificateError);
      expect(() => verifyCertPassword(p12, pw)).toThrow(MalformedCertificateError);
    }
  });

  it('rejects a PFX with no MAC, which would otherwise unlock under any password', () => {
    const { privateKey, cert } = keyAndCert();
    const p12 = toDerBytes(
      forge.pkcs12.toPkcs12Asn1(privateKey, [cert], null as unknown as string, { useMac: false }),
    );
    expect(() => loadP12(p12, 'anything')).toThrow(MalformedCertificateError);
  });

  it('rejects bytes that are not DER', () => {
    expect(() => loadP12(new Uint8Array([1, 2, 3, 4]), 'pw')).toThrow(MalformedCertificateError);
  });

  it('rejects a PFX holding a certificate but no private key', () => {
    const { cert } = keyAndCert();
    const p12 = toDerBytes(
      forge.pkcs12.toPkcs12Asn1(null, [cert], 'pw', {
        algorithm: '3des',
      }),
    );
    expect(() => loadP12(p12, 'pw')).toThrow(MalformedCertificateError);
  });

  it('still reports a genuine wrong password as BadPasswordError', () => {
    const { p12Bytes } = generateSelfSignedP12({ commonName: 'Good' }, 'right');
    expect(() => loadP12(p12Bytes, 'wrong')).toThrow(BadPasswordError);
    expect(verifyCertPassword(p12Bytes, 'wrong')).toBe(false);
    expect(verifyCertPassword(p12Bytes, 'right')).toBe(true);
  });
});
