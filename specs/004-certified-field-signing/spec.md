# Feature Specification: Sign a Certified PDF in a Field Its Author Prepared

**Feature Branch**: `feat/rfc-23-1`

**Created**: 2026-11-16

**Status**: Draft

**Input**: User description: "Issue #23 item 1: sign a certified (DocMDP P=2/P=3) PDF by filling an existing empty signature field. The design is accepted in docs/rfc-23-1-certified-empty-field.md (owner decisions D1–D10, all option (a)). Owner decisions of 2026-11-16: run it as spec 004; build the full later-revision rule now, including a second signer after a first (no narrowing fallback); generated fixtures now and a real-world form later; the 'no eligible field' message suggests asking the sender for a version with a signature field; an Acrobat Reader spot-check before release, not before merge; release as v0.3.0 across all three distributions."

## Overview

Some PDFs are **certified**: their author signed them first and declared what may still change.
Two of the three certification levels allow the document to be signed afterwards, but only inside a
signature field the author already put there. Today the app refuses every certified PDF, because
its only way to sign is to add a new field, and a new field breaks a certification at every level.

This feature adds a second, narrower way to sign. When a certified document allows signing and
holds an empty signature field that passes a fixed list of safety rules, the user picks that field
and the app signs inside it, changing nothing else. Every other certified case stays refused, and
each refusal says why.

Who it is for: people who receive a certified form (an application, a contract template, an
approval sheet) with a signature box in it and are asked to sign that box.

The accepted design, its evidence and its threat model live in
[docs/rfc-23-1-certified-empty-field.md](../../docs/rfc-23-1-certified-empty-field.md). This spec
turns it into requirements and does not re-open decisions D1–D10. Rule and row numbers below
(rules 1–8, 5a–5d; rows R1–R18; threats T1–T13) are the RFC's.

## Constitutional Impact

No amendment is needed (constitution v1.2.0). The feature adds no distribution, no network use and
no stored data. It is bound by three principles in particular:

- **III (crypto correctness)**: one shared signing path for all three distributions; no
  distribution-specific branch.
- **IV (honest posture)**: the app states what it did, never that the certification "stays valid".
  The app does not verify signatures, and says nothing that implies it did.
- **V (real readers)**: each distribution proves the feature with its own output, checked by the
  pinned validator. Evidence is not inherited from another distribution.

## Clarifications

### Session 2026-11-15 (RFC acceptance)

- D1: both signing-permitted levels are supported, each proven by its own fixture. If the less
  restrictive level fails the validator, it ships as refused.
- D2: a field carrying a lock or seed-value constraints is refused, not partly honoured.
- D3: the user always picks the field, even when only one is eligible.
- D4: any field-lock policy on any existing signature refuses the whole document.
- D5: invisible fields are refused.
- D6: the stamp is fitted into the field's box, aspect preserved, and cannot be moved or resized.
- D7: uncertified PDFs keep today's behaviour; their empty fields are not offered.
- D8: a field whose visible box is a separate child object is refused.
- D9: after certification, the only later changes accepted are signature fills of fields that
  existed at certification.
- D10: all three distributions ship together.

### Session 2026-11-16

- Q: Process? → A: spec 004 through the repository's spec-kit flow, the RFC as input.
- Q: If classifying later revisions proves expensive, narrow the rule to "never touched since
  certification"? → A: No. Build the full rule now; a second signer after a first must work (D9
  as written).
- Q: Real-world certified form as a fixture? → A: Proceed with generated fixtures; add a real form
  later if one turns up.
- Q: "No eligible field" message? → A: It also suggests asking the sender for a version with a
  signature field.
- Q: Acrobat Reader spot-check timing? → A: Before release, not before merge.
- Q: Release? → A: v0.3.0, one release for the web app, desktop and Android.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign a certified PDF in the field its author prepared (Priority: P1)

A user opens a certified PDF that permits signing and contains an empty signature box. Instead of
a refusal, the app explains that the document can only be signed in a prepared field, outlines the
fields that can be used, and lets the user pick one. The user then goes through the normal
signature-image and certificate steps and downloads the signed PDF. The stamp sits inside the
field's box.

**Why this priority**: This is the whole point of issue #23 item 1. Without it every certified
form is a dead end.

**Independent Test**: Open the generated "certified, fill-forms level, one empty field" fixture,
pick the field, sign, and run the pinned validator on the output: both signatures intact, and the
certification reports the later change as form filling.

**Acceptance Scenarios**:

1. **Given** a certified PDF at the fill-forms level with one eligible empty field, **When** the
   user opens it, **Then** the app says the document is certified and can only be signed in a
   field its author prepared, and does not offer free placement.
2. **Given** that document, **When** the user views the page, **Then** the eligible field is
   outlined at the place its box really is, with its page number and its name labelled as a name
   set by the document.
3. **Given** one eligible field, **When** the user has not picked it, **Then** nothing is selected
   and signing is not available.
4. **Given** a picked field, **When** the user signs, **Then** the output starts with the input's
   exact bytes, the picked field now holds the signature, and no other pre-existing part of the
   document differs.
5. **Given** the signed output, **When** the pinned validator checks it, **Then** every signature
   passes integrity and policy, and the certification signature reports the modification level
   "form filling".
6. **Given** a certified PDF at the annotate level with an eligible field, **When** the user signs
   it, **Then** the same holds, or (D1) that level is shipped as refused with its own reason.
7. **Given** a field whose box is wider or taller than the signature image, **When** the stamp is
   drawn, **Then** it keeps its aspect ratio inside the box, on a rotated page as well, and the
   user cannot move or resize it.
8. **Given** a successful signature, **When** the result is shown, **Then** the message names the
   field that was signed and says no other part of the document was changed, and does not say the
   certification is still valid.

---

### User Story 2 - Understand why a certified PDF or a field cannot be signed (Priority: P1)

A user opens a certified PDF the app must refuse, or one where some fields cannot be used. The app
says which case applies. Fields that exist but cannot be used are listed, greyed out, each with its
reason. When there is nothing to sign in, the message suggests asking the sender for a version
that has a signature field.

**Why this priority**: The feature narrows a refusal; it does not remove it. A wrong success here
breaks someone else's certification, so the refusals are as much the product as the success path.

**Independent Test**: For each refused fixture, open it and check that the specific reason is
shown and that signing is unavailable.

**Acceptance Scenarios**:

1. **Given** a PDF certified at "no changes allowed", **When** it is opened, **Then** it is refused
   with today's message, whether or not it has an empty field.
2. **Given** a certified PDF with no empty signature field, **When** it is opened, **Then** the
   message says it is certified and has no empty signature field to sign, and suggests asking the
   sender for a version with one.
3. **Given** a certified PDF whose empty fields are all ineligible, **When** it is opened, **Then**
   each field is listed with its own reason and none can be picked.
4. **Given** a certified PDF with both eligible and ineligible empty fields, **When** it is opened,
   **Then** the eligible ones can be picked and the others are shown greyed with their reasons.
5. **Given** any certified PDF, **When** the signing step runs by any route, **Then** free
   placement is refused again at that step, not only hidden in the interface.
6. **Given** a certified PDF that was changed after certification by anything other than a
   signature in a prepared field, **When** it is opened, **Then** the whole document is refused
   with a document-level reason.
7. **Given** an uncertified PDF with empty signature fields, **When** it is opened, **Then**
   nothing changes from today: free placement, no field picker (D7).

---

### User Story 3 - Sign as the second signer of a certified PDF (Priority: P2)

A certified form has two prepared fields. The first person signs one, in this app or in another
tool, and sends the file on. The second person opens it and signs the remaining field.

**Why this priority**: Forms with more than one signer are common, and the owner chose to build
this now instead of refusing every certified document that was touched after certification.

**Independent Test**: Sign "Approver" on the two-field fixture with the app, reopen the output,
sign "Witness", and validate the result: three signatures, all intact, policy satisfied for each.
Repeat starting from a file whose first fill was made by the validator's own signing tool.

**Acceptance Scenarios**:

1. **Given** a certified PDF with two eligible fields, **When** the user signs one and reopens the
   output, **Then** the other field is still offered and the signed one is not.
2. **Given** that output, **When** the second field is signed, **Then** the validator passes all
   three signatures and the certification still reports "form filling".
3. **Given** a certified PDF whose first field was filled by another tool in the accepted shape,
   **When** it is opened, **Then** the remaining field is offered.
4. **Given** a certified PDF where a later signature's coverage also contains some other change
   (for example an added annotation), **When** it is opened, **Then** the document is refused.
5. **Given** a certified PDF with content appended after the last signature, **When** it is
   opened, **Then** the document is refused.

---

### User Story 4 - The same result on the web app, desktop and Android (Priority: P2)

Whichever distribution the user runs, certified-field signing behaves the same and has been proven
on that distribution's own output.

**Why this priority**: The owner chose to ship all three together (D10), and the constitution does
not allow one distribution's evidence to stand for another's.

**Independent Test**: On each distribution, load the fill-forms fixture, pick the field, sign, and
validate the file that distribution produced.

**Acceptance Scenarios**:

1. **Given** each of the three distributions, **When** its end-to-end run signs the fixture,
   **Then** the validator passes that distribution's own output.
2. **Given** the release candidate, **When** the outputs at both supported levels are opened in
   Acrobat Reader, **Then** the certification and the new signature both show as valid, and the
   result is recorded before the release is published.
3. **Given** the release, **When** it is published, **Then** it is version 0.3.0 for all three
   distributions from the same commit.

---

### Edge Cases

- The field's name is misleading ("Approved by Finance Director"). The name is shown as data from
  the document, never as a role the app asserts; the user picks by position (T1).
- The field says it is on one page but is listed on another, on several, or on none: refused (T2,
  T3, R15).
- The field is hidden, has a zero-size box, lies outside the visible page area, or belongs to an
  optional layer: refused (T4, R16).
- The field is read-only, or carries a lock or seed-value constraints: refused (R5, R6, R16).
- The field's box is a separate child object, even a single one: refused (R12).
- Two fields share a name, a name contains a period, or part of the name path is missing: refused
  (R13).
- A parent carries a value its children inherit, or signature fields share a parent: refused
  (R14).
- The field was added after certification: refused, even though it looks the same on screen (R17,
  T11).
- The document's form says appearances must be regenerated, lacks the signature flags a certified
  document carries, or carries an XFA form: refused (R9, R10).
- The certification data is inconsistent (the catalog points to a certification the signature does
  not declare, or there are two): refused as an unknown policy (R8).
- The document holds thousands of fields or deeply nested ones: refused above a fixed limit (T10).
- The field already has an appearance drawn by the author: it is replaced by the new stamp, never
  edited in place (T5).
- The document carries scripts or actions on the field: the app runs nothing and adds none (T9).
- A signature's declared coverage is malformed, overlaps another, or does not start at the
  beginning of the file: refused.

## Requirements *(mandatory)*

### Functional Requirements

**Classification**

- **FR-001**: On opening a PDF, the app MUST classify it as exactly one of: signable by free
  placement (today's behaviour), signable only by filling a prepared field, or not signable, with
  a reason. Anything it cannot classify MUST be refused.
- **FR-002**: A certified PDF MUST never be offered free placement, and the signing step MUST
  re-check this itself (R11).
- **FR-003**: A PDF certified at "no changes allowed" MUST stay refused with the current message
  (R1). A field-lock policy on any existing signature MUST refuse the document (R4, D4). An
  unrecognised policy MUST refuse the document (R7).
- **FR-004**: The app MUST refuse a certified document whose certification data is inconsistent
  (R8), whose form flags are not those of a signed, append-only form or which requires appearance
  regeneration (R9), or which carries an XFA form (R10). It MUST NOT repair any of these.
- **FR-005**: Uncertified PDFs MUST behave exactly as before this feature (D7).

**Field eligibility**

- **FR-006**: An empty signature field MUST be eligible only if all of RFC rules 1–8 and 5a–5d
  hold: it is a signature field (1); it has no value, own or inherited, and no signature sibling
  under a shared parent (2); the field and its visible box are one object, with no children (3);
  it names a page, that page lists it, and no other page does (4); it is visible, non-empty in
  size, inside the visible page area and in no optional layer (5); it is not read-only (5a); every
  name on its path exists, has no period and is unique among siblings (5b); it existed when the
  document was certified (5c); every revision after certification is acceptable under FR-008
  (5d); it has no lock and no seed values (6); no field-lock policy exists anywhere (7); its
  existing appearance, if any, is not shared with another annotation (8).
- **FR-007**: "Existed when the document was certified" (5c) MUST be decided from the bytes the
  certification signature covers: both the field and its listing on its page must be present
  there.
- **FR-008**: Every part of the file after the certified bytes MUST be accounted for by later
  signatures, each of which adds exactly one signature fill of a field that satisfied FR-007, with
  nothing else changed, and the last of which covers the file to its end. Otherwise the document
  MUST be refused (R18, D9). [NEEDS CLARIFICATION: when such a fill, made by another tool, also
  rewrites the document information dictionary (its modified date and producer), is the document
  accepted or refused? The validator's own signing tool does this, so "refused" means a second
  signer can only follow a first who used this app.]
- **FR-009**: The field walk and the revision check MUST be bounded: the document is refused above
  2,000 form nodes (T10) and above a fixed number of signed revisions after certification.
  [NEEDS CLARIFICATION: the revision limit. Each one costs a full re-read of the document.]
- **FR-010**: Each ineligible empty field MUST carry one specific reason, shown to the user (R3,
  R5, R6, R12–R17).

**Choosing and signing**

- **FR-011**: The app MUST list eligible fields in the document's own order, each with its page
  number, its full name labelled as set by the document, and an outline at its real position on
  the page preview. Ineligible empty fields MUST be listed greyed, with their reasons.
- **FR-012**: The user MUST pick the field. The app MUST NOT pre-select one, including when only
  one is eligible (D3).
- **FR-013**: The signature appearance MUST be fitted to the field's box with its aspect ratio
  preserved, respecting page rotation, and MUST NOT be movable or resizable (D6). The appearance
  options that exist today (name label, date line) MUST keep working inside that box.
- **FR-014**: Signing into a field MUST leave every byte of the input unchanged and add only: the
  new signature, its new appearance and resources, and a new version of the picked field that
  points to them. It MUST NOT add a field or an annotation, and MUST NOT change the form, any
  page, the catalog or the certification (RFC §2).
- **FR-015**: Before returning the output, the app MUST re-read it and confirm that the set of
  fields is unchanged, the picked field now holds the new signature, and no other pre-existing
  object differs. If the check fails, no output is produced.
- **FR-016**: The new signature MUST be an ordinary approval signature. It MUST NOT declare a
  certification or a field lock.

**Messages**

- **FR-017**: For a fill-only document the app MUST say: "This PDF is certified. It can only be
  signed in one of the signature fields its author prepared."
- **FR-018**: When a certified document has no eligible field, the message MUST state that and
  MUST suggest asking the sender for a version that has a signature field.
- **FR-019**: After signing, the app MUST say: "Signed in the existing field '<name>'. No other
  part of the document was changed." It MUST NOT claim the certification is or remains valid.

**Evidence and delivery**

- **FR-020**: The signature gate MUST validate the app's fill output at each supported level with
  the pinned validator, requiring integrity and policy to pass for every signature and the
  certification's modification level to be "form filling".
- **FR-021**: The gate MUST also prove it can fail: the old add-a-field path forced onto a
  certified fixture, and a fill output with a further disallowed change appended, MUST each be
  reported as a policy violation.
- **FR-022**: Every refusal row R1–R10 and R12–R18 MUST have a fixture and a test that asserts the
  specific reason. Fixtures are generated by the validator's toolkit with a key that is never
  stored. Adding fixtures MUST NOT change the bytes of fixtures already committed.
- **FR-023**: Each distribution MUST run its own end-to-end fill and validate its own output.
- **FR-024**: The signing code MUST stay shared. No distribution may branch in the signing path.
- **FR-025**: The feature ships as version 0.3.0 for all three distributions from one commit. An
  Acrobat Reader check of the outputs at both levels MUST be recorded in the audit document before
  that release is published; it does not block merging.
- **FR-026**: The README, the audit record (SEC-02) and the RFC's status line MUST be updated in
  the same change that makes them out of date.

### Key Entities

- **Signing classification**: the result of opening a PDF: free placement, fill-only (with the
  eligible fields and the ineligible ones with reasons), or blocked (with a reason).
- **Candidate field**: an empty signature field found in the document: its identity, full name,
  page, box, and either "eligible" or one reason.
- **Signed revision**: the document as it stood at the end of one signature's coverage. The first
  is the certified revision; each later one must differ from the one before by one fill.
- **Field placement**: the user's choice of a candidate field, used in place of a drawn box.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can open a certified form with one prepared field, pick it, sign and download
  in under 2 minutes with a certificate already at hand.
- **SC-002**: 100% of outputs signed into a prepared field, at each supported level and on each of
  the three distributions, pass the pinned validator with the certification intact and the change
  classed as form filling.
- **SC-003**: 100% of the refusal fixtures are refused with their specific reason; 0 of them
  produce an output.
- **SC-004**: A document signed twice through prepared fields (first and second signer) passes the
  validator for all three signatures.
- **SC-005**: The gate reports a policy violation for both negative controls (forced new field,
  tampered fill).
- **SC-006**: Every test that passed before the feature still passes, and uncertified documents
  behave identically (baseline: 160 unit tests, signature gate passing, on `a6f4eef`).
- **SC-007**: 0 pre-existing fixture files change.
- **SC-008**: Acrobat Reader shows the certification and the added signature as valid for the
  outputs at both levels, recorded before v0.3.0 is published.

## Assumptions

- The pinned validator (pyHanko 0.36.2) is the authority for "policy satisfied". The app's rules
  are chosen so that what it accepts, the validator accepts; where the app is stricter, that is
  deliberate.
- The app does not verify existing signatures. A document whose certification is already broken
  can still be signed in a prepared field; the success message makes no claim about it (FR-019).
- A certification is the first signature in a document. A document with a signature that ends
  before the certification's coverage is refused as unclassifiable.
- The less restrictive level (annotate) is supported only if its fixture passes the validator
  (D1). The validator warns that it was not designed for that level.
- Generated fixtures stand in for real-world forms for now. Forms from other producers may hit
  refusals the fixtures do not show (separate child boxes, shared appearances); those refusals are
  safe by design.
- No stored data changes shape, so there is no migration and reverting the change restores the
  refusal of every certified PDF.

## Dependencies

- [docs/rfc-23-1-certified-empty-field.md](../../docs/rfc-23-1-certified-empty-field.md), accepted
  2026-11-15.
- The signature gate's Python toolchain (`scripts/requirements-verify.txt`).
- An Android emulator and the desktop build for the per-distribution runs (as in spec 003).
- Acrobat Reader on a machine the owner controls, for FR-025.
