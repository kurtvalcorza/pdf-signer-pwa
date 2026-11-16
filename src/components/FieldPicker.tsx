import type {
  CandidateField,
  FieldIneligibleReason,
  ObjectId,
  SigningClassification,
} from '../features/signing/types';

/**
 * Choosing the prepared signature field of a certified PDF (spec 004, FR-011 / FR-012).
 *
 * A certified document cannot take a freely placed signature, so these two pieces replace the
 * draggable overlay: outlines on the page preview, at the place each field's box really is, and
 * a list in the sheet. Nothing is ever picked for the user, including when one field is the only
 * choice (D3). A field's name is shown as data from the document, never as a role (T1).
 *
 * No text here may say the certification is valid, preserved or still in force: the app does not
 * verify signatures (Principle IV).
 */

/** FR-017. */
export const FILL_ONLY_NOTICE =
  'This PDF is certified. It can only be signed in one of the signature fields its author prepared.';

/** FR-019: what the app did, and nothing about the certification. */
export const fieldSignedMessage = (name: string): string =>
  `Signed in the existing field '${name}'. No other part of the document was changed.`;

export const fieldLabel = (field: CandidateField): string =>
  `Field name set by the document: "${field.name}"` +
  (field.pageIndex !== null ? ` (page ${field.pageIndex + 1})` : '');

/** One sentence per reason an empty signature field cannot be signed here (FR-010). */
export const FIELD_REASON_TEXT: Record<FieldIneligibleReason, string> = {
  'inherited-value': 'A parent of this field already carries a value.',
  'shared-parent': 'This field shares a parent with another signature field.',
  'separate-widget':
    'This field’s box is stored as a separate object, which this app cannot sign safely.',
  'page-mismatch': 'This field names a page that does not list it.',
  'on-several-pages': 'This field appears on more than one page.',
  'not-visible': 'This field is hidden, has no size, or lies outside the page.',
  'optional-content': 'This field belongs to an optional layer that a viewer may hide.',
  'rotated-widget': 'This field’s box is rotated, which this app cannot draw into.',
  'read-only': 'The document marks this field as read-only.',
  'bad-name': 'This field’s name is missing, contains a period, or is used twice.',
  'added-after-certification': 'This field was added after the document was certified.',
  locked: 'Signing this field would lock other fields, which this app does not do.',
  'seed-values': 'This field sets requirements for its signature that this app does not check.',
  'shared-appearance': 'This field shares its appearance with another part of the document.',
};

export const sameField = (a: ObjectId | null, b: ObjectId): boolean =>
  !!a && a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;

/**
 * Outlines of the eligible fields on the page being shown. Rendered inside the page's
 * positioned container, so the percentages are of the displayed page. The stamp preview is
 * fitted inside the picked field's box (aspect ratio kept) and cannot be moved or resized (D6).
 */
export function FieldOutlines({
  fields,
  pageIndex,
  picked,
  onPick,
  imageUrl,
}: {
  fields: CandidateField[];
  pageIndex: number;
  picked: ObjectId | null;
  onPick: (field: CandidateField) => void;
  imageUrl: string | null;
}) {
  return (
    <>
      {fields
        .filter((f) => f.pageIndex === pageIndex && f.box)
        .map((f) => {
          const box = f.box!;
          const isPicked = sameField(picked, f.ref);
          return (
            <button
              key={`${f.ref.objectNumber}-${f.ref.generationNumber}`}
              type="button"
              data-testid="field-outline"
              aria-pressed={isPicked}
              aria-label={`Sign in this field. ${fieldLabel(f)}`}
              onClick={() => onPick(f)}
              className={`absolute rounded-sm border-2 ${
                isPicked
                  ? 'border-blue-500 bg-blue-400/10'
                  : 'border-dashed border-amber-500 bg-amber-300/25'
              }`}
              style={{
                left: `${box.nx * 100}%`,
                top: `${box.ny * 100}%`,
                width: `${box.nw * 100}%`,
                height: `${box.nh * 100}%`,
              }}
            >
              {isPicked && imageUrl && (
                <img
                  src={imageUrl}
                  alt="signature"
                  className="pointer-events-none h-full w-full object-contain"
                  draggable={false}
                />
              )}
            </button>
          );
        })}
    </>
  );
}

/**
 * The fields of a certified document, in the document's own order: eligible ones as choices,
 * the others greyed out with the reason each cannot be used.
 */
export function FieldList({
  signing,
  picked,
  onPick,
}: {
  signing: Exclude<SigningClassification, { kind: 'ok' }>;
  picked: ObjectId | null;
  onPick: (field: CandidateField) => void;
}) {
  const eligible = signing.kind === 'fill-only' ? signing.fields : [];
  if (eligible.length === 0 && signing.ineligible.length === 0) return null;
  return (
    <div className="rounded-lg bg-white/5 px-3 py-2 text-xs" data-testid="field-list">
      {signing.kind === 'fill-only' && <p className="mb-2 text-amber-200">{FILL_ONLY_NOTICE}</p>}
      <ul className="flex flex-col gap-1">
        {eligible.map((f) => {
          const isPicked = sameField(picked, f.ref);
          return (
            <li key={`${f.ref.objectNumber}-${f.ref.generationNumber}`}>
              <button
                type="button"
                data-testid="field-option"
                aria-pressed={isPicked}
                onClick={() => onPick(f)}
                className={`w-full rounded px-2 py-1 text-left ${
                  isPicked ? 'bg-blue-500/30 text-white' : 'bg-white/10 hover:bg-white/15'
                }`}
              >
                {fieldLabel(f)}
              </button>
            </li>
          );
        })}
        {signing.ineligible.map((f, i) => (
          <li key={`ineligible-${i}`} data-testid="field-ineligible" className="px-2 text-white/40">
            {fieldLabel(f)}. {f.reason ? FIELD_REASON_TEXT[f.reason] : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
