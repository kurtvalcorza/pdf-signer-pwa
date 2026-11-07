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
