import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import type { PlacementInput, Pkcs12 } from './types';
import { verifyCertPassword } from './cert';
import { PDFDocument, PDFArray, PDFName, PDFRef } from 'pdf-lib';
import { buildAppearance, formatDate, type SignFirstOptions } from './signFirst';
import { getSignerCommonName } from './cert';
import {
  clampBox,
  normalizedBoxToPdfRect,
  appearanceLayout,
  type Rotation,
} from '../../lib/coords';
import {
  addIncrementalPlaceholder,
  acroFormFieldRefs,
  reserveExistingObjectNumbers,
} from './incrementalUpdate';
import { signingPolicyBlock } from './signingPolicy';

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
 *    front (CertificationLockedError) — see signingPolicy.ts;
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

  const lock = signingPolicyBlock(probe);
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
