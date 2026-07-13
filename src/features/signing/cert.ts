import forge from 'node-forge';
import { BadPasswordError } from './types';

function toBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Parse a PKCS#12; throws if the password is wrong (FR-015). In-memory only. */
export function loadP12(p12Bytes: Uint8Array, password: string): forge.pkcs12.Pkcs12Pfx {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(toBinary(p12Bytes)));
    return forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch {
    // node-forge throws "MAC could not be verified" on a bad password.
    throw new BadPasswordError();
  }
}

/** True iff the password unlocks the certificate (used before signing, FR-015). */
export function verifyCertPassword(p12Bytes: Uint8Array, password: string): boolean {
  try {
    loadP12(p12Bytes, password);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort signer common name for display; null if unavailable. */
export function getSignerCommonName(p12Bytes: Uint8Array, password: string): string | null {
  const p12 = loadP12(p12Bytes, password);
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = bags[forge.pki.oids.certBag]?.[0];
  const cert = certBag?.cert;
  if (!cert) return null;
  const cn = cert.subject.getField('CN');
  return cn?.value ?? null;
}
