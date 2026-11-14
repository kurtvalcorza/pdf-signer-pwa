import forge from 'node-forge';
import { BadPasswordError, MalformedCertificateError } from './types';

function toBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const WRONG_PASSWORD = /MAC could not be verified|wrong password|Invalid password/i;
// Facts about the file that hold under any password, so they never mean a mistyped one.
const UNUSABLE_FILE = /unsupported|iteration count must be/i;

/**
 * Parse a PKCS#12 in memory (FR-015). Throws BadPasswordError when the password does not unlock it
 * and MalformedCertificateError for anything else unusable.
 *
 * What makes a password check real is either a MAC or an encrypted private key, and the signer needs
 * the encrypted form regardless: P12Signer reads only pkcs8ShroudedKeyBag. So the key must be
 * shrouded, and a file with no MAC is accepted only on that basis, since it then still cannot be read
 * without the password. The same goes for the rest of P12Signer's rule: an RSA key with a matching
 * certificate. Forge >= 1.4.1 rejects zero-iteration MACs and key derivations (GHSA-jc66-7q78-782g);
 * tests/signing/p12Malformed.test.ts holds that in place.
 */
export function loadP12(p12Bytes: Uint8Array, password: string): forge.pkcs12.Pkcs12Pfx {
  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(forge.util.createBuffer(toBinary(p12Bytes)));
  } catch {
    throw new MalformedCertificateError();
  }
  if (!Array.isArray(asn1.value) || asn1.value.length < 2) throw new MalformedCertificateError();
  const hasMac = asn1.value.length > 2;

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    // With no MAC, a wrong password shows up as undecryptable content in any number of ways.
    if (WRONG_PASSWORD.test(message) || (!hasMac && !UNUSABLE_FILE.test(message))) {
      throw new BadPasswordError();
    }
    throw new MalformedCertificateError();
  }

  const { pkcs8ShroudedKeyBag } = forge.pki.oids;
  const hasKey = !!p12.getBags({ bagType: pkcs8ShroudedKeyBag })[pkcs8ShroudedKeyBag]?.[0]?.key;
  // Checked before the key/certificate match so the message names the real cause: forge leaves a
  // certificate it cannot read as null, and an RSA ID issued by an ECDSA CA is one of those.
  if (hasKey) {
    const unreadable = unreadableCertificate(p12);
    if (unreadable) throw new MalformedCertificateError(unreadable);
  }
  if (!signingCertificate(p12)) {
    throw new MalformedCertificateError(
      'This .p12 needs a password-protected RSA private key and its certificate, so it was not used.',
    );
  }
  return p12;
}

const EC_OID_PREFIX = '1.2.840.10045.';

/**
 * P12Signer adds every certificate bag to the signature and dereferences each one, so a single bag
 * forge could not parse (cert === null) makes it throw a raw TypeError (#23 G1-1). Returns the
 * message for such bags, or null when every certificate is readable. A bag whose key is RSA but
 * which forge still could not read was signed by its issuer with a non-RSA algorithm, such as an
 * ECDSA CA (#23 G1-2); that cause is reported in preference to a stray non-RSA certificate.
 */
function unreadableCertificate(p12: forge.pkcs12.Pkcs12Pfx): string | null {
  const { certBag } = forge.pki.oids;
  const bags = (p12.getBags({ bagType: certBag })[certBag] ?? []).filter((bag) => !bag.cert);
  if (bags.length === 0) return null;
  const algorithms = bags.map((bag) => certificateAlgorithms(bag.asn1));
  const rsaKeyed = algorithms.find((a) => a?.publicKey === forge.pki.oids.rsaEncryption);
  if (rsaKeyed) {
    const by = rsaKeyed.signature?.startsWith(EC_OID_PREFIX)
      ? 'ECDSA'
      : 'an algorithm other than RSA';
    return `This .p12's certificate was signed by its issuer with ${by}, which the signer cannot read, so it was not used.`;
  }
  const ec = algorithms.some((a) => a?.publicKey?.startsWith(EC_OID_PREFIX));
  return `This .p12 includes ${ec ? 'an ECDSA' : 'a non-RSA'} certificate, which the signer cannot read, so it was not used.`;
}

/** OIDs of a certificate's public key and of its issuer's signature, read from raw ASN.1. */
function certificateAlgorithms(
  cert: forge.asn1.Asn1 | undefined,
): { publicKey: string; signature: string } | null {
  try {
    const [tbs, signatureAlgorithm] = cert!.value as forge.asn1.Asn1[];
    const fields = tbs.value as forge.asn1.Asn1[];
    // Skip the optional [0] version; then serial, signature, issuer, validity, subject, SPKI.
    const first = fields[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
    const spki = fields[first + 5].value as forge.asn1.Asn1[];
    const oidOf = (seq: forge.asn1.Asn1) =>
      forge.asn1.derToOid((seq.value as forge.asn1.Asn1[])[0].value as string);
    return { publicKey: oidOf(spki[0]), signature: oidOf(signatureAlgorithm) };
  } catch {
    return null;
  }
}

/**
 * The certificate that belongs to the private key, as P12Signer chooses it. Forge leaves an EC key or
 * certificate as null rather than failing, and a chain may list the CA first, so bags alone say
 * nothing about usability or which certificate is the signer's.
 */
export function signingCertificate(p12: forge.pkcs12.Pkcs12Pfx): forge.pki.Certificate | null {
  const { pkcs8ShroudedKeyBag, certBag } = forge.pki.oids;
  const key = p12.getBags({ bagType: pkcs8ShroudedKeyBag })[pkcs8ShroudedKeyBag]?.[0]?.key as
    | forge.pki.rsa.PrivateKey
    | null
    | undefined;
  if (!key) return null;
  const certs = (p12.getBags({ bagType: certBag })[certBag] ?? []).map((bag) => bag.cert);
  return (
    certs.find((cert) => {
      const publicKey = cert?.publicKey as forge.pki.rsa.PublicKey | undefined;
      return publicKey?.n?.compareTo(key.n) === 0 && publicKey.e.compareTo(key.e) === 0;
    }) ?? null
  );
}

/**
 * True iff the password unlocks the certificate (used before signing, FR-015). A malformed
 * file is not a wrong password, so MalformedCertificateError propagates to the caller.
 */
export function verifyCertPassword(p12Bytes: Uint8Array, password: string): boolean {
  try {
    loadP12(p12Bytes, password);
    return true;
  } catch (e) {
    if (e instanceof BadPasswordError) return false;
    throw e;
  }
}

/** Best-effort signer common name for display; null if unavailable. */
export function getSignerCommonName(p12Bytes: Uint8Array, password: string): string | null {
  const cn = signingCertificate(loadP12(p12Bytes, password))?.subject.getField('CN');
  return cn?.value ?? null;
}
