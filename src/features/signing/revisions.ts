import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
} from 'pdf-lib';

/**
 * Signed revisions of a certified PDF (specs/004-certified-field-signing, research.md R1).
 *
 * pdf-lib exposes only the final, merged object graph. Two rules of RFC 23-1 need history:
 *  - 5c: the field existed when the document was certified;
 *  - 5d: every revision after the certification is one signature fill of such a field.
 *
 * pdf-lib parses objects in file order and ignores the cross-reference table, so the byte prefix
 * a signature's /ByteRange covers loads as a complete document of its own. Each prefix is loaded
 * once and every indirect object is serialized immediately; consecutive revisions are then
 * compared object by object. All direct objects live inside some indirect object, so if only the
 * field object differs, everything reachable from the catalog is unchanged except through that
 * field's own keys.
 *
 * Nothing here verifies a signature. The byte ranges come from the document; a lying range only
 * moves where a certification that no longer verifies appears to end (research.md, residual risk).
 */

/** C2 (owner, 2026-11-16): each signed revision costs one full parse. T041 confirms or lowers it. */
export const MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION = 8;
/** T10: the form walk is refused above this many nodes on a certified document. */
export const MAX_FORM_NODES = 2000;

/** Keys a signature fill may change on the field dictionary (pyHanko VALUE_UPDATE_KEYS). */
const FILL_KEYS = new Set(['/AP', '/AS', '/V', '/F', '/DA', '/Q', '/Ff', '/Type']);

const N = (s: string) => PDFName.of(s);

export const refKey = (ref: { objectNumber: number; generationNumber: number }): string =>
  `${ref.objectNumber} ${ref.generationNumber}`;

/** Absent and null both mean "no value". */
export const isEmptyValue = (v: PDFObject | undefined): boolean => v === undefined || v === PDFNull;

/** A field attribute, own or inherited through /Parent (cycle-guarded). */
export function inheritable(dict: PDFDict, key: string): PDFObject | undefined {
  const seen = new Set<PDFDict>();
  let cur: PDFDict | undefined = dict;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const v = cur.lookup(N(key));
    if (!isEmptyValue(v)) return v;
    const parent: PDFObject | undefined = cur.lookup(N('Parent'));
    cur = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

/** The node's own partial name (/T) as text, or null when it has none. */
export function partialName(dict: PDFDict): string | null {
  const t = dict.lookup(N('T'));
  return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : null;
}

export interface FormNode {
  /** Null when the node is a direct dictionary inside /Fields or /Kids. */
  ref: PDFRef | null;
  dict: PDFDict;
  parent: FormNode | null;
  kids: FormNode[];
}

export interface FormWalk {
  roots: FormNode[];
  /** Every node, in /Fields order (depth first). */
  nodes: FormNode[];
  /** A dictionary was reachable twice (a cycle or a shared kid); it was visited once. */
  repeated: boolean;
}

export class FormTooLargeError extends Error {
  constructor() {
    super('This PDF has more form fields than this app will check.');
    this.name = 'FormTooLargeError';
  }
}

/** Walk /AcroForm /Fields and their /Kids iteratively, with a cycle guard and an optional cap. */
export function walkFormNodes(doc: PDFDocument, cap = Infinity): FormWalk {
  const walk: FormWalk = { roots: [], nodes: [], repeated: false };
  const acro = doc.catalog.lookup(N('AcroForm'));
  const fields = acro instanceof PDFDict ? acro.lookup(N('Fields')) : undefined;
  if (!(fields instanceof PDFArray)) return walk;

  const seen = new Set<PDFDict>();
  const stack: Array<{ arr: PDFArray; parent: FormNode | null; i: number }> = [
    { arr: fields, parent: null, i: 0 },
  ];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i >= top.arr.size()) {
      stack.pop();
      continue;
    }
    const raw = top.arr.get(top.i++);
    const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    if (!(dict instanceof PDFDict)) continue;
    if (seen.has(dict)) {
      walk.repeated = true;
      continue;
    }
    seen.add(dict);
    const node: FormNode = {
      ref: raw instanceof PDFRef ? raw : null,
      dict,
      parent: top.parent,
      kids: [],
    };
    walk.nodes.push(node);
    (top.parent ? top.parent.kids : walk.roots).push(node);
    if (walk.nodes.length > cap) throw new FormTooLargeError();
    const kids = dict.lookup(N('Kids'));
    if (kids instanceof PDFArray) stack.push({ arr: kids, parent: node, i: 0 });
  }
  return walk;
}

export interface SignatureEntry {
  node: FormNode;
  /** Null when /V holds the signature dictionary directly. */
  valueRef: PDFRef | null;
  value: PDFDict;
}

/** Every form node whose /V is a signature dictionary (it carries a /ByteRange array). */
export function signatureEntries(nodes: FormNode[]): SignatureEntry[] {
  const out: SignatureEntry[] = [];
  for (const node of nodes) {
    const raw = node.dict.get(N('V'));
    const value = node.dict.lookup(N('V'));
    if (value instanceof PDFDict && value.lookup(N('ByteRange')) instanceof PDFArray) {
      out.push({ node, valueRef: raw instanceof PDFRef ? raw : null, value });
    }
  }
  return out;
}

/**
 * End of the bytes a signature covers (`b + c` of `/ByteRange [0 a b c]`), or null when the range
 * is not exactly that shape, runs past the file, or its gap is not the `<…>` hex string.
 */
export function byteRangeEnd(value: PDFDict, bytes: Uint8Array): number | null {
  const range = value.lookup(N('ByteRange'));
  if (!(range instanceof PDFArray) || range.size() !== 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = range.lookup(i);
    if (!(n instanceof PDFNumber)) return null;
    const v = n.asNumber();
    if (!Number.isSafeInteger(v) || v < 0) return null;
    nums.push(v);
  }
  const [zero, a, b, c] = nums;
  if (zero !== 0 || !(a < b) || b + c > bytes.length) return null;
  if (bytes[a] !== 0x3c || bytes[b - 1] !== 0x3e) return null;
  return b + c;
}

function serialize(o: PDFObject): Uint8Array {
  const buf = new Uint8Array(o.sizeInBytes());
  o.copyBytesInto(buf, 0);
  return buf;
}

function sameBytes(a: Uint8Array, b: Uint8Array | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The document as it stood at the end of one signature's byte range. */
export interface SignedRevision {
  end: number;
  doc: PDFDocument;
  /** "num gen" → the object's serialized bytes, captured right after parsing. */
  objects: Map<string, Uint8Array>;
}

/**
 * Load `bytes[0 .. end]` as a document. `updateMetadata: false` matters: the default rewrites
 * /Info in memory, which would show up as a change. Objects are serialized before anything walks
 * the page tree, so no lazy normalisation can leak into the comparison.
 */
export async function loadRevision(bytes: Uint8Array, end = bytes.length): Promise<SignedRevision> {
  const doc = await PDFDocument.load(end === bytes.length ? bytes : bytes.subarray(0, end), {
    updateMetadata: false,
  });
  const objects = new Map<string, Uint8Array>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    objects.set(refKey(ref), serialize(obj));
  }
  return { end, doc, objects };
}

/** Keys of every signature field (own or inherited /FT /Sig) that is an indirect object. */
export function signatureFieldKeys(doc: PDFDocument): Set<string> {
  const keys = new Set<string>();
  for (const node of walkFormNodes(doc, MAX_FORM_NODES).nodes) {
    if (node.ref && inheritable(node.dict, 'FT') === N('Sig')) keys.add(refKey(node.ref));
  }
  return keys;
}

function annotsContain(pageNode: PDFDict, ref: PDFRef): boolean {
  const annots = pageNode.lookup(N('Annots'));
  if (!(annots instanceof PDFArray)) return false;
  for (let i = 0; i < annots.size(); i++) {
    const entry = annots.get(i);
    if (entry instanceof PDFRef && refKey(entry) === refKey(ref)) return true;
  }
  return false;
}

/**
 * Rule 5c: in this revision the reference resolves to a signature field (with the expected name,
 * when given) and a page lists it in /Annots.
 */
export function existedAtCertification(
  certified: SignedRevision,
  ref: PDFRef,
  expectedName?: string,
): boolean {
  try {
    const field = certified.doc.context.lookup(ref);
    if (!(field instanceof PDFDict) || inheritable(field, 'FT') !== N('Sig')) return false;
    if (expectedName !== undefined && partialName(field) !== expectedName) return false;
    return certified.doc.getPages().some((p) => annotsContain(p.node, ref));
  } catch {
    return false;
  }
}

/** C1: an /Info a fill may rewrite is a dictionary of direct strings and names, nothing else. */
function isPlainInfo(obj: PDFObject | undefined): boolean {
  if (!(obj instanceof PDFDict)) return false;
  for (const [, v] of obj.entries()) {
    if (!(v instanceof PDFString || v instanceof PDFHexString || v instanceof PDFName))
      return false;
  }
  return true;
}

export interface CompareOptions {
  /**
   * C1 (owner, 2026-11-16): a fill made by another tool may also rewrite the trailer's /Info
   * dictionary. Nothing else is on the list; an XMP /Metadata stream is an ordinary object and
   * any change to it refuses. The app's own output is checked with this off.
   */
  allowInfoRewrite: boolean;
  /** The certified revision: the filled field must have existed in it (rule 5c). */
  certified: SignedRevision;
  /** Signature field keys of the certified revision. */
  certifiedFieldKeys: Set<string>;
}

export type CompareResult = { ok: true; field: PDFRef } | { ok: false; detail: string };

/**
 * Rule 5d for one step: `after` differs from `before` by exactly one signature fill.
 *
 * The set of pre-existing objects that differ must be exactly one object. It must be a signature
 * field that was empty, existed at certification, now holds a NEW signature dictionary whose byte
 * range ends at `after.end`, and differs only in the fill keys. The trailer must name the same
 * catalog and declare no encryption.
 */
export function compareRevisions(
  before: SignedRevision,
  after: SignedRevision,
  opts: CompareOptions,
  bytes?: Uint8Array,
): CompareResult {
  const fail = (detail: string): CompareResult => ({ ok: false, detail });
  const ta = before.doc.context.trailerInfo;
  const tb = after.doc.context.trailerInfo;
  if (!(ta.Root instanceof PDFRef) || !(tb.Root instanceof PDFRef)) return fail('no-root');
  if (refKey(ta.Root) !== refKey(tb.Root)) return fail('root-changed');
  if (ta.Encrypt !== undefined || tb.Encrypt !== undefined) return fail('encrypted');

  const changed: string[] = [];
  for (const [key, bytesBefore] of before.objects) {
    if (!sameBytes(bytesBefore, after.objects.get(key))) changed.push(key);
  }

  // The trailer's /Info: the same object (possibly rewritten, C1), or a new one (C1), or as before.
  const infoBefore = ta.Info instanceof PDFRef ? refKey(ta.Info) : null;
  const infoAfter = tb.Info instanceof PDFRef ? refKey(tb.Info) : null;
  if (ta.Info !== undefined && !(ta.Info instanceof PDFRef)) return fail('info-not-a-reference');
  if (tb.Info !== undefined && !(tb.Info instanceof PDFRef)) return fail('info-not-a-reference');
  let rest = changed;
  if (infoBefore !== infoAfter || (infoAfter !== null && changed.includes(infoAfter))) {
    if (!opts.allowInfoRewrite) return fail('info-rewritten');
    if (infoAfter === null) return fail('info-removed');
    if (infoAfter !== infoBefore && before.objects.has(infoAfter)) return fail('info-repointed');
    if (!isPlainInfo(after.doc.context.lookup(tb.Info as PDFRef))) return fail('info-not-plain');
    rest = changed.filter((k) => k !== infoAfter);
  }

  if (rest.length !== 1) return fail(`changed-objects:${rest.join(',') || 'none'}`);
  const [num, gen] = rest[0].split(' ').map(Number);
  const ref = PDFRef.of(num, gen);
  const was = before.doc.context.lookup(ref);
  const now = after.doc.context.lookup(ref);
  if (!(was instanceof PDFDict) || !(now instanceof PDFDict)) return fail('not-a-dictionary');
  if (inheritable(was, 'FT') !== N('Sig') || !isEmptyValue(was.lookup(N('V')))) {
    return fail('not-an-empty-signature-field');
  }
  if (!opts.certifiedFieldKeys.has(rest[0])) return fail('field-not-certified');
  if (!existedAtCertification(opts.certified, ref, partialName(was) ?? undefined)) {
    return fail('field-not-certified');
  }

  const valueRef = now.get(N('V'));
  if (!(valueRef instanceof PDFRef) || before.objects.has(refKey(valueRef))) {
    return fail('value-not-new');
  }
  const value = after.doc.context.lookup(valueRef);
  if (!(value instanceof PDFDict)) return fail('value-not-a-signature');
  const end = bytes ? byteRangeEnd(value, bytes) : rawEnd(value);
  if (end !== after.end) return fail('value-range-mismatch');

  const keys = new Set([...was.keys(), ...now.keys()].map((k) => k.toString()));
  for (const key of keys) {
    if (FILL_KEYS.has(key)) continue;
    const x = was.get(N(key.slice(1)));
    const y = now.get(N(key.slice(1)));
    if (!x || !y || !sameBytes(serialize(x), serialize(y))) return fail(`field-key-changed:${key}`);
  }
  return { ok: true, field: ref };
}

/** `b + c` of a /ByteRange without the byte-level checks (used when only the prefix is at hand). */
function rawEnd(value: PDFDict): number | null {
  const range = value.lookup(N('ByteRange'));
  if (!(range instanceof PDFArray) || range.size() !== 4) return null;
  const b = range.lookup(2);
  const c = range.lookup(3);
  return b instanceof PDFNumber && c instanceof PDFNumber ? b.asNumber() + c.asNumber() : null;
}

export type RevisionFailure =
  | 'no-single-certification'
  | 'malformed-byte-range'
  | 'duplicate-byte-range'
  | 'signature-before-certification'
  | 'unsigned-tail'
  | 'too-many-revisions'
  | 'too-many-fields'
  | 'not-a-single-fill'
  | 'unreadable';

export type RevisionAnalysis =
  | {
      ok: true;
      /** Ends of every signed revision, ascending; the first is the certification's. */
      ends: number[];
      certified: SignedRevision;
      /** Object keys of the fields filled after certification, in order. */
      fills: string[];
    }
  | { ok: false; reason: RevisionFailure; detail?: string };

/**
 * Split a certified document into its signed revisions and check rule 5d on every step.
 *
 * `doc` is the already parsed file; it is only read. Never throws: anything that cannot be
 * classified is a refusal.
 */
export async function analyzeRevisions(
  doc: PDFDocument,
  bytes: Uint8Array,
): Promise<RevisionAnalysis> {
  try {
    let nodes: FormNode[];
    try {
      nodes = walkFormNodes(doc, MAX_FORM_NODES).nodes;
    } catch (err) {
      if (err instanceof FormTooLargeError) return { ok: false, reason: 'too-many-fields' };
      throw err;
    }

    const perms = doc.catalog.lookup(N('Perms'));
    const certRef = perms instanceof PDFDict ? perms.get(N('DocMDP')) : undefined;
    const entries = signatureEntries(nodes);
    const ends: number[] = [];
    let certEnd: number | null = null;
    let certCount = 0;
    for (const entry of entries) {
      const end = byteRangeEnd(entry.value, bytes);
      if (end === null) return { ok: false, reason: 'malformed-byte-range' };
      ends.push(end);
      if (
        certRef instanceof PDFRef &&
        entry.valueRef &&
        refKey(entry.valueRef) === refKey(certRef)
      ) {
        certEnd = end;
        certCount++;
      }
    }
    if (certCount !== 1 || certEnd === null)
      return { ok: false, reason: 'no-single-certification' };

    ends.sort((x, y) => x - y);
    if (new Set(ends).size !== ends.length) return { ok: false, reason: 'duplicate-byte-range' };
    if (ends[0] !== certEnd) return { ok: false, reason: 'signature-before-certification' };
    if (ends[ends.length - 1] !== bytes.length) return { ok: false, reason: 'unsigned-tail' };
    if (ends.length - 1 > MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION) {
      return { ok: false, reason: 'too-many-revisions' };
    }

    const certified = await loadRevision(bytes, ends[0]);
    const certifiedFieldKeys = signatureFieldKeys(certified.doc);
    const fills: string[] = [];
    let before = certified;
    for (let i = 1; i < ends.length; i++) {
      const after = await loadRevision(bytes, ends[i]);
      const step = compareRevisions(
        before,
        after,
        { allowInfoRewrite: true, certified, certifiedFieldKeys },
        bytes,
      );
      if (!step.ok) return { ok: false, reason: 'not-a-single-fill', detail: step.detail };
      fills.push(refKey(step.field));
      // Only consecutive revisions are compared; drop the older snapshot to bound memory.
      if (before !== certified) before.objects.clear();
      before = after;
    }
    return { ok: true, ends, certified, fills };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
