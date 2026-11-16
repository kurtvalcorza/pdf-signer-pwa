import {
  PDFArray,
  PDFCatalog,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectParser,
  PDFObjectStreamParser,
  PDFPageLeaf,
  PDFPageTree,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';

/**
 * The cross-reference data of an incremental section, read the way a conforming reader does
 * (spec 004, rule 5d; review finding R1).
 *
 * pdf-lib builds its object graph by reading every `N G obj` in FILE ORDER and never looks at
 * the cross-reference table. A conforming reader does the opposite: it starts at the final
 * `startxref`, and an object is whatever the xref says it is. The two views can be made to
 * disagree on purpose: an object marked free, a second definition the xref points at while
 * pdf-lib takes the last one, a new generation of an old number, a trailer the reader never
 * reaches. A check that only compares pdf-lib's graph is blind to all of them.
 *
 * So for every section after the certified bytes this module requires the two views to be the
 * same thing, and refuses otherwise. It accepts one narrow shape:
 *
 *  - the revision ends `startxref N %%EOF`, with exactly one `startxref` in its bytes;
 *  - at N there is one classic table with its trailer, or one cross-reference stream;
 *  - `/Prev` is the previous revision's `startxref`; there is no `/XRefStm` (hybrid) and no
 *    `/Encrypt`; `/Root` and `/Info` are the ones pdf-lib took for this revision;
 *  - the only free entry is object 0; no object number is listed twice;
 *  - every in-use entry points, inside this revision, at an `N G obj` header with that number
 *    and generation, and the object parsed THERE is byte-for-byte the one pdf-lib used;
 *  - an entry for an object NUMBER that already existed (any generation, container objects
 *    included) is allowed only for the filled field, and for the trailer's `/Info` when C1
 *    applies;
 *  - the `N G obj` headers found in the revision's bytes are exactly the in-use entries, once
 *    each, and nothing pdf-lib registered from this revision is missing from them.
 *
 * Three more things two readers can disagree on are refused outright (review round 2):
 *
 *  - a dictionary that repeats a key. ISO 32000-1 7.3.7 leaves its value undefined; pdf-lib
 *    keeps the last, other readers the first. Every trailer and definition read here goes
 *    through a parser that throws on a repeated key, and `findRepeatedKeys` applies the same
 *    parser to every object of a certified file, object streams included;
 *  - a trailer `/Size` that is not the section's highest object number plus one, or that
 *    shrinks: a reader ignores objects numbered at or above `/Size`;
 *  - a cross-reference stream with `/DecodeParms` or any filter but plain FlateDecode: pdf-lib
 *    applies no predictor, every other reader does, so the two would read different tables.
 *
 * Object numbers above 8388607 and generations above 65535 (ISO 32000-1 Annex C) are refused.
 *
 * Entries of type 2 (objects inside an object stream) are refused: no signing tool this project
 * can run writes a fill that way, so the shape could not be tested, and an untested acceptance
 * is worse than a refusal (fail closed). Anything that does not parse strictly is refused too.
 * A header-looking byte run inside stream data makes a section look inconsistent; that also
 * refuses, which is the safe direction.
 */

const N = (s: string) => PDFName.of(s);

export const refKey = (ref: { objectNumber: number; generationNumber: number }): string =>
  `${ref.objectNumber} ${ref.generationNumber}`;

export function serialize(o: PDFObject): Uint8Array {
  const buf = new Uint8Array(o.sizeInBytes());
  o.copyBytesInto(buf, 0);
  return buf;
}

export function sameBytes(a: Uint8Array, b: Uint8Array | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// PDF whitespace (ISO 32000-1 7.2.2): NUL, HT, LF, FF, CR, SP.
const isWs = (c: number): boolean =>
  c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isDelimiter = (c: number): boolean =>
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d ||
  c === 0x2f ||
  c === 0x25;

function matches(bytes: Uint8Array, at: number, word: string): boolean {
  if (at < 0 || at + word.length > bytes.length) return false;
  for (let i = 0; i < word.length; i++) if (bytes[at + i] !== word.charCodeAt(i)) return false;
  return true;
}

/** Number of (possibly overlapping-free) occurrences of `word` in `bytes[from .. to)`. */
export function countWord(bytes: Uint8Array, from: number, to: number, word: string): number {
  let count = 0;
  for (let i = from; i + word.length <= to; i++) {
    if (bytes[i] === word.charCodeAt(0) && matches(bytes, i, word)) {
      count++;
      i += word.length - 1;
    }
  }
  return count;
}

/** Index after a run of whitespace and `%…EOL` comments, as pdf-lib skips them. */
function skipWsAndComments(bytes: Uint8Array, i: number, limit: number): number {
  for (;;) {
    while (i < limit && isWs(bytes[i])) i++;
    if (i < limit && bytes[i] === 0x25) {
      while (i < limit && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    return i;
  }
}

/** An unsigned decimal integer at `i`; null when there is none or it is not a safe integer. */
function readInt(
  bytes: Uint8Array,
  i: number,
  limit: number,
): { value: number; end: number } | null {
  let value = 0;
  let j = i;
  while (j < limit && isDigit(bytes[j])) {
    value = value * 10 + (bytes[j] - 0x30);
    if (value > Number.MAX_SAFE_INTEGER / 16) return null;
    j++;
  }
  return j === i ? null : { value, end: j };
}

export interface ObjectHeader {
  num: number;
  gen: number;
  /** Offset of the object number. */
  offset: number;
  /** Offset just past the `obj` keyword. */
  end: number;
}

/** `N G obj` starting exactly at `start`, or null. */
export function objectHeaderAt(
  bytes: Uint8Array,
  start: number,
  limit: number,
): ObjectHeader | null {
  const num = readInt(bytes, start, limit);
  if (!num) return null;
  let i = skipWsAndComments(bytes, num.end, limit);
  if (i === num.end) return null;
  const gen = readInt(bytes, i, limit);
  if (!gen) return null;
  i = skipWsAndComments(bytes, gen.end, limit);
  if (i === gen.end || !matches(bytes, i, 'obj') || i + 3 > limit) return null;
  const after = i + 3 < bytes.length ? bytes[i + 3] : -1;
  if (after !== -1 && !isWs(after) && !isDelimiter(after)) return null; // e.g. `object`
  return { num: num.value, gen: gen.value, offset: start, end: i + 3 };
}

/**
 * Every `N G obj` header in `bytes[from .. to)`, in file order: one linear pass, a header being
 * tried at the first digit of every digit run. Deliberately over-inclusive: a header-looking run
 * inside a string or a stream counts, which can only refuse more.
 */
export function scanObjectHeaders(bytes: Uint8Array, from: number, to: number): ObjectHeader[] {
  const found: ObjectHeader[] = [];
  let i = from;
  while (i < to) {
    // pdf-lib starts an object wherever a header parses, glued to `endobj` included, so the
    // only thing that rules a digit out here is being the middle of a longer number.
    const boundary = i === 0 || !isDigit(bytes[i - 1]);
    if (!isDigit(bytes[i]) || !boundary) {
      i++;
      continue;
    }
    const header = objectHeaderAt(bytes, i, to);
    if (header) {
      found.push(header);
      i = header.end;
    } else {
      while (i < to && isDigit(bytes[i])) i++;
    }
  }
  return found;
}

/** Thrown by the strict parser when a dictionary names a key twice. */
export class RepeatedKeyError extends Error {
  constructor() {
    super('A dictionary repeats a key.');
    this.name = 'RepeatedKeyError';
  }
}

/** ISO 32000-1 Annex C: the largest object number and generation a conforming file uses. */
const MAX_OBJECT_NUMBER = 8388607;
const MAX_GENERATION = 65535;

interface ParserInternals {
  bytes: {
    assertNext(c: number): number;
    done(): boolean;
    peek(): number;
    peekAhead(n: number): number;
    offset(): number;
  };
  context: PDFContext;
  skipWhitespaceAndComments(): void;
  parseName(): PDFName;
  parseObject(): PDFObject;
  parseDict: () => PDFDict;
}

/**
 * Make a pdf-lib object parser refuse a dictionary that repeats a key, at any depth (stream
 * dictionaries included). The method is pdf-lib 1.17.1's `parseDict` with that one check added;
 * it replaces the method on this instance, and the parser's own recursion goes through it.
 */
function makeStrict<T extends PDFObjectParser>(parser: T): T {
  const p = parser as unknown as ParserInternals;
  p.parseDict = () => {
    p.bytes.assertNext(0x3c);
    p.bytes.assertNext(0x3c);
    p.skipWhitespaceAndComments();
    const dict = new Map<PDFName, PDFObject>();
    while (!p.bytes.done() && p.bytes.peek() !== 0x3e && p.bytes.peekAhead(1) !== 0x3e) {
      const key = p.parseName();
      const value = p.parseObject();
      // PDFName is interned after #xx decoding, so /Rect and /#52ect are the same key here.
      if (dict.has(key)) throw new RepeatedKeyError();
      dict.set(key, value);
      p.skipWhitespaceAndComments();
    }
    p.skipWhitespaceAndComments();
    p.bytes.assertNext(0x3e);
    p.bytes.assertNext(0x3e);
    const type = dict.get(N('Type'));
    if (type === N('Catalog')) return PDFCatalog.fromMapWithContext(dict, p.context);
    if (type === N('Pages')) return PDFPageTree.fromMapWithContext(dict, p.context);
    if (type === N('Page')) return PDFPageLeaf.fromMapWithContext(dict, p.context);
    return PDFDict.fromMapWithContext(dict, p.context);
  };
  return parser;
}

/**
 * Parse one PDF value at `start` with pdf-lib's own object parser, made strict; `end` is where
 * it stopped. Throws RepeatedKeyError on a repeated dictionary key.
 */
function parseValueAt(
  bytes: Uint8Array,
  start: number,
  limit: number,
): { object: PDFObject; end: number } {
  const parser = makeStrict(
    PDFObjectParser.forBytes(bytes.subarray(start, limit), PDFContext.create()),
  );
  const object = parser.parseObject();
  const consumed = (parser as unknown as ParserInternals).bytes.offset();
  return { object, end: start + consumed };
}

/**
 * The indirect object defined at `offset`: header, value, `endobj`. Null when it is not one.
 * Throws RepeatedKeyError when it is one whose dictionary repeats a key.
 */
export function parseObjectAt(
  bytes: Uint8Array,
  offset: number,
  limit: number,
): { header: ObjectHeader; object: PDFObject; end: number } | null {
  const header = objectHeaderAt(bytes, offset, limit);
  if (!header) return null;
  try {
    const start = skipWsAndComments(bytes, header.end, limit);
    const { object, end } = parseValueAt(bytes, start, limit);
    const tail = skipWsAndComments(bytes, end, limit);
    if (!matches(bytes, tail, 'endobj') || tail + 6 > limit) return null;
    return { header, object, end: tail + 6 };
  } catch (err) {
    if (err instanceof RepeatedKeyError) throw err;
    return null;
  }
}

/**
 * The first object in `bytes[from .. to)` whose dictionary repeats a key, at any depth, or null.
 *
 * Every definition the header scan finds is parsed strictly, and so is every object stored in an
 * object stream. This is how the objects a decision reads in the CERTIFIED revision (the catalog,
 * `/Perms`, the form, fields and widgets, pages) are covered: rather than pick them out, all of
 * them are checked. A header-looking run that does not parse as an object is skipped; an object
 * stream that cannot be read strictly is reported, because what it holds was never checked.
 */
export async function findRepeatedKeys(
  bytes: Uint8Array,
  from: number,
  to: number,
): Promise<{ offset: number; detail: string } | null> {
  for (const header of scanObjectHeaders(bytes, from, to)) {
    let parsed: ReturnType<typeof parseObjectAt>;
    try {
      parsed = parseObjectAt(bytes, header.offset, to);
    } catch {
      return { offset: header.offset, detail: `repeated-key:${header.num}` };
    }
    if (!parsed || !(parsed.object instanceof PDFRawStream)) continue;
    if (parsed.object.dict.lookup(N('Type')) !== N('ObjStm')) continue;
    try {
      await makeStrict(PDFObjectStreamParser.forStream(parsed.object)).parseIntoContext();
    } catch (err) {
      const kind = err instanceof RepeatedKeyError ? 'repeated-key' : 'object-stream-unreadable';
      return { offset: header.offset, detail: `${kind}:${header.num}` };
    }
  }
  return null;
}

/** The final `startxref N %%EOF` of `bytes[0 .. end)`: where the keyword is and what it names. */
export function readStartxref(
  bytes: Uint8Array,
  end: number,
): { keywordAt: number; target: number } | null {
  let i = end;
  while (i > 0 && isWs(bytes[i - 1])) i--;
  if (!matches(bytes, i - 5, '%%EOF')) return null;
  i -= 5;
  let j = i;
  while (j > 0 && isWs(bytes[j - 1])) j--;
  if (j === i) return null;
  let k = j;
  while (k > 0 && isDigit(bytes[k - 1])) k--;
  const target = readInt(bytes, k, j);
  if (!target || target.end !== j) return null;
  let m = k;
  while (m > 0 && isWs(bytes[m - 1])) m--;
  if (m === k || !matches(bytes, m - 9, 'startxref')) return null;
  return { keywordAt: m - 9, target: target.value };
}

export interface XrefEntry {
  num: number;
  gen: number;
  kind: 'free' | 'in-use' | 'compressed';
  /** Byte offset for `in-use`; the container's object number for `compressed`. */
  offset: number;
}

export interface XrefSection {
  form: 'table' | 'stream';
  /** Offset of the section (the value after `startxref`). */
  at: number;
  /** Offset of the `startxref` keyword that names it. */
  keywordAt: number;
  entries: XrefEntry[];
  /** The trailer a reader reaches: the table's trailer, or the stream's dictionary. */
  trailer: PDFDict;
  /** The cross-reference stream's own object, when the section is one. */
  own: ObjectHeader | null;
}

export type SectionResult = { ok: true; section: XrefSection } | { ok: false; detail: string };

const MAX_ENTRIES = 100_000;

/**
 * Read the cross-reference section a conforming reader reaches from the end of
 * `bytes[0 .. end)`. The section must lie in `bytes[from .. end)`. With `withEntries` off only
 * the trailer is read (the certified revision: its entries are the certifier's business).
 */
export function readSection(
  bytes: Uint8Array,
  from: number,
  end: number,
  withEntries = true,
): SectionResult {
  const fail = (detail: string): SectionResult => ({ ok: false, detail });
  try {
    const tail = readStartxref(bytes, end);
    if (!tail) return fail('xref-no-startxref');
    const { keywordAt, target: at } = tail;
    if (at < from || at >= keywordAt) return fail('xref-outside-revision');

    if (matches(bytes, at, 'xref')) {
      let p = at + 4;
      const entries: XrefEntry[] = [];
      if (withEntries) {
        for (;;) {
          const q = skipWsAndComments(bytes, p, keywordAt);
          // `xref` must be followed by an end of line; entries carry their own.
          if (q === p && p === at + 4) return fail('xref-table-malformed');
          p = q;
          if (matches(bytes, p, 'trailer')) break;
          const first = readInt(bytes, p, keywordAt);
          if (!first || bytes[first.end] !== 0x20) return fail('xref-table-malformed');
          let s = first.end;
          while (bytes[s] === 0x20) s++;
          const count = readInt(bytes, s, keywordAt);
          if (!count) return fail('xref-table-malformed');
          p = count.end;
          while (bytes[p] === 0x20) p++;
          if (bytes[p] === 0x0d && bytes[p + 1] === 0x0a) p += 2;
          else if (bytes[p] === 0x0a || bytes[p] === 0x0d) p += 1;
          else return fail('xref-table-malformed');
          if (entries.length + count.value > MAX_ENTRIES) return fail('xref-too-large');
          for (let k = 0; k < count.value; k++, p += 20) {
            // Exactly 20 bytes: nnnnnnnnnn ggggg n|f, then a two-byte end of line.
            if (p + 20 > keywordAt) return fail('xref-table-malformed');
            for (let d = 0; d < 18; d++) {
              const c = bytes[p + d];
              const wantSpace = d === 10 || d === 16;
              if (d === 17 ? c !== 0x6e && c !== 0x66 : wantSpace ? c !== 0x20 : !isDigit(c)) {
                return fail('xref-table-malformed');
              }
            }
            const eol = (bytes[p + 18] << 8) | bytes[p + 19];
            if (eol !== 0x200a && eol !== 0x200d && eol !== 0x0d0a) {
              return fail('xref-table-malformed');
            }
            const offset = readInt(bytes, p, p + 10)!.value;
            const gen = readInt(bytes, p + 11, p + 16)!.value;
            entries.push({
              num: first.value + k,
              gen,
              kind: bytes[p + 17] === 0x6e ? 'in-use' : 'free',
              offset,
            });
          }
        }
      } else {
        // The table body holds only digits, spaces and n/f, so the first `trailer` is its end.
        while (p < keywordAt && !matches(bytes, p, 'trailer')) p++;
        if (p >= keywordAt) return fail('xref-table-malformed');
      }
      p = skipWsAndComments(bytes, p + 7, keywordAt);
      const parsed = parseValueAt(bytes, p, keywordAt);
      if (!(parsed.object instanceof PDFDict)) return fail('xref-trailer-malformed');
      if (skipWsAndComments(bytes, parsed.end, keywordAt) !== keywordAt) {
        return fail('xref-trailer-malformed');
      }
      return {
        ok: true,
        section: { form: 'table', at, keywordAt, entries, trailer: parsed.object, own: null },
      };
    }

    // Otherwise it must be a cross-reference stream object.
    const obj = parseObjectAt(bytes, at, keywordAt);
    if (!obj || !(obj.object instanceof PDFRawStream)) return fail('xref-not-found');
    const dict = obj.object.dict;
    if (dict.lookup(N('Type')) !== N('XRef')) return fail('xref-not-found');
    if (skipWsAndComments(bytes, obj.end, keywordAt) !== keywordAt) {
      return fail('xref-stream-malformed');
    }
    const entries: XrefEntry[] = [];
    if (withEntries) {
      // pdf-lib inflates but applies no predictor, and every other reader does: with
      // /DecodeParms the two would read different tables from one stream. Refused until a
      // predictor is implemented and tested; so is every filter but plain FlateDecode.
      const filter = dict.get(N('Filter'));
      if (dict.has(N('DecodeParms')) || (filter !== undefined && filter !== N('FlateDecode'))) {
        return fail('xref-stream-filter');
      }
      const w = dict.lookup(N('W'));
      const size = dict.lookup(N('Size'));
      if (!(w instanceof PDFArray) || w.size() !== 3 || !(size instanceof PDFNumber)) {
        return fail('xref-stream-malformed');
      }
      const widths: number[] = [];
      for (let i = 0; i < 3; i++) {
        const n = w.lookup(i);
        if (!(n instanceof PDFNumber)) return fail('xref-stream-malformed');
        const v = n.asNumber();
        if (!Number.isInteger(v) || v < 0 || v > 8) return fail('xref-stream-malformed');
        widths.push(v);
      }
      const ranges: number[] = [];
      const index = dict.lookup(N('Index'));
      if (index === undefined) {
        ranges.push(0, size.asNumber());
      } else {
        if (!(index instanceof PDFArray) || index.size() % 2 !== 0) {
          return fail('xref-stream-malformed');
        }
        for (let i = 0; i < index.size(); i++) {
          const n = index.lookup(i);
          if (!(n instanceof PDFNumber) || !Number.isInteger(n.asNumber()) || n.asNumber() < 0) {
            return fail('xref-stream-malformed');
          }
          ranges.push(n.asNumber());
        }
      }
      const data = decodePDFRawStream(obj.object).decode();
      const row = widths[0] + widths[1] + widths[2];
      let rows = 0;
      for (let i = 1; i < ranges.length; i += 2) rows += ranges[i];
      if (row === 0 || rows > MAX_ENTRIES || data.length !== rows * row) {
        return fail('xref-stream-malformed');
      }
      const field = (at0: number, width: number): number => {
        let v = 0;
        for (let i = 0; i < width; i++) {
          v = v * 256 + data[at0 + i];
          if (v > Number.MAX_SAFE_INTEGER / 256) throw new Error('xref field too large');
        }
        return v;
      };
      let p = 0;
      for (let r = 0; r < ranges.length; r += 2) {
        for (let k = 0; k < ranges[r + 1]; k++, p += row) {
          const type = widths[0] === 0 ? 1 : field(p, widths[0]);
          const second = field(p + widths[0], widths[1]);
          const third = field(p + widths[0] + widths[1], widths[2]);
          if (type > 2) return fail('xref-stream-malformed');
          entries.push({
            num: ranges[r] + k,
            gen: type === 2 ? 0 : third,
            kind: type === 0 ? 'free' : type === 1 ? 'in-use' : 'compressed',
            offset: second,
          });
        }
      }
    }
    return {
      ok: true,
      section: { form: 'stream', at, keywordAt, entries, trailer: dict, own: obj.header },
    };
  } catch (err) {
    return fail(err instanceof RepeatedKeyError ? 'repeated-key' : 'xref-unreadable');
  }
}

/**
 * The trailer a reader reaches must name what pdf-lib took for this revision: pdf-lib keeps the
 * LAST trailer in file order, which need not be the one `startxref` leads to.
 */
function trailerMismatch(trailer: PDFDict, doc: PDFDocument): string | null {
  const info = doc.context.trailerInfo;
  if (trailer.has(N('Encrypt')) || info.Encrypt !== undefined) return 'encrypted';
  const root = trailer.get(N('Root'));
  if (!(root instanceof PDFRef) || !(info.Root instanceof PDFRef)) return 'trailer-root-mismatch';
  if (refKey(root) !== refKey(info.Root)) return 'trailer-root-mismatch';
  const reached = trailer.get(N('Info'));
  if (reached === undefined && info.Info === undefined) return null;
  if (!(reached instanceof PDFRef) || !(info.Info instanceof PDFRef)) {
    return 'trailer-info-mismatch';
  }
  return refKey(reached) === refKey(info.Info) ? null : 'trailer-info-mismatch';
}

/** A parsed revision, as revisions.ts defines it (structural, to avoid an import cycle). */
interface Revision {
  end: number;
  doc: PDFDocument;
  objects: Map<string, Uint8Array>;
}

/** What the next section is checked against. */
export interface XrefState {
  /** Every object number in use so far, containers (object streams, xref streams) included. */
  known: Set<number>;
  /** The `startxref` value of the revision just before: the next `/Prev` must equal it. */
  startxref: number;
  /** The `/Size` of the revision just before (0 when it had none): `/Size` never shrinks. */
  size: number;
}

export type XrefStateResult = { ok: true; state: XrefState } | { ok: false; detail: string };

/**
 * State after a revision whose own sections are NOT checked entry by entry (the certified
 * revision, or the whole input of a fill): its reachable trailer must still be the one pdf-lib
 * took. `known` is over-inclusive on purpose (every header-looking number counts), which can
 * only refuse more.
 */
export function initialXrefState(bytes: Uint8Array, revision: Revision): XrefStateResult {
  const read = readSection(bytes, 0, revision.end, false);
  if (!read.ok) return { ok: false, detail: read.detail };
  const mismatch = trailerMismatch(read.section.trailer, revision.doc);
  if (mismatch) return { ok: false, detail: mismatch };
  const known = new Set<number>();
  for (const key of revision.objects.keys()) known.add(Number(key.split(' ')[0]));
  for (const header of scanObjectHeaders(bytes, 0, revision.end)) known.add(header.num);
  const size = read.section.trailer.get(N('Size'));
  return {
    ok: true,
    state: {
      known,
      startxref: read.section.at,
      size: size instanceof PDFNumber && Number.isInteger(size.asNumber()) ? size.asNumber() : 0,
    },
  };
}

export interface XrefAllowance {
  /** Key (`num gen`) of the one field this revision may rewrite. */
  fieldKey: string;
  /** C1: the trailer's /Info may be rewritten too. Off for the app's own output. */
  allowInfoRewrite: boolean;
}

/**
 * Check the one cross-reference section of the revision `after` against pdf-lib's view of it
 * (see the module comment for the rules). On success the returned state is the one the NEXT
 * revision is checked against.
 */
export function checkRevisionXref(
  bytes: Uint8Array,
  before: Revision,
  after: Revision,
  state: XrefState,
  allow: XrefAllowance,
): XrefStateResult {
  const fail = (detail: string): XrefStateResult => ({ ok: false, detail });
  try {
    const from = before.end;
    const sections = countWord(bytes, from, after.end, 'startxref');
    if (sections !== 1) return fail(`xref-sections:${sections}`);
    const read = readSection(bytes, from, after.end);
    if (!read.ok) return fail(read.detail);
    const { section } = read;
    if (countWord(bytes, from, after.end, 'trailer') !== (section.form === 'table' ? 1 : 0)) {
      return fail('xref-extra-trailer');
    }

    const { trailer } = section;
    if (trailer.has(N('XRefStm'))) return fail('xref-hybrid');
    const prev = trailer.get(N('Prev'));
    if (!(prev instanceof PDFNumber) || prev.asNumber() !== state.startxref) {
      return fail('xref-prev');
    }
    const mismatch = trailerMismatch(trailer, after.doc);
    if (mismatch) return fail(mismatch);

    const info = after.doc.context.trailerInfo.Info;
    const infoKey = allow.allowInfoRewrite && info instanceof PDFRef ? refKey(info) : null;

    const listed = new Map<number, XrefEntry>();
    for (const entry of section.entries) {
      if (listed.has(entry.num)) return fail(`xref-duplicate-entry:${entry.num}`);
      listed.set(entry.num, entry);
    }

    const inUse = new Map<number, XrefEntry>();
    let highest = section.own ? section.own.num : 0;
    for (const entry of section.entries) {
      if (entry.num > MAX_OBJECT_NUMBER || entry.gen > MAX_GENERATION) {
        return fail(`xref-number-range:${entry.num}`);
      }
      highest = Math.max(highest, entry.num);
      if (entry.kind === 'free') {
        if (entry.num !== 0) return fail(`xref-free-entry:${entry.num}`);
        continue;
      }
      if (entry.kind === 'compressed') return fail(`xref-compressed-entry:${entry.num}`);
      if (entry.num === 0) return fail('xref-object-zero');
      inUse.set(entry.num, entry);

      const key = `${entry.num} ${entry.gen}`;
      const isOwn = section.own !== null && section.own.num === entry.num;
      if (state.known.has(entry.num) && (isOwn || (key !== allow.fieldKey && key !== infoKey))) {
        return fail(`xref-preexisting-object:${entry.num}`);
      }
      if (isOwn) {
        if (entry.offset !== section.at || entry.gen !== section.own!.gen) {
          return fail(`xref-offset:${entry.num}`);
        }
        continue;
      }
      if (entry.offset < from || entry.offset >= section.at)
        return fail(`xref-offset:${entry.num}`);
      const defined = parseObjectAt(bytes, entry.offset, section.at);
      if (!defined || defined.header.num !== entry.num || defined.header.gen !== entry.gen) {
        return fail(`xref-offset:${entry.num}`);
      }
      // The definition a reader resolves must be the one the object comparison used.
      if (!sameBytes(serialize(defined.object), after.objects.get(key))) {
        return fail(`xref-definition-mismatch:${entry.num}`);
      }
    }
    if (section.own && !inUse.has(section.own.num)) {
      // A cross-reference stream need not list itself, but its number must still be new.
      if (state.known.has(section.own.num))
        return fail(`xref-preexisting-object:${section.own.num}`);
    }

    // A reader ignores every object numbered at or above /Size (ISO 32000-1 7.5.5), so /Size
    // must be exactly one past the highest number this section lists, and must not shrink.
    const size = trailer.get(N('Size'));
    if (
      !(size instanceof PDFNumber) ||
      size.asNumber() !== highest + 1 ||
      size.asNumber() < state.size
    ) {
      return fail('xref-size');
    }

    // The bytes of the revision define exactly the listed objects, once each.
    const seen = new Set<number>();
    for (const header of scanObjectHeaders(bytes, from, after.end)) {
      if (header.num > MAX_OBJECT_NUMBER || header.gen > MAX_GENERATION) {
        return fail(`xref-number-range:${header.num}`);
      }
      if (seen.has(header.num)) return fail(`xref-duplicate-definition:${header.num}`);
      seen.add(header.num);
      const entry = inUse.get(header.num);
      const isOwn = section.own !== null && section.own.offset === header.offset;
      if (isOwn && !entry) continue;
      if (!entry || entry.offset !== header.offset || entry.gen !== header.gen) {
        return fail(`xref-unlisted-definition:${header.num}`);
      }
    }
    for (const num of inUse.keys()) {
      if (!seen.has(num)) return fail(`xref-offset:${num}`);
    }

    // Nothing pdf-lib registered or changed in this revision is missing from the xref.
    for (const [key, value] of after.objects) {
      if (sameBytes(value, before.objects.get(key))) continue;
      const [num, gen] = key.split(' ').map(Number);
      const entry = inUse.get(num);
      if (!entry || entry.gen !== gen) return fail(`xref-unlisted-object:${num}`);
    }

    const known = new Set(state.known);
    for (const num of inUse.keys()) known.add(num);
    if (section.own) known.add(section.own.num);
    return { ok: true, state: { known, startxref: section.at, size: size.asNumber() } };
  } catch (err) {
    return fail(err instanceof RepeatedKeyError ? 'repeated-key' : 'xref-unreadable');
  }
}
