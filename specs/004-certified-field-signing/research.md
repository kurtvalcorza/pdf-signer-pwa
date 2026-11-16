# Research: Certified-Field Signing (004)

Evidence labels: **[run]** executed in this worktree on 2026-11-16 at `a6f4eef` plus the spike
commit; **[read]** read in source; **[inferred]** not yet run.

The design questions D1–D10 are settled in
[docs/rfc-23-1-certified-empty-field.md](../../docs/rfc-23-1-certified-empty-field.md). This file
covers what the RFC left to implementation.

## Baseline (before any change)

**[run]** on `a6f4eef`, Windows, Node from the repo lockfile, Python 3.12.10, pyHanko 0.36.2:

| Gate | Command | Exit | Result |
| :-- | :-- | :-- | :-- |
| Lint | `npm run lint` | 0 | clean |
| Types | `npx tsc --noEmit` | 0 | clean |
| Unit | `npx vitest run` | 0 | 160 passed, 16 files |
| Signature gate | `npm run verify:signatures` | 0 | passed |

## R1 — Spike: a signature's byte-range prefix loads as its own revision

**Question.** pdf-lib exposes only the final, merged object graph. Rule 5c needs "the field existed
when the document was certified" and rule 5d needs "every later revision is one signature fill".
Does loading `bytes[0 .. b+c]`, from a signature's `/ByteRange [0 a b c]`, as a document of its own
give both rules what they need?

**Decision: yes. Build `src/features/signing/revisions.ts` on it.** The prototype is
`tests/signing/revisionSpike.test.ts` (test-only, deleted when the real module lands).

**Why it works.** **[read]** pdf-lib 1.17.1 does not follow the cross-reference table. Its parser
(`node_modules/pdf-lib/cjs/core/parser/PDFParser.js`, `parseDocument` → `parseDocumentSection` in a
`while (!this.bytes.done())` loop) reads every object in file order and `context.assign`s it, so a
later definition replaces an earlier one. A byte prefix that ends at a revision boundary is
therefore a complete document to it, classic xref table or xref stream alike.

**Method the prototype uses.**

1. Load the whole file. Collect every signed `/Sig` field's `/ByteRange`; require `[0 a b c]` with
   `a < b`, `b + c ≤ length`, and the gap `[a, b)` to be a `<…>` hex string.
2. Sort the ends `b + c`. Require them distinct, the smallest to belong to the signature that
   `/Perms /DocMDP` names, and the largest to equal the file length.
3. Load each prefix with `updateMetadata: false`, and serialize every indirect object
   (`context.enumerateIndirectObjects()`, `copyBytesInto`) before anything walks the page tree.
4. **5c**: the target field's reference resolves in the first prefix to a `/FT /Sig` dictionary
   with the same `/T`, and a page of that prefix lists it in `/Annots`.
5. **5d**: for each consecutive pair of prefixes, the set of pre-existing objects whose serialized
   form differs must be exactly one object; it must be a `/Sig` field that had no `/V`, was in the
   first prefix's field list, now has a `/V` whose byte range ends at this prefix's end and whose
   object is new, and differs only in `/AP /AS /V /F /DA /Q /Ff /Type` (pyHanko's
   `VALUE_UPDATE_KEYS`).

**Result [run]: 14 of 14 spike tests pass** (`npx vitest run tests/signing/revisionSpike.test.ts`,
exit 0). Fixtures are pyHanko's, written by `scripts/make_policy_fixtures.py`:

| Fixture | Signature ends / file length | Spike verdict | pyHanko (`validate_pdf.py`) |
| :-- | :-- | :-- | :-- |
| `certified-p2-empty-field.pdf` | 8064 / 8064 | 5c true for `Approver`; no later revision | valid |
| `certified-p3-empty-field.pdf` | 8064 / 8064 | same | valid (P=3 warning logged) |
| `certified-p2-empty-field-xref-stream.pdf` | 7986 / 7986 | same, through an xref stream | valid |
| `certified-p2-two-empty-fields.pdf` | 8388 / 8388 | 5c true for both fields | valid |
| `certified-p2-two-empty-fields-signed-once.pdf` | 8388, 14930 / 14930 | one fill (`Approver`); `Witness` 5c true; 14 → 17 objects | valid; certification at FORM_FILLING |
| `…-signed-once-xref-stream.pdf` | 8277, 14829 / 14829 | same | valid; FORM_FILLING |
| `certified-p2-empty-field-signed-once.pdf` | 8064, 14603 / 14603 | strict: refused, 2 objects changed (field `6 0` and `/Info` `8 0`); tolerating `/Info`: one fill | valid; FORM_FILLING |
| `certified-p2-late-visible-field.pdf` | 7646 / 8485 | 5c false for `Late`; unsigned revision after last signature | policy violation |
| `certified-p2-later-annotation.pdf` | 8064 / 8653 | unsigned revision after last signature | policy violation |
| `certified-p3-later-annotation.pdf` | 8064 / 8653 | unsigned revision after last signature | policy violation |
| `certified-p3-annotation-then-fill.pdf` | 8388, 15529 / 15529 | refused: 3 objects changed (`4 0`, `6 0`, `10 0`) | policy violation |
| `certified-p2-two-revisions.pdf` (existing) | 7646, 14415 / 14415 | refused: 3 objects changed (`4 0`, `5 0`, `7 0`) | policy violation |

Every spike refusal is a pyHanko violation and every spike acceptance is a pyHanko pass, with one
exception discussed next.

### Finding F1 — pyHanko's own fill rewrites `/Info` (owner decision, FR-008)

**[run]** pyHanko's fill of an existing field writes a new version of the trailer's `/Info`
dictionary (new `/ModDate`, `/Producer`) in the same revision. pyHanko's validator accepts that
(the three `signed-once` fixtures validate at FORM_FILLING). The RFC's rule 5d lists "metadata
updates" among the things that refuse. So, read strictly, 5d refuses a certified document whose
first field was filled by pyHanko.

The two-field fixtures pass the strict rule only by accident: their certification and fill were
written within the same second, so `/ModDate` did not move and the rewritten `/Info` serializes
identically. The single-field fixture straddled a second and shows the real behaviour.

The app's own writer does not touch `/Info` (it carries the reference forward,
`incrementalUpdate.ts` `previousTrailerEntries`), so app → app chains are unaffected either way.
What other producers do (Acrobat is likely to update `/Info` and the XMP `/Metadata` stream) is
**[inferred]** and has no fixture.

This is FR-008's open question. The plan implements the comparison with a single allow-list of
"objects a fill may also rewrite"; the decision sets its contents (empty, or the trailer `/Info`
object when it stays a dictionary of direct, non-reference values).

### Finding F2 — the comparison is stronger than the RFC's sketch, and should stay so

The design note proposed comparing "field set equal, every page `/Annots` equal, one field gained
`/V`". That misses a page-content or catalog change slipped into the same signed range. Comparing
**every** pre-existing indirect object catches it at no extra parse cost, and gives a short
argument for soundness: all direct objects live inside some indirect object, so if only the field
object differs, everything reachable from the catalog is unchanged except through the field's own
keys, of which only the fill keys may differ.

### Finding F3 — cost and bounds (FR-009)

The check parses the file once per signed revision (certification included) on top of today's
single parse. On these 8–15 KB fixtures the whole 14-test file runs in about 80 ms **[run]**. For
files near the size limit the cost is linear in size times revisions **[inferred]**, so the number
of signed revisions after certification needs a cap. The value is FR-009's open question; T041
measures the largest allowed file at the chosen cap before it is fixed.

### Finding F4 — things the real module must add that the spike skipped

- Walk `/Kids` with the existing cycle guard and the 2,000-node cap; the spike reads root-level
  fields only.
- Fail closed on every thrown error (the spike throws on a malformed `/ByteRange`).
- Use `updateMetadata: false` for every load that feeds a comparison. `signIncremental.ts:50`
  loads its probe with the default, which rewrites `/Info` in memory; harmless for appending, but
  it would poison a before/after comparison.
- Parser-differential note (T8): because pdf-lib reads objects in file order, an object that is
  present in the bytes but unreachable through the xref still counts for it. That is already true
  of the whole app. The gate compares pyHanko's field enumeration with pdf-lib's on every fixture
  (T042).

### Residual risk accepted

The byte ranges come from the document, and the app verifies no signature. A lying range can only
make the certified revision look larger or smaller than what was actually digested, and in both
cases the certification no longer verifies in any validator. The app then signs a document whose
certification was already broken, which Assumption 2 of the spec and FR-019's wording cover.

**Alternatives considered.** (a) A byte-level revision parser of our own (xref walking): more code,
a second parser to keep in step with pdf-lib, no gain. (b) The narrow rule "refuse anything after
certification": rejected by the owner on 2026-11-16. (c) Comparing only fields and `/Annots`:
weaker, see F2.

## R2 — Fixtures: add, never rewrite

**Decision.** `make_policy_fixtures.py` writes only files that are missing; `--force` regenerates
all. **Why**: the signing key is created per run, so a plain re-run would change the bytes of all
10 committed fixtures for no reason (SC-007). **[run]** the 10 existing fixtures reported "kept";
`git status` showed only additions.

**Fixture list.** The RFC's §7.1 names 24. This plan adds 32 fixture files:

- 11 exist after the spike. Three of them are additions to the RFC list, each needed by R1:
  `certified-p2-two-empty-fields-signed-once.pdf` and its `-xref-stream` twin (5d positive from a
  foreign writer), and `certified-p3-annotation-then-fill.pdf` (a change hidden inside a later
  signature's range).
- 15 remain from §7.1.
- 4 close a gap: §7.3 requires a fixture per refusal row, but §7.1 has none for R8, R9 or
  R10. Added: `certified-p2-perms-without-reference.pdf` (R8), `certified-p2-sigflags-1.pdf` and
  `certified-p2-need-appearances.pdf` (R9), `certified-p2-xfa.pdf` (R10). The node cap (T10) is
  tested with a document built in the test, not a committed fixture.
- 2 are for geometry (R6): a rotated page and a widget with `/MK /R`.

`certified-p2-no-empty-field.pdf` is the existing `certified-p2.pdf` under the RFC's name; the
tests use the existing file and no copy is committed.

**Note.** pyHanko's `append_signature_field` writes `/SigFlags 1` in the base revision; the
certification revision raises it to 3. The final value is 3 on all 11 **[run]**, which is what R9
reads.

## R3 — Gate: one new expectation in `validate_pdf.py`

**Decision.** Add `--expect-certification-level <NAME>`: in addition to the default checks, the
signature that certifies the document must report `modification_level == <NAME>` (here
`FORM_FILLING`). `verify-signatures.mjs` runs the fill outputs through it, and routes the two
negative controls (forced add-a-field on a certified fixture; fill output plus a further
disallowed revision) to the existing `--expect-policy-violation` list. **Why**: FR-020 needs the
level asserted, not just "policy passed"; the existing three modes cannot express it. A mode in
the validator is checked by exit code, which is what the gate already relies on; parsing printed
lines in a test would be weaker.

## R4 — Types: a classification replaces `string | null`

**Decision.** `signingPolicyBlock` becomes `classifySigning`, returning
`{ kind: 'ok' } | { kind: 'fill-only', fields, ineligible } | { kind: 'blocked', reason }`
([contracts/signing-classification.md](contracts/signing-classification.md)). Consumers **[read]**:
`loadPdf.ts:9,35,40-46`, `signIncremental.ts:61-65`, `App.tsx:59,147-148,162,472`, and
`tests/signing/policy.test.ts` (two references). `LoadedPdf.signingBlock` is replaced by
`LoadedPdf.signing`. The classification needs the bytes as well as the parsed document (R1), so
its signature is `(doc, bytes)` and it is async.

`signIncremental` keeps its drawn-box behaviour and gains a sibling, `signIntoField`, sharing
everything after placement. Both re-classify from the bytes and refuse a mismatch (FR-002): the
drawn-box path requires `ok`, the field path requires `fill-only` with the requested field
eligible.

## R5 — Writer: share the tail, add no object but three

**Decision.** Extract from `addIncrementalPlaceholder` the part that serializes changed and new
objects and writes the xref section and trailer; `fillExistingSignatureField` reuses it and emits
only the appearance resources, the appearance stream, the signature dictionary and a new version
of the field. The field's new version is built from the parsed dictionary by setting `/V` and
`/AP` (and `/F` Print if absent), leaving every other key as parsed.

The post-write check (FR-015) reuses R1's object comparison between input and output: exactly one
pre-existing object differs, it is the picked field, and only fill keys changed.

## R6 — Geometry: the field's `/Rect` drives the existing layout maths

**Decision.** Convert the field's `/Rect` to the normalized box the existing `appearanceLayout`
takes, and fit the image inside it with the aspect ratio preserved (letterboxed, centred). The
BBox is the field's box; the user's box is never used (D6). `/Rotate` handling is the existing
code path. An `/MK /R` rotation on the widget is not honoured: a widget carrying `/MK /R` other
than 0 is refused with a per-field reason **[inferred: no fixture yet; T014 adds one]**, because
drawing upright in a rotated widget would not match the preview.

## R7 — Preview scripting (T9)

**[read]** `src/features/viewer/renderPage.ts:40` calls `pdfjsLib.getDocument({ data })` with no
scripting option, and nothing in `src/` mentions `enableScripting`. That pdf.js runs no document
JavaScript without a scripting sandbox being supplied is **[inferred]**. T030 pins the option
explicitly and adds a test that a fixture with a field action renders without executing it.

## R8 — Per-distribution evidence

Web: `tests/e2e/us7-certified-field.spec.ts`, modelled on `us6-countersign.spec.ts`. Desktop: a
case in `tests/e2e-desktop/desktop-sign.spec.ts`. Android: a `--certified-field` mode in
`scripts/android-gate.mjs`, which already resolves the policy fixture directory. Each validates
its own download with the new validator mode. CI wiring for these lives in `.github/workflows/`,
which a parallel change (issue #23 item 2) is editing; T038 lands after that change merges.

## R9 — Phases 1–3 as built (2026-11-16)

**[run]** on the branch head after T027, Windows, Python 3.12.10, pyHanko 0.36.2:

| Gate | Command | Exit | Result |
| :-- | :-- | :-- | :-- |
| Lint | `npm run lint` | 0 | clean |
| Types | `npx tsc --noEmit` | 0 | clean |
| Unit | `npx vitest run` | 0 | 258 passed, 18 files (baseline 174 in 17: minus the 14 spike tests, plus 98) |
| Signature gate | `npm run verify:signatures` | 0 | 8 default outputs valid; 4 fill outputs valid with the certification at FORM_FILLING; 6 violating fixtures and 2 negative controls reported as policy violations |
| Web E2E | `npm run e2e` | 0 | 21 passed, `us7-certified-field.spec.ts` among them, with the validator run on the download |

Not run in this pass: the PWA and desktop E2E configurations, the Android gate, Acrobat Reader.

### D1: P=3 is supported

**[run]** `fill-certified-p3-empty-field.pdf`, written by the app's own writer, validates with
both signatures intact, policy satisfied, and the certification at
`ModificationLevel.FORM_FILLING`. pyHanko still logs its "not designed for DocMDP level 3"
warning. P=3 therefore stays classified `fill-only`; the fallback of D1 (ship P=3 as refused) is
not needed. The same holds for the xref-stream and the rotated-page fixtures.

### Findings from the build

- **F5 — the comparison also pins the trailer.** The spike compared indirect objects only. A
  later revision could leave every pre-existing object alone and point the trailer's `/Root` at a
  new catalog. `compareRevisions` now also requires the same `/Root` reference in both revisions
  and no `/Encrypt`, and treats `/Info` as C1 decided: the same reference rewritten, or a new
  object, and in both cases a dictionary of direct strings and names only. Anything else refuses.
- **F6 — open: deletions through the cross-reference table are invisible to pdf-lib.** pdf-lib
  reads objects in file order and ignores the xref, so a later revision that marks an object free
  (for example an annotation) changes what Acrobat and pyHanko see but not what the app compares.
  pyHanko reports such a revision as a violation; the app would still offer the field. The result
  is a signature added to a document whose certification was already broken, which Assumption 2
  and FR-019 cover, but rule 5d does not catch it. T042's cross-check does not either. Candidate
  fix: refuse a certified document whose appended sections carry an xref entry of type `f` other
  than object 0. Not built; needs an owner decision on scope.
- **F7 — pyHanko drops `/NeedAppearances` when it signs**, as it raises `/SigFlags` to 3. The R9
  fixtures (`certified-p2-sigflags-1.pdf`, `certified-p2-need-appearances.pdf`) therefore set
  those values in an unsigned revision after the certification. The form checks run before the
  revision check, so each still reports `form-not-fillable`.
- **R17 is not reachable as a per-field reason on any fixture.** A field added after
  certification arrives in a revision that rule 5d refuses first, so
  `certified-p2-late-visible-field.pdf` reports `changed-after-certification`. The per-field rule
  5c is still evaluated (it is what the 5d comparison and `added-after-certification` use) and is
  tested directly in tests/unit/revisions.test.ts.
- **FR-015 runs on the signed bytes**, not on the placeholder: `assertFillWellFormed` re-reads
  the final output, so it also checks that the new signature's byte range ends at the end of the
  file.

### Where the build differs from the plan

- `CandidateField` gained `box` (data-model.md): the UI needs the field's place on the displayed
  page, and computing it next to `rect` keeps the outline and the stamp on one conversion
  (`fieldRectToNormBox`, the exact inverse of `normalizedBoxToPdfRect`).
- The R11 message is no longer today's CERTIFIED text. That text said "this app signs by adding
  [a field]", which stopped being true. The drawn-box path now says a signature cannot be placed
  freely on a certified PDF.
- `tests/signing/out-violations/` is ignored through `tests/signing/.gitignore`, not the root
  `.gitignore`.
- The E2E validator step is skipped with an annotation when pyHanko is not importable, unless
  `REQUIRE_PYHANKO` is set. T038 must set it in CI, or the web E2E proves less there than here.
- A `/V` that is present but is not a signature dictionary makes the field "not empty", so it is
  never offered. Listing it as an ineligible field with its own reason is left to T029.
