# Contract: signing classification and field signing

Internal contract between the signing engine (`src/features/signing/`) and its callers
(`loadPdf.ts`, `App.tsx`, the tests). Entity definitions are in [../data-model.md](../data-model.md).

## `classifySigning(doc, bytes) → Promise<SigningClassification>`

Replaces `signingPolicyBlock(doc): string | null`.

- Never throws. Anything it cannot classify returns `blocked` (`unreadable-policy`).
- Pure: it does not modify `doc` or `bytes`.
- Deterministic for given bytes.
- Order of checks: field-lock and unknown policy (R4, R7) → certification consistency (R8) → P=1
  (R1) → not certified ⇒ `ok` → form checks (R9, R10) → node cap → revisions (R18, FR-009) →
  candidate fields (rules 1–8, 5a–5c) → `fill-only` if any is eligible, else R2 or R3.
- For an uncertified document the result and its cost are the same as before this feature (no
  extra parse).

## `LoadedPdf.signing`

Replaces `LoadedPdf.signingBlock: string | null`. The UI derives:

| Classification | Free placement | Field picker | Sign enabled when |
| :-- | :-- | :-- | :-- |
| `ok` | yes | no | a placement exists (today's rule) |
| `fill-only` | no | yes | a field is picked and an image is set |
| `blocked` | no | list of `ineligible` only, when non-empty | never |

## `signIncremental(signedPdf, placement, cert, opts)`

Unchanged signature. It re-classifies and throws `CertificationLockedError` unless the result is
`ok` (FR-002, R11).

## `signIntoField(signedPdf, placement: FieldPlacementInput, cert, opts) → Promise<Uint8Array>`

- Re-classifies; throws `CertificationLockedError` unless the result is `fill-only` and
  `placement.fieldRef` is one of its eligible fields.
- Output: `signedPdf` byte-for-byte, followed by one incremental update containing only the
  appearance resources, one appearance stream, one signature dictionary and a new version of the
  field (FR-014).
- Before returning, compares input and output object by object and throws (no output) unless
  exactly the picked field differs, and only in fill keys (FR-015).
- Same password, certificate and appearance options as `signIncremental`.

## Copy (exact)

| Where | Text |
| :-- | :-- |
| Fill-only notice (FR-017) | This PDF is certified. It can only be signed in one of the signature fields its author prepared. |
| Field label | Field name set by the document: "<name>" (page <n>) |
| No empty field (FR-018) | This PDF is certified and has no empty signature field to sign. Ask the sender for a version that includes a signature field for you. |
| No eligible field (R3) | This PDF is certified, and none of its empty signature fields can be signed here. The reasons are listed below. |
| Changed after certification (R18) | This PDF was changed after it was certified in a way this app cannot check, so it cannot be signed here. |
| Form not fillable (R9) | This certified PDF's form is not set up the way a signed form must be, so it cannot be signed here. |
| XFA (R10) | This certified PDF uses an XFA form, which this app cannot sign. |
| Success (FR-019) | Signed in the existing field '<name>'. No other part of the document was changed. |

Per-field reasons are one short sentence each, keyed by `FieldIneligibleReason`; their wording is
set in T024 and reviewed with the UI.

The words "valid", "still certified" and "certification preserved" MUST NOT appear in any message
this feature adds (Principle IV).
