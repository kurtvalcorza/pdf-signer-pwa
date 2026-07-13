import forge from 'node-forge';
import { loadP12 } from './cert';

function binaryToBytes(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

export interface GeneratedCertificate {
  /** PKCS#12 (private key + cert) — the signing Digital ID. */
  p12Bytes: Uint8Array;
  /** DER-encoded X.509 public certificate — export/share so others can trust the signer. */
  certDer: Uint8Array;
}

export interface CertSubject {
  /** Full name (Common Name / CN) — required. */
  commonName: string;
  /** Organization (O). */
  organization?: string;
  /** Division / department (Organizational Unit / OU). */
  organizationalUnit?: string;
  /** Email address (added to the subject DN and as a subjectAltName). */
  email?: string;
}

/**
 * Generate a self-signed PKCS#12 Digital ID entirely on-device (Principle I).
 * Self-signed → readers show "validity unknown" until the public cert is trusted
 * (FR-016). This is the same kind of ID Adobe creates for a new Digital ID.
 */
export function generateSelfSignedP12(
  subject: CertSubject,
  password: string,
  years = 5,
): GeneratedCertificate {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '00' + Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + years);

  const attrs: forge.pki.CertificateField[] = [{ name: 'commonName', value: subject.commonName }];
  if (subject.organization) attrs.push({ name: 'organizationName', value: subject.organization });
  if (subject.organizationalUnit)
    attrs.push({ name: 'organizationalUnitName', value: subject.organizationalUnit });
  if (subject.email) attrs.push({ name: 'emailAddress', value: subject.email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  const extensions: object[] = [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
  ];
  if (subject.email) {
    // rfc822Name (email) subjectAltName — where Adobe reads the signer's email.
    extensions.push({ name: 'subjectAltName', altNames: [{ type: 1, value: subject.email }] });
  }
  cert.setExtensions(extensions);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Der = forge.asn1
    .toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' }))
    .getBytes();
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();

  return { p12Bytes: binaryToBytes(p12Der), certDer: binaryToBytes(certDer) };
}

/** Extract the DER public certificate from a .p12 (to export as a .cer for trust). */
export function extractPublicCertDer(p12Bytes: Uint8Array, password: string): Uint8Array {
  const p12 = loadP12(p12Bytes, password);
  const bag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0];
  if (!bag?.cert) throw new Error('No certificate found in the .p12.');
  return binaryToBytes(forge.asn1.toDer(forge.pki.certificateToAsn1(bag.cert)).getBytes());
}
