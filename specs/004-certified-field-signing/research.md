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

Superseded by T035 (2026-11-17): `scripts/make_policy_fixtures.py` now waits 1.1 s before the two
two-field fills, and both two-field `signed-once` fixtures were regenerated, so their `/ModDate`
moves and they exercise the C1 accept path. The tests in `tests/signing/policy.test.ts` assert that
`/Info` really changed, so a same-second regeneration would fail rather than pass by accident. The
generator certifies again with a fresh key on each run, so `certified-p2-two-empty-fields-signed-once.pdf`
is no longer a byte extension of the committed `certified-p2-two-empty-fields.pdf`. No test relies
on that.

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

**T041 measurement (2026-11-18) [run].** Two generated documents at the limits of
`src/lib/limits.ts`, each certified at P=2 with nine empty fields and then filled eight times by
pyHanko, so that eight signed revisions follow the certification (the C2 cap) and one field is
left: the app classifies both `fill-only` after walking all eight revisions. *one-stream*: one
page and one uncompressed random stream, 104,186,441 bytes (99.4 MB). *many-pages*: 5,000 pages
(the page limit) with a ~20 KB content stream each, 103,688,021 bytes (98.9 MB), about 10,000
indirect objects. Generated at bench time, not committed. Windows 11, one developer laptop.

| Shape | Node 26, `classifySigning` alone (5 runs) | Node 26, whole `loadPdf` | Production web build in Chromium, file chosen to certified notice shown |
| :-- | :-- | :-- | :-- |
| one-stream | median 4.5 s, max 4.7 s | median 4.4 s, max 5.2 s | 6.4, 7.8, 12.0 s (3 runs); 16.4 s at 4x CPU throttle |
| many-pages | median 13.1 s, max 15.9 s | median 13.0 s, max 15.6 s | 22.0, 31.5, 35.1 s (3 runs); 48.0 s at 4x CPU throttle |

The parse itself is small (30 ms and 0.6–1.0 s): the cost is the eight extra revision loads and
the object-by-object comparison, and it grows with object count more than with bytes. In the
browser the runs slow down one after another on the same page (memory pressure is
**[inferred]**), and the classification runs on the main thread, so the page does not respond for
that long. The worst throttled figure is below the 60 s `loadMs` budget, which bounds the pdf.js
load, not this check. The cap stays at 8; whether these times are acceptable, or whether the cap
should be lowered or the check moved off the main thread, is the owner's call (T041 records it
for that decision; nothing in `src/` changed).

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
- **F6 — closed by R10 (it was wider than first recorded).** Originally: deletions through the cross-reference table are invisible to pdf-lib. pdf-lib
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
  never offered. Superseded by T029 (2026-11-17): such a value now refuses the whole certified
  document as `unreadable-policy`, even when its other fields are eligible.

## R10 — Review round: rule 5d through the cross-reference data (2026-11-16)

**Finding (P1, reproduced by the reviewer and by the orchestrator).** Rule 5d compared pdf-lib's
file-order object graph and never read the cross-reference data. A conforming reader does the
opposite: it starts at the last `startxref`, and an object is whatever the xref says it is. So a
change expressed only through the xref was invisible: an object marked free, a second definition
the xref points at while pdf-lib keeps the last one, a new generation of an old number, a
trailer the reader never reaches. On such files the certification still verified and pyHanko
reported its policy as violated, while the app offered the remaining field and signed. That is
not Assumption 2's residual risk; it is what FR-008 exists to refuse.

**Fix.** `src/features/signing/xrefSections.ts`, called for every signed revision after the
certification (`analyzeRevisions`) and for the app's own output (`checkFill`, FR-015). It reads
the one section a reader reaches from the revision's final `startxref` and requires that view
and pdf-lib's to describe the same objects:

- exactly one `startxref` in the revision; one classic table with its trailer, or one
  cross-reference stream; `/Prev` equal to the previous revision's `startxref`; no `/XRefStm`;
  no `/Encrypt`; the reached trailer's `/Root` and `/Info` are the ones pdf-lib took;
- the only free entry is object 0; no number listed twice;
- every in-use entry points, inside the revision, at an `N G obj` header with its number and
  generation, and the object parsed there is byte for byte the one the comparison used;
- an entry for a number that already existed (any generation; object-stream and xref-stream
  containers count) is allowed only for the filled field, and for `/Info` under C1;
- the `N G obj` headers in the revision's bytes are exactly the in-use entries, once each.

The certified revision's own sections are not checked entry by entry (they are what the
certifier signed), but its final `startxref` must be readable and its reached trailer must be the
one pdf-lib took.

**Decisions made while building it (fail closed).**

- *Hybrid sections* (`/XRefStm`) after certification are refused.
- *Objects inside object streams* (xref entries of type 2) after certification are refused. No
  signing tool this project can run writes a fill that way (pyHanko writes plain objects, with a
  table or with an xref stream), so an acceptance could not be tested. **Open for the owner:**
  another producer's fill of an xref-stream document may use object streams and would be refused
  with "changed after it was certified in a way this app cannot check". Supporting it needs a
  fixture from such a producer.
- *A pre-existing object re-emitted unchanged* is refused, although pyHanko accepts it
  (`certified-p2-xref-rewritten-object.pdf` validates at FORM_FILLING). The app is stricter than
  the validator here on purpose: object by object nothing differs, so the xref is the only place
  the rewrite shows, and the rule is "only the field".
- A header-looking byte run inside stream data makes a section look inconsistent and refuses.
- The table parser is strict (20-byte entries). A real-world fill with a sloppier table is
  refused, not guessed at.

**Evidence [run].**

| File | pyHanko (`validate_pdf.py`, default) | App |
| :-- | :-- | :-- |
| `certified-p2-xref-duplicate-object.pdf` | exit 1, certification policy violated | blocked, `xref-sections:2` |
| `certified-p2-xref-free-entry.pdf` | exit 1, policy violated | blocked, `xref-sections:2` |
| `certified-p2-xref-double-trailer.pdf` | exit 1, policy violated | blocked, `xref-sections:2` |
| `certified-p2-xref-generation-bump.pdf` | exit 1, strict read error (orphaned generation) | blocked, `xref-sections:2` |
| `certified-p2-xref-hybrid.pdf` | exit 1, strict read error | blocked, `xref-sections:2` |
| `certified-p2-xref-rewritten-object.pdf` | exit 0, FORM_FILLING | blocked, `xref-preexisting-object:3` |

The first five are a hand-written section followed by pyHanko's fill, so their signatures are
intact; that makes two sections in one signed revision, and they all stop at the same guard. A
single hand-written section cannot be given a valid signature without a signing tool that
writes it, so the per-entry guards are exercised by `tests/unit/xrefSections.test.ts`, which
appends one section to a certified fixture and asserts each refusal by name (free entry,
duplicate definition, definition mismatch, unlisted definition, generation bump, unchanged
rewrite, wrong offset, `/Prev`, hybrid, `/Encrypt`, trailer mismatch, extra trailer, type 2
entry, an xref stream taking an existing number, and the malformed-table and malformed-stream
cases).

**Assumption 1 on the input side (P2).** The gate now runs the validator on every fixture the
app classifies `fill-only` (7 inputs) and fails on a mismatch. The app-is-stricter direction
(rewritten-object above) is allowed; the other direction is what the gate forbids.

**Guard tests and mutation check (P2).** Every `compareRevisions` reason, the four reachable
`checkFill` reasons and the per-field reasons `shared-parent` and `shared-appearance` now have a
test that asserts the exact reason. A quick mutation run replaced each guard's `return` with a
no-op, one at a time, and ran the unit and signing tests: 120 guards in `revisions.ts`,
`xrefSections.ts`, `signingPolicy.ts` and `checkFill`; 102 produced a failing test, 18 did not.
The 18 (the grouping below is from reading the code, not from a further run):

- *Shadowed by a later guard with the same result* (11): three table-format checks and four
  xref-stream format checks in `readSection` (a later format check refuses the same input with
  the same reason); `xref-offset` for an offset outside the revision (the header check after it
  refuses); the R8 consistency check and the 2,000-node cap in `classifySigning` (the revision
  analysis repeats both); `/MK` that is not a dictionary (the next line refuses).
- *Redundant by construction* (4; corrected in R11: the first two were NOT redundant at this
  point, they were untested, because the header scan could not see a header glued to `endobj`):
  `xref-unlisted-object` and the final `xref-offset` sweep; `field-set-changed` in `checkFill` (the form is a
  pre-existing object, so the object comparison refuses first); `added-after-certification`
  (a late field always arrives in a revision rule 5d refuses first, see R9).
- *Catch-all handlers* (3): the `catch` blocks that turn a thrown error
  into a refusal.

Line-level list: scratchpad `new/survivors-*.json` of the build session; not committed.

**Gates after the round [run].** lint 0, tsc 0, vitest 0 (366 passed in 20 files),
`npm run verify:signatures` 0, `npm run e2e` 0 (21 passed).

## R11 — Second review round: what two readers can disagree on (2026-11-16)

**Finding (P1, reproduced by the reviewer and by the orchestrator).** The R10 check compared two
views that are both pdf-lib's: the document parse and `PDFObjectParser` each keep the LAST value
of a repeated dictionary key. ISO 32000-1 7.3.7 leaves that value undefined, and other readers
keep the first. Three single-section, validly signed fill revisions were classified fill-only
while the validator refused to read them: `/Root` twice in the reached trailer (a first-wins
reader opens a different document), `/Prev` twice (it skips the certified section), `/Rect`
twice in the field (the widget covers the page). Two more gaps had the same effect: a trailer
`/Size` that makes a reader ignore objects (P2), and a cross-reference stream with
`/DecodeParms`, which pdf-lib inflates without applying the predictor (P2).

**Fix, all in `src/features/signing/xrefSections.ts`.**

- *Repeated keys (S1).* `makeStrict` gives a pdf-lib object parser a `parseDict` that throws on
  a key it has already seen, at any depth; `PDFName` is interned after `#xx` decoding, so
  `/#52ect` and `/Rect` collide. It is used for the reached trailer and every listed definition
  of every later revision, and `findRepeatedKeys` runs it over every object of a certified file,
  objects inside object streams included. That is how the objects a decision reads in the
  certified revision (catalog, `/Perms`, form, fields, widgets, pages) are covered: all objects
  are checked, not a chosen few. Inside the certified bytes a repeated key reports
  `unreadable-policy`; after them, `changed-after-certification`. An object stream that cannot
  be read strictly is refused, because what it holds was never checked.
- *`/Size` (S2).* Must be an integer equal to the section's highest listed object number plus
  one (pyHanko's strict rule), and not below the previous revision's.
- *Cross-reference stream filters (S3).* `/DecodeParms`, or any `/Filter` other than a plain
  `/FlateDecode` name, is refused in a later revision. Predictors are not implemented.
- *Glued headers (S4).* The header scan now tries every digit run, so `endobj3 0 obj` is seen.
  An unlisted object stream or cross-reference stream therefore fails `xref-unlisted-definition`.
- *Number ranges (S5).* Object numbers above 8388607 and generations above 65535 are refused.

**Fixtures: one hand-written fill revision, signed again.** `make_policy_fixtures.py` now
rebuilds pyHanko's fill of `Approver` as a single cross-reference section, changes one thing and
signs it (SHA-256 over the new byte range, CMS from the fixture signer), so every signature in
these files verifies. This is the shape R10 said could not be produced.

| Fixture (`certified-p2-signed-xref-…`) | Validator (default mode) [run] | App [run] |
| :-- | :-- | :-- |
| `control.pdf` (classic table) | exit 0 | fill-only, `Witness` |
| `control-xref-stream.pdf` | exit 0 | fill-only, `Witness` |
| `repeated-key-field.pdf` | exit 1, "Multiple definitions in dictionary … /Rect" | blocked, `repeated-key:6` |
| `repeated-key-root.pdf` | exit 1, same for `/Root` | blocked, `repeated-key` |
| `repeated-key-prev.pdf` | exit 1, same for `/Prev` | blocked, `repeated-key` |
| `size-low.pdf` (`/Size 3`) | exit 1, "Xref table size mismatch" | blocked, `xref-size` |
| `size-short.pdf` (one short) | exit 1, size mismatch | blocked, `xref-size` |
| `decode-parms.pdf` | exit 1 (reader error) | blocked, `xref-stream-filter` |
| `glued-definitions.pdf` | **exit 0** | blocked, `xref-unlisted-definition:3` |

`glued-definitions.pdf` is the one case where the validator passes and the app refuses: the
glued definitions are unlisted, so no reader that follows the xref reaches them. The app refuses
because pdf-lib does read them, and the two views then differ. The gate cannot list it as a
validator failure; the classification test pins the app's refusal.

**Rulings recorded (orchestrator, following the reviewer).**

- *Object streams after certification stay refused* (xref entries of type 2). A fill by a
  producer that compresses objects is refused until a real fixture exists.
- *A pre-existing object re-emitted unchanged stays refused*, although pyHanko accepts it.
- *The certified revision's own cross-reference entries are not checked.* A file-order versus
  xref disagreement inside the bytes the certifier signed is accepted as residual risk (threat
  T8): the app reads those bytes as pdf-lib does, the certification covers them either way, and
  repeated keys in them are refused by `findRepeatedKeys`. What is not caught is a certified
  revision that itself holds two definitions of one object.

**Known over-refusals (S7; all fail closed, none fixed).**

1. A certified revision that is a linearized full save: its final `startxref` names the
   first-page section, whose trailer is not followed by that `startxref`, so the document is
   `unreadable-policy` even with no fill after it.
2. Any byte after the last signature's range, a trailing newline or comment included, is a
   change after certification.
3. The words `trailer` or `startxref` anywhere in a later revision's bytes (a `/Reason` or
   `/Name` string, appearance text) refuse an honest fill.
4. A fill trailer that omits `/Info` while an earlier one had it, because pdf-lib inherits the
   earlier value and a reader does not.
5. A later revision whose cross-reference stream uses a predictor (qpdf, Acrobat and most
   writers other than pyHanko), or whose objects sit in an object stream.
6. A fill whose `/Size` is larger than its highest object number plus one, and a table whose
   rows are not exactly 20 bytes.
7. A header-looking byte run (`12 0 obj`) inside a string or stream of a later revision.

**Guard tests (S6).** Added: a subsection header and its first row on one line; an unlisted
object glued to `endobj`; a listed one (accepted, both views agree); an altered copy plus the
original, both glued. A mutation rerun over `xrefSections.ts` with the current tests: 55 guards,
44 produce a failing test, 11 do not. The 11, grouped by reading the code: two table-format and
four stream-format checks that a later format check repeats with the same reason; the two
`xref-number-range` checks, each of which the other repeats; `xref-offset` for an offset outside
the revision (the header check after it refuses); and the final `xref-offset` sweep and
`xref-unlisted-object`, which the header scan, now complete, shadows.

**Gates after the round [run]** on `6e2f83c` (rebased onto `origin/main` `47b26e8`): lint 0,
tsc 0, vitest 0 (401 passed in 20 files), `npm run verify:signatures` 0 (9 fill-only
inputs validated, 8 fixtures that must not validate), `npm run e2e` 0 (21 passed).
