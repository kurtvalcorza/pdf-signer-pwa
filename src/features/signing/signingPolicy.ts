import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import type {
  BlockReason,
  CandidateField,
  FieldIneligibleReason,
  SigningClassification,
} from './types';
import {
  MAX_FORM_NODES,
  analyzeRevisions,
  existedAtCertification,
  inheritable,
  isEmptyValue,
  partialName,
  refKey,
  signatureEntries,
  walkFormNodes,
  type FormNode,
  type RevisionFailure,
  type SignedRevision,
} from './revisions';
import { fieldRectToNormBox, type PageBox } from '../placement/placement';
import type { Rotation } from '../../lib/coords';

/**
 * Shown when free placement is asked for on a certified document (RFC 23-1 row R11). Appending a
 * NEW signature field after a certification is a disallowed change at every /P; pyHanko confirms
 * it (tests/signing/policy.test.ts, forced-append control).
 */
export const CERTIFIED_FREE_PLACEMENT =
  'This PDF is certified. Its policy does not allow a new signature field to be added, so a ' +
  'signature cannot be placed freely on it without breaking the certification.';

/** One message per document-level reason (contracts/signing-classification.md, "Copy"). */
export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  'certified-no-changes':
    'This PDF is certified with a “no changes allowed” policy. Adding any signature would break ' +
    'that certification, so it cannot be signed here.',
  'certified-no-empty-field':
    'This PDF is certified and has no empty signature field to sign. Ask the sender for a ' +
    'version that includes a signature field for you.',
  'certified-no-eligible-field':
    'This PDF is certified, and none of its empty signature fields can be signed here. The ' +
    'reasons are listed below.',
  'field-locked':
    'An existing signature on this PDF locks its form fields (FieldMDP). Adding a signature ' +
    'field could break that signature, so it cannot be signed here.',
  'unknown-policy':
    'An existing signature on this PDF uses a modification policy this app does not recognise, ' +
    'so it cannot be signed here.',
  'form-not-fillable':
    'This certified PDF’s form is not set up the way a signed form must be, so it cannot be ' +
    'signed here.',
  'xfa-form': 'This certified PDF uses an XFA form, which this app cannot sign.',
  'changed-after-certification':
    'This PDF was changed after it was certified in a way this app cannot check, so it cannot ' +
    'be signed here.',
  'too-many-fields':
    'This certified PDF has more form fields than this app will check, so it cannot be signed ' +
    'here.',
  'too-many-revisions':
    'This certified PDF has been signed more times than this app will check, so it cannot be ' +
    'signed here.',
  'unreadable-policy':
    'This PDF’s signature policy could not be read, so it cannot be signed here.',
};

const N = (s: string) => PDFName.of(s);

const blocked = (
  reason: BlockReason,
  ineligible: CandidateField[] = [],
): SigningClassification => ({
  kind: 'blocked',
  reason,
  message: BLOCK_MESSAGES[reason],
  ineligible,
});

const REVISION_REASONS: Record<RevisionFailure, BlockReason> = {
  'no-single-certification': 'unknown-policy',
  'malformed-byte-range': 'unreadable-policy',
  'duplicate-byte-range': 'unreadable-policy',
  'signature-before-certification': 'unreadable-policy',
  'unsigned-tail': 'changed-after-certification',
  'not-a-single-fill': 'changed-after-certification',
  'too-many-revisions': 'too-many-revisions',
  'too-many-fields': 'too-many-fields',
  'xref-unreadable': 'unreadable-policy',
  unreadable: 'unreadable-policy',
};

/**
 * Decide how, if at all, this PDF may be signed (contracts/signing-classification.md):
 *
 *  - `ok`: not certified and no blocking policy. A new signature field is appended, as before.
 *  - `fill-only`: certified at DocMDP P=2 or P=3 with at least one empty signature field that
 *    passes every rule of RFC 23-1 section 3. Only such a field may be signed; adding a field
 *    would break the certification.
 *  - `blocked`: everything else, with a reason.
 *
 * Never throws and never modifies `doc` or `bytes`. Anything it cannot classify is `blocked`
 * (`unreadable-policy`). For an uncertified document it does what `signingPolicyBlock` did, at
 * the same cost: the revisions are only parsed once a certification has been found.
 */
export async function classifySigning(
  doc: PDFDocument,
  bytes: Uint8Array,
): Promise<SigningClassification> {
  try {
    return await classify(doc, bytes);
  } catch {
    return blocked('unreadable-policy');
  }
}

async function classify(doc: PDFDocument, bytes: Uint8Array): Promise<SigningClassification> {
  // No cap yet: an uncertified document is walked exactly as before this feature (FR-005).
  const walk = walkFormNodes(doc);

  // --- Policies declared by existing signatures (R4, R7), as before. ---
  const perms = doc.catalog.lookup(N('Perms'));
  const declared = perms instanceof PDFDict && perms.has(N('DocMDP'));
  const permsSig = perms instanceof PDFDict ? perms.lookup(N('DocMDP')) : undefined;
  const sigDicts = new Set<PDFDict>();
  if (permsSig instanceof PDFDict) sigDicts.add(permsSig);
  for (const entry of signatureEntries(walk.nodes)) sigDicts.add(entry.value);

  const docMdp = new Set<PDFDict>();
  let fieldLocked = false;
  let unknown = false;
  let noChanges = false;
  for (const sig of sigDicts) {
    const refs = sig.lookup(N('Reference'));
    if (refs === undefined) continue;
    if (!(refs instanceof PDFArray)) throw new Error('unreadable /Reference');
    for (let i = 0; i < refs.size(); i++) {
      const sigRef = refs.lookup(i);
      if (!(sigRef instanceof PDFDict)) throw new Error('unreadable /Reference entry');
      const method = sigRef.lookup(N('TransformMethod'));
      if (method === N('FieldMDP')) {
        fieldLocked = true;
      } else if (method === N('DocMDP')) {
        docMdp.add(sig);
        const params = sigRef.lookup(N('TransformParams'));
        const p = params instanceof PDFDict ? params.lookup(N('P')) : undefined;
        if (p instanceof PDFNumber && p.asNumber() === 1) noChanges = true;
      } else if (method !== N('Identity')) {
        unknown = true;
      }
    }
  }
  if (fieldLocked) return blocked('field-locked');
  if (unknown) return blocked('unknown-policy');

  const certified = declared || docMdp.size > 0;
  if (!certified) return { kind: 'ok' };

  // --- R8: the catalog and the signature must agree on one certification. ---
  if (!(permsSig instanceof PDFDict) || docMdp.size !== 1 || !docMdp.has(permsSig)) {
    return blocked('unknown-policy');
  }
  // --- R1. ---
  if (noChanges) return blocked('certified-no-changes');

  // --- R9, R10: the form must already be a signed, append-only AcroForm. Never repaired. ---
  const acro = doc.catalog.lookup(N('AcroForm'));
  if (!(acro instanceof PDFDict)) return blocked('form-not-fillable');
  const sigFlags = acro.lookup(N('SigFlags'));
  if (!(sigFlags instanceof PDFNumber) || sigFlags.asNumber() !== 3) {
    return blocked('form-not-fillable');
  }
  const needAppearances = acro.lookup(N('NeedAppearances'));
  if (needAppearances !== undefined && needAppearances !== PDFBool.False) {
    return blocked('form-not-fillable');
  }
  if (acro.has(N('XFA'))) return blocked('xfa-form');

  // --- T10, and a form that is not a tree. ---
  if (walk.nodes.length > MAX_FORM_NODES) return blocked('too-many-fields');
  if (walk.repeated) return blocked('unreadable-policy');

  // --- R18 (rule 5d) and FR-009. ---
  const analysis = await analyzeRevisions(doc, bytes);
  if (!analysis.ok) return blocked(REVISION_REASONS[analysis.reason]);

  // --- Candidate fields: rules 1–8, 5a–5c. ---
  const ctx = fieldContext(doc, walk.roots, walk.nodes, analysis.certified);
  const fields: CandidateField[] = [];
  const ineligible: CandidateField[] = [];
  for (const node of walk.nodes) {
    if (!isEmptySignatureField(node)) continue;
    const candidate = describeField(node, ctx);
    (candidate.eligible ? fields : ineligible).push(candidate);
  }
  if (fields.length > 0) return { kind: 'fill-only', fields, ineligible };
  return blocked(
    ineligible.length > 0 ? 'certified-no-eligible-field' : 'certified-no-empty-field',
    ineligible,
  );
}

const isSignatureField = (node: FormNode): boolean => inheritable(node.dict, 'FT') === N('Sig');
const isNamed = (node: FormNode): boolean => partialName(node.dict) !== null;

/**
 * Rule 1 and the "empty" half of rule 2: a signature field with no value of its own. A kid
 * without a /T is a widget of its parent, not a field (ISO 32000-1 12.7.3.1), so it is never a
 * candidate itself; a node whose kids carry names is a non-terminal, not a field to sign.
 */
function isEmptySignatureField(node: FormNode): boolean {
  if (!isSignatureField(node)) return false;
  if (!isNamed(node) && node.parent !== null) return false;
  if (node.kids.some(isNamed)) return false;
  return isEmptyValue(node.dict.lookup(N('V')));
}

interface FieldContext {
  roots: FormNode[];
  nodes: FormNode[];
  certified: SignedRevision;
  /** Page object key → page index. */
  pageIndex: Map<string, number>;
  /** Annotation object key → index of every page whose /Annots lists it (once per listing). */
  listedOn: Map<string, number[]>;
  pageBoxes: Array<PageBox | null>;
  /** Raw /AP values that are indirect references, counted across fields and page annotations. */
  appearanceUses: Map<string, number>;
}

function fieldContext(
  doc: PDFDocument,
  roots: FormNode[],
  nodes: FormNode[],
  certified: SignedRevision,
): FieldContext {
  const pageIndex = new Map<string, number>();
  const listedOn = new Map<string, number[]>();
  const pageBoxes: Array<PageBox | null> = [];
  const appearanceOwners = new Map<string, Set<PDFDict>>();
  const noteAppearance = (dict: PDFDict) => {
    const ap = dict.get(N('AP'));
    if (!(ap instanceof PDFRef)) return;
    const owners = appearanceOwners.get(refKey(ap)) ?? new Set<PDFDict>();
    owners.add(dict);
    appearanceOwners.set(refKey(ap), owners);
  };

  doc.getPages().forEach((page, index) => {
    pageIndex.set(refKey(page.ref), index);
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    let box: PageBox | null = null;
    try {
      const crop = page.getCropBox();
      if ([0, 90, 180, 270].includes(angle) && crop.width > 0 && crop.height > 0) {
        box = { ...crop, rotation: angle as Rotation };
      }
    } catch {
      box = null;
    }
    pageBoxes.push(box);
    const annots = page.node.lookup(N('Annots'));
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (dict instanceof PDFDict) noteAppearance(dict);
      if (!(raw instanceof PDFRef)) continue;
      const pages = listedOn.get(refKey(raw)) ?? [];
      pages.push(index);
      listedOn.set(refKey(raw), pages);
    }
  });
  for (const node of nodes) noteAppearance(node.dict);

  const appearanceUses = new Map<string, number>();
  for (const [key, owners] of appearanceOwners) appearanceUses.set(key, owners.size);
  return { roots, nodes, certified, pageIndex, listedOn, pageBoxes, appearanceUses };
}

/** The field's /Rect as `[x1, y1, x2, y2]` with x1 < x2 and y1 < y2, or null. */
function fieldRect(dict: PDFDict): [number, number, number, number] | null {
  const rect = dict.lookup(N('Rect'));
  if (!(rect instanceof PDFArray) || rect.size() !== 4) return null;
  const v: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = rect.lookup(i);
    if (!(n instanceof PDFNumber) || !Number.isFinite(n.asNumber())) return null;
    v.push(n.asNumber());
  }
  const [x1, x2] = v[0] <= v[2] ? [v[0], v[2]] : [v[2], v[0]];
  const [y1, y2] = v[1] <= v[3] ? [v[1], v[3]] : [v[3], v[1]];
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function fullName(node: FormNode): string {
  const parts: string[] = [];
  for (let n: FormNode | null = node; n; n = n.parent) {
    parts.unshift(partialName(n.dict) ?? '(unnamed)');
  }
  return parts.join('.');
}

function describeField(node: FormNode, ctx: FieldContext): CandidateField {
  const rect = fieldRect(node.dict);
  const listed = node.ref ? (ctx.listedOn.get(refKey(node.ref)) ?? []) : [];
  const p = node.dict.get(N('P'));
  const named = p instanceof PDFRef ? ctx.pageIndex.get(refKey(p)) : undefined;
  const onOnePage = named !== undefined && listed.length === 1 && listed[0] === named;
  const pageIndex = onOnePage ? named : null;
  const pageBox = pageIndex !== null ? ctx.pageBoxes[pageIndex] : null;
  const reason = ineligibility(node, ctx, { rect, listed, onOnePage, pageBox });
  return {
    ref: node.ref
      ? { objectNumber: node.ref.objectNumber, generationNumber: node.ref.generationNumber }
      : { objectNumber: 0, generationNumber: 0 },
    name: fullName(node),
    pageIndex,
    rect,
    box: rect && pageBox ? fieldRectToNormBox(rect, pageBox) : null,
    eligible: reason === null,
    ...(reason ? { reason } : {}),
  };
}

/** The first rule of RFC 23-1 section 3 this field fails, in rule order, or null. */
function ineligibility(
  node: FormNode,
  ctx: FieldContext,
  geom: {
    rect: [number, number, number, number] | null;
    listed: number[];
    onOnePage: boolean;
    pageBox: PageBox | null;
  },
): FieldIneligibleReason | null {
  const d = node.dict;

  // Rule 2: no inherited value, and no signature sibling under a shared parent.
  for (let a = node.parent; a; a = a.parent) {
    if (!isEmptyValue(a.dict.lookup(N('V')))) return 'inherited-value';
  }
  if (node.parent?.kids.some((k) => k !== node && isNamed(k) && isSignatureField(k))) {
    return 'shared-parent';
  }

  // Rule 3: field and widget are one indirect object, with no kids (D8).
  if (!node.ref || node.kids.length > 0 || d.has(N('Kids'))) return 'separate-widget';
  if (d.lookup(N('Subtype')) !== N('Widget')) return 'separate-widget';

  // Rule 4: it names a page, that page lists it, and no other listing exists.
  if (geom.listed.length > 1) return 'on-several-pages';
  if (!geom.onOnePage) return 'page-mismatch';

  // Rule 5: visible, with a real box that touches the visible page area, in no optional layer.
  const flags = d.lookup(N('F'));
  const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
  if (flags !== undefined && !(flags instanceof PDFNumber)) return 'not-visible';
  if (f & 2 || f & 32) return 'not-visible'; // Hidden, NoView
  const { rect, pageBox } = geom;
  if (!rect || !pageBox) return 'not-visible';
  const overlaps =
    rect[0] < pageBox.x + pageBox.width &&
    rect[2] > pageBox.x &&
    rect[1] < pageBox.y + pageBox.height &&
    rect[3] > pageBox.y;
  if (!overlaps) return 'not-visible';
  if (d.has(N('OC'))) return 'optional-content';

  // research.md R6: an upright stamp in a rotated widget would not match the preview.
  const mk = d.lookup(N('MK'));
  if (mk !== undefined) {
    const r = mk instanceof PDFDict ? mk.lookup(N('R')) : null;
    if (r === null) return 'rotated-widget';
    if (r !== undefined && (!(r instanceof PDFNumber) || r.asNumber() % 360 !== 0)) {
      return 'rotated-widget';
    }
  }

  // Rule 5a: not read-only (inherited /Ff bit 1).
  const ff = inheritable(d, 'Ff');
  if (ff !== undefined && (!(ff instanceof PDFNumber) || ff.asNumber() & 1)) return 'read-only';

  // Rule 5b: every name on the path exists, has no period, and is unique among its siblings.
  for (let n: FormNode | null = node; n; n = n.parent) {
    const name = partialName(n.dict);
    if (name === null || name === '' || name.includes('.')) return 'bad-name';
    const siblings = n.parent ? n.parent.kids : ctx.roots;
    if (siblings.filter((s) => partialName(s.dict) === name).length !== 1) return 'bad-name';
    // The /Parent pointer must agree with the tree the walk found, or the path is ambiguous.
    const pointer = n.dict.lookup(N('Parent'));
    if (n.parent ? pointer !== n.parent.dict : pointer !== undefined) return 'bad-name';
  }

  // Rule 5c: the field and its page listing are in the bytes the certification covers.
  if (!existedAtCertification(ctx.certified, node.ref, partialName(d) ?? undefined)) {
    return 'added-after-certification';
  }

  // Rule 6: no lock, no seed values (D2).
  if (d.has(N('Lock'))) return 'locked';
  if (d.has(N('SV'))) return 'seed-values';

  // Rule 8: an indirect /AP dictionary must not be shared with another annotation.
  const ap = d.get(N('AP'));
  if (ap instanceof PDFRef && (ctx.appearanceUses.get(refKey(ap)) ?? 0) > 1) {
    return 'shared-appearance';
  }
  return null;
}
