import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';

/**
 * T018 SPIKE — prove the core signing pipeline with the chosen libraries:
 *  - a VISIBLE signature (widgetRect) that a reader shows as a clickable field, and
 *  - INCREMENTAL multi-signature (calling this again on a signed buffer appends a
 *    new signature without re-serializing the earlier signed bytes; research R4).
 *
 * NOTE: this proves the sign + incremental + validate machinery. Making the placed
 * IMAGE the field's appearance stream (FR-011/012) is the follow-on refinement in
 * signFirst (T033); the widget here uses the default appearance.
 */
export interface VisibleSignOptions {
  reason?: string;
  name?: string;
  location?: string;
  contactInfo?: string;
  /** [x1, y1, x2, y2] in PDF points; non-zero makes the signature visible. */
  widgetRect?: [number, number, number, number];
}

export async function signVisible(
  pdf: Buffer,
  p12: Buffer,
  passphrase: string,
  opts: VisibleSignOptions = {},
): Promise<Buffer> {
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: pdf,
    reason: opts.reason ?? 'Approved',
    contactInfo: opts.contactInfo ?? '',
    name: opts.name ?? 'Signer',
    location: opts.location ?? '',
    widgetRect: opts.widgetRect ?? [40, 40, 240, 110],
  });

  const signer = new P12Signer(p12, { passphrase });
  return signpdf.sign(withPlaceholder, signer);
}
