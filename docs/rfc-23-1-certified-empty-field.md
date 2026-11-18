# RFC 23-1: Sign a certified PDF through an existing empty signature field

Status: **accepted 2026-11-15, implemented in v0.3.0** (spec 004, `specs/004-certified-field-signing/`; release pending the owner's Acrobat check, T045, and the tag's Android emulator gate, T040). Issue #23, item 1. Owner decisions recorded in
[§8](#8-owner-decisions): D1–D9 option (a), D10 option (a) (all three distributions together). Follows SEC-02 in [audit.md](audit.md).

## Summary

Today `signingPolicyBlock` (`src/features/signing/signingPolicy.ts`) refuses every certified PDF.
The app has one counter-signing path, `addIncrementalPlaceholder`
(`src/features/signing/incrementalUpdate.ts`), and that path always **appends a new signature
field**. pyHanko treats a new visible signature field after a certification signature as a
disallowed change at every DocMDP level. That is why P=2 and P=3 are refused along with P=1.

This RFC proposes a second, narrower path. When the document is certified at P=2 or P=3 and
already holds an **empty signature field** that no lock covers, the app fills that field. It
appends a new signature dictionary and a new appearance stream, and it rewrites only the field's
own dictionary to point at them. Nothing else in the document changes. Every other certified
case stays refused.

Evidence labels used below:

- **[pyHanko]**: read in the pinned validator source, pyHanko 0.36.2
  (`scripts/requirements-verify.in`). The files are
  `pyhanko/sign/diff_analysis/rules/form_field_rules.py`, `.../policies.py`, `.../constants.py`
  and `pyhanko/sign/fields.py`.
- **[ISO]**: ISO 32000-1:2008, cited by clause. The table numbers come from the 2008 edition
  and were **not re-checked against the text in this pass**. Check them against your copy before
  quoting them in a spec.
- **[repo]**: read in this repository at `origin/main` `02ef745`.
- **[inferred]**: reasoning that a fixture in the test plan would confirm. It has not been run.

## 1. Why the current path cannot work, and why this one can

- **[pyHanko]** `SigFieldCreationRule` has the parameter `allow_new_visible_after_certify=False`.
  Its docstring says that creating new visible signature fields after a certification signature
  "is disallowed … by default; this is stricter than Acrobat". The `FormUpdate` for a new visible
  field carries `valid_when_certifying=False`. `StandardDiffPolicy` then raises "only allowed after
  an approval signature, not a certification signature" whenever `doc_mdp` is set. That
  reproduces the SEC-02 result **[repo]** (`tests/signing/policy.test.ts`, fixtures
  `certified-p2.pdf` and `certified-p3.pdf`).
- **[pyHanko]** `SigFieldModificationRule.check_form_field` handles an **existing** `/Sig` field
  that had no `/V` before and has one now (`not previously_signed and now_signed`). It whitelists:
  - the field dictionary's new version, at `LTA_UPDATES`, as long as only the
    `VALUE_UPDATE_KEYS` changed: `/AP /AS /V /F /DA /Q /Ff /Type` (`constants.py`);
  - the new `/AP` streams, at `FORM_FILLING`. This holds only if `/AP /N` (and `/R`, `/D`) point
    at streams created in the new revision (`_allow_appearance_update`). Rewriting an existing
    appearance stream in place is a different case. It is also allowed by default, under a
    separate rule with more conditions (`allow_in_place_appearance_stream_changes=True`,
    `form_field_rules.py:464`; `_allow_in_place_appearance_update`). This design does not rely
    on that rule: it always writes a new stream;
  - the new signature dictionary that `/V` references, at `FORM_FILLING`. It must be an indirect
    reference to an object that did not exist in the old revision. Otherwise the result is
    `SuspiciousModification`.

  None of these updates sets `valid_when_certifying=False`, so a certified document can pass. The
  result is a modification level of `FORM_FILLING`. That level is permitted at P=2 and P=3.

- **[ISO]** 12.8.2.2 (DocMDP, Table 254 `/P`): P=2 permits filling in forms, instantiating page
  templates and signing. P=3 also permits annotation creation, deletion and modification. P=1
  permits no changes. A missing `/P` means 2, which is what `signingPolicyBlock` already assumes:
  an unlabelled DocMDP counts as certified, not as P=1.
- **[pyHanko]** `StandardDiffPolicy` logs a warning that it "was not designed to support DocMDP
  level 3 (MDPPerm.ANNOTATE)". So a P=3 pass must be shown by a fixture, not assumed (decision
  D1).
- **[pyHanko, review probe]** The Fable review's probe (`scratchpad/review-probe/probe.py`,
  in-memory PDFs, pyHanko signing and validating) ran these cases at both P=2 and P=3:

  | Case                                                      | Result                                                        |
  | :-------------------------------------------------------- | :------------------------------------------------------------ |
  | Merged field/widget, filled                               | pass, `docmdp_ok=True` at FORM_FILLING (P=3 logs the warning) |
  | Field with one separate widget kid, filled                | **fail** (`docmdp_ok=False`)                                  |
  | New visible field after certification                     | fail                                                          |
  | Visible field appended after certification, then filled   | fail                                                          |
  | Invisible field appended after certification, then filled | pass                                                          |
  | Fill that rewrites the AcroForm with unchanged content    | pass                                                          |

  This is evidence about **pyHanko's own** writer, not yet about the app's. The per-level fixtures
  in §7 are what prove the app's writer.

## 2. What the incremental update changes

The update is still a byte-level append. The original bytes are never rewritten
([ISO] 7.5.6). It contains exactly these objects:

| #   | Object                                                                                               | New or new version                                 | Notes                                                                                                                                        |
| :-- | :--------------------------------------------------------------------------------------------------- | :------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Appearance resources: the image XObject and the font, if a label is drawn                            | new                                                | Same as today (`incrementalUpdate.ts` step 0).                                                                                               |
| 2   | Appearance form XObject (`/AP /N`)                                                                   | new                                                | It must be a **new** stream ([pyHanko] `_allow_appearance_update`). Its BBox comes from the field's `/Rect`, not from a user-drawn box (§4). |
| 3   | Signature dictionary `/Type /Sig` with `/Filter /SubFilter /ByteRange /Contents /M /Reason`          | new                                                | Same placeholder `@signpdf` fills today. **No `/Reference` array**: this is an approval signature, not a certification.                      |
| 4   | The field: a merged field/widget dictionary only (§3 rule 3)                                         | **new version, same object number and generation** | Adds `/V` (a reference to #3) and replaces `/AP` with `<< /N ref(#2) >>`. It may set `/F` to Print if absent. Nothing else changes.          |
| 5   | xref section and trailer, `/Prev` set to the previous `startxref`, `/Root /Info /ID` carried forward | new                                                | Same as today (step 4).                                                                                                                      |

What the update does **not** change, compared with the current path:

- **No new annotation, and no page `/Annots` rewrite.** The widget is already on its page.
  Step 3 of `addIncrementalPlaceholder` must not run.
- **No AcroForm rewrite and no `/Fields` rewrite.** The field is already listed, so step 2 does
  not need to run. The actual constraint is narrower: **no AcroForm key may change other than
  `/Fields /DR /DA /Q /NeedAppearances`** (`ACROFORM_EXEMPT_STRICT_COMPARISON`, [pyHanko]
  `constants.py`). `/SigFlags` is not on that list. The review probe showed that rewriting the
  AcroForm with unchanged content still passes at P=2 and P=3. A _changed_ `/SigFlags` value is
  expected to fail under the strict comparison **[inferred; not run]**. Not rewriting the AcroForm
  at all is simply the easiest way to meet the constraint. A certifying writer already sets SigFlags 3 ([ISO] 12.7.2,
  Table 219: SignaturesExist and AppendOnly). pyHanko does this when it signs (`fields.py`), and
  the committed `certified-p2.pdf` and `certified-p3.pdf` both contain `/SigFlags 3` **[repo]**.
  So leaving it untouched loses nothing. If the
  document's `/SigFlags` is not 3, refuse; do not fix it (§5, row R9).
- **No catalog rewrite.** `/Perms /DocMDP` stays as it is.
- **No DocMDP or FieldMDP dictionary is added.** The new signature carries no `/Reference`. A
  `/Lock` dictionary on the empty field would require one ([ISO] 12.7.4.5, Table 233; pyHanko
  writes it from `SigFieldSpec.field_mdp_spec`, `fields.py`). This RFC refuses such fields rather
  than honouring them (decision D2).

### Implementation shape

The implementation shape is **[inferred]**; this design does not change any `src/` file.

- Add `fillExistingSignatureField(signedPdf, probe, { fieldRef, appearanceRef })` in
  `incrementalUpdate.ts`. It shares `append`, the xref writer, `previousTrailerEntries` and
  `reserveExistingObjectNumbers` with `addIncrementalPlaceholder`. Extract the shared tail; do not
  copy it.
- Add a `signIntoField` branch in `signIncremental.ts` with its own well-formedness check. The
  field set before and after must be **equal**, not one field larger. The target field must now
  have `/V` set to the new signature dictionary. Every page's `/Annots` must be byte-identical to
  the previous revision.
- Change `signingPolicyBlock` from `string | null` to a classification:
  `{ kind: 'ok' } | { kind: 'fill-only', fields: EligibleField[] } | { kind: 'blocked', reason }`.
  The existing call sites (`loadPdf.ts`, `signIncremental.ts`) then branch on it.

## 3. Finding an eligible empty field

Walk `/AcroForm /Fields` with the cyclic `/Parent`/`/Kids` guard `allSignatureDicts` already uses.
A field is **eligible** only when every one of these holds:

1. `/FT /Sig`, inherited through `/Parent` as [ISO] 12.7.3.1 allows.
2. It has no `/V`, or its `/V` is null, **and no ancestor on its `/Parent` chain carries a `/V`**.
   `/V` is inheritable ([ISO] 12.7.3.1). No other `/Sig` terminal shares its parent, because a
   value inherited by siblings would be ambiguous. A `/V` that is not a dictionary is refused, not
   treated as empty.
3. It is a **merged field/widget dictionary**: `/Subtype /Widget` on the terminal field itself
   ([ISO] 12.7.3.1, 12.5.6.19), with no `/Kids`. **A field whose widget is a separate kid is
   refused, even when it has only one kid.** The review probe shows pyHanko 0.36.2 rejects that
   fill at P=2 and P=3: `docmdp_ok=False`, with "objects … replaced … without precise
   justification" naming the kid widget. The reason is that a kid without `/T` is not a field
   (`form_rules_api.py:289-292`), and `SigFieldModificationRule` whitelists `/AP` only on the field
   dictionary itself. Supporting separate kid widgets would need its own investigation: a custom
   diff policy, or an Acrobat-only evidence bar that the pinned gate cannot provide (D8). Fields
   with two or more widgets are refused anyway (threat T3).
4. The widget's `/P` resolves to a page, that page's `/Annots` contains the widget reference, and
   **no other page's `/Annots` does**. If any of these fails, refuse. A reader would place or
   repeat it differently from what we show (T2, T3).
5. The widget is **visible**. Hidden (bit 2) and NoView (bit 6) must be clear ([ISO] 12.5.3,
   Table 165), and the `/Rect` must have non-zero width and height and intersect the page's
   CropBox. pyHanko's own `is_field_visible` checks only that the `/Rect` area is non-zero
   ([pyHanko]), so the flag and CropBox rules are ours and are stricter. A widget carrying `/OC`
   (optional content, [ISO] 8.11) is refused, because a hidden content group can make it invisible
   in some viewers. Invisible fields are refused (decision D5).
   - **Rule 5a.** The field is not **read-only**: `/Ff` bit 1 is clear, inherited values included ([ISO]
     12.7.3.1, Table 221). A read-only signature field is one the author did not mean anyone to sign.
   - **Rule 5b.** **Names are well formed.** Every node on the path to the field has a `/T`. No partial name
     contains a period, and no two siblings share a partial name. pyHanko's field walk raises
     "Duplicate field name" and "Partial names must not contain periods"
     (`form_rules_api.py:297-300`), so a document the app accepted here would fail the gate. Two
     fields with the same displayed name would also confuse the picker (T1).
   - **Rule 5c.** **The field existed when the document was certified.** Its object, and its widget's page
     `/Annots` entry, must be defined in the bytes the certification signature's `/ByteRange`
     covers. In practice: the revision whose `startxref` lies inside the signed range must already
     resolve the field. The review probe shows that a _visible_ field appended after a P=2 or P=3
     certification and then filled fails `docmdp_ok`. Later revisions are handled by rule 5d and D9.
   - **Rule 5d.** **Every revision after the certification is classifiable.** Each must be a signature fill of a
     field that passed 5c, the same shape this RFC writes. Anything else after certification (new
     annotations, new fields, page changes, DSS or metadata updates) refuses the document. The app
     has no diff analysis of its own, so it cannot tell whether such a revision kept the
     certification intact. This rule covers P=2 documents that already have annotation revisions
     (probably in violation already) and P=3 documents with permitted later annotations, which may
     sit over or beside the field (D9).
6. No `/Lock` and no `/SV` on the field ([ISO] 12.7.4.5, Tables 232–234). A seed-value dictionary
   can require a filter, sub-filter, digest or certificate this app may not meet. This RFC refuses
   rather than half-honouring it (D2).
7. No FieldMDP lock from any existing signature names the field. This RFC goes further and keeps
   today's rule: **any** FieldMDP reference anywhere refuses the document (D4).
8. Its `/AP`, if present, is not an indirect dictionary shared with another annotation
   ([pyHanko] `_allow_appearance_update` rejects shared appearance dictionaries).

**Choosing between several.** List the eligible fields in `/Fields` order. For each, show its
page number, its fully qualified `/T` name and its position on the rendered page. The user picks
one. Nothing is picked for them, including when only one is eligible (D3).

Ineligible empty fields are listed too, greyed out, each with the reason it is ineligible. That way
the user is not left wondering why a field they can see cannot be used.

## 4. How the UI offers it

**[inferred]** UI shape, to be settled in the spec that implements this:

- On load, `loadPdf.ts` gets `fill-only`. Instead of the CERTIFIED refusal, the user sees:
  "This PDF is certified. It can only be signed in one of the signature fields its author
  prepared." This replaces the current "cannot be signed here" message for this case only.
- The placement step is replaced, not extended. Free placement (drawing a box) is **not offered**:
  a new field would break the certification. The eligible fields are outlined on the page preview,
  and selecting one opens the normal stamp and certificate flow.
- The stamp is laid out into the field's `/Rect`, taking the page `/Rotate` into account through
  the same `appearanceLayout` maths. Aspect ratio is preserved, so the stamp may letterbox. The
  user cannot move or resize it (D6).
- After signing, the existing success copy applies. Add one sentence that says only what the app
  did: "Signed in the existing field '<name>'. No other part of the document was changed." Do
  **not** claim that the certification "stays valid". The app runs no diff analysis, and the
  fixtures prove validity only for the shapes they cover. A validator such as Acrobat or pyHanko
  is the authority on that.

## 5. What stays refused

| Row | Case                                                                                         | Detected by                                     | Message class                                                                         |
| :-- | :------------------------------------------------------------------------------------------- | :---------------------------------------------- | :------------------------------------------------------------------------------------ |
| R1  | DocMDP P=1                                                                                   | `/TransformParams /P 1` (today's check)         | CERTIFIED_NO_CHANGES (unchanged)                                                      |
| R2  | Certified, no empty signature field                                                          | §3 finds none                                   | New: "certified, and has no empty signature field to sign"                            |
| R3  | Certified, empty fields exist but none is eligible                                           | §3 rules 3–8                                    | New: lists the fields and their reasons                                               |
| R4  | Any FieldMDP reference on any signature, including the certification one                     | today's `FIELD_LOCKED` check                    | FIELD_LOCKED (unchanged)                                                              |
| R5  | Empty field carrying `/Lock` (PDF 2.0 `/Lock /P` included)                                   | rule 6                                          | per-field reason                                                                      |
| R6  | Empty field carrying `/SV`                                                                   | rule 6                                          | per-field reason                                                                      |
| R7  | Unknown `/TransformMethod` (UR3 included)                                                    | today's UNKNOWN_POLICY                          | unchanged                                                                             |
| R8  | `/Perms /DocMDP` present but its `/Reference` lacks a DocMDP entry, or two DocMDP signatures | new consistency check                           | UNKNOWN_POLICY                                                                        |
| R9  | `/AcroForm /SigFlags` is not 3, or `/NeedAppearances true`                                   | new check; we must not rewrite the AcroForm     | new reason                                                                            |
| R10 | XFA present (`/AcroForm /XFA`)                                                               | new check                                       | new reason. An XFA form's field model is not the AcroForm one we edit **[inferred]**. |
| R11 | Free placement on any certified document                                                     | UI never offers it; `signIncremental` re-checks | CERTIFIED (unchanged)                                                                 |
| R12 | Empty field whose widget is a separate kid (one kid or more)                                 | rule 3                                          | per-field reason (pyHanko rejects the fill; D8)                                       |
| R13 | Duplicate partial name, a partial name containing a period, or a node without `/T`           | rule 5b                                         | per-field reason                                                                      |
| R14 | `/V` inherited from a non-terminal parent, or `/Sig` siblings sharing a parent               | rule 2                                          | per-field reason                                                                      |
| R15 | Widget listed in more than one page's `/Annots`                                              | rule 4                                          | per-field reason                                                                      |
| R16 | Widget with `/OC`, or a read-only field (`/Ff` bit 1)                                        | rules 5, 5a                                     | per-field reason                                                                      |
| R17 | Field not present in the certified revision                                                  | rule 5c                                         | per-field reason                                                                      |
| R18 | A revision after certification that is not a signature fill of a certified-revision field    | rule 5d                                         | new document-level reason (D9)                                                        |

Approval-only documents (not certified) keep today's append-a-field path unchanged. Whether they
should also be offered their empty fields is a separate choice (D7).

## 6. Threat model

The adversary controls the input PDF. The user trusts what the preview shows. The question in
issue #23: could a malicious PDF trick the user into signing an unexpected field?

| ID  | Attack                                                                                                                                                                                            | Control                                                                                                                                                                                                                                                                                     |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | **Misleading field name**: `/T (Approved by Finance Director)` on a field the user picks as their own.                                                                                            | Show `/T` as data, labelled "field name set by the document", never as a role the app asserts. Selection is by position on the page. The signature's meaning comes from the certificate, not the field name.                                                                                |
| T2  | **Widget drawn somewhere other than where we show it**: `/P` names page 1, but the widget sits in page 3's `/Annots`, or in none.                                                                 | Rule 4: `/P` and `/Annots` must agree, or the field is refused. Highlight the field from the `/Rect` we will actually lay the stamp into.                                                                                                                                                   |
| T3  | **One field, several widgets**: the user sees one box, and the signature appears in five places, including on a page they did not review.                                                         | Rule 3 (merged widget only, no `/Kids`) and rule 4 (listed in exactly one page's `/Annots`).                                                                                                                                                                                                |
| T4  | **Invisible or off-page field**: zero `/Rect`, Hidden or NoView flag, or a Rect outside the CropBox, so the signature is real but the user sees no box.                                           | Rule 5.                                                                                                                                                                                                                                                                                     |
| T5  | **Overlay or appearance tricks**: an existing `/AP` that draws text resembling a signature, or a field placed over content to obscure it.                                                         | We always write a new `/AP /N` (pyHanko requires a new stream anyway). Placing a box over content is no different from today's approval flow. The user reviews the whole document before signing.                                                                                           |
| T6  | **Hidden or shadow content** (the "shadow attack" class: content swapped in a later permitted revision).                                                                                          | Our signature covers the whole file as shown, so this is not new to this path. A P=2 certifier permits form filling by design. Point to pyHanko's diff report as the authority for what changed between revisions; do not claim more.                                                       |
| T7  | **Seed values or a lock the user does not know about**: the certifier set `/SV /Cert` to pin a specific signer, or `/Lock` to freeze other fields on signing.                                     | Rule 6 refuses both. This loses some legitimate PDFs (D2).                                                                                                                                                                                                                                  |
| T8  | **Parser differential**: pdf-lib resolves the field one way, and Acrobat or pyHanko resolve it another way (duplicate object numbers, a broken xref, an object in an ObjStm with a stale offset). | `reserveExistingObjectNumbers` already covers number reuse. Add a post-update check that the **pyHanko** field enumeration in the test gate (`enumerate_sig_fields`) matches pdf-lib's on every fixture. In production, re-parse with pdf-lib and require exactly one field to change (§2). |
| T9  | **Actions on the field**: `/AA` or `/A` JavaScript.                                                                                                                                               | The app executes nothing, and pdf.js preview runs with scripting off **[inferred: confirm in `renderPage.ts`]**. We never add actions. A downstream viewer running pre-existing JS is outside our control and not new.                                                                      |
| T11 | **Late field**: a field appended after certification, so filling it breaks the certification while the app reports success.                                                                       | Rules 5c and 5d (R17, R18). Success copy states only what the app did (§4).                                                                                                                                                                                                                 |
| T12 | **Name collision**: two fields shown as the same name, or a dotted name that resolves to another field in some readers.                                                                           | Rule 5b (R13).                                                                                                                                                                                                                                                                              |
| T13 | **Annotation over the field (P=3)**: a permitted later annotation drawn over or beside the field, changing what the stamp appears to approve.                                                     | Rule 5d refuses any later annotation revision (R18). An annotation already in the certified revision is part of what the user reviews.                                                                                                                                                      |
| T10 | **Resource exhaustion**: thousands of empty fields, or deep `/Kids`.                                                                                                                              | Cap the field walk (for example 2,000 nodes, a number to set in the spec) and refuse above it. This extends the SEC-08 limits.                                                                                                                                                              |

Residual risk: a certifier-designed form whose visible text around the field misdescribes what the
signature means. No tool can fix that. The user's review of the document is the control.

## 7. Test plan

### 7.1 New fixtures (`scripts/make_policy_fixtures.py`)

Use pyHanko's `append_signature_field(writer, SigFieldSpec(...))` (**[pyHanko]** `fields.py`) on the
base PDF, and certify afterwards, so the empty field exists in the certified revision:

| Fixture                                    | Construction                                                                          | Expectation                                                                                                             |
| :----------------------------------------- | :------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------- |
| `certified-p2-empty-field.pdf`             | empty `Approver` field at a box, then certify P=2 into `Cert`                         | eligible; sign succeeds                                                                                                 |
| `certified-p3-empty-field.pdf`             | same, P=3                                                                             | eligible, subject to D1                                                                                                 |
| `certified-p2-empty-field-xref-stream.pdf` | same, with `stream_xrefs=True`                                                        | eligible (ObjStm path)                                                                                                  |
| `certified-p2-two-empty-fields.pdf`        | `Approver` on p.1 and `Witness` on p.1                                                | both listed; each signable                                                                                              |
| `certified-p2-empty-field-signed-once.pdf` | P=2 fixture, then pyHanko fills `Approver`                                            | `Witness` absent, so R2                                                                                                 |
| `certified-p1-empty-field.pdf`             | empty field, certify P=1                                                              | R1                                                                                                                      |
| `certified-p2-no-empty-field.pdf`          | existing `certified-p2.pdf`                                                           | R2                                                                                                                      |
| `certified-p2-empty-field-lock.pdf`        | `SigFieldSpec(field_mdp_spec=FieldMDPSpec(ALL))` on `Approver`                        | R5                                                                                                                      |
| `certified-p2-empty-field-sv.pdf`          | `SigFieldSpec(seed_value_dict=SigSeedValueSpec(...))`                                 | R6                                                                                                                      |
| `certified-p2-fieldmdp-approval.pdf`       | P=2 cert, then an approval signature with FieldMDP Include `Approver`                 | R4                                                                                                                      |
| `certified-p2-empty-field-hidden.pdf`      | built with `generic` objects: `/F 2` on the widget                                    | R3 (T4)                                                                                                                 |
| `certified-p2-empty-field-two-widgets.pdf` | built with `generic` objects: `/Kids` with two widgets on different pages             | R3 (T3)                                                                                                                 |
| `certified-p2-empty-field-p-mismatch.pdf`  | widget `/P` names page 1 but sits in page 2's `/Annots`                               | R3 (T2)                                                                                                                 |
| `certified-p2-empty-field-kid-widget.pdf`  | `generic` objects: `/Sig` field with one separate widget kid, then certify P=2        | R12. Also run pyHanko's own fill on it and require `docmdp_ok=False`, so the refusal stays justified if pyHanko changes |
| `certified-p3-empty-field-kid-widget.pdf`  | same, P=3                                                                             | R12                                                                                                                     |
| `certified-p2-duplicate-names.pdf`         | two sibling `/Sig` fields both `/T (Approver)`                                        | R13                                                                                                                     |
| `certified-p2-dotted-name.pdf`             | `/T (Approver.One)` on a terminal                                                     | R13                                                                                                                     |
| `certified-p2-inherited-v.pdf`             | non-terminal parent with `/V` and an empty-looking `/Sig` kid                         | R14                                                                                                                     |
| `certified-p2-widget-two-pages.pdf`        | one merged widget referenced from page 1 and page 2 `/Annots`                         | R15                                                                                                                     |
| `certified-p2-widget-oc.pdf`               | widget with `/OC` naming an OFF group                                                 | R16                                                                                                                     |
| `certified-p2-readonly-field.pdf`          | `/Ff 1` on the field                                                                  | R16                                                                                                                     |
| `certified-p2-late-visible-field.pdf`      | certify P=2, then append a visible empty field (pyHanko, approval-only writer)        | R17. Also show that pyHanko's own fill of it gives `docmdp_ok=False`                                                    |
| `certified-p3-later-annotation.pdf`        | P=3 empty-field fixture, then a revision adding a `/Square` annotation over the field | R18                                                                                                                     |
| `certified-p2-later-annotation.pdf`        | same at P=2 (the revision is already a violation)                                     | R18                                                                                                                     |

The generator keeps the in-memory key rule: nothing private is stored.

### 7.2 Positive gates

- `tests/signing/policy.test.ts`: for each "eligible" fixture, `signIntoField` succeeds.
  `npm run verify:signatures` then runs `validate_pdf.py` in default mode on the output, which
  requires every signature to have `integrity_ok` and `docmdp_ok=True` with a known modification
  level (**[repo]** `scripts/validate_pdf.py`). Additionally, assert that the **certification**
  signature's `modification_level` is `FORM_FILLING`, not `ANNOTATIONS`. That shows the update was
  read as form filling, which is the change P=2 permits.
- A structural assertion on the output: exactly one pre-existing object number gets a new version
  (the field), plus N new objects. Every page's `/Annots` and the AcroForm are unchanged from the
  previous revision.
- Run the same on the counter-signed output a second time, signing `Witness` after `Approver`, to
  prove that a third revision still validates.

### 7.3 Negative gates

- Every refuse row R1–R10 and R12–R18 has a fixture that `signingPolicyBlock` classifies correctly. Each one
  asserts the specific reason, not just "blocked".
- **The current path stays refused on certified input.** Force `addIncrementalPlaceholder` (the
  append-a-field path) on `certified-p2-empty-field.pdf` in a test-only harness. Then run
  `validate_pdf.py --expect-policy-violation` and require it to pass. This proves the gate can
  still tell the two paths apart.
- **Tampered fill.** Take the fill output and append one more revision that also adds an unrelated
  `/Annot` (P=2) or changes `/SigFlags`. pyHanko must flag a policy violation. This shows the
  positive result is not a validator that accepts everything.
- Keep `violates-p1.pdf` and the existing negative fixtures unchanged.

### 7.4 Manual

- Acrobat Reader spot-check on the P=2 and P=3 outputs: the certification is shown as valid and
  the approval signature as valid. This is per-distribution evidence under Principle V. Each
  distribution (PWA, desktop, Android) runs its own E2E fill on one fixture. Evidence is not
  inherited from the web build.

## 8. Owner decisions

**Decided 2026-11-15 by the owner:** D1 (a), D2 (a), D3 (a), D4 (a), D5 (a), D6 (a), D7 (a), D8 (a),
D9 (a), D10 (a). The options below are kept as the record of what was weighed.

**D1. Which DocMDP levels to support**

- **(a) P=2 and P=3, each gated by its own fixture passing `docmdp_ok=True` at FORM_FILLING.
  Recommended.** If P=3 fails in pyHanko, ship P=2 only and record P=3 as refused. Evidence so
  far: the review probe's merged-field fill by **pyHanko's own writer** passes at P=3 at
  FORM_FILLING, with only the "not designed for P=3" warning logged. The app's writer still needs
  its own P=3 fixture.
- (b) P=2 only, and leave P=3 refused because pyHanko warns it was not designed for P=3.
- (c) P=2 and P=3 without a P=3 fixture. Not recommended.

**D2. Empty fields carrying `/Lock` or `/SV`**

- **(a) Refuse them in this RFC, with a per-field reason. Recommended**: no partial honouring.
- (b) Honour `/Lock` by writing the FieldMDP reference into our signature, and still refuse `/SV`.
- (c) Ignore both. Rejected: that breaks the certifier's intent silently.

**D3. Choosing the field**

- **(a) The user always picks from highlighted eligible fields, even when there is only one.
  Recommended.**
- (b) Auto-select when exactly one is eligible.
- (c) The first eligible field in `/Fields` order, with no prompt.

**D4. FieldMDP on existing signatures**

- **(a) Keep refusing any FieldMDP reference anywhere (today's rule). Recommended.**
- (b) Evaluate the lock scope with `FieldMDPSpec.is_locked` semantics, and allow fields outside it.

**D5. Invisible empty fields**

- **(a) Refuse them. Recommended**: the app's value is the visible stamp, and T4 is the main
  trick.
- (b) Allow them as invisible signatures, with a warning.

**D6. Stamp geometry**

- **(a) Fit the stamp into the field's `/Rect`, aspect preserved, not movable. Recommended.**
- (b) Let the user draw inside the field and clip to `/Rect`.

**D7. Uncertified PDFs that have empty signature fields**

- **(a) Out of scope here, keeping today's append path. Recommended**: a smaller change.
- (b) Also offer the fill path there, as an alternative to free placement.

**D8. Fields whose widget is a separate kid**

- **(a) Refuse them (R12) and leave support to a later investigation. Recommended.** pyHanko
  0.36.2 rejects the fill at P=2 and P=3, and the project's gate is pyHanko.
- (b) Investigate support now: a custom pyHanko diff rule that whitelists the kid widget's `/AP`
  update. This changes what the gate means, so it needs its own review.
- (c) Support them with Acrobat as the only evidence. Not recommended: it contradicts the
  automatable-validator rule (Principle V).

**D9. Revisions after the certification**

- **(a) Allow only later revisions that are signature fills of fields present at certification.
  Refuse everything else (R18). Recommended.** The app cannot diff-analyse, so this is the shape
  it can classify.
- (b) Also allow P=3 documents whose later revisions only add annotations, accepting T13.
- (c) Ignore later revisions. Not recommended: the app could report success on a document whose
  certification is already broken.

**D10. Delivery scope**

- **(a) Ship all three distributions together at 6–9 days. Recommended**: Principle V evidence
  is per distribution, and one signing path keeps FR-009.
- (b) Desktop first (about 5–7 days), with PWA and Android E2E and the Acrobat check following
  in a second PR. The signing code is shared, so only the evidence is staged.

## 9. Open questions for Kurt

1. Is there a real-world certified form, for example a government form, that this must accept?
   If so, add it, redacted, as a fixture. pyHanko-generated fixtures may not show what Acrobat
   or other producers emit (an indirect `/AP`, `/DA` without `/DR`, kids arrays).
2. Should the "no eligible field" message suggest asking the sender for a version with a
   signature field? That is product copy, not mechanism.
3. Is the Acrobat Reader spot-check (7.4) required before merge, or before release?

## 10. Effort

About **6–9 working days** for one implementer (raised from 4–6 after review). This is
**[inferred]**, from the size of the existing `incrementalUpdate.ts` and `signingPolicy.ts` (488 and
77 lines). A desktop-first split is D10 (b).

| Part                                                                                                                                                      | Estimate   |
| :-------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------- |
| Fixtures (24), many hand-built from `generic` objects, plus pyHanko's own-fill controls                                                                   | 1.5–2 days |
| `signingPolicyBlock` classification across `loadPdf.ts` and `signIncremental.ts`; rules 1–8 and 5a–5d (revision classification included), with unit tests | 1.5–2 days |
| `fillExistingSignatureField`, shared tail extraction, well-formedness check                                                                               | 1–1.5 days |
| UI field picker on the preview with `/Rotate`, and copy                                                                                                   | 1–1.5 days |
| Gates (positive, negative, tampered)                                                                                                                      | 0.5–1 day  |
| E2E on three distributions, and the Acrobat check                                                                                                         | 0.5–1 day  |

## Sources

- pyHanko 0.36.2 source, read locally: `sign/diff_analysis/rules/form_field_rules.py`
  (`SigFieldCreationRule`, `SigFieldModificationRule`, `_allow_appearance_update`),
  `sign/diff_analysis/policies.py` (P=3 warning, `valid_when_certifying`, lock enforcement),
  `sign/diff_analysis/constants.py`, `sign/fields.py` (`SigFieldSpec`, `append_signature_field`,
  `FieldMDPSpec.is_locked`). Upstream: <https://github.com/MatthiasValvekens/pyHanko>.
- pyHanko documentation, validation and difference analysis:
  <https://docs.pyhanko.eu/en/latest/lib-guide/validation.html>.
- ISO 32000-1:2008 clauses 7.5.6, 12.5.3, 12.5.6.19, 12.7.2, 12.7.3.1, 12.7.4.5, 12.8.1,
  12.8.2.2 and 12.8.2.4. Table numbers are not re-verified (see Evidence labels).
- Repository: `src/features/signing/{signingPolicy,signIncremental,incrementalUpdate}.ts`,
  `scripts/make_policy_fixtures.py`, `scripts/validate_pdf.py`, `tests/signing/policy.test.ts`,
  [audit.md](audit.md) SEC-02, issue #16.
