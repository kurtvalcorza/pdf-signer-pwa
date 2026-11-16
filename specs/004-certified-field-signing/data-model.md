# Data Model: Certified-Field Signing (004)

Nothing here is stored. Every entity lives in memory for one open document.

## SigningClassification

The result of classifying an opened PDF. Exactly one of:

| Kind | Fields | Meaning |
| :-- | :-- | :-- |
| `ok` | none | Not certified and no blocking policy. Free placement, as today. |
| `fill-only` | `fields: CandidateField[]` (eligible, in `/Fields` order, at least 1), `ineligible: CandidateField[]` | Certified at P=2 or P=3 with at least one eligible empty field. Free placement is not offered. |
| `blocked` | `reason: BlockReason`, `message: string`, `ineligible: CandidateField[]` (may be empty) | Not signable here. |

Rules:

- A document with a certification is never `ok`.
- `fill-only` requires every document-level check to pass (R1, R4, R7–R10, R18, node cap) and at
  least one field to pass every field-level rule.
- Any thrown error during classification yields `blocked` with reason `unreadable-policy`.

## BlockReason (document level)

| Value | RFC row | Message source |
| :-- | :-- | :-- |
| `certified-no-changes` | R1 | existing CERTIFIED_NO_CHANGES |
| `certified-no-empty-field` | R2 | new; includes the "ask the sender" sentence (FR-018) |
| `certified-no-eligible-field` | R3 | new; the picker lists `ineligible` |
| `field-locked` | R4 | existing FIELD_LOCKED |
| `unknown-policy` | R7, R8 | existing UNKNOWN_POLICY |
| `form-not-fillable` | R9 | new (`/SigFlags` not 3, or `/NeedAppearances true`) |
| `xfa-form` | R10 | new |
| `changed-after-certification` | R18 | new |
| `too-many-fields` | T10 | new (above 2,000 form nodes) |
| `too-many-revisions` | FR-009 | new (above the cap, 8, C2) |
| `unreadable-policy` | fail-closed | existing "could not be read" message |

R11 (free placement on a certified document) is not a classification value: it is the signing
step refusing a drawn-box request when the classification is not `ok`.

## CandidateField

An empty signature field found by walking `/AcroForm /Fields`.

| Field | Type | Notes |
| :-- | :-- | :-- |
| `ref` | object number and generation | Identity; what `signIntoField` is given |
| `name` | string | Fully qualified `/T`, shown as "field name set by the document" |
| `pageIndex` | number or null | null when rule 4 could not resolve a single page |
| `rect` | `[x1, y1, x2, y2]` in PDF points, or null | The box the stamp is fitted into |
| `eligible` | boolean | |
| `reason` | FieldIneligibleReason, absent when eligible | Exactly one: the first rule that failed, in rule order |

## FieldIneligibleReason (field level)

| Value | Rule | RFC row |
| :-- | :-- | :-- |
| `inherited-value` | 2 | R14 |
| `shared-parent` | 2 | R14 |
| `separate-widget` | 3 | R12 |
| `page-mismatch` | 4 | R3 (T2) |
| `on-several-pages` | 4 | R15 |
| `not-visible` | 5 (Hidden, NoView, zero or off-page `/Rect`) | R3 (T4) |
| `optional-content` | 5 | R16 |
| `rotated-widget` | research R6 (`/MK /R` not 0) | R3 |
| `read-only` | 5a | R16 |
| `bad-name` | 5b | R13 |
| `added-after-certification` | 5c | R17 |
| `locked` | 6 (`/Lock`) | R5 |
| `seed-values` | 6 (`/SV`) | R6 |
| `shared-appearance` | 8 | R3 |

Rule 7 (FieldMDP anywhere) and rule 5d are document-level and appear as BlockReason, not here.

## SignedRevision

The document as it stood at the end of one signature's byte range.

| Field | Type | Notes |
| :-- | :-- | :-- |
| `end` | number | `b + c` of `/ByteRange [0 a b c]` |
| `doc` | parsed document | Loaded from `bytes[0 .. end]` with metadata updating off |
| `objects` | map from object id to serialized bytes | Captured immediately after parsing |

Validation:

- Every byte range starts at 0, has `a < b`, `end ≤ file length`, and a `<…>` gap.
- Ends are distinct. The smallest belongs to the certification signature. The largest equals the
  file length.
- At most `MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION` (8, C2) revisions follow the first.

Transition between consecutive revisions (rule 5d): the set of pre-existing objects that differ is
exactly one field that was empty, was present in the first revision, now holds a new signature
whose range ends at this revision, and differs only in the fill keys
`/AP /AS /V /F /DA /Q /Ff /Type`. The trailer's `/Info` dictionary may also
differ (C1); an XMP `/Metadata` stream may not.

## FieldPlacementInput

What the UI hands to `signIntoField` instead of a drawn box.

| Field | Type | Notes |
| :-- | :-- | :-- |
| `imageBytes` | bytes | as `PlacementInput` |
| `format` | `'png' \| 'jpeg'` | as `PlacementInput` |
| `fieldRef` | object number and generation | Must match an eligible `CandidateField` when re-classified at signing time |

No position or size: they come from the field (D6).
