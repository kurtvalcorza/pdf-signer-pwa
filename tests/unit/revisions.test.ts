/**
 * Signed revisions of a certified PDF (specs/004-certified-field-signing, research.md R1).
 * Fixtures are pyHanko's (scripts/make_policy_fixtures.py); every refusal here is a pyHanko
 * policy violation and every acceptance a pyHanko pass (research.md R1 table).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import {
  MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION,
  FormTooLargeError,
  analyzeRevisions,
  compareRevisions,
  existedAtCertification,
  loadRevision,
  partialName,
  refKey,
  signatureEntries,
  signatureFieldKeys,
  walkFormNodes,
} from '../../src/features/signing/revisions';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = resolve(HERE, '../signing/fixtures/policy');
const load = (name: string) => new Uint8Array(readFileSync(resolve(POLICY, name)));
const N = (s: string) => PDFName.of(s);
const parse = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });

async function analyze(name: string) {
  const bytes = load(name);
  return { bytes, analysis: await analyzeRevisions(await parse(bytes), bytes) };
}

function fieldRef(doc: PDFDocument, name: string): PDFRef {
  const node = walkFormNodes(doc).nodes.find((n) => partialName(n.dict) === name);
  if (!node?.ref) throw new Error(`fixture lacks field ${name}`);
  return node.ref;
}

/** Ends (`b + c`) of every /ByteRange in the raw bytes, ascending. */
function rangeEnds(bytes: Uint8Array): number[] {
  const text = Buffer.from(bytes).toString('latin1');
  return [...text.matchAll(/\/ByteRange\s*\[\s*0\s+\d+\s+(\d+)\s+(\d+)/g)]
    .map((m) => Number(m[1]) + Number(m[2]))
    .sort((a, b) => a - b);
}

describe('signed revisions: rule 5c (the field existed at certification)', () => {
  it.each([
    'certified-p2-empty-field.pdf',
    'certified-p3-empty-field.pdf',
    'certified-p2-empty-field-xref-stream.pdf',
    'certified-p2-two-empty-fields.pdf',
  ])('%s: one signed revision, and Approver is in it', async (name) => {
    const { bytes, analysis } = await analyze(name);
    expect(analysis).toMatchObject({ ok: true, ends: [bytes.length], fills: [] });
    if (!analysis.ok) return;
    const ref = fieldRef(await parse(bytes), 'Approver');
    expect(existedAtCertification(analysis.certified, ref, 'Approver')).toBe(true);
    expect(existedAtCertification(analysis.certified, ref, 'Someone else')).toBe(false);
    expect(signatureFieldKeys(analysis.certified.doc).has(refKey(ref))).toBe(true);
  });

  it('a visible field appended after certification is not in the certified revision', async () => {
    const { bytes, analysis } = await analyze('certified-p2-late-visible-field.pdf');
    expect(analysis).toMatchObject({ ok: false, reason: 'unsigned-tail' });
    const certified = await loadRevision(bytes, rangeEnds(bytes)[0]);
    const late = fieldRef(await parse(bytes), 'Late');
    expect(existedAtCertification(certified, late, 'Late')).toBe(false);
  });
});

describe('signed revisions: rule 5d (every later revision is one fill)', () => {
  it.each([
    'certified-p2-two-empty-fields-signed-once.pdf',
    'certified-p2-two-empty-fields-signed-once-xref-stream.pdf',
  ])(
    '%s: certification, then one fill of Approver; Witness is still certified-era',
    async (name) => {
      const { bytes, analysis } = await analyze(name);
      expect(analysis.ok).toBe(true);
      if (!analysis.ok) return;
      const doc = await parse(bytes);
      expect(analysis.ends).toHaveLength(2);
      expect(analysis.ends[1]).toBe(bytes.length);
      expect(analysis.fills).toEqual([refKey(fieldRef(doc, 'Approver'))]);
      expect(existedAtCertification(analysis.certified, fieldRef(doc, 'Witness'), 'Witness')).toBe(
        true,
      );
    },
  );

  it('C1: a foreign fill that also rewrites the trailer /Info is accepted', async () => {
    // pyHanko's own fill stamps /ModDate and /Producer into /Info (research.md F1).
    const { bytes, analysis } = await analyze('certified-p2-empty-field-signed-once.pdf');
    expect(analysis).toMatchObject({ ok: true });
    if (!analysis.ok) return;
    expect(analysis.fills).toHaveLength(1);

    // The same step is refused when /Info rewrites are not on the allow-list (the app's own output).
    const [first, second] = analysis.ends;
    const before = await loadRevision(bytes, first);
    const after = await loadRevision(bytes, second);
    const strict = compareRevisions(before, after, {
      allowInfoRewrite: false,
      certified: before,
      certifiedFieldKeys: signatureFieldKeys(before.doc),
    });
    expect(strict).toEqual({ ok: false, detail: 'info-rewritten' });
  });

  it('C1: nothing but /Info is on the allow-list (an XMP /Metadata rewrite refuses)', async () => {
    const bytes = load('certified-p2-empty-field-signed-once.pdf');
    const [first, second] = rangeEnds(bytes);
    const before = await loadRevision(bytes, first);
    const after = await loadRevision(bytes, second);
    const opts = {
      allowInfoRewrite: true,
      certified: before,
      certifiedFieldKeys: signatureFieldKeys(before.doc),
    };
    expect(compareRevisions(before, after, opts, bytes).ok).toBe(true);

    // Stand-in for a rewritten metadata stream: any other pre-existing object that differs.
    const info = after.doc.context.trailerInfo.Info as PDFRef;
    const field = refKey(fieldRef(after.doc, 'Approver'));
    const other = [...before.objects.keys()].find((k) => k !== refKey(info) && k !== field)!;
    const tampered = { ...after, objects: new Map(after.objects) };
    tampered.objects.set(other, new Uint8Array([0x25]));
    expect(compareRevisions(before, tampered, opts, bytes)).toMatchObject({ ok: false });

    // An /Info that carries anything but direct strings and names is not the allowed shape.
    after.doc.context.lookup(info, PDFDict).set(N('Metadata'), PDFRef.of(1));
    expect(compareRevisions(before, after, opts, bytes)).toEqual({
      ok: false,
      detail: 'info-not-plain',
    });
  });

  it.each(['certified-p3-annotation-then-fill.pdf', 'certified-p2-two-revisions.pdf'])(
    '%s: a change inside a later signature byte range is not a single fill',
    async (name) => {
      expect((await analyze(name)).analysis).toMatchObject({
        ok: false,
        reason: 'not-a-single-fill',
      });
    },
  );

  it.each(['certified-p2-later-annotation.pdf', 'certified-p3-later-annotation.pdf'])(
    '%s: content after the last signature is refused',
    async (name) => {
      expect((await analyze(name)).analysis).toMatchObject({ ok: false, reason: 'unsigned-tail' });
    },
  );

  it('the certified prefix of a filled document is itself a complete certified file', async () => {
    const bytes = load('certified-p2-two-empty-fields-signed-once.pdf');
    const prefix = bytes.subarray(0, rangeEnds(bytes)[0]);
    expect(Buffer.from(prefix.subarray(-6)).toString('latin1')).toMatch(/%%EOF\r?\n?$/);
    expect(await analyzeRevisions(await parse(prefix), prefix)).toMatchObject({
      ok: true,
      fills: [],
    });
  });
});

describe('signed revisions: malformed input is refused, never thrown', () => {
  const sigOf = (doc: PDFDocument, name: string) =>
    doc.context.lookup(fieldRef(doc, name), PDFDict).lookup(N('V'), PDFDict);
  const range = (doc: PDFDocument, name: string) =>
    sigOf(doc, name)
      .lookup(N('ByteRange'), PDFArray)
      .asArray()
      .map((n) => Number(n.toString()));

  it.each([
    ['does not start at 0', (r: number[]) => [1, r[1], r[2], r[3]]],
    ['has an empty or inverted gap', (r: number[]) => [0, r[2], r[1], r[3]]],
    ['runs past the end of the file', (r: number[]) => [0, r[1], r[2], r[3] + 1]],
    ['has a gap that is not the hex string', (r: number[]) => [0, r[1] + 1, r[2], r[3]]],
    ['has three numbers', (r: number[]) => [0, r[1], r[2]]],
  ])('a /ByteRange that %s', async (_label, change) => {
    const bytes = load('certified-p2-empty-field.pdf');
    const doc = await parse(bytes);
    sigOf(doc, 'Cert').set(N('ByteRange'), doc.context.obj(change(range(doc, 'Cert'))));
    expect(await analyzeRevisions(doc, bytes)).toEqual({
      ok: false,
      reason: 'malformed-byte-range',
    });
  });

  it('two signatures that end at the same byte', async () => {
    const bytes = load('certified-p2-two-empty-fields-signed-once.pdf');
    const doc = await parse(bytes);
    sigOf(doc, 'Approver').set(N('ByteRange'), doc.context.obj(range(doc, 'Cert')));
    expect(await analyzeRevisions(doc, bytes)).toEqual({
      ok: false,
      reason: 'duplicate-byte-range',
    });
  });

  it('a signature that ends before the certification', async () => {
    const bytes = load('certified-p2-two-empty-fields-signed-once.pdf');
    const doc = await parse(bytes);
    const later = doc.context.lookup(fieldRef(doc, 'Approver'), PDFDict).get(N('V'))!;
    doc.catalog.lookup(N('Perms'), PDFDict).set(N('DocMDP'), later);
    expect(await analyzeRevisions(doc, bytes)).toEqual({
      ok: false,
      reason: 'signature-before-certification',
    });
  });

  it('a catalog certification that no field holds', async () => {
    const bytes = load('certified-p2-empty-field.pdf');
    const doc = await parse(bytes);
    doc.catalog.lookup(N('Perms'), PDFDict).set(N('DocMDP'), PDFRef.of(99999));
    expect(await analyzeRevisions(doc, bytes)).toEqual({
      ok: false,
      reason: 'no-single-certification',
    });
  });

  it(`more than ${MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION} signed revisions after certification (C2)`, async () => {
    const bytes = load('certified-p2-empty-field-signed-once.pdf');
    const doc = await parse(bytes);
    const [zero, a, b, c] = range(doc, 'Approver');
    const fields = doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('Fields'), PDFArray);
    // Extra signature dictionaries sharing the real gap, each ending one byte earlier.
    for (let k = 1; k <= MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION; k++) {
      const sig = doc.context.register(doc.context.obj({ ByteRange: [zero, a, b, c - k] }));
      fields.push(doc.context.register(doc.context.obj({ FT: 'Sig', T: `Extra${k}`, V: sig })));
    }
    expect(signatureEntries(walkFormNodes(doc).nodes)).toHaveLength(
      MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION + 2,
    );
    expect(await analyzeRevisions(doc, bytes)).toEqual({ ok: false, reason: 'too-many-revisions' });
  });

  it('bytes that do not match the parsed document, and a document that cannot be walked', async () => {
    const bytes = load('certified-p2-empty-field.pdf');
    const doc = await parse(bytes);
    expect(await analyzeRevisions(doc, bytes.subarray(0, 200))).toMatchObject({ ok: false });
    await expect(analyzeRevisions({} as PDFDocument, bytes)).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});

describe('the form walk', () => {
  it('follows nested /Kids and records each parent', async () => {
    const doc = await parse(load('certified-p2-inherited-v.pdf'));
    const walk = walkFormNodes(doc);
    const approver = walk.nodes.find((n) => partialName(n.dict) === 'Approver')!;
    expect(partialName(approver.parent!.dict)).toBe('Group');
    expect(walk.roots.map((n) => partialName(n.dict))).toContain('Group');
    expect(walk.repeated).toBe(false);
  });

  it('visits a dictionary reachable twice only once, and says so', async () => {
    const doc = await parse(load('certified-p2-inherited-v.pdf'));
    const group = walkFormNodes(doc).nodes.find((n) => partialName(n.dict) === 'Group')!;
    group.dict.lookup(N('Kids'), PDFArray).push(group.ref!); // a cycle
    const walk = walkFormNodes(doc);
    expect(walk.repeated).toBe(true);
    expect(walk.nodes.filter((n) => n.dict === group.dict)).toHaveLength(1);
  });

  it('stops above the cap', async () => {
    const doc = await parse(load('certified-p2-two-empty-fields.pdf'));
    expect(() => walkFormNodes(doc, 1)).toThrow(FormTooLargeError);
  });
});
