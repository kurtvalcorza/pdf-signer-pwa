---
description: "Task list for PDF Signer PWA (001-pdf-signer)"
---

# Tasks: PDF Signer PWA

**Input**: Design documents from `specs/001-pdf-signer/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: INCLUDED. Constitution Principle V mandates test-first for the signing path plus a
pyHanko validation gate. Signing/coordinate code is TDD; UI is covered by Playwright E2E per story.

**Organization**: Grouped by user story. Story completion order matches spec priorities
(US1 P1 → US2 P2 → US3 P2 → US4 P3).

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no incomplete-task dependency)
- **[Story]**: US1–US4 (user-story phases only)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and tooling.

- [X] T001 Scaffold Vite + React 18 + TypeScript project at repo root (package.json, tsconfig.json, index.html, src/main.tsx, src/App.tsx)
- [X] T002 [P] Configure Tailwind CSS (tailwind.config.ts, postcss.config.js, src/styles/index.css)
- [X] T003 [P] Configure vite.config.ts with vite-plugin-pwa and vite-plugin-node-polyfills (Buffer/process for node-forge/@signpdf) — pinned Vite 5 (node-polyfills lacks Vite 6 peer)
- [X] T004 [P] Install runtime deps in package.json: pdfjs-dist, pdf-lib, @signpdf/signpdf, @signpdf/placeholder-pdf-lib, @signpdf/placeholder-plain, @signpdf/signer-p12, node-forge, idb-keyval
- [X] T005 [P] Configure ESLint + Prettier (2-space, single quotes, semicolons) — eslint.config.js (flat) + .prettierrc
- [X] T006 [P] Set up Vitest (test config in vite.config.ts; tests/ directory)
- [ ] T007 [P] Set up Playwright (headless Chromium) in playwright.config.ts with tests/e2e/ directory
- [ ] T008 Add npm scripts (dev, build, preview, test, e2e, verify:signatures) to package.json, document pyHanko prerequisite in README.md, and add a local **pre-push git hook** (Husky) that runs `npm run verify:signatures` so the Principle V gate is enforced locally until GitHub Actions is wired (closes analysis finding C1) — PARTIAL: npm scripts done; README + pre-push hook pending
- [X] T009 [P] Add strict CSP (target `connect-src 'none'`) via index.html meta + vite config, and object-src/base-uri/form-action lockdown per research R9
- [ ] T010 [P] Add PWA manifest.webmanifest + placeholder 192/512/maskable icons in public/ — PARTIAL: manifest done; icon PNGs pending

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared infrastructure. **⚠️ Includes the CRITICAL signing spike (T018) that de-risks
the whole crypto approach before UI is built on it.**

- [X] T011 Define signing-engine contract types in src/features/signing/types.ts (per contracts/signing-engine.md)
- [X] T012 [P] Implement PDF ingestion — load bytes + detect encryption/reject in src/features/viewer/loadPdf.ts
- [X] T013 [P] Unit tests FIRST for coordinate transforms (round-trip, rotation, bounds) in tests/unit/coords.test.ts (6 passing)
- [X] T014 Implement coordinate transform lib (screenToNormalized, normalizedBoxToPdfRect) in src/lib/coords.ts to make T013 pass (research R6)
- [ ] T015 [P] Implement pdf.js page renderer with locally-bundled worker in src/features/viewer/renderPage.ts
- [X] T016 Implement app shell — document-dominant stage + collapsing bottom-sheet skeleton in src/App.tsx and src/components/{DocumentStage,BottomSheet}.tsx (FR-026)
- [X] T017 Implement the verification harness (pyHanko via scripts/validate_pdf.py + scripts/verify-signatures.mjs over tests/signing/out/)
- [X] T018 **[CRITICAL SPIKE]** Prove signing primitives in tests/signing/spike.test.ts + src/features/signing/spike/: (b) incremental multi-signature (placeholder-plain append) + visible widget signatures, pyHanko-validated as intact+valid, first signature stays valid after the second (SC-009). **NOTE:** sub-item (a) image-AS-appearance-stream is deferred to signFirst/T033 — the spike used a default widget appearance. Pipeline de-risked; Acrobat manual spot-check still pending. **GATE for US2: pipeline proven.**
- [ ] T019 [P] CSP/precache spike — confirm Workbox precache coexists with `connect-src 'none'`; if not, set fallback `'self'` and record the honest final policy in research.md (Principle IV) — build generates SW OK; runtime coexistence check pending (needs browser)

**Checkpoint**: Foundation substantially ready. Remaining foundational: T015 (pdf.js renderer), T019 (runtime CSP check). US2 pipeline de-risked (T018).

---

## Phase 3: User Story 1 - Place a visible signature and download (Priority: P1) 🎯 MVP

**Goal**: Open a PDF, place one or more signature images, export a visibly-signed PDF — offline, on-device.

**Independent Test**: Load a PDF, add a signature image, position/scale it, download; the output shows the signature at the chosen spot; offline works; no network request carries document/image data.

### Tests for User Story 1

- [X] T020 [P] [US1] Unit test FIRST: stampVisual draws image and clamps out-of-bounds placements in tests/unit/stampVisual.test.ts (4 tests pass)
- [ ] T021 [P] [US1] Playwright E2E: open → place → download → signature present, offline run, no data-bearing network request, AND assert the document occupies the majority of the viewport (SC-006) in tests/e2e/us1-visual-stamp.spec.ts — PENDING (Playwright not set up)

### Implementation for User Story 1

- [X] T022 [US1] Implement Tier A stampVisual(pdf, placements) — embedPng/embedJpg + drawImage + bounds clamp in src/features/signing/stampVisual.ts (T020 green; FR-008/009/010)
- [X] T023 [P] [US1] Implement signature-image upload ingestion (PNG/JPEG decode, format detect) in src/features/ingest/imageInput.ts (+ tests)
- [X] T024 [P] [US1] Implement placement model + move/resize helpers (normalized coords) in src/features/placement/placement.ts (+ tests)
- [X] T025 [US1] Implement SignatureOverlay component (draggable/resizable image over the page) in src/components/SignatureOverlay.tsx
- [X] T026 [US1] Support multiple placements across pages (add/select/delete) in placement state + overlay UI (FR-009)
- [X] T027 [US1] Implement page navigation for multi-page documents (renderPage + App page state) (FR-003)
- [X] T028 [US1] Wire "Apply & Download" visual-only export (Blob download) in src/features/signing/export.ts + bottom-sheet action

**Checkpoint**: US1 ASSEMBLED — engine unit-tested (stampVisual/coords/ingest/placement, 18 tests), UI builds clean and **renders live** (empty state + controls, no console errors). REMAINING to call US1 "done": end-to-end click-through (drag a signature onto a real PDF and download) is not yet automated — T021 Playwright E2E pending; live drag+download not click-verified in-browser this session.

---

## Phase 4: User Story 2 - Apply cryptographic digital signature(s) (Priority: P2)

**Goal**: Sign with a `.p12` so each placed image becomes a clickable, verifiable signature field; support multiple signatures without invalidating earlier ones.

**Independent Test**: With a placed signature, supply a valid `.p12` + password, sign; pyHanko + Acrobat confirm a valid clickable signature; a second signature leaves the first valid; tamper invalidates.

**Prerequisite**: Foundational spike T018 passed.

### Tests for User Story 2

- [ ] T029 [P] [US2] Verify-test FIRST: signFirst produces a pyHanko-valid, clickable, visible-appearance signature in tests/signing/signFirst.test.ts
- [ ] T030 [P] [US2] Verify-test FIRST: signIncremental leaves the prior signature valid, and a tampered byte invalidates, in tests/signing/multiSign.test.ts (SC-007/009)
- [ ] T031 [P] [US2] Playwright E2E: cert sign → download → validity + remember-cert opt-in + password re-entry in tests/e2e/us2-crypto-sign.spec.ts

### Implementation for User Story 2

- [ ] T032 [US2] Implement certificate ingestion + node-forge parse + password verify (typed BadPasswordError) in src/features/signing/cert.ts (FR-015)
- [ ] T033 [US2] Implement signFirst — visible image-appearance signature field (pdf-lib dicts + @signpdf placeholder-pdf-lib + signer-p12) in src/features/signing/signFirst.ts (productionize spike; make T029 pass; FR-011/012)
- [ ] T034 [US2] Implement signIncremental — byte-level placeholder-plain append, never re-serialize in src/features/signing/signIncremental.ts (make T030 pass; FR-013)
- [ ] T035 [US2] Enforce ordering — visual stamps committed before crypto signing; block post-signature page edits in engine + placement state (FR-014)
- [ ] T036 [US2] Detect existing signature and warn on invalidation in src/features/viewer/loadPdf.ts + UI (FR-017)
- [ ] T037 [P] [US2] Certificate sheet UI (cert upload, password field, sign action) in src/components/CertSheet.tsx
- [ ] T038 [P] [US2] Disclosure UI — self-signed "validity unknown" + no-timestamp notice shown before signing in src/components/DisclosureBanner.tsx (FR-016)
- [ ] T039 [US2] Implement opt-in certificate persistence (idb-keyval save/load/clear; never password/key) in src/features/persistence/certStore.ts (FR-021/022; contracts/persistence.md)

**Checkpoint**: User Stories 1 AND 2 both work independently.

---

## Phase 5: User Story 3 - Install to phone and use fully offline (Priority: P2)

**Goal**: Installable Android PWA that runs standalone and fully offline after first load.

**Independent Test**: Visit once online, install to home screen, enable airplane mode, launch from icon, complete a signing flow.

### Tests for User Story 3

- [ ] T040 [P] [US3] Playwright E2E / manual checklist: install prompt, standalone launch, airplane-mode full flow in tests/e2e/us3-install-offline.spec.ts

### Implementation for User Story 3

- [ ] T041 [US3] Finalize manifest.webmanifest (standalone, theme/background colors) + real 192/512/maskable icons in public/ (FR-025)
- [ ] T042 [US3] Configure Workbox precache of app shell + all signing deps for full offline in vite.config.ts (FR-019; honor CSP from T019)

**Checkpoint**: App is installable and offline-capable.

---

## Phase 6: User Story 4 - Capture a paper signature and clean it up (Priority: P3)

**Goal**: Photograph a signature and optionally remove the paper background.

**Independent Test**: Capture/supply a photo of a signature on white paper, apply cleanup, place the cleaned overlay.

### Tests for User Story 4

- [ ] T043 [P] [US4] Unit test FIRST: luminance threshold yields a transparent-background PNG in tests/unit/bgClean.test.ts

### Implementation for User Story 4

- [ ] T044 [US4] Add camera capture input (accept=image/*, capture=environment) in src/features/ingest/imageInput.ts (FR-004)
- [ ] T045 [US4] Implement canvas background cleanup (threshold + adjustable slider → cleanedBytes) in src/features/ingest/backgroundClean.ts (make T043 pass; optional path, FR-029)
- [ ] T046 [US4] Add skippable cleanup UI step (preview + threshold slider) in src/components/CleanupSheet.tsx (FR-029)

**Checkpoint**: All four user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T047 [P] Error handling + user-friendly messages for all edge cases (encrypted PDF, corrupt file/.p12, storage denied, first-load-offline) across features (FR-028)
- [ ] T048 [P] Honest-copy pass — purpose/non-goal and no-legal-binding text in UI (FR-027)
- [ ] T049 [P] Best-effort memory cleanup — drop refs to document/image/decrypted key/password after export (FR-023)
- [ ] T050 [P] Performance pass — 60 fps placement, large-PDF responsiveness (plan Performance Goals)
- [ ] T051 [P] Accessibility pass — ARIA, focus order, contrast (workspace guidelines)
- [ ] T052 Run full quickstart.md validation (V1–V5) and confirm `npm run verify:signatures` is green
- [ ] T053 [P] Update CLAUDE.md / research.md with any deviations discovered (e.g., final CSP)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: after Setup. T011–T016 unblock US1; T017–T018 (spike) additionally unblock US2.
- **US1 (Phase 3)**: after T011–T016. No dependency on the crypto spike — can proceed while T018 runs.
- **US2 (Phase 4)**: after Foundational **including the T018 spike gate**.
- **US3 (Phase 5)**: after Setup + Foundational; independent of US1/US2 logic but validated against a working flow.
- **US4 (Phase 6)**: after US1 (extends image ingestion/placement).
- **Polish (Phase 7)**: after the desired stories are complete.

### Story independence

- US1 is a standalone MVP (visual stamp; no crypto).
- US2 builds on US1's placement but is independently testable via the signing engine + pyHanko.
- US3 is orthogonal (PWA shell) and testable on any working flow.
- US4 extends US1 ingestion; the base app works without it.

### Parallel opportunities

- Setup: T002–T007, T009, T010 in parallel.
- Foundational: T012, T013, T015 parallel; **run T018 spike early, in parallel with US1 build**.
- US1: T020/T021 (tests) parallel; T023/T024 parallel.
- US2: T029/T030/T031 (tests) parallel; T037/T038 parallel.

---

## Parallel Example: User Story 1

```bash
# Tests first (parallel):
Task: "Unit test stampVisual bounds in tests/unit/stampVisual.test.ts"    # T020
Task: "Playwright E2E visual stamp in tests/e2e/us1-visual-stamp.spec.ts"  # T021

# Then parallel implementation:
Task: "Signature image ingestion in src/features/ingest/imageInput.ts"    # T023
Task: "Placement model + gestures in src/features/placement/placement.ts" # T024
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 Setup.
2. Phase 2 Foundational T011–T016 (defer/parallelize the T018 spike).
3. Phase 3 User Story 1.
4. **STOP and VALIDATE** — visual stamp works offline, no data egress. Demoable MVP.

### De-risk in parallel

Run the **T018 signing spike early** (alongside US1). It gates US2, and it is the single most
likely thing to fail — proving it before building the crypto UI avoids sunk cost.

### Incremental Delivery

Setup + Foundational → US1 (MVP) → US2 (crypto) → US3 (install/offline) → US4 (camera cleanup),
each an independently testable, deployable increment.

---

## Notes

- [P] = different files, no incomplete-task dependency.
- Signing-path and coordinate tasks are TDD (test before implementation) per Constitution V.
- `npm run verify:signatures` (pyHanko) must pass for any signing-path task to be "done". CI
  automation is deferred (git local); a **local pre-push git hook (T008)** enforces the gate on
  every push until GitHub Actions is wired.
- Never re-serialize a signed PDF (incremental appends only) — the core invariant behind US2.
- Commit after each task or logical group.
