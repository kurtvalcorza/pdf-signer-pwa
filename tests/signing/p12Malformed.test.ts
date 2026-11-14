import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { P12Signer } from '@signpdf/signer-p12';
import { generateSelfSignedP12 } from '../../src/features/signing/generateCert';
import {
  getSignerCommonName,
  loadP12,
  verifyCertPassword,
} from '../../src/features/signing/cert';
import { BadPasswordError, MalformedCertificateError } from '../../src/features/signing/types';

const toBytes = (bin: string): Uint8Array => Uint8Array.from(bin, (c) => c.charCodeAt(0));
const toDerBytes = (a: forge.asn1.Asn1): Uint8Array => toBytes(forge.asn1.toDer(a).getBytes());

// Throwaway files from OpenSSL with the password "pw", which forge cannot build itself.
const EC_KEY_P12 = 'MIIEHAIBAzCCA9IGCSqGSIb3DQEHAaCCA8MEggO/MIIDuzCCAmoGCSqGSIb3DQEHBqCCAlswggJXAgEAMIICUAYJKoZIhvcNAQcBMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBCR84gWWqY6aqd9mObYVpRGAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQvYD+5GU7tOx/N67Dfasi14CCAeDwyrQ6o1+ew62H78gvB3DrLY5TOkZII1AJdvqZFPnVG/gEldKoP8X5uKI8ZXrX5xAMV1QuiXxNUIeSCnWhX/OXa3gfbtV+jSSRF4VyZIumVa4ilDzKDC6GiCj6wxxi7sDY4Vt3e5PknFncVmD5Mbhp1qS0ULC62Tdxqm6u8DbmXlRRO+YpSh8xalbBZgwKXpsQC7Y45r3epTyFV58Xe488sdHJOvnNR2zyhK4xtOSJ/jDXayPeI/ejmlKSaOwBiuyWYj2UjXd6jo49nBrrtwhpKODZTyPdvE7r5d/YP0olm0VTIl0lH+JQpFGyLSr+VRqaa9MNP+AMc59WgyP1QU6sDyx2DX5l0OWaxzu+ldQ5kGPPVEkfU/jKk45CbpHXdTWjoEyETsxT+JTrPDq8CDbMigG6xUtgFX74NXI+2Ib66JvI1UeNcQogaCTrADezpjHZjjOLs+8DBXpjoHtX0CiEyZCGAlnfZsBs6WLS01SWTPr7uVYZjij1Bqtg2H9jPAuphY5F4apcOyUb9BPW5BDkxeAVGyfT6o4roMB20qpYQCRZ63f5X6XxWaBq1B+ZKzbrH6tnDIRiCGLdc94KyPg51QIIgfPNI08rY2aKP50nLOvmsFJ595N2c8djM2s/8dAwggFJBgkqhkiG9w0BBwGgggE6BIIBNjCCATIwggEuBgsqhkiG9w0BDAoBAqCB9zCB9DBfBgkqhkiG9w0BBQ0wUjAxBgkqhkiG9w0BBQwwJAQQlA5PcQ2zGAAFXOIe79fQvwICCAAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEELS8F4N/YsIezBX/Zbg/aLcEgZCQgU0+2LD+4zFVrCCS24E33wUcWq2yt9QTVx9CgWyVRyFwe3CFGbszAHLkSEAFCOGmazpO0tuGp2ErrKmAcCXqh2JSggONxbwkikbiGn7wCxV2WgKw3CLBUOpFv+HNnNAO13UaQYGHctI96P0qOngMuFod3LnP1lhfbyL2SEDPxwjQxhfNK1QF+FrV6+Xhn7AxJTAjBgkqhkiG9w0BCRUxFgQUbvPxHgzmYiUF5EOylCH/NahfVTowQTAxMA0GCWCGSAFlAwQCAQUABCDhN+HimpmHScDOYrvCc31SkT7yxkSXcTK58Dk8LgrIlgQI3n6rNutzsYYCAggA';
const RC4_NO_MAC_P12 = 'MIIFwwIBAzCCBbwGCSqGSIb3DQEHAaCCBa0EggWpMIIFpTCCAqkGCSqGSIb3DQEHBqCCApowggKWAgEAMIICjwYJKoZIhvcNAQcBMBwGCiqGSIb3DQEMAQEwDgQIqQR6xbuwPgACAggAgIICYknJH6huhAWw+Z6iFbhWBW1LRQLkhZDHggHav+SzmMGjQ4CNp3ECQPpwVdsyuHv1URLN8dpnbRIZPZxkpjt/twCtHraujHflAxZSGoo70oeGv8uDqgE2gc6+y2W3l2kLPTF+5CCLZP1Cc5aTE4lGRl7n50gMgAVZf22zisBffZdA/cin6SoKyhpUeO2N4NPuFW6v/QslmffB2FD4pjpdncb/up0CMrvMnVojPta31RJtm39834fnxYMXK+kuqeFGrGo6N2Gz3I5r++7/MG757a0VoBDOMLiCy71P3igNnQBaLcgTSheqdcPuG8fn6iz1Ko/V4wd8JmLD2lguYF3L7VGDQpAD6lhWG7Cwwy/T68jlQwE5fy8zas5rePpO/tol28gIb3JhKV3IoAwWwTWbDsCZvLHN4UA0Hj1NhXX0EcZMDMYZUhr3Lq59tpDR21ULQ84U31vGIjplC2Xzw4K1hptLI54rsC+4T+bGLqvMR0TcgP5YGtA+eGHzice7hsACTxv8VHFNL7T4rxI6ueTEdIeihAXSQ2mkdCaVzWPHVD1MZ/Xy+SfStzwNhymaOiwhzB7cZ2feSFKoaKF066ZcAEnuwr7ss2zfLaNqsSAJIKcGLkZd5PylxrcBJNH8ihDHhn31TmF2LSEVAbazNJXSSAczfUMJc3LN1PlCDpzlHys2z5GpdFVT85yUoJvgY2AkhNSdaX/wuVVq7PnrS6xhgs9uFZDNx1EKoTpXnP4BQl+0Lj+2NN3WoXdNilcdq3pRcWHbZVfqKfNRBnNE7uSP+FJ7G21aRoN3lbqh1REmyo+uNE4wggL0BgkqhkiG9w0BBwGgggLlBIIC4TCCAt0wggLZBgsqhkiG9w0BDAoBAqCCAqEwggKdMBwGCiqGSIb3DQEMAQEwDgQIVmnehpe2W+wCAggABIICewCza82GOMKfio2Bgkm0YvAbQZ0Q1NhGT1fzJpTvPckCXkoVCNPzKFxvPpwz1Ug8tk1p30S1RNVFmEmyTIhmAHVFNlMlrXk0pzzZvcNS23s+mAYKaPoXbCUqQHatTEuPXkI/6N7+DsjqLKzfR6Mc9lBsVTu4vjbTUhTPLv24aeWiTGu6JoJWOP2D3lSmZofn16lmK/qE1/t6apqMWM56Tx7H73v2/v9knpNrD6rnI2i/MFigjsk+Jg4Y+E6VXl4IB469RJP1LYZC7Wkn47TdM0ZkhA+HMSphHaqudQhvdElYPp66cFfpHO5wSHxhDKI3hU1/svOSJK0Tb2rdVDPH6+n++Q6rUB57hy0UQpCYFM1NMI7yWjUfY6iUGAhYdnYZWCaRYhteUdsm6SQZDffluJuI3PAi1biXKkXoODbvaaw6NX/Usvt53UWpg2Uzhe+uOgjwRLkqQTz8w+xdNgIULt6kpr/phP862CZp0rAhk2kPvWscEQFeDW+s/q8nmrlSwz4CZus3K8yxdmRojAd1FPJm8F1v1pnhNWHpmPN3jIm+ft4bbmhLjdbjHzbdfEMJ5HdQ7iOicCf8jfmu0DyBNtC8sDOxSAgqLv/dxX14eeFhJHgx0qS/mWpXrD7DvWi9djTi6EePgh23s48fVRzXEvnL8dovL4x6tjdRvjnkF4EX6UwldGGNdiXDYF2F6dC4Oqc7ehstfUnv7xCRxV2WAE+oj/MZTugPWirvQnxCj/7EuD++yYc1W2OmQk3jCUr/H9zBracV67uA1nagr7PngYwXQVL2ZkcempgIzOgsl1GDS86c6Im1HN9Dz+r0oug2gO/ZEf60mmpzK5AKMSUwIwYJKoZIhvcNAQkVMRYEFAwQZ5Jnc8c2OnLJN2iYzBnlGY8w';
// #23 G1-1: an RSA key and certificate plus one extra ECDSA certificate (OpenSSL, password "pw").
const RSA_PLUS_EC_CERT_P12 = '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';
// #23 G1-2: an RSA key whose certificate an ECDSA CA issued, with that CA (OpenSSL, password "pw").
const RSA_ISSUED_BY_EC_CA_P12 = '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';
const fromBase64 = (b: string) => new Uint8Array(Buffer.from(b, 'base64'));

function keyAndCert(commonName = 'Fixture') {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: commonName }];
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
  return unencryptedPfxWithMac('\x03'.repeat(20), '\x00');
}

function unencryptedPfxWithMac(macKey: string, iterations: string): Uint8Array {
  const { privateKey, cert } = keyAndCert();
  const pfx = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], null as unknown as string, {
    useMac: false,
  });
  const authSafe = (pfx.value as forge.asn1.Asn1[])[1];
  const content = ((authSafe.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0];
  const hmac = forge.hmac.create();
  hmac.start('sha1', macKey);
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
    create(Class.UNIVERSAL, Type.INTEGER, false, iterations),
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

  it('rejects an unencrypted PFX with no MAC, which would unlock under any password', () => {
    const { privateKey, cert } = keyAndCert();
    const p12 = toDerBytes(
      forge.pkcs12.toPkcs12Asn1(privateKey, [cert], null as unknown as string, { useMac: false }),
    );
    expect(() => loadP12(p12, 'anything')).toThrow(MalformedCertificateError);
  });

  it('rejects an unencrypted private key even with a valid MAC: the signer could not use it', () => {
    const macKey = forge.pkcs12
      .generateKey('pw', forge.util.createBuffer('saltsalt'), 3, 1, 20)
      .getBytes();
    const p12 = unencryptedPfxWithMac(macKey, '\x01');
    expect(() => loadP12(p12, 'pw')).toThrow(/password-protected RSA private key/);
  });

  it('accepts an encrypted key with no MAC: the password still gates it', () => {
    const { privateKey, cert } = keyAndCert();
    const p12 = toDerBytes(
      forge.pkcs12.toPkcs12Asn1(privateKey, [cert], 'right', { useMac: false, algorithm: '3des' }),
    );
    expect(verifyCertPassword(p12, 'right')).toBe(true);
    expect(() => loadP12(p12, 'wrong')).toThrow(BadPasswordError);
    expect(verifyCertPassword(p12, 'wrong')).toBe(false);
    const signer = new P12Signer(Buffer.from(p12), { passphrase: 'right' });
    return expect(signer.sign(Buffer.from('data'))).resolves.toBeTruthy();
  });

  it('rejects an EC key: it would pass, then crash the signer', () => {
    const p12 = fromBase64(EC_KEY_P12);
    expect(() => loadP12(p12, 'pw')).toThrow(/RSA private key/);
    expect(() => verifyCertPassword(p12, 'pw')).toThrow(MalformedCertificateError);
    expect(verifyCertPassword(p12, 'nope')).toBe(false);
  });

  it('names a stray ECDSA certificate, which would pass and then crash the signer (#23 G1-1)', async () => {
    const p12 = fromBase64(RSA_PLUS_EC_CERT_P12);
    // The failure this guards against: the signer dereferences the certificate forge left as null.
    const signer = new P12Signer(Buffer.from(p12), { passphrase: 'pw' });
    await expect(signer.sign(Buffer.from('data'))).rejects.toThrow(TypeError);
    expect(() => loadP12(p12, 'pw')).toThrow(MalformedCertificateError);
    expect(() => loadP12(p12, 'pw')).toThrow(/includes an ECDSA certificate/);
    expect(() => verifyCertPassword(p12, 'pw')).toThrow(MalformedCertificateError);
    expect(verifyCertPassword(p12, 'nope')).toBe(false);
  });

  it('blames the ECDSA issuer, not a missing key, for an RSA ID from an ECDSA CA (#23 G1-2)', () => {
    const p12 = fromBase64(RSA_ISSUED_BY_EC_CA_P12);
    expect(() => loadP12(p12, 'pw')).toThrow(MalformedCertificateError);
    expect(() => loadP12(p12, 'pw')).toThrow(/signed by its issuer with ECDSA/);
    expect(() => loadP12(p12, 'pw')).not.toThrow(/RSA private key/);
    expect(verifyCertPassword(p12, 'nope')).toBe(false);
  });

  it('rejects a key whose certificate belongs to a different key', () => {
    const { privateKey } = keyAndCert();
    const { cert } = keyAndCert();
    const p12 = toDerBytes(forge.pkcs12.toPkcs12Asn1(privateKey, [cert], 'pw', { algorithm: '3des' }));
    expect(() => loadP12(p12, 'pw')).toThrow(/RSA private key/);
  });

  it('does not blame the password for an unsupported cipher in a no-MAC file', () => {
    const p12 = fromBase64(RC4_NO_MAC_P12);
    expect(() => loadP12(p12, 'pw')).toThrow(MalformedCertificateError);
    expect(() => loadP12(p12, 'nope')).toThrow(MalformedCertificateError);
  });

  it('names the signer, not the CA, when a chain lists the CA first', () => {
    const leaf = keyAndCert('Signer');
    const { cert: ca } = keyAndCert('Issuing CA');
    const p12 = toDerBytes(
      forge.pkcs12.toPkcs12Asn1(leaf.privateKey, [ca, leaf.cert], 'pw', { algorithm: '3des' }),
    );
    expect(getSignerCommonName(p12, 'pw')).toBe('Signer');
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
