/**
 * The cross-reference check of rule 5d (review finding R1): a later revision must look the same
 * through its xref section, which a conforming reader follows, as in pdf-lib's file-order graph.
 *
 * Each case appends ONE hand-written incremental section to a certified fixture and checks it
 * directly. No signature covers the section: the check reads structure, not cryptography, and a
 * single section is the shape an attacker who signs with their own tool would produce. Every
 * refusal asserts its exact reason, so a test fails when its guard is removed. The committed
 * `certified-p2-xref-*.pdf` fixtures show the same class with intact signatures (pyHanko's fill
 * on top of a crafted section), which the classification then refuses as a whole.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import {
  analyzeRevisions,
  loadRevision,
  partialName,
  refKey,
  walkFormNodes,
  type SignedRevision,
} from '../../src/features/signing/revisions';
import {
  checkRevisionXref,
  initialXrefState,
  readSection,
  readStartxref,
  scanObjectHeaders,
  serialize,
  type XrefStateResult,
} from '../../src/features/signing/xrefSections';

const POLICY = resolve(dirname(fileURLToPath(import.meta.url)), '../signing/fixtures/policy');
const load = (name: string) => new Uint8Array(readFileSync(resolve(POLICY, name)));

interface Obj {
  num: number;
  gen?: number;
  body: string | Buffer;
  /** false: written to the file but left out of the xref. */
  listed?: boolean;
  /** Offset to put in the xref instead of the real one. */
  offset?: number;
}
interface SectionOptions {
  /** Extra rows after the object-0 entry and the listed objects. */
  rows?: string;
  /** Replaces the default `/Prev <previous startxref>`. */
  prev?: string;
  root?: string;
  info?: string;
  extra?: string;
  /** Raw bytes placed between the trailer and `startxref`. */
  unreached?: string;
  /** Raw bytes placed after the objects, before the section a reader reaches. */
  before?: string;
}

let base: Uint8Array;
let baseDoc: PDFDocument;
let before: SignedRevision;
let field: PDFRef;
let fieldBody: string;
let contents: PDFRef;
let root: string;
let info: string;
let prevStartxref: number;

const SIG = '<< /Type /Sig /ByteRange [ 0 1 2 3 ] >>';
const NEW = 50; // the fixture's highest object number is far below this

beforeAll(async () => {
  base = load('certified-p2-two-empty-fields.pdf');
  baseDoc = await PDFDocument.load(base, { updateMetadata: false });
  before = await loadRevision(base);
  field = walkFormNodes(baseDoc).nodes.find((n) => partialName(n.dict) === 'Approver')!.ref!;
  const dict = baseDoc.context.lookup(field, PDFDict).toString();
  fieldBody = dict.replace(/>>\s*$/, `/V ${NEW} 0 R\n>>`);
  contents = baseDoc.getPages()[0].node.get(PDFName.of('Contents')) as PDFRef;
  const trailer = baseDoc.context.trailerInfo;
  root = `${refKey(trailer.Root as PDFRef)} R`;
  info = `${refKey(trailer.Info as PDFRef)} R`;
  prevStartxref = readStartxref(base, base.length)!.target;
});

/** Append one classic incremental section to `pdf`. */
function appendSection(pdf: Uint8Array, objects: Obj[], opts: SectionOptions = {}): Uint8Array {
  let out = Buffer.from(pdf);
  const rows: string[] = ['0 1\n0000000000 65535 f \n'];
  for (const o of objects) {
    const at = out.length + 1;
    out = Buffer.concat([
      out,
      Buffer.from(`\n${o.num} ${o.gen ?? 0} obj\n`),
      typeof o.body === 'string' ? Buffer.from(o.body, 'latin1') : o.body,
      Buffer.from('\nendobj\n'),
    ]);
    if (o.listed !== false) {
      const offset = String(o.offset ?? at).padStart(10, '0');
      rows.push(`${o.num} 1\n${offset} ${String(o.gen ?? 0).padStart(5, '0')} n \n`);
    }
  }
  out = Buffer.concat([out, Buffer.from(opts.before ?? '', 'latin1')]);
  const at = out.length;
  const prev = opts.prev ?? `/Prev ${readStartxref(pdf, pdf.length)!.target}`;
  const trailer =
    `<< /Size 99 ${opts.root ?? `/Root ${root}`} ${opts.info ?? `/Info ${info}`} ` +
    `${prev} ${opts.extra ?? ''} >>`;
  return new Uint8Array(
    Buffer.concat([
      out,
      Buffer.from(
        `xref\n${rows.join('')}${opts.rows ?? ''}trailer\n${trailer}\n${opts.unreached ?? ''}` +
          `startxref\n${at}\n%%EOF\n`,
        'latin1',
      ),
    ]),
  );
}

/** The honest fill: a new version of the field and a new signature dictionary. */
const fill = (): Obj[] => [
  { num: field.objectNumber, gen: field.generationNumber, body: fieldBody },
  { num: NEW, body: SIG },
];

async function check(bytes: Uint8Array, allowInfoRewrite = true): Promise<XrefStateResult> {
  const initial = initialXrefState(base, before);
  if (!initial.ok) throw new Error(initial.detail);
  const after = await loadRevision(bytes);
  return checkRevisionXref(bytes, before, after, initial.state, {
    fieldKey: refKey(field),
    allowInfoRewrite,
  });
}
const refused = async (bytes: Uint8Array) => {
  const result = await check(bytes);
  return result.ok ? 'accepted' : result.detail;
};

/** A copy of the page content stream's original definition, as written in the file. */
function originalContents(): string {
  const text = Buffer.from(base).toString('latin1');
  const re = new RegExp(`(?<![0-9])${contents.objectNumber} 0 obj\\n([\\s\\S]*?)\\nendobj`);
  return re.exec(text)![1];
}
const EVIL = '<< /Length 16 >>\nstream\n0 0 612 792 re f\nendstream';

describe('a later revision read through its cross-reference section', () => {
  it('accepts one section that rewrites the field and adds its signature', async () => {
    const bytes = appendSection(base, fill());
    const result = await check(bytes);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.state.startxref).toBe(readStartxref(bytes, bytes.length)!.target);
    expect(result.state.known.has(NEW)).toBe(true);
    expect(result.state.known.has(contents.objectNumber)).toBe(true);
  });

  it('accepts a rewritten trailer /Info only when C1 applies', async () => {
    const infoNum = Number(info.split(' ')[0]);
    const bytes = appendSection(base, [...fill(), { num: infoNum, body: '<< /Producer (x) >>' }]);
    expect(await check(bytes, true)).toMatchObject({ ok: true });
    expect(await check(bytes, false)).toEqual({
      ok: false,
      detail: `xref-preexisting-object:${infoNum}`,
    });
  });

  it('refuses a free entry for anything but object 0 (an object deleted through the xref)', async () => {
    const n = contents.objectNumber;
    const bytes = appendSection(base, fill(), { rows: `${n} 1\n0000000000 00001 f \n` });
    expect(await refused(bytes)).toBe(`xref-free-entry:${n}`);
  });

  it('refuses a pre-existing object re-emitted unchanged (invisible object by object)', async () => {
    const n = contents.objectNumber;
    const bytes = appendSection(base, [...fill(), { num: n, body: originalContents() }]);
    expect(await refused(bytes)).toBe(`xref-preexisting-object:${n}`);
  });

  it('refuses a new generation of a pre-existing object number', async () => {
    const n = contents.objectNumber;
    const bytes = appendSection(base, [...fill(), { num: n, gen: 1, body: EVIL }]);
    expect(await refused(bytes)).toBe(`xref-preexisting-object:${n}`);
  });

  it('refuses an xref entry that points at a different definition than the one compared', async () => {
    // Two definitions of a NEW object: the xref names the first, a file-order parser keeps the last.
    const bytes = appendSection(base, [
      ...fill(),
      { num: 51, body: '<< /A 1 >>' },
      { num: 51, body: '<< /A 2 >>', listed: false },
    ]);
    expect(await refused(bytes)).toBe('xref-definition-mismatch:51');
  });

  it('refuses an object number defined twice in one revision, even with equal content', async () => {
    const bytes = appendSection(base, [
      ...fill(),
      { num: 51, body: '<< /A 1 >>' },
      { num: 51, body: '<< /A 1 >>', listed: false },
    ]);
    expect(await refused(bytes)).toBe('xref-duplicate-definition:51');
  });

  it('refuses a definition the xref does not list', async () => {
    const bytes = appendSection(base, [...fill(), { num: 52, body: '<< /A 1 >>', listed: false }]);
    expect(await refused(bytes)).toBe('xref-unlisted-definition:52');
  });

  it('refuses an offset that is not the object header, or lies outside the revision', async () => {
    const shifted = appendSection(base, [
      { num: field.objectNumber, body: fieldBody },
      { num: NEW, body: SIG, offset: base.length + 3 },
    ]);
    expect(await refused(shifted)).toBe(`xref-offset:${NEW}`);
    const old = scanObjectHeaders(base, 0, base.length).find((h) => h.num === 1)!;
    const outside = appendSection(base, [
      { num: field.objectNumber, body: fieldBody },
      { num: NEW, body: SIG, offset: old.offset },
    ]);
    expect(await refused(outside)).toBe(`xref-offset:${NEW}`);
  });

  it('refuses an object number listed twice', async () => {
    const bytes = appendSection(base, fill(), { rows: `${NEW} 1\n0000000000 00000 n \n` });
    expect(await refused(bytes)).toBe(`xref-duplicate-entry:${NEW}`);
  });

  it('refuses a /Prev that is not the previous startxref, or is missing', async () => {
    expect(await refused(appendSection(base, fill(), { prev: `/Prev ${prevStartxref - 1}` }))).toBe(
      'xref-prev',
    );
    expect(await refused(appendSection(base, fill(), { prev: '' }))).toBe('xref-prev');
  });

  it('refuses a hybrid section (/XRefStm)', async () => {
    const bytes = appendSection(base, fill(), { extra: '/XRefStm 100' });
    expect(await refused(bytes)).toBe('xref-hybrid');
  });

  it('refuses an encrypted trailer', async () => {
    // pdf-lib refuses to load such a file at all, so build the revision the lenient way to
    // show this check does not depend on that.
    const bytes = appendSection(base, fill(), { extra: '/Encrypt 1 0 R' });
    await expect(loadRevision(bytes)).rejects.toThrow();
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    const objects = new Map<string, Uint8Array>();
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      objects.set(refKey(ref), serialize(obj));
    }
    const initial = initialXrefState(base, before);
    if (!initial.ok) throw new Error(initial.detail);
    expect(
      checkRevisionXref(bytes, before, { end: bytes.length, doc, objects }, initial.state, {
        fieldKey: refKey(field),
        allowInfoRewrite: true,
      }),
    ).toEqual({ ok: false, detail: 'encrypted' });
  });

  it('refuses a reached trailer whose /Root or /Info is not what pdf-lib took', async () => {
    // pdf-lib keeps the earlier trailer's values when the last one omits them; a reader does not.
    expect(await refused(appendSection(base, fill(), { root: '' }))).toBe('trailer-root-mismatch');
    expect(await refused(appendSection(base, fill(), { info: '' }))).toBe('trailer-info-mismatch');
  });

  it('refuses two sections in one revision', async () => {
    const first = appendSection(base, [{ num: 51, body: '<< /A 1 >>' }]);
    const second = appendSection(first, fill());
    expect(await refused(second)).toBe('xref-sections:2');
  });

  it('refuses a second xref and trailer that startxref does not reach', async () => {
    const pair = `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root ${root} /Info ${info} >>\n`;
    // After the reached trailer: a file-order parser would take this one as the last word.
    expect(await refused(appendSection(base, fill(), { unreached: pair }))).toBe(
      'xref-trailer-malformed',
    );
    // Before the reached table, among the objects.
    expect(await refused(appendSection(base, fill(), { before: pair }))).toBe('xref-extra-trailer');
  });

  it('refuses a table whose entries are not exactly 20 bytes', async () => {
    const bytes = appendSection(base, fill(), { rows: '60 1\n000000000 00000 f \n' });
    expect(await refused(bytes)).toBe('xref-table-malformed');
  });

  it('refuses a revision that does not end in startxref and %%EOF', async () => {
    const bytes = appendSection(base, fill());
    const cut = bytes.subarray(0, bytes.length - 7); // drops "\n%%EOF\n"
    const after = await loadRevision(bytes);
    const initial = initialXrefState(base, before);
    if (!initial.ok) throw new Error(initial.detail);
    expect(
      checkRevisionXref(cut, before, { ...after, end: cut.length }, initial.state, {
        fieldKey: refKey(field),
        allowInfoRewrite: true,
      }),
    ).toEqual({ ok: false, detail: 'xref-no-startxref' });
  });
});

describe('a later revision whose section is a cross-reference stream', () => {
  /** Append objects and one uncompressed xref stream (W [1 4 1]) that lists `entries`. */
  function appendStreamSection(
    objects: Obj[],
    opts: { own?: number; extraEntries?: Array<[number, number, number, number]> } = {},
  ): Uint8Array {
    let out = Buffer.from(base);
    const entries: Array<[number, number, number, number]> = [[0, 0, 0, 0]]; // num, type, f2, f3
    for (const o of objects) {
      entries.push([o.num, 1, out.length + 1, o.gen ?? 0]);
      out = Buffer.concat([
        out,
        Buffer.from(`\n${o.num} ${o.gen ?? 0} obj\n${o.body}\nendobj\n`, 'latin1'),
      ]);
    }
    const own = opts.own ?? 60;
    const at = out.length + 1;
    entries.push([own, 1, at, 0], ...(opts.extraEntries ?? []));
    entries.sort((a, b) => a[0] - b[0]);
    const data = Buffer.alloc(entries.length * 6);
    entries.forEach(([, type, f2, f3], i) => {
      data.writeUInt8(type, i * 6);
      data.writeUInt32BE(f2, i * 6 + 1);
      data.writeUInt8(f3, i * 6 + 5);
    });
    const index = entries.map(([num]) => `${num} 1`).join(' ');
    return new Uint8Array(
      Buffer.concat([
        out,
        Buffer.from(
          `\n${own} 0 obj\n<< /Type /XRef /W [ 1 4 1 ] /Index [ ${index} ] /Size 99 ` +
            `/Root ${root} /Info ${info} /Prev ${prevStartxref} /Length ${data.length} >>\nstream\n`,
          'latin1',
        ),
        data,
        Buffer.from(`\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`),
      ]),
    );
  }

  it('accepts one that lists the fill and itself', async () => {
    expect(await check(appendStreamSection(fill()))).toMatchObject({ ok: true });
  });

  it('refuses an object stored in an object stream (type 2 entry): not analysed, so not accepted', async () => {
    const bytes = appendStreamSection(fill(), { extraEntries: [[53, 2, 61, 0]] });
    expect(await refused(bytes)).toBe('xref-compressed-entry:53');
  });

  it('refuses a free entry', async () => {
    const n = contents.objectNumber;
    const bytes = appendStreamSection(fill(), { extraEntries: [[n, 0, 0, 1]] });
    expect(await refused(bytes)).toBe(`xref-free-entry:${n}`);
  });

  it('refuses a cross-reference stream that takes the number of an existing object', async () => {
    // pdf-lib never registers the xref stream, so object by object nothing changed; a reader
    // would now find the stream where the page content used to be.
    const n = contents.objectNumber;
    expect(await refused(appendStreamSection(fill(), { own: n }))).toBe(
      `xref-preexisting-object:${n}`,
    );
  });
});

describe('reading sections and the state a check starts from', () => {
  it('reads the final section of pyHanko files: table and stream', () => {
    const table = readSection(base, 0, base.length);
    expect(table).toMatchObject({ ok: true, section: { form: 'table', own: null } });
    const streamed = load('certified-p2-empty-field-xref-stream.pdf');
    const stream = readSection(streamed, 0, streamed.length);
    expect(stream).toMatchObject({ ok: true, section: { form: 'stream' } });
    if (!stream.ok || !table.ok) return;
    expect(stream.section.entries.some((e) => e.num === stream.section.own!.num)).toBe(true);
    expect(table.section.entries.every((e) => e.kind !== 'compressed')).toBe(true);
    expect(table.section.entries.find((e) => e.num === 0)).toMatchObject({ kind: 'free' });
  });

  it('counts every object number of the starting revision as known, containers included', async () => {
    const streamed = load('certified-p2-empty-field-xref-stream.pdf');
    const revision = await loadRevision(streamed);
    const initial = initialXrefState(streamed, revision);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const section = readSection(streamed, 0, streamed.length);
    if (!section.ok) throw new Error(section.detail);
    // The xref stream object itself is not in pdf-lib's graph, but its number is taken.
    expect(revision.objects.has(`${section.section.own!.num} 0`)).toBe(false);
    expect(initial.state.known.has(section.section.own!.num)).toBe(true);
  });

  it('refuses a starting revision whose end is not startxref and %%EOF', async () => {
    const junk = new Uint8Array(Buffer.concat([Buffer.from(base), Buffer.from('junk')]));
    expect(initialXrefState(junk, { ...before, end: junk.length })).toEqual({
      ok: false,
      detail: 'xref-no-startxref',
    });
  });
});

describe('the committed xref-level fixtures (intact signatures) are refused for the stated reason', () => {
  it.each([
    ['certified-p2-xref-duplicate-object.pdf', 'xref-sections:2'],
    ['certified-p2-xref-free-entry.pdf', 'xref-sections:2'],
    ['certified-p2-xref-generation-bump.pdf', 'xref-sections:2'],
    ['certified-p2-xref-hybrid.pdf', 'xref-sections:2'],
    ['certified-p2-xref-double-trailer.pdf', 'xref-sections:2'],
    ['certified-p2-xref-rewritten-object.pdf', /^xref-preexisting-object:\d+$/],
  ])('%s', async (name, detail) => {
    const bytes = load(name);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const analysis = await analyzeRevisions(doc, bytes);
    expect(analysis).toMatchObject({ ok: false, reason: 'not-a-single-fill' });
    expect(!analysis.ok && analysis.detail).toMatch(detail);
  });
});

describe('strict reading: each malformed section is refused for its own reason', () => {
  /** The honest section, split so one part can be replaced. */
  function parts() {
    const bytes = appendSection(base, fill());
    const text = Buffer.from(bytes).toString('latin1');
    const at = text.lastIndexOf('xref\n0 1\n');
    const tail = text.slice(at);
    return {
      head: Buffer.from(bytes.subarray(0, at)),
      at,
      rows: tail.slice(5, tail.indexOf('trailer')),
      trailer: tail.slice(tail.indexOf('trailer'), tail.indexOf('startxref')),
    };
  }
  /** Rebuild the section with another table, trailer or startxref value. */
  function rebuilt(change: {
    table?: (rows: string) => string;
    trailer?: string;
    startxref?: number;
  }): Uint8Array {
    const p = parts();
    const table = change.table ? change.table(p.rows) : `xref\n${p.rows}`;
    return new Uint8Array(
      Buffer.concat([
        p.head,
        Buffer.from(
          `${table}${change.trailer ?? p.trailer}startxref\n${change.startxref ?? p.at}\n%%EOF\n`,
          'latin1',
        ),
      ]),
    );
  }
  const read = (bytes: Uint8Array) => {
    const result = readSection(bytes, base.length, bytes.length);
    return result.ok ? 'read' : result.detail;
  };

  it('reads the honest section', () => {
    expect(read(rebuilt({}))).toBe('read');
  });

  it.each([
    ['no end of line after the xref keyword', (r: string) => `xref${r}`, 'xref-table-malformed'],
    [
      'no space in a subsection header',
      (r: string) => `xref\n${r.replace('0 1\n', '0x1\n')}`,
      'xref-table-malformed',
    ],
    [
      'no count in a subsection header',
      (r: string) => `xref\n${r.replace('0 1\n', '0 \n')}`,
      'xref-table-malformed',
    ],
    [
      'junk after the count',
      (r: string) => `xref\n${r.replace('0 1\n', '0 1 x\n')}`,
      'xref-table-malformed',
    ],
    [
      'more entries than the limit',
      (r: string) => `xref\n${r.replace('0 1\n', '0 100001\n')}`,
      'xref-too-large',
    ],
    [
      'an entry flag that is neither n nor f',
      (r: string) => `xref\n${r.replace('65535 f', '65535 x')}`,
      'xref-table-malformed',
    ],
    [
      'an entry without its two-byte end of line',
      (r: string) => `xref\n${r.replace('65535 f \n', '65535 fxx')}`,
      'xref-table-malformed',
    ],
  ])('a table with %s', (_label, table, detail) => {
    expect(read(rebuilt({ table }))).toBe(detail);
  });

  it('a table that ends before its last entry', () => {
    const bytes = rebuilt({ table: () => 'xref\n0 2\n0000000000 65535 f \n', trailer: '' });
    expect(read(bytes)).toBe('xref-table-malformed');
  });

  it('a trailer that is not a dictionary', () => {
    expect(read(rebuilt({ trailer: 'trailer\n[ 1 ]\n' }))).toBe('xref-trailer-malformed');
  });

  it('a startxref that points before the revision', () => {
    expect(read(rebuilt({ startxref: prevStartxref }))).toBe('xref-outside-revision');
  });

  it('a starting revision whose table has no trailer', () => {
    const bytes = rebuilt({ trailer: '' });
    expect(initialXrefState(bytes, { ...before, end: bytes.length })).toEqual({
      ok: false,
      detail: 'xref-table-malformed',
    });
  });

  it('a starting revision whose reached trailer is not the one pdf-lib took', async () => {
    const revision = await loadRevision(base);
    (revision.doc.context.trailerInfo as unknown as Record<string, unknown>).Root =
      PDFRef.of(99999);
    expect(initialXrefState(base, revision)).toEqual({
      ok: false,
      detail: 'trailer-root-mismatch',
    });
  });

  it('an in-use entry for object 0', async () => {
    const bytes = rebuilt({ table: (r) => `xref\n${r.replace('65535 f', '00000 n')}` });
    expect(await refused(bytes)).toBe('xref-object-zero');
  });

  /** One uncompressed cross-reference stream after the fill, with any part replaced. */
  function streamed(
    change: {
      type?: string;
      w?: string;
      index?: string;
      extraData?: number;
      entryType?: number;
      junk?: string;
      own?: number;
      listOwn?: boolean;
      ownOffset?: number;
      startxref?: (at: number) => number;
    } = {},
  ): Uint8Array {
    let out = Buffer.from(base);
    const entries: Array<[number, number, number, number]> = [[0, 0, 0, 0]];
    for (const o of fill()) {
      entries.push([o.num, change.entryType ?? 1, out.length + 1, o.gen ?? 0]);
      out = Buffer.concat([
        out,
        Buffer.from(`\n${o.num} ${o.gen ?? 0} obj\n${o.body}\nendobj\n`, 'latin1'),
      ]);
    }
    const own = change.own ?? 60;
    const at = out.length + 1;
    if (change.listOwn !== false) entries.push([own, 1, change.ownOffset ?? at, 0]);
    entries.sort((a, b) => a[0] - b[0]);
    const data = Buffer.alloc(entries.length * 6 + (change.extraData ?? 0));
    entries.forEach(([, type, f2, f3], i) => {
      data.writeUInt8(type, i * 6);
      data.writeUInt32BE(f2, i * 6 + 1);
      data.writeUInt8(f3, i * 6 + 5);
    });
    const index = change.index ?? `[ ${entries.map(([num]) => `${num} 1`).join(' ')} ]`;
    return new Uint8Array(
      Buffer.concat([
        out,
        Buffer.from(
          `\n${own} 0 obj\n<< /Type /${change.type ?? 'XRef'} /W ${change.w ?? '[ 1 4 1 ]'} ` +
            `/Index ${index} /Size 99 /Root ${root} /Info ${info} /Prev ${prevStartxref} ` +
            `/Length ${data.length} >>\nstream\n`,
          'latin1',
        ),
        data,
        Buffer.from(
          `\nendstream\nendobj\n${change.junk ?? ''}startxref\n` +
            `${change.startxref ? change.startxref(at) : at}\n%%EOF\n`,
        ),
      ]),
    );
  }

  it('reads the honest cross-reference stream', () => {
    expect(read(streamed())).toBe('read');
  });

  it.each([
    [
      'a startxref that does not point at an object',
      { startxref: (at: number) => at + 3 },
      'xref-not-found',
    ],
    ['an object that is not a cross-reference stream', { type: 'Metadata' }, 'xref-not-found'],
    ['bytes between the stream and startxref', { junk: 'junk\n' }, 'xref-stream-malformed'],
    ['a /W with two widths', { w: '[ 1 4 ]' }, 'xref-stream-malformed'],
    ['a /W that holds a name', { w: '[ 1 /A 1 ]' }, 'xref-stream-malformed'],
    ['a /W wider than 8 bytes', { w: '[ 1 9 1 ]' }, 'xref-stream-malformed'],
    ['an /Index with an odd length', { index: '[ 0 1 6 ]' }, 'xref-stream-malformed'],
    ['an /Index that holds a fraction', { index: '[ 0 1.5 ]' }, 'xref-stream-malformed'],
    ['data that is not a whole number of rows', { extraData: 1 }, 'xref-stream-malformed'],
    ['an entry of an unknown type', { entryType: 3 }, 'xref-stream-malformed'],
  ])('a cross-reference stream with %s', (_label, change, detail) => {
    expect(read(streamed(change))).toBe(detail);
  });

  it('a cross-reference stream listed at an offset that is not its own', async () => {
    expect(await refused(streamed({ ownOffset: base.length + 1 }))).toBe('xref-offset:60');
  });

  it('a cross-reference stream that does not list itself and takes an existing number', async () => {
    const n = contents.objectNumber;
    expect(await refused(streamed({ own: n, listOwn: false }))).toBe(
      `xref-preexisting-object:${n}`,
    );
  });
});
