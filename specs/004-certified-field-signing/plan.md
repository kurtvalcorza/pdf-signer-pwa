# Implementation Plan: Sign a Certified PDF in a Field Its Author Prepared

**Branch**: `feat/rfc-23-1` | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-certified-field-signing/spec.md`; accepted design
[docs/rfc-23-1-certified-empty-field.md](../../docs/rfc-23-1-certified-empty-field.md)

## Summary

Add a second signing path beside "append a new field": fill an empty signature field that already
exists in a document certified at DocMDP P=2 or P=3. The policy check stops returning a string and
returns a classification (free placement, fill-only with candidate fields, or blocked). A new
revision module decides rules 5c and 5d by loading the bytes each signature covers as a document
of its own and comparing consecutive ones object by object; the spike proved this on pyHanko's
fixtures ([research.md](research.md) R1). The writer gains `fillExistingSignatureField`, which
appends three kinds of object and a new version of one field, and nothing else. The UI replaces
free placement with a field picker for fill-only documents. The gate learns to assert the
certification's modification level and gains two negative controls. All three distributions ship
it together as v0.3.0, each with its own evidence.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), React 18; Python 3.11+ for the gate scripts only.

**Primary Dependencies**: pdf-lib 1.17.1, `@signpdf/*` 3.2, node-forge, pdfjs-dist 4.7 (all
existing). **No new dependency.** Gate: pyHanko 0.36.2, pyhanko-certvalidator 0.31.4 (pinned).

**Storage**: none. No stored shape changes; the certificate and signature-image stores are
untouched.

**Testing**: vitest (unit and signing), Playwright (web, PWA, desktop), `scripts/android-gate.mjs`
(emulator), `npm run verify:signatures` (pyHanko).

**Target Platform**: the web PWA, the Electron desktop builds, the Android APK; one shared `src/`.

**Project Type**: client-only web application with two packaging shells.

**Performance Goals**: classification on open adds one parse per signed revision. Target: under
1 s added on a 10-page form on a mid-range phone; the largest allowed file at the revision cap is
measured in T041 before the cap is fixed. Measured 2026-11-18 (research.md F3): 4.5 s (one 99 MB
stream) to 13.1 s (5,000 pages) median in Node at the cap of 8; the cap's fate is the owner's.

**Constraints**: input bytes are a strict prefix of the output; fail closed on anything
unclassifiable; no distribution-specific branch in the signing path; no network.

**Scale/Scope**: about 7 source files changed, 2 added; 21 fixtures added to the 11 the spike
produced (61 as built: the review rounds R9–R11 added more); 48 tasks.

**Decided 2026-11-16 (owner)**: C1 (a) and C2 (a), see the table below. They were: FR-008 (`/Info` rewritten by a foreign fill) and FR-009 (revision cap). Each is
one condition or one constant in `revisions.ts`; neither changes the structure below.

## Constitution Check

*Against constitution v1.2.0. Run before Phase 0 and again after Phase 1 (below).*

| Principle | Obligation here | How this plan meets it | Status |
| :-- | :-- | :-- | :-- |
| **I. Zero-server** (NON-NEGOTIABLE) | No new network use | Pure in-memory parsing and appending; no dependency added | pass |
| **II. Offline-first & installable** | Works offline on all three | No new asset or fetch; same bundle | pass |
| **III. Crypto correctness** (NON-NEGOTIABLE) | Standards-compliant signature; earlier signatures stay valid; one shared path | Incremental append only; new approval signature with no `/Reference`; post-write object comparison (FR-015); `src/` shared, no shell change | pass |
| **IV. Honest posture** | No overclaiming | Success copy states what was done, never that the certification is valid (FR-019); field names shown as document data (T1) | pass |
| **V. Real readers (test-first)** | Validator evidence per distribution; tests before code | pyHanko gate with level assertion and two negative controls; one E2E per distribution on its own output; Acrobat check before release; test tasks precede implementation in each story | pass |
| **VI. Data minimisation** | Nothing new persisted | No store touched | pass |
| Tech constraints | Named distributions only | No new distribution | pass |

No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-certified-field-signing/
├── spec.md
├── plan.md
├── research.md              # R1 spike result, R2–R8 decisions, baseline
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── signing-classification.md   # types, reasons, copy
│   └── signature-gate.md           # validator mode, gate routing, fixtures
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── features/signing/
│   ├── signingPolicy.ts        # classifySigning: ok | fill-only | blocked; rules 1–8, 5a, 5b
│   ├── revisions.ts            # NEW: signed revisions, rules 5c and 5d, object comparison
│   ├── incrementalUpdate.ts    # shared append/xref/trailer tail; fillExistingSignatureField
│   ├── signIncremental.ts      # signIntoField; assertFillWellFormed
│   └── types.ts                # SigningClassification, CandidateField, FieldPlacementInput
├── features/placement/placement.ts   # field /Rect → layout box, aspect-fit
├── features/viewer/loadPdf.ts        # LoadedPdf.signing
├── features/viewer/renderPage.ts     # scripting pinned off (T9)
├── components/FieldPicker.tsx        # NEW: outlines, list, reasons
└── App.tsx                           # fill-only flow and copy

scripts/
├── make_policy_fixtures.py     # remaining fixtures (adds only)
├── validate_pdf.py             # --expect-certification-level
├── verify-signatures.mjs       # fill outputs, negative controls
└── android-gate.mjs            # --certified-field mode

tests/
├── signing/policy.test.ts          # classification per row; fills; chain; structure
├── signing/revisionSpike.test.ts   # spike, deleted by T008
├── unit/revisions.test.ts          # NEW
├── unit/loadPdf.test.ts
├── e2e/us7-certified-field.spec.ts # NEW
└── e2e-desktop/desktop-sign.spec.ts

docs/audit.md, README.md, docs/rfc-23-1-certified-empty-field.md   # updated with the change
```

**Structure Decision**: the existing single-project layout. Everything user-visible is in shared
`src/`, so the desktop and Android shells need no code change; `electron/` and `android/` are not
touched. `.github/workflows/` is touched only by T038, after the parallel item-2 change merges.

## Phases after this plan

1. **Foundation**: remaining fixtures, types, `revisions.ts` from the spike, the classification
   wired through with fill-only still shown as blocked (behaviour-neutral checkpoint).
2. **US1**: writer, signing branch, geometry, picker, gate. First point at which a certified PDF
   can be signed. Stop for review.
3. **US2**: every refusal row asserted; reasons shown; copy.
4. **US3**: the second-signer chain, app → app and pyHanko → app.
5. **US4**: desktop and Android evidence, docs, version, Acrobat check, release.

## Owner decisions (answered 2026-11-16: C1 (a), C2 (a))

| # | Question | Decision | Affects |
| :-- | :-- | :-- | :-- |
| C1 | A foreign fill that also rewrites `/Info` (FR-008) | Accept the trailer's `/Info` rewrite only; refuse XMP and everything else | T007, US3 scenario 3 |
| C2 | Cap on signed revisions after certification (FR-009) | 8 | T007, T041 |

## Post-design Constitution re-check

Re-run after writing data-model, contracts and quickstart: no change. The design added no
dependency, store, network path or distribution branch. The one place the design is stricter than
the validator (F1 in research.md, if C1 is answered "refuse") errs toward refusal, which
Principles III and IV prefer.

## Complexity Tracking

None.
