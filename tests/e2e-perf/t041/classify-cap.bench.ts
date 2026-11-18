/**
 * T041 (spec 004, research.md F3): time the certified-PDF classification on a file made by
 * make_cap_pdf.py. Opt-in only: the `.bench.ts` name keeps it out of `vitest run`.
 *
 *   npx vite-node tests/e2e-perf/t041/classify-cap.bench.ts <file.pdf> [runs=5]
 *
 * Prints one JSON line: per-run times for PDFDocument.load, classifySigning and the whole
 * loadPdf, with the median and max of the classification.
 */
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { classifySigning } from '../../../src/features/signing/signingPolicy';
import { loadPdf } from '../../../src/features/viewer/loadPdf';

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function main(): Promise<void> {
  const [file, runsArg] = process.argv.slice(2);
  if (!file) throw new Error('usage: classify-cap.bench.ts <file.pdf> [runs]');
  const runs = Number(runsArg ?? 5);
  const bytes = new Uint8Array(readFileSync(file));
  const parse: number[] = [];
  const classify: number[] = [];
  const whole: number[] = [];
  let kind = '';
  for (let i = 0; i < runs; i++) {
    let t = performance.now();
    const doc = await PDFDocument.load(bytes);
    parse.push(performance.now() - t);
    t = performance.now();
    kind = (await classifySigning(doc, bytes)).kind;
    classify.push(performance.now() - t);
    t = performance.now();
    await loadPdf(bytes);
    whole.push(performance.now() - t);
  }
  const ms = (xs: number[]) => xs.map((x) => Math.round(x));
  console.log(
    JSON.stringify({
      file,
      bytes: bytes.length,
      runs,
      kind,
      parse_ms: ms(parse),
      classify_ms: ms(classify),
      loadPdf_ms: ms(whole),
      classify_median_ms: Math.round(median(classify)),
      classify_max_ms: Math.round(Math.max(...classify)),
      node: process.version,
    }),
  );
}

void main();
