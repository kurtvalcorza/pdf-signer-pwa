/**
 * SPIKE for specs/004-certified-field-signing (research.md R1). Not product code.
 *
 * Question: pdf-lib only exposes the final, merged object graph. Rules 5c and 5d of RFC 23-1 need
 * to know what the document looked like when it was certified, and what each later revision
 * changed. Does loading the byte prefix that a signature's /ByteRange covers, as a document of its
 * own, give both rules what they need?
 *
 * The prototype below is deliberately small. The hardened version belongs in
 * src/features/signing/revisions.ts (tasks.md), and this file is deleted when it lands.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRef } from 'pdf-lib';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = resolve(HERE, 'fixtures/policy');
const OUT = resolve(HERE, 'out');
const load = (name: string) => new Uint8Array(readFileSync(resolve(POLICY, name)));
const N = (s: string) => PDFName.of(s);

/** Keys a signature fill may change on the field dictionary (pyHanko VALUE_UPDATE_KEYS). */
const FILL_KEYS = new Set(['/AP', '/AS', '/V', '/F', '/DA', '/Q', '/Ff', '/Type']);

const serialize = (o: PDFObject): string => {
  const buf = new Uint8Array(o.sizeInBytes());
  o.copyBytesInto(buf, 0);
  return Buffer.from(buf).toString('latin1');
};

/** A parsed revision: the document as it stood at byte `end`, plus every object serialized. */
interface Revision {
  end: number;
  doc: PDFDocument;
  objects: Map<string, string>; // "num gen" -> serialized object
}

async function revisionAt(bytes: Uint8Array, end: number): Promise<Revision> {
  // updateMetadata:false matters: the default rewrites /Info, which would show up as a change.
  const doc = await PDFDocument.load(bytes.subarray(0, end), { updateMetadata: false });
  const objects = new Map<string, string>();
  // Serialize before anything walks the page tree, so no lazy normalisation can leak in.
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    objects.set(`${ref.objectNumber} ${ref.generationNumber}`, serialize(obj));
  }
  return { end, doc, objects };
}

interface SigField {
  ref: PDFRef;
  name: string;
  /** End of the byte range of the signature in /V, or null when the field is empty. */
  signedEnd: number | null;
  isCertification: boolean;
}

/** Root-level /Sig fields. The spike does not walk /Kids: no fixture here nests fields. */
function sigFields(doc: PDFDocument, fileLength: number, bytes?: Uint8Array): SigField[] {
  const acro = doc.catalog.lookupMaybe(N('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(N('Fields'), PDFArray);
  const certRef = doc.catalog.lookupMaybe(N('Perms'), PDFDict)?.get(N('DocMDP'));
  const out: SigField[] = [];
  for (let i = 0; fields && i < fields.size(); i++) {
    const ref = fields.get(i);
    if (!(ref instanceof PDFRef)) throw new Error('direct field dictionary');
    const field = doc.context.lookup(ref, PDFDict);
    if (field.get(N('FT')) !== N('Sig')) continue;
    const name = field.lookup(N('T'))?.toString() ?? '';
    const vRef = field.get(N('V'));
    const v = field.lookupMaybe(N('V'), PDFDict);
    let signedEnd: number | null = null;
    if (v) {
      const br = v.lookup(N('ByteRange'), PDFArray);
      const [zero, a, b, c] = [0, 1, 2, 3].map((k) => br.lookup(k, PDFNumber).asNumber());
      if (br.size() !== 4 || zero !== 0 || !(a < b) || b + c > fileLength) {
        throw new Error(`malformed /ByteRange on ${name}`);
      }
      // The gap must be exactly the /Contents hex string, or the range is not what it claims.
      if (bytes && (bytes[a] !== 0x3c || bytes[b - 1] !== 0x3e)) {
        throw new Error(`/ByteRange gap of ${name} is not a hex string`);
      }
      signedEnd = b + c;
    }
    out.push({ ref, name, signedEnd, isCertification: !!vRef && vRef === certRef });
  }
  return out;
}

type Verdict =
  | { ok: true; ends: number[]; fills: string[]; infoRewritten: boolean[]; revisions: Revision[] }
  | { ok: false; reason: string; detail?: unknown };

/**
 * Rule 5d: every revision after the certification is exactly one signature fill.
 *
 * `tolerateInfo` also accepts a rewrite of the trailer's /Info dictionary in the same revision.
 * pyHanko's own fill does that (it stamps /ModDate and /Producer), so without it a document
 * filled by pyHanko is refused. Whether to tolerate it is an owner decision (research.md R1).
 */
async function classifyRevisions(
  bytes: Uint8Array,
  { tolerateInfo = false }: { tolerateInfo?: boolean } = {},
): Promise<Verdict> {
  const final = await PDFDocument.load(bytes, { updateMetadata: false });
  const signed = sigFields(final, bytes.length, bytes).filter((f) => f.signedEnd !== null);
  const cert = signed.filter((f) => f.isCertification);
  if (cert.length !== 1) return { ok: false, reason: 'no-single-certification' };

  const ends = signed.map((f) => f.signedEnd!).sort((x, y) => x - y);
  if (new Set(ends).size !== ends.length) return { ok: false, reason: 'duplicate-byte-range' };
  if (ends[0] !== cert[0].signedEnd) return { ok: false, reason: 'signature-before-certification' };
  if (ends[ends.length - 1] !== bytes.length) {
    return { ok: false, reason: 'unsigned-revision-after-last-signature' };
  }

  const revisions: Revision[] = [];
  for (const end of ends) revisions.push(await revisionAt(bytes, end));

  const fills: string[] = [];
  const infoRewritten: boolean[] = [];
  for (let i = 0; i + 1 < revisions.length; i++) {
    const [a, b] = [revisions[i], revisions[i + 1]];
    let changed: string[] = [];
    for (const [key, before] of a.objects) {
      if (b.objects.get(key) !== before) changed.push(key);
    }
    const info = b.doc.context.trailerInfo.Info;
    const infoKey = info instanceof PDFRef ? `${info.objectNumber} ${info.generationNumber}` : '';
    infoRewritten.push(changed.includes(infoKey));
    if (tolerateInfo) changed = changed.filter((k) => k !== infoKey);
    if (changed.length !== 1) {
      return {
        ok: false,
        reason: 'revision-is-not-a-single-fill',
        detail: { step: i + 1, changed },
      };
    }
    const [num, gen] = changed[0].split(' ').map(Number);
    const ref = PDFRef.of(num, gen);
    const before = a.doc.context.lookup(ref);
    const after = b.doc.context.lookup(ref);
    if (!(before instanceof PDFDict) || !(after instanceof PDFDict)) {
      return { ok: false, reason: 'changed-object-is-not-a-field', detail: changed };
    }
    const wasEmptySig = before.get(N('FT')) === N('Sig') && !before.has(N('V'));
    const inCertifiedRevision = sigFields(revisions[0].doc, bytes.length).some(
      (f) => f.ref === ref,
    );
    const value = after.lookupMaybe(N('V'), PDFDict);
    const br = value?.lookupMaybe(N('ByteRange'), PDFArray);
    const end = br ? br.lookup(2, PDFNumber).asNumber() + br.lookup(3, PDFNumber).asNumber() : -1;
    const keys = new Set([...before.keys(), ...after.keys()].map((k) => k.toString()));
    const otherKeysEqual = [...keys]
      .filter((k) => !FILL_KEYS.has(k))
      .every((k) => before.get(N(k.slice(1)))?.toString() === after.get(N(k.slice(1)))?.toString());
    const valueIsNew = !a.objects.has(
      `${(after.get(N('V')) as PDFRef).objectNumber} ${(after.get(N('V')) as PDFRef).generationNumber}`,
    );
    if (!wasEmptySig || !inCertifiedRevision || end !== b.end || !otherKeysEqual || !valueIsNew) {
      return {
        ok: false,
        reason: 'changed-object-is-not-a-fill',
        detail: { wasEmptySig, inCertifiedRevision, end, otherKeysEqual, valueIsNew },
      };
    }
    fills.push(after.lookup(N('T'))!.toString());
  }
  return { ok: true, ends, fills, infoRewritten, revisions };
}

/** Rule 5c: the field and its page /Annots entry are defined in the certified revision. */
async function existedAtCertification(bytes: Uint8Array, fieldName: string): Promise<boolean> {
  const final = await PDFDocument.load(bytes, { updateMetadata: false });
  const all = sigFields(final, bytes.length, bytes);
  const cert = all.find((f) => f.isCertification);
  const target = all.find((f) => f.name === fieldName);
  if (!cert || !target) throw new Error(`fixture lacks ${fieldName} or a certification`);
  const certified = await PDFDocument.load(bytes.subarray(0, cert.signedEnd!), {
    updateMetadata: false,
  });
  const field = certified.context.lookup(target.ref);
  if (!(field instanceof PDFDict) || field.get(N('FT')) !== N('Sig')) return false;
  if (field.lookup(N('T'))?.toString() !== fieldName) return false;
  return certified
    .getPages()
    .some((p) => (p.node.lookupMaybe(N('Annots'), PDFArray)?.indexOf(target.ref) ?? -1) >= 0);
}

const report: Record<string, unknown> = {};
afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'revision-spike.json'), JSON.stringify(report, null, 2));
});

describe('004 spike: a signature byte-range prefix loads as its own revision', () => {
  it.each([
    'certified-p2-empty-field.pdf',
    'certified-p3-empty-field.pdf',
    'certified-p2-empty-field-xref-stream.pdf',
    'certified-p2-two-empty-fields.pdf',
  ])('5c: %s resolves its empty field inside the certified revision', async (name) => {
    const bytes = load(name);
    expect(await existedAtCertification(bytes, '(Approver)')).toBe(true);
    const verdict = await classifyRevisions(bytes);
    expect(verdict).toMatchObject({ ok: true, ends: [bytes.length], fills: [] });
    report[name] = { ok: verdict.ok, objects: verdict.ok && verdict.revisions[0].objects.size };
  });

  it('5c: a visible field appended after certification is not in the certified revision', async () => {
    const bytes = load('certified-p2-late-visible-field.pdf');
    expect(await existedAtCertification(bytes, '(Late)')).toBe(false);
    const verdict = await classifyRevisions(bytes);
    expect(verdict).toMatchObject({ ok: false, reason: 'unsigned-revision-after-last-signature' });
    report['certified-p2-late-visible-field.pdf'] = verdict;
  });

  it.each([
    'certified-p2-two-empty-fields-signed-once.pdf',
    'certified-p2-two-empty-fields-signed-once-xref-stream.pdf',
  ])('5d: %s is certification + one fill, and Witness is still certified-era', async (name) => {
    const bytes = load(name);
    const verdict = await classifyRevisions(bytes);
    expect(verdict).toMatchObject({ ok: true, fills: ['(Approver)'] });
    if (!verdict.ok) return;
    expect(verdict.ends).toHaveLength(2);
    expect(verdict.ends[1]).toBe(bytes.length);
    expect(await existedAtCertification(bytes, '(Witness)')).toBe(true);
    // The first prefix is byte-for-byte the certified document the fill was made from.
    const [certified, filled] = verdict.revisions;
    report[name] = {
      ok: true,
      ends: verdict.ends,
      fills: verdict.fills,
      objectsBefore: certified.objects.size,
      objectsAfter: filled.objects.size,
    };
    expect(filled.objects.size).toBeGreaterThan(certified.objects.size);
  });

  it("5d: pyHanko's own fill also rewrites /Info, which the strict rule refuses", async () => {
    // FINDING. The fill changed two pre-existing objects: the field, and the trailer's /Info
    // (new /ModDate). The two-field fixtures above pass the strict rule only because their
    // certification and fill were written within the same second, so /ModDate did not move.
    const bytes = load('certified-p2-empty-field-signed-once.pdf');
    const strict = await classifyRevisions(bytes);
    expect(strict).toMatchObject({ ok: false, reason: 'revision-is-not-a-single-fill' });
    expect((strict as { detail: { changed: string[] } }).detail.changed).toHaveLength(2);
    const tolerant = await classifyRevisions(bytes, { tolerateInfo: true });
    expect(tolerant).toMatchObject({ ok: true, fills: ['(Approver)'], infoRewritten: [true] });
    report['certified-p2-empty-field-signed-once.pdf'] = { strict, tolerant: { ok: tolerant.ok } };
  });

  it('5d: tolerating /Info does not let the other refusals through', async () => {
    for (const name of [
      'certified-p3-annotation-then-fill.pdf',
      'certified-p2-two-revisions.pdf',
    ]) {
      const verdict = await classifyRevisions(load(name), { tolerateInfo: true });
      expect(verdict).toMatchObject({ ok: false, reason: 'revision-is-not-a-single-fill' });
    }
  });

  it.each(['certified-p2-later-annotation.pdf', 'certified-p3-later-annotation.pdf'])(
    '5d: %s has an unsigned revision after the last signature',
    async (name) => {
      const verdict = await classifyRevisions(load(name));
      expect(verdict).toMatchObject({
        ok: false,
        reason: 'unsigned-revision-after-last-signature',
      });
      report[name] = verdict;
    },
  );

  it('5d: an annotation revision hidden inside the next signature byte range is caught', async () => {
    const verdict = await classifyRevisions(load('certified-p3-annotation-then-fill.pdf'));
    expect(verdict).toMatchObject({ ok: false, reason: 'revision-is-not-a-single-fill' });
    report['certified-p3-annotation-then-fill.pdf'] = verdict;
  });

  it('5d: an approval signature in a NEW field after certification is caught', async () => {
    const verdict = await classifyRevisions(load('certified-p2-two-revisions.pdf'));
    expect(verdict).toMatchObject({ ok: false, reason: 'revision-is-not-a-single-fill' });
    report['certified-p2-two-revisions.pdf'] = verdict;
  });

  it('the certified prefix of a filled document equals the standalone certified fixture', async () => {
    // Same construction, different run of the generator, so compare shape, not bytes: the
    // prefix must itself be a complete file ending in %%EOF that classifies as "no later revision".
    const bytes = load('certified-p2-two-empty-fields-signed-once.pdf');
    const verdict = await classifyRevisions(bytes);
    if (!verdict.ok) throw new Error(verdict.reason);
    const prefix = bytes.subarray(0, verdict.ends[0]);
    expect(Buffer.from(prefix.subarray(-6)).toString('latin1')).toMatch(/%%EOF\r?\n?$/);
    expect(await classifyRevisions(prefix)).toMatchObject({ ok: true, fills: [] });
  });
});
