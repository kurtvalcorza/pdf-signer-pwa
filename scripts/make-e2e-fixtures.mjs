#!/usr/bin/env node
// Generate deterministic E2E fixtures: a sample 2-page PDF and a signature PNG.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

console.log(`fixtures written to ${DIR}`);
