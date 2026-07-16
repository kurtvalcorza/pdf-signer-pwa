import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import type { PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword } from './cert';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { buildAppearance, formatDate, type SignFirstOptions } from './signFirst';
import { getSignerCommonName } from './cert';
import {
  clampBox,
  normalizedBoxToPdfRect,
  appearanceLayout,
  type Rotation,
} from '../../lib/coords';
import { addIncrementalPlaceholder, acroFormFieldRefs } from './incrementalUpdate';

/**
 * Tier B — a subsequent cryptographic signature added as a BYTE-LEVEL INCREMENTAL
 * update (research R4). The already-signed bytes are never re-serialized, so
 * earlier signatures stay valid (FR-013 / SC-009). Works on any page and on any
 * parseable PDF structure (xref streams, object streams, indirect /Annots or
 * /Fields) — the update is built from pdf-lib's parsed graph, not string surgery
 * (see incrementalUpdate.ts).
 *
 * Guards that keep the FR-013 claim honest rather than best-effort:
 *  - a certification (DocMDP "no changes") or FieldMDP-locked signature rejects
 *    up front (CertificationLockedError) — appending a field would break it;
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
  const originalLargestObjectNumber = probe.context.largestObjectNumber;

  const lock = modificationLock(probe);
  if (lock) {
    const { CertificationLockedError } = await import('./types');
    throw new CertificationLockedError(lock);
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
 * A human-readable reason if any existing signature's policy makes appending a new
 * signature field a disallowed modification, else null. Checked conservatively:
 *
 *  - DocMDP with /TransformParams /P 1 ("no changes allowed") — P of 2 (form-fill +
 *    sign) or 3 (+ annotate) permits an approval signature; missing /P defaults to 2
 *    per the PDF spec. Found via catalog /Perms or any signature's own /Reference.
 *  - FieldMDP (e.g. Acrobat's "lock fields after signing") — adding our field
 *    rewrites /Fields, a form modification the lock may disallow; we cannot prove
 *    the new field is permitted, so reject rather than risk breaking the signature.
 */
function modificationLock(doc: PDFDocument): string | null {
  for (const sig of allSignatureDicts(doc)) {
    const refs = sig.lookupMaybe(PDFName.of('Reference'), PDFArray);
    if (!refs) continue;
    for (let i = 0; i < refs.size(); i++) {
      const sigRef = refs.lookupMaybe(i, PDFDict);
      const method = sigRef?.lookupMaybe(PDFName.of('TransformMethod'), PDFName);
      if (method === PDFName.of('FieldMDP')) {
        return (
          'An existing signature on this PDF locks its form fields (FieldMDP). Adding a ' +
          'signature field could break that signature, so the document was not signed.'
        );
      }
      if (method === PDFName.of('DocMDP')) {
        const params = sigRef!.lookupMaybe(PDFName.of('TransformParams'), PDFDict);
        const p = params?.lookupMaybe(PDFName.of('P'), PDFNumber);
        if ((p?.asNumber() ?? 2) === 1) {
          return (
            'This PDF is certified with a “no changes allowed” policy. Adding any ' +
            'signature would break that certification, so it was not signed.'
          );
        }
      }
    }
  }
  return null;
}

/** The certification signature (catalog /Perms /DocMDP) plus every signed field's /V. */
function* allSignatureDicts(doc: PDFDocument): Generator<PDFDict> {
  const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  const certSig = perms?.lookupMaybe(PDFName.of('DocMDP'), PDFDict);
  if (certSig) yield certSig;

  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return;
  const stack: PDFDict[] = [];
  const seen = new Set<PDFDict>();
  const push = (arr: PDFArray) => {
    for (let i = 0; i < arr.size(); i++) {
      const d = arr.lookupMaybe(i, PDFDict);
      if (d) stack.push(d);
    }
  };
  push(fields);
  while (stack.length) {
    const field = stack.pop()!;
    if (seen.has(field)) continue; // cyclic /Parent–/Kids guard
    seen.add(field);
    const value = field.lookupMaybe(PDFName.of('V'), PDFDict);
    if (value?.lookupMaybe(PDFName.of('ByteRange'), PDFArray)) yield value;
    const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) push(kids);
  }
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
