---
description: "Task list for 004-certified-field-signing"
---

# Tasks: Sign a Certified PDF in a Field Its Author Prepared

**Input**: Design documents from `specs/004-certified-field-signing/`. Load [plan.md](plan.md),
[research.md](research.md) (R1 spike and findings F1–F4, R2–R8), [data-model.md](data-model.md),
[contracts/signing-classification.md](contracts/signing-classification.md),
[contracts/signature-gate.md](contracts/signature-gate.md), [quickstart.md](quickstart.md) and the
accepted design `docs/rfc-23-1-certified-empty-field.md` before starting any task.

**Tests**: Required. Constitution Principle V is test-first and the spec makes the fixtures and the
gate requirements (FR-020 to FR-023). In every story the test tasks come first and must fail
before the implementation tasks start.

**Hard rules for every task**:

- Fail closed. Anything the code cannot classify is `blocked`; a thrown error never becomes a
  success.
- The input bytes are a strict prefix of every output. No task may rewrite existing bytes.
- No distribution-specific branch under `src/`. `electron/` and `android/` are not edited.
- `.github/workflows/` is edited only by T038, after the issue #23 item 2 change has merged.
- `python scripts/make_policy_fixtures.py` only adds files. Never pass `--force` in this feature.
- No message may say the certification is valid, preserved or still certified (FR-019).
- `[OWNER]` tasks are Kurt's. Commit only when asked; push, PR, tag and merge each need his yes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 from spec.md
- **[OWNER]**: Kurt performs it

---

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Re-run the baseline (`npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run verify:signatures`), capture each real exit code, and confirm it matches the table in specs/004-certified-field-signing/research.md (lint 0, tsc 0, 160 tests plus the 14 spike tests, gate 0)
- [x] T002 [OWNER] Answer C1 (foreign fill that rewrites `/Info`) and C2 (cap on signed revisions after certification) from specs/004-certified-field-signing/plan.md; then replace the two `[NEEDS CLARIFICATION]` markers in specs/004-certified-field-signing/spec.md (FR-008, FR-009) and tick the item in specs/004-certified-field-signing/checklists/requirements.md — answered 2026-11-16: C1 = (a) accept a trailer `/Info` rewrite only; C2 = (a) cap 8, T041 confirms or lowers it

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: fixtures, types, the revision module and the classification wired through, with
fill-only still presented as a refusal. No user-visible change at the end of this phase.

- [x] T003 [P] Add the 15 remaining RFC §7.1 fixtures to `certified_field_fixtures` in scripts/make_policy_fixtures.py and generate them into tests/signing/fixtures/policy/: `certified-p1-empty-field`, `certified-p2-empty-field-lock`, `-sv`, `certified-p2-fieldmdp-approval`, `certified-p2-empty-field-hidden`, `-two-widgets`, `-p-mismatch`, `-kid-widget`, `certified-p3-empty-field-kid-widget`, `certified-p2-duplicate-names`, `-dotted-name`, `-inherited-v`, `-widget-two-pages`, `-widget-oc`, `-readonly-field` (all `.pdf`); the hand-built ones use pyHanko `generic` objects and are certified after the field exists
- [x] T004 [P] Add the 4 gap fixtures of research.md R2 in scripts/make_policy_fixtures.py: `certified-p2-perms-without-reference.pdf` (R8), `certified-p2-sigflags-1.pdf` and `certified-p2-need-appearances.pdf` (R9), `certified-p2-xfa.pdf` (R10); confirm with `git status --short tests/signing/fixtures/policy` that no existing file changed
- [x] T005 Add `SigningClassification`, `BlockReason`, `CandidateField`, `FieldIneligibleReason` and `FieldPlacementInput` to src/features/signing/types.ts exactly as in data-model.md (one reason per ineligible field: "the first rule that failed, in rule order")
- [x] T006 Write tests/unit/revisions.test.ts from tests/signing/revisionSpike.test.ts against the planned API of src/features/signing/revisions.ts (signed revisions, 5c lookup, 5d transition, malformed `/ByteRange`, duplicate ends, signature before certification, unsigned tail, nested `/Kids`, thrown error ⇒ refusal); it must fail before T007
- [x] T007 Implement src/features/signing/revisions.ts per research.md R1 and F2–F4: load every prefix with `updateMetadata: false`, serialize all indirect objects before any page walk, enforce the SignedRevision validation rules of data-model.md, apply C1's allow-list and C2's cap (constant `MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION`), never throw (depends on T002, T005)
- [x] T008 Delete tests/signing/revisionSpike.test.ts once tests/unit/revisions.test.ts covers every case it had
- [x] T009 Rewrite the two `signingBlock` assertions in tests/signing/policy.test.ts and the affected cases in tests/unit/loadPdf.test.ts against `LoadedPdf.signing` (`kind` and `reason`), keeping the six currently refused fixtures refused; they must fail before T010
- [x] T010 Replace `signingPolicyBlock` with async `classifySigning(doc, bytes)` in src/features/signing/signingPolicy.ts in the check order of contracts/signing-classification.md, document level only (R1, R4, R7 and the existing messages); until T016 a certified document with empty fields returns `blocked` / `certified-no-eligible-field`
- [x] T011 Carry the classification through src/features/viewer/loadPdf.ts (`signing` replaces `signingBlock`, thrown ⇒ `unreadable-policy`), src/features/signing/signIncremental.ts (drawn-box path requires `ok`) and src/App.tsx (lines 59, 147–148, 162, 472 today); behaviour is unchanged for every existing fixture
- [x] T012 Run lint, `tsc`, vitest and `npm run verify:signatures` with real exit codes; every pre-existing test passes and no existing fixture file changed

**Checkpoint**: classification in place, nothing new signable yet.

---

## Phase 3: User Story 1 - Sign a certified PDF in the field its author prepared (Priority: P1) 🎯 MVP

**Goal**: a certified P=2 or P=3 PDF with one eligible empty field can be signed in that field.

**Independent Test**: open `certified-p2-empty-field.pdf`, pick the field, sign;
`validate_pdf.py --expect-certification-level FORM_FILLING` exits 0 on the download.

### Tests for User Story 1 (write first, must fail)

- [x] T013 [P] [US1] Add fill cases to tests/signing/policy.test.ts for `certified-p2-empty-field.pdf`, `certified-p3-empty-field.pdf` and `certified-p2-empty-field-xref-stream.pdf`: `signIntoField` succeeds; input is a byte prefix of the output; exactly one pre-existing object differs and it is the field; `/AcroForm` and every page `/Annots` are unchanged; the new signature dictionary has no `/Reference`; outputs written to tests/signing/out/fill-<name>
- [x] T014 [P] [US1] Add `certified-p2-empty-field-rotated-page.pdf` (page `/Rotate 90`) and `certified-p2-empty-field-mk-rotation.pdf` (widget `/MK /R 90`) to scripts/make_policy_fixtures.py and generate them
- [x] T015 [P] [US1] Add geometry cases to tests/unit/coords.test.ts: a field `/Rect` maps to the layout box; a wide image in a tall box and a tall image in a wide box keep their aspect ratio and are centred; `/Rotate` 0, 90, 180 and 270
- [x] T016 [P] [US1] Add a forced-append harness case to tests/signing/policy.test.ts that calls `addIncrementalPlaceholder` directly on `certified-p2-empty-field.pdf` and writes the result to tests/signing/out-violations/, and a tampered-fill case that appends one `/Square` annotation revision to a fill output and writes it there too

### Implementation for User Story 1

- [x] T017 [US1] Implement candidate-field enumeration in src/features/signing/signingPolicy.ts: walk `/AcroForm /Fields` with the cycle guard and the 2,000-node cap; apply rules 1–8, 5a, 5b (inheritance of `/FT`, `/V`, `/Ff` through `/Parent`), 5c through revisions.ts, and the `/MK /R` refusal of research.md R6; return `fill-only` when at least one field is eligible
- [x] T018 [US1] Extract the shared append, xref-section and trailer tail out of `addIncrementalPlaceholder` in src/features/signing/incrementalUpdate.ts with no behaviour change (tests/signing/multiSign.test.ts and policy.test.ts stay green)
- [x] T019 [US1] Add `fillExistingSignatureField(signedPdf, probe, { fieldRef, appearanceRef, originalLargestObjectNumber })` to src/features/signing/incrementalUpdate.ts: emit the new objects and one new version of the field with `/V`, `/AP << /N ref >>` and `/F` Print if absent; no `/AcroForm`, `/Annots` or catalog write (RFC §2, FR-014)
- [x] T020 [P] [US1] Add the field-`/Rect`-to-layout conversion with aspect-preserving fit to src/features/placement/placement.ts, reusing `appearanceLayout`
- [x] T021 [US1] Add `signIntoField` and `assertFillWellFormed` to src/features/signing/signIncremental.ts per contracts/signing-classification.md: re-classify, require `fill-only` and an eligible `fieldRef`, build the appearance into the field's box, then compare input and output object by object through revisions.ts and throw without output on any other difference (FR-015)
- [x] T022 [P] [US1] Add `--expect-certification-level <NAME>` to scripts/validate_pdf.py per contracts/signature-gate.md (exactly one certification signature; its level equals NAME; exit 2 on an unknown name or a combined mode)
- [x] T023 [US1] Route outputs in scripts/verify-signatures.mjs per contracts/signature-gate.md: `fill-*.pdf` to the new mode and out of the default list; tests/signing/out-violations/ and the four new violating fixtures to `--expect-policy-violation`; fail on an empty list
- [x] T024 [P] [US1] Create src/components/FieldPicker.tsx: eligible fields outlined on the page preview at their `/Rect` (rotation-aware), listed in `/Fields` order with page number and "Field name set by the document", none pre-selected; ineligible fields greyed with a one-sentence reason per `FieldIneligibleReason`
- [x] T025 [US1] Wire the fill-only flow in src/App.tsx and src/components/DocumentStage.tsx: show the FR-017 notice, replace free placement with the picker, enable signing only when a field is picked, call `signIntoField`, and show the FR-019 success sentence with the field's name
- [x] T026 [US1] Add tests/e2e/us7-certified-field.spec.ts modelled on tests/e2e/us6-countersign.spec.ts: load the P=2 fixture, assert no free placement and no pre-selection, pick, sign, download, and run scripts/validate_pdf.py `--expect-certification-level FORM_FILLING` on the download
- [x] T027 [US1] Run all gates with real exit codes; record the P=3 result in specs/004-certified-field-signing/research.md and, if P=3 fails the validator, classify P=3 as blocked with its own reason (D1) instead of weakening the gate

**Checkpoint**: US1 works on the web build. Stop for review before US2.

**Reached 2026-11-16.** Results, and where the build differs from the task wording, are in
[research.md](research.md) R9. In short: the Phase 2 checkpoint ("fill-only still shown as a
refusal") was not built as a separate state, because T010 and T017 edit the same function;
T012's gate run was done once, at the end of Phase 3. The document-level checks of T031 (R8,
R9, R10) and a fixture-by-fixture table (the core of T028) landed early, with T010 and as
tests/signing/fixtureClassification.test.ts; T028 and T031 stay open for what they add.

**Review round, 2026-11-16 (one P1, two P2).** Rule 5d now also reads the cross-reference data
of every section after the certified bytes (src/features/signing/xrefSections.ts), eight
hand-built fixtures were added, the gate validates every input the app classifies fill-only,
and each guard has a test that names it. Details and the mutation check are in
[research.md](research.md) R10. T028 and T031 stay unticked.

**Second review round, 2026-11-16 (one P1, two P2, four P3).** Repeated dictionary keys, a
wrong trailer `/Size` and cross-reference streams with a predictor are now refused, object
headers glued to `endobj` are seen, and nine fixtures hold one hand-written fill revision that
is signed again, so the gate tests the single-section shape with intact signatures. See
[research.md](research.md) R11.

---

## Phase 4: User Story 2 - Understand why a certified PDF or a field cannot be signed (Priority: P1)

**Goal**: every refusal row has a fixture, a specific reason and visible copy.

**Independent Test**: each refused fixture opens with its own reason and no way to sign.

### Tests for User Story 2 (write first, must fail)

- [x] T028 [P] [US2] Add one case per refusal row to tests/signing/policy.test.ts asserting the exact `BlockReason` or `FieldIneligibleReason` from data-model.md for R1–R10 and R12–R18, each naming its fixture; assert that no output is produced and that `signIncremental` (drawn box) throws `CertificationLockedError` on every certified fixture (R11) — done 2026-11-17: one case per row R1–R10, R12–R18 (20 cases over the 17 rows), each asserting the reason, the exact message and no output from either signing path; R11 on all 56 certified fixtures. R7 needed a fixture (`approval-unknown-transform.pdf`, generated). R17 is refused at document level by rule 5d (`changed-after-certification`), which runs before rule 5c can name the field
- [x] T029 [P] [US2] Add cases to tests/unit/revisions.test.ts and tests/unit/loadPdf.test.ts for: more than 2,000 form nodes (document built in the test), a cyclic `/Kids`, a `/V` that is not a dictionary, and a parse error during classification ⇒ `unreadable-policy` — done 2026-11-17: cap (2,001 nodes refused, 2,000 classified), cyclic `/Kids`, a parse error, and a non-dictionary `/V` (number, string, array), in revisions.test.ts through `classifySigning` and in loadPdf.test.ts on rewritten files; the `/V` case failed first (it read as R2)
- [x] T030 [P] [US2] Pin scripting off explicitly at the `getDocument` call in src/features/viewer/renderPage.ts and add a test with a fixture whose field carries an `/AA` JavaScript action showing that rendering runs nothing (T9, research.md R7) — done 2026-11-17: pdf.js 4.10 `getDocument` has no scripting option (scripts run only through the viewer sandbox, never loaded), so `isEvalSupported: false` and `enableXfa: false` are pinned; tests/unit/renderPage.test.ts checks the call and that pdf.js reports the fixture's field actions, and us7 opens `certified-p2-empty-field-aa-javascript.pdf` with no dialog and no sandbox request

### Implementation for User Story 2

- [x] T031 [US2] Complete the document-level checks in src/features/signing/signingPolicy.ts: R8 (catalog `/Perms /DocMDP` without a matching DocMDP `/Reference`, or two certifications), R9 (`/SigFlags` not 3 or `/NeedAppearances true`), R10 (`/AcroForm /XFA`), R2 versus R3, R18 from revisions.ts — done 2026-11-17: R8–R10 and R2/R3 were already in place (Phase 3 notes); added the refusal of a signature field whose `/V` is neither empty nor a dictionary (`unreadable-policy`) and a two-certifications test for R8; the R9 message now uses the contract's ASCII apostrophe
- [x] T032 [US2] Show refusals in src/App.tsx and src/components/FieldPicker.tsx with the exact copy of contracts/signing-classification.md: the R2 message with the "ask the sender" sentence (FR-018), R3 with the greyed list, R9, R10 and R18 — done 2026-11-17: a refused document shows its message in the field list for as long as it is open (it was a transient error cleared by the next action), the R3 greyed list below it; no free placement, image controls disabled, certificate signing disabled (it was enabled once an image was chosen)
- [x] T033 [US2] Extend tests/e2e/us7-certified-field.spec.ts: `certified-p1.pdf`, `certified-p2.pdf`, `certified-p2-empty-field-kid-widget.pdf` and `certified-p2-later-annotation.pdf` each show their message and no enabled sign control; `approval.pdf` still offers free placement (D7) — done 2026-11-17: the four fixtures show their exact message and no enabled sign control, even after an image is chosen through the file input; `approval.pdf` still places freely; 7/7 locally with `REQUIRE_PYHANKO=1`

**Checkpoint**: US1 and US2 pass together.

---

## Phase 5: User Story 3 - Sign as the second signer of a certified PDF (Priority: P2)

**Goal**: after one prepared field is filled, the remaining one can still be signed.

**Independent Test**: sign `Approver` then `Witness` on `certified-p2-two-empty-fields.pdf`; the
validator passes three signatures.

### Tests for User Story 3 (write first, must fail)

- [x] T034 [P] [US3] Add a chain case to tests/signing/policy.test.ts: `signIntoField` on `Approver`, classify the output (only `Witness` eligible), `signIntoField` on `Witness`, write tests/signing/out/fill-chain-two-fields.pdf; assert the first output is a byte prefix of the second — done 2026-11-17; passed on its first run (US1's code already handled the chain)
- [x] T035 [P] [US3] Add foreign-writer cases to tests/signing/policy.test.ts using `certified-p2-two-empty-fields-signed-once.pdf`, its `-xref-stream` twin and `certified-p2-empty-field-signed-once.pdf`, with expectations set by C1; and negative cases `certified-p3-annotation-then-fill.pdf`, `certified-p2-two-revisions.pdf` ⇒ `changed-after-certification` — done 2026-11-17: each foreign case asserts its /Info really changed; the two two-field `signed-once` fixtures failed that (same-second /ModDate, research.md F1) and were regenerated by scripts/make_policy_fixtures.py with the fill a second later

### Implementation for User Story 3

- [x] T036 [US3] Make T034 and T035 pass in src/features/signing/revisions.ts and src/features/signing/signingPolicy.ts (a filled field is no longer a candidate; the app's own fill is an accepted transition), and confirm scripts/verify-signatures.mjs validates the chain output with three signatures and the certification at FORM_FILLING — done 2026-11-17: no change to src/ was needed (US1's revision check already accepts the app's own fill, and a filled field has a /V so it is no candidate); `REQUIRE_PYHANKO=1 npm run verify:signatures` exits 0 and validates fill-chain-two-fields.pdf with three signatures, certification at FORM_FILLING
- [x] T037 [US3] Extend tests/e2e/us7-certified-field.spec.ts: sign one field of the two-field fixture, load the download, check the signed field is not offered, sign the other, validate — done 2026-11-17, web project (android-chrome) 8/8 with `REQUIRE_PYHANKO=1`; the desktop config does not run tests/e2e

**Checkpoint**: US1–US3 pass on the web build.

---

## Phase 6: User Story 4 - The same result on the web app, desktop and Android (Priority: P2)

**Goal**: each distribution has its own evidence; v0.3.0 is ready to publish.

**Independent Test**: each distribution's run signs the fixture and validates its own output.

- [x] T038 [US4] **v0.3.0 blocker.** tests/e2e/us7-certified-field.spec.ts skips its validator step when pyHanko is not importable unless `REQUIRE_PYHANKO=1` is set, so until this task sets it in CI the web E2E proves less there than locally (review finding R4). After the issue #23 item 2 change merges, wire `us7-certified-field.spec.ts`, the desktop case and the Android `--certified-field` run into the existing jobs under .github/workflows/ (no new job; same commit for all three) — done 2026-11-16: ci.yml `e2e` gains setup-python + pyHanko and `REQUIRE_PYHANKO=1` on the signing E2E step; `REQUIRE_PYHANKO=1` on every desktop E2E step (ci.yml `desktop`, release-desktop.yml `build`); the release emulator gate runs `--certified-field` through scripts/android-release-gate.sh (ci.yml `android` runs no emulator, so none was added). First CI run of the wiring is the PR's
- [x] T039 [P] [US4] Add a certified-field case to tests/e2e-desktop/desktop-sign.spec.ts that signs `certified-p2-empty-field.pdf` in the packaged desktop app and validates the saved file with the new validator mode — done 2026-11-16, passes locally on Windows with `REQUIRE_PYHANKO=1`; Linux runs first in CI
- [ ] T040 [P] [US4] Add the `--certified-field` mode to scripts/android-gate.mjs per contracts/signature-gate.md and run it against a locally built signed APK on the emulator — mode added 2026-11-16 (pure helpers in scripts/android-gate-certified.mjs, unit-tested in tests/unit/androidGateCertified.test.ts). **Open: never run on an emulator.** Owner decision 2026-11-16: the first run is the v0.3.0 tag's release-desktop.yml emulator gate (the `android` job runs on `v*` tags only); tick this when that run passes. A failure there blocks `publish`.
- [ ] T041 [US4] Measure classification time for the largest file the app accepts at the C2 cap (a generated document signed that many times) on the web build; record the numbers in specs/004-certified-field-signing/research.md F3 and confirm or adjust `MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION` with the owner — done 2026-11-18: two generated 99 MB certified documents with eight pyHanko fills after the certification, both classified fill-only; `classifySigning` median 4.5 s (one stream) and 13.1 s (5,000 pages) in Node, 6–35 s from file chosen to notice in the production web build, 48 s at 4x CPU throttle (F3). The measurement is done and the constant stays at 8; **open: the owner's ruling on the cap**, so the task stays unticked
- [x] T042 [P] [US4] Add to scripts/verify-signatures.mjs the field-enumeration cross-check (pyHanko `enumerate_sig_fields` versus pdf-lib on every fixture, T8) and pyHanko's own-fill controls for `certified-p2-empty-field-kid-widget.pdf` and `certified-p2-late-visible-field.pdf` (both must be policy violations) — done 2026-11-18: scripts/pyhanko_probe.py and scripts/sig-fields.mjs; 61 fixtures agree except the three R11 differentials, which are listed and must keep differing; pyHanko's own fill of the kid-widget field is a violation (its input validates, so the control can fail); the late-visible-field control was dropped in review (US4-R1), because that input is already a violation in the gate's violations list. Two temporary mutations (pdf-lib walk stops at `/Kids`; one differential unlisted) each made the gate exit 1, then were reverted
- [x] T043 [P] [US4] Update README.md (certified PDFs: what is and is not signable), docs/audit.md (SEC-02 row), the status line of docs/rfc-23-1-certified-empty-field.md, and docs/android.md if it lists gate modes — done 2026-11-18: README "Sign a certified PDF" section and troubleshooting entry; SEC-02 row with the Acrobat slot left for T045; RFC status implemented; docs/android.md lists no gate modes, unchanged
- [x] T044 [US4] Bump the version to 0.3.0 in package.json, package-lock.json and the Android version fields that specs/003-android-packaging/research.md R15 names — done 2026-11-18: package.json and package-lock.json; android/app/build.gradle.kts derives versionName and versionCode (300) from package.json, so nothing else changed. Not tagged
- [ ] T045 [OWNER] [US4] Open the P=2 and P=3 fill outputs from tests/signing/out/ in Acrobat Reader; record the Reader version and the result for the certification and the new signature in docs/audit.md (FR-025, before release, not before merge)
- [ ] T046 [OWNER] [US4] Publish v0.3.0 for the web app, desktop and Android from one commit after T045

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T047 Run `/speckit-analyze` over spec.md, plan.md and tasks.md and fix inconsistencies; with the owner's yes, update the `<!-- SPECKIT START -->` block of CLAUDE.md to name 004 as the active feature (deliberately not done by the plan step) — analyze half done 2026-11-18, by hand from the speckit-analyze skill (the command was not run): spec status, C2/FR-009 and the plan's performance goal brought up to T041, the plan's fixture count, and a success-criteria-to-tasks line in the notes. **Open: the CLAUDE.md half, pending the owner's yes**, so the task stays unticked
- [ ] T048 Run quickstart.md end to end; run every gate with real exit codes and compare with the baseline; list in the PR body which commits are distribution-neutral changes under `src/` — done 2026-11-18 on Windows: §1 fixtures exit 0, 61 kept, no change under tests/signing/fixtures/policy; §2 lint 0, tsc 0, vitest 0 (505, as the baseline on 4de7b2c); §3 `REQUIRE_PYHANKO=1 npm run verify:signatures` 0; §5 `us7-certified-field.spec.ts` 0 (8 passed) and `npm run e2e:desktop` 0 (9 passed), both with `REQUIRE_PYHANKO=1`. **Open:** §4 (manual app run, owner), the Android part of §5 (T040), and the PR-body list of distribution-neutral `src/` commits (none: no US4 commit touches `src/`), which goes in when the PR is opened

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none. T002 blocks T007 only.
- **Foundational (Phase 2)**: T003 and T004 are independent of the code tasks. T005 → T006 → T007 → T008. T009 → T010 → T011 → T012.
- **US1 (Phase 3)**: needs Phase 2. This is the MVP.
- **US2 (Phase 4)**: needs T017 (field rules) and T003/T004 (fixtures). Independent of US3.
- **US3 (Phase 5)**: needs US1's `signIntoField` (T021).
- **US4 (Phase 6)**: needs US1–US3. T038 also waits for the item 2 merge.
- **Polish (Phase 7)**: last.

### Within Each User Story

Tests first and failing; then policy and writer; then UI; then E2E; then the gate run.
T018 before T019. T017 and T019 before T021. T022 before T023. T024 before T025.

### Parallel Opportunities

- T003 and T004 with each other and with T005–T011 (scripts versus `src/`).
- T013–T016 together (tests and fixtures).
- T020, T022 and T024 while T017–T019 are in progress (different files).
- T028–T030 together; T034 and T035 together; T039, T040, T042 and T043 together.

## Parallel Example: User Story 1

```bash
# Tests and fixtures first, together:
Task: "T013 fill cases in tests/signing/policy.test.ts"
Task: "T014 rotated fixtures in scripts/make_policy_fixtures.py"
Task: "T015 geometry cases in tests/unit/coords.test.ts"

# Then, in different files:
Task: "T020 field rect to layout in src/features/placement/placement.ts"
Task: "T022 --expect-certification-level in scripts/validate_pdf.py"
Task: "T024 src/components/FieldPicker.tsx"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

Phases 1–3. At T027 a certified P=2 form with one field can be signed on the web build and the
gate proves it. Stop for review there.

### Incremental Delivery

US2 next (it shares fixtures with US1 and must ship with it: the refusals are part of the same
safety argument). US3 adds the second signer. US4 adds the other two distributions' evidence and
the release. Nothing ships to users before US1 and US2 are both done.

### Sequencing with builders

The signing-engine tasks (T007, T010, T017–T021, T031, T036) touch the same four files and run
serially. Fixture, validator, picker and E2E tasks can go to a second builder.

## Notes

- Estimate: 6–8 working days for one implementer from T001, inside the RFC's 6–9. The spike
  removed the largest unknown (revision parsing); the remaining risk is the hand-built fixtures of
  T003 and the Android gate mode of T040.
- 11 of the 32 planned fixtures already exist (spike commit). As built there are 61 (R9–R11).
- Success criteria to tasks (added by T047): SC-001 T025, T026 and the quickstart §4 manual run;
  SC-002 T023, T026, T038, T039, T040; SC-003 T028–T033; SC-004 T034–T037; SC-005 T016, T023;
  SC-006 every phase's gate run (T048); SC-007 T012 and T048 (quickstart §1); SC-008 T045.
- If C1 is answered "refuse", T035's foreign-writer expectations flip to
  `changed-after-certification` for `certified-p2-empty-field-signed-once.pdf`, and the two-field
  `signed-once` fixtures must be regenerated so their `/ModDate` differs, or they would pass by
  accident (research.md F1).
