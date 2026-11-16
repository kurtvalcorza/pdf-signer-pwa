/**
 * Pure helpers for `android-gate.mjs --certified-field` (spec 004 T040,
 * contracts/signature-gate.md). No adb, no device: kept apart from the gate so the unit tests can
 * import them (tests/unit/androidGateCertified.test.ts) and pin the on-screen strings to the
 * shared app's own (src/components/FieldPicker.tsx).
 */

/** The policy fixture the mode signs: certified at DocMDP P=2, one empty field "Approver". */
export const CERTIFIED_FIELD_FIXTURE = 'certified-p2-empty-field.pdf';
export const CERTIFIED_FIELD_NAME = 'Approver';
export const CERTIFIED_FIELD_PAGE = 1;
/** The validator mode the saved file must pass (contracts/signature-gate.md). */
export const CERTIFICATION_LEVEL = 'FORM_FILLING';

/** FR-017: the shared app's notice for a fill-only document. */
export const FILL_ONLY_NOTICE =
  'This PDF is certified. It can only be signed in one of the signature fields its author prepared.';

/** The shared app's label for an eligible field (FieldPicker `fieldLabel`), page 1-based. */
export const fieldOptionText = (name, page) =>
  `Field name set by the document: "${name}" (page ${page})`;

/** FR-019: what the app says after signing in a field. */
export const fieldSignedText = (name) =>
  `Signed in the existing field '${name}'. No other part of the document was changed.`;

/** FR-019: wording the app must never show about the certification. */
export const CERTIFICATION_CLAIM = /still certified|certification preserved|remains valid/i;

/** A regex matching exactly `s` (the accessibility tree carries the visible text verbatim). */
export const exactText = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/**
 * Checks the saved file against its input without a validator: the input bytes are a strict
 * prefix of the output (no existing byte rewritten), and the output carries `signatures`
 * /ByteRange entries. Returns null when both hold, else what is wrong.
 */
export function appendOnlyProblem(input, output, signatures) {
  if (output.length <= input.length)
    return `the output (${output.length} bytes) is not longer than the input (${input.length} bytes)`;
  if (!output.subarray(0, input.length).equals(input))
    return 'the input is not a byte prefix of the output: existing bytes were rewritten';
  const found = (output.toString('latin1').match(/\/ByteRange/g) ?? []).length;
  if (found !== signatures)
    return `the output has ${found} /ByteRange entries, expected ${signatures}`;
  return null;
}
