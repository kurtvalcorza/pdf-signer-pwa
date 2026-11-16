import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import type { FieldPlacementInput, PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword } from './cert';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFRef } from 'pdf-lib';
import { buildAppearance, formatDate, type SignFirstOptions } from './signFirst';
import { getSignerCommonName } from './cert';
import {
  clampBox,
  normalizedBoxToPdfRect,
  appearanceLayout,
  type AppearanceLayout,
  type Rotation,
} from '../../lib/coords';
import {
  addIncrementalPlaceholder,
  acroFormFieldRefs,
  fillExistingSignatureField,
  reserveExistingObjectNumbers,
} from './incrementalUpdate';
import { CERTIFIED_FREE_PLACEMENT, classifySigning } from './signingPolicy';
import {
  compareRevisions,
  loadRevision,
  refKey,
  signatureFieldKeys,
  walkFormNodes,
} from './revisions';
import { checkRevisionXref, findRepeatedKeys, initialXrefState } from './xrefSections';

/**
 * Tier B — a subsequent cryptographic signature added as a BYTE-LEVEL INCREMENTAL
 * update (research R4). The already-signed bytes are never re-serialized, so
 * earlier signatures stay valid (FR-013 / SC-009). Works on any page and on any
 * parseable PDF structure (xref streams, object streams, indirect /Annots or
 * /Fields) — the update is built from pdf-lib's parsed graph, not string surgery
 * (see incrementalUpdate.ts).
 *
 * Guards that keep the FR-013 claim honest rather than best-effort:
 *  - a certified or FieldMDP-locked document, or an unrecognised policy, rejects up
 *    front (CertificationLockedError) — see signingPolicy.ts. A certified document is
 *    refused here even when it can be signed in a prepared field: this path appends a
 *    NEW field, which breaks a certification at every level (spec 004 FR-002, row R11);
 *  - the produced update is re-parsed and must still enumerate every
 *    pre-existing field plus the new one, attached to the requested page —
 *    anything less would hide earlier signatures from validators, so we refuse
 *    to emit it.
 */
export async function signIncremental(
  signedPdf: Uint8Array,
  placement: PlacementInput,
  cert: Pkcs12,
  opts: SignFirstOptions = {},
): Promise<Uint8Array> {
  if (!verifyCertPassword(cert.p12Bytes, cert.password)) {
    const { BadPasswordError } = await import('./types');
    throw new BadPasswordError();
  }

  // Read structure WITHOUT mutating/saving the signed bytes (read-only load; the
  // probe's parsed objects are also what the incremental update is built from).
  const probe = await PDFDocument.load(signedPdf);

  // Reserve every object number the file already uses BEFORE embedding anything. In a
  // compressed PDF, object-stream and xref-stream container objects are never registered
  // on pdf-lib's context, so their numbers look "free" and would be reused — silently
  // clobbering a live object stream and hiding the earlier signature. Must precede the
  // first register() below (image/appearance), and originalLargestObjectNumber is read
  // AFTER it so the newly-embedded resources are still detected as new.
  reserveExistingObjectNumbers(signedPdf, probe);
  const originalLargestObjectNumber = probe.context.largestObjectNumber;

  const signing = await classifySigning(probe, signedPdf);
  if (signing.kind !== 'ok') {
    const { CertificationLockedError } = await import('./types');
    throw new CertificationLockedError(
      signing.kind === 'blocked' ? signing.message : CERTIFIED_FREE_PLACEMENT,
    );
  }

  const page = probe.getPages()[placement.pageIndex];
  if (!page) throw new Error(`Signature targets a missing page (index ${placement.pageIndex}).`);
  const { width, height } = page.getSize();
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as Rotation;
  const box = clampBox({ nx: placement.nx, ny: placement.ny, nw: placement.nw, nh: placement.nh });
  const geom = { widthPt: width, heightPt: height, rotation };
  const rect = normalizedBoxToPdfRect(box, geom);
  const appearance = appearanceLayout(box, geom);

  const priorFieldRefs = acroFormFieldRefs(probe).map(String);
  const appearanceRef = await embedAppearance(probe, placement, appearance, cert, opts);

  const withPlaceholder = addIncrementalPlaceholder(signedPdf, probe, {
    pageIndex: placement.pageIndex,
    widgetRect: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
    appearanceRef,
    originalLargestObjectNumber,
  });

  await assertUpdateWellFormed(withPlaceholder, priorFieldRefs, placement.pageIndex);

  const signer = new P12Signer(cert.p12Bytes, { passphrase: cert.password });
  const signed = await signpdf.sign(withPlaceholder, signer);
  return new Uint8Array(signed);
}

/**
 * Sign a certified PDF by FILLING a signature field its author prepared (spec 004, RFC 23-1).
 *
 * The only signing path a certified document has: nothing is added to the form or to any page.
 * The output is the input byte for byte, followed by one incremental update holding the
 * appearance resources, one appearance stream, one signature dictionary and a new version of the
 * picked field (FR-014). The signature is an ordinary approval signature (FR-016).
 *
 *  - The document is classified again from its bytes here, whatever the caller believed: it must
 *    be fill-only and `placement.fieldRef` must be one of its eligible fields, or this throws
 *    CertificationLockedError and nothing is produced.
 *  - The stamp is laid out into the field's own box; there is no position or size to pass (D6).
 *  - Before returning, input and output are compared object by object (FR-015).
 *
 * It does not verify the certification and makes no claim about it.
 */
export async function signIntoField(
  signedPdf: Uint8Array,
  placement: FieldPlacementInput,
  cert: Pkcs12,
  opts: SignFirstOptions = {},
): Promise<Uint8Array> {
  if (!verifyCertPassword(cert.p12Bytes, cert.password)) {
    const { BadPasswordError } = await import('./types');
    throw new BadPasswordError();
  }

  // updateMetadata:false keeps /Info exactly as parsed; this update must not touch it.
  const probe = await PDFDocument.load(signedPdf, { updateMetadata: false });
  reserveExistingObjectNumbers(signedPdf, probe); // before anything is registered, as above
  const originalLargestObjectNumber = probe.context.largestObjectNumber;

  const signing = await classifySigning(probe, signedPdf);
  const target =
    signing.kind === 'fill-only'
      ? signing.fields.find(
          (f) =>
            f.ref.objectNumber === placement.fieldRef.objectNumber &&
            f.ref.generationNumber === placement.fieldRef.generationNumber,
        )
      : undefined;
  if (!target || target.pageIndex === null || !target.rect || !target.box) {
    const { CertificationLockedError } = await import('./types');
    throw new CertificationLockedError(
      signing.kind === 'blocked'
        ? signing.message
        : signing.kind === 'ok'
          ? 'This PDF is not certified, so it is signed by placing a signature, not by ' +
            'filling a field.'
          : 'That signature field cannot be signed here. Pick one of the fields the app ' +
            'outlines on the page.',
    );
  }

  const page = probe.getPages()[target.pageIndex];
  const crop = page.getCropBox();
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as Rotation;
  const appearance = appearanceLayout(target.box, {
    widthPt: crop.width,
    heightPt: crop.height,
    rotation,
  });
  const appearanceRef = await embedAppearance(probe, placement, appearance, cert, opts);

  const fieldRef = PDFRef.of(target.ref.objectNumber, target.ref.generationNumber);
  const withPlaceholder = fillExistingSignatureField(signedPdf, probe, {
    fieldRef,
    appearanceRef,
    originalLargestObjectNumber,
  });

  const signer = new P12Signer(cert.p12Bytes, { passphrase: cert.password });
  const signed = new Uint8Array(await signpdf.sign(withPlaceholder, signer));
  await assertFillWellFormed(signedPdf, signed, fieldRef);
  return signed;
}

/**
 * Embed the signature image (and the label font, if a label is drawn) on the probe and register
 * the appearance form XObject. Shared by both incremental paths; the layout decides the box.
 */
async function embedAppearance(
  probe: PDFDocument,
  placement: Pick<PlacementInput, 'imageBytes' | 'format'>,
  appearance: AppearanceLayout,
  cert: Pkcs12,
  opts: SignFirstOptions,
): Promise<PDFRef> {
  const image =
    placement.format === 'png'
      ? await probe.embedPng(placement.imageBytes)
      : await probe.embedJpg(placement.imageBytes);
  const showLabel = opts.label !== false;
  const showDate = opts.date !== false;
  const signerName =
    opts.displayName ?? getSignerCommonName(cert.p12Bytes, cert.password) ?? 'Signer';
  const { content: apContent, resources } = await buildAppearance(
    probe,
    appearance.widthPt,
    appearance.heightPt,
    image,
    {
      name: showLabel ? signerName : null,
      dateStr: showDate ? `Date: ${formatDate(new Date())}` : null,
    },
  );
  const apStream = probe.context.stream(apContent, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, appearance.widthPt, appearance.heightPt],
    Matrix: appearance.matrix,
    Resources: resources,
  } as Parameters<typeof probe.context.stream>[1]);
  const appearanceRef = probe.context.register(apStream);
  await probe.flush();
  return appearanceRef;
}

/**
 * Re-parse the produced update and require: every pre-existing field still
 * enumerated, exactly one new field added, and the new widget attached to the
 * requested page. Throws instead of letting a malformed update be signed —
 * a file that hides earlier signatures from validators must never leave here.
 */
async function assertUpdateWellFormed(
  withPlaceholder: Buffer,
  priorFieldRefs: string[],
  pageIndex: number,
): Promise<void> {
  let reparsed: PDFDocument;
  try {
    reparsed = await PDFDocument.load(new Uint8Array(withPlaceholder));
  } catch {
    throw updateMalformed();
  }
  const after = acroFormFieldRefs(reparsed).map(String);
  const afterSet = new Set(after);
  if (after.length !== priorFieldRefs.length + 1 || priorFieldRefs.some((r) => !afterSet.has(r))) {
    throw updateMalformed();
  }
  const newRefStr = after.find((r) => !priorFieldRefs.includes(r))!;
  const page = reparsed.getPages()[pageIndex];
  const annots = page?.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  let onPage = false;
  for (let i = 0; annots && i < annots.size(); i++) {
    const ref = annots.get(i);
    if (ref instanceof PDFRef && String(ref) === newRefStr) onPage = true;
  }
  if (!onPage) throw updateMalformed();
}

function updateMalformed(): Error {
  return new Error(
    'The incremental update could not preserve the existing signature field(s) of this ' +
      'PDF, which would hide the earlier signature(s) from validators. The document was ' +
      'left unsigned.',
  );
}

/**
 * FR-015: re-read the signed output and compare it with the input, object by object AND through
 * the cross-reference data. Returns null when the output is exactly one fill of `fieldRef`, else
 * a short reason.
 *
 * Required: the input is a byte prefix of the output; exactly one pre-existing object differs
 * and it is the picked field; that field changed only in the fill keys and now holds a NEW
 * signature dictionary whose byte range ends at the end of the file; that dictionary declares no
 * /Reference (an approval signature, not a certification or a lock); the trailer still names the
 * same catalog and /Info; the appended bytes are one cross-reference section that lists exactly
 * the objects compared, frees nothing and re-defines no other existing object number
 * (xrefSections.ts); the set of form nodes is unchanged. Every page's /Annots, the form and the
 * catalog are pre-existing objects (or live inside one), so "no other object differs" covers
 * them.
 */
export async function checkFill(
  input: Uint8Array,
  output: Uint8Array,
  fieldRef: PDFRef,
): Promise<string | null> {
  try {
    if (output.length <= input.length) return 'nothing-appended';
    for (let i = 0; i < input.length; i++) {
      if (output[i] !== input[i]) return 'input-bytes-changed';
    }
    const before = await loadRevision(input);
    const after = await loadRevision(output);
    const result = compareRevisions(
      before,
      after,
      {
        allowInfoRewrite: false,
        certified: before,
        certifiedFieldKeys: signatureFieldKeys(before.doc),
      },
      output,
    );
    if (!result.ok) return result.detail;
    if (refKey(result.field) !== refKey(fieldRef)) return 'another-field-changed';

    const repeated = await findRepeatedKeys(output, input.length, output.length);
    if (repeated) return repeated.detail;
    const initial = initialXrefState(input, before);
    if (!initial.ok) return initial.detail;
    const reader = checkRevisionXref(output, before, after, initial.state, {
      fieldKey: refKey(fieldRef),
      allowInfoRewrite: false,
    });
    if (!reader.ok) return reader.detail;

    const nodeKeys = (doc: PDFDocument) =>
      walkFormNodes(doc)
        .nodes.map((n) => (n.ref ? refKey(n.ref) : 'direct'))
        .join(',');
    if (nodeKeys(before.doc) !== nodeKeys(after.doc)) return 'field-set-changed';

    const field = after.doc.context.lookup(fieldRef, PDFDict);
    const value = field.lookup(PDFName.of('V'), PDFDict);
    if (value.has(PDFName.of('Reference'))) return 'signature-declares-a-transform';
    return null;
  } catch {
    return 'unreadable-output';
  }
}

/** Throws, so that no output leaves `signIntoField`, unless `checkFill` finds nothing. */
export async function assertFillWellFormed(
  input: Uint8Array,
  output: Uint8Array,
  fieldRef: PDFRef,
): Promise<void> {
  if ((await checkFill(input, output, fieldRef)) !== null) {
    throw new Error(
      'The signature could not be added to the chosen field without changing another part of ' +
        'this certified PDF, so no signed file was produced.',
    );
  }
}
