#!/usr/bin/env node
// Generate deterministic E2E fixtures: a sample 2-page PDF and a signature PNG.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import forge from 'node-forge';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const E2E_CERT_PASSWORD = 'e2e-pass';

const DIR = resolve('tests/e2e/fixtures');
mkdirSync(DIR, { recursive: true });

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 2; i++) {
  const page = doc.addPage([595, 842]); // A4
  page.drawText(`Sample agreement — page ${i}`, { x: 60, y: 780, size: 16, font });
  page.drawText('Signature:', { x: 60, y: 140, size: 12, font });
  page.drawLine({ start: { x: 140, y: 138 }, end: { x: 400, y: 138 }, thickness: 1, color: rgb(0, 0, 0) });
}
writeFileSync(resolve(DIR, 'sample.pdf'), await doc.save());

// A small solid PNG (red 1x1); the app scales it to the placement box.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
writeFileSync(resolve(DIR, 'signature.png'), PNG_1x1);

// A self-signed .p12 for the crypto E2E.
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
const attrs = [
  { name: 'commonName', value: 'E2E Signer' },
  { name: 'organizationName', value: 'PDF Signer PWA (e2e)' },
];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey, forge.md.sha256.create());
const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], E2E_CERT_PASSWORD, {
  algorithm: '3des',
});
writeFileSync(
  resolve(DIR, 'e2e-cert.p12'),
  Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary'),
);

console.log(`fixtures written to ${DIR}`);
