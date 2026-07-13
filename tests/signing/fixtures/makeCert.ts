import forge from 'node-forge';

/**
 * Generate a self-signed PKCS#12 for signing tests. Self-signed → readers show
 * "validity unknown" (as the app discloses, FR-016), but the signature is
 * cryptographically real and its integrity is verifiable.
 */
export function makeSelfSignedP12(passphrase: string, commonName = 'Test Signer'): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'PDF Signer PWA (test)' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, {
    algorithm: '3des',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(der, 'binary');
}
