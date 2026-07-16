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
- [X] T007 [P] Set up Playwright (Chromium, Pixel 7 device) in playwright.config.ts with tests/e2e/ + fixtures
- [X] T008 npm scripts (dev, build, preview, test, e2e, e2e:pwa, verify:signatures) + pyHanko prerequisite documented in README. **Principle V enforcement now via GitHub Actions CI (T061), not a local pre-push hook** — the Husky hook was never implemented, so CI supersedes it and genuinely closes analysis finding C1
- [X] T009 [P] Add strict CSP (target `connect-src 'none'`) via index.html meta + vite config, and object-src/base-uri/form-action lockdown per research R9
- [X] T010 [P] PWA manifest.webmanifest + real 192/512/maskable icons in public/icons (dependency-free PNG encoder in scripts/make-icons.mjs; validated by the offline E2E)

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
- [X] T019 [P] CSP/precache spike — CONFIRMED: Workbox precache coexists with `connect-src 'none'` (the offline-reload E2E passes under that exact CSP; no fallback to `'self'` needed) (Principle IV)

**Checkpoint**: Foundation substantially ready. Remaining foundational: T015 (pdf.js renderer), T019 (runtime CSP check). US2 pipeline de-risked (T018).

---

## Phase 3: User Story 1 - Place a visible signature and download (Priority: P1) 🎯 MVP

**Goal**: Open a PDF, place one or more signature images, export a visibly-signed PDF — offline, on-device.

**Independent Test**: Load a PDF, add a signature image, position/scale it, download; the output shows the signature at the chosen spot; offline works; no network request carries document/image data.

### Tests for User Story 1

- [X] T020 [P] [US1] Unit test FIRST: stampVisual draws image and clamps out-of-bounds placements in tests/unit/stampVisual.test.ts (4 tests pass)
- [X] T021 [P] [US1] Playwright E2E (Pixel 7): open → render → place → Apply&Download produces a valid larger PDF; asserts SC-006 (document >50% viewport) and SC-003 (no external network) in tests/e2e/us1-visual-stamp.spec.ts — PASSING (offline-run assertion not yet added; deferred to US3)

### Implementation for User Story 1

- [X] T022 [US1] Implement Tier A stampVisual(pdf, placements) — embedPng/embedJpg + drawImage + bounds clamp in src/features/signing/stampVisual.ts (T020 green; FR-008/009/010)
- [X] T023 [P] [US1] Implement signature-image upload ingestion (PNG/JPEG decode, format detect) in src/features/ingest/imageInput.ts (+ tests)
- [X] T024 [P] [US1] Implement placement model + move/resize helpers (normalized coords) in src/features/placement/placement.ts (+ tests)
- [X] T025 [US1] Implement SignatureOverlay component (draggable/resizable image over the page) in src/components/SignatureOverlay.tsx
- [X] T026 [US1] Support multiple placements across pages (add/select/delete) in placement state + overlay UI (FR-009)
- [X] T027 [US1] Implement page navigation for multi-page documents (renderPage + App page state) (FR-003)
- [X] T028 [US1] Wire "Apply & Download" visual-only export (Blob download) in src/features/signing/export.ts + bottom-sheet action

**Checkpoint**: ✅ US1 DONE (MVP) — engine unit-tested (18 tests) AND end-to-end verified by a passing Playwright E2E on a Pixel 7 profile: open a real 2-page PDF → render → place signature → Apply & Download yields a valid larger PDF, with SC-006 (document dominance) and SC-003 (no external network) asserted. Follow-ups: add an explicit offline-run assertion (US3), image-as-signature-appearance is US2/T033.

---

## Phase 4: User Story 2 - Apply cryptographic digital signature(s) (Priority: P2)

**Goal**: Sign with a `.p12` so each placed image becomes a clickable, verifiable signature field; support multiple signatures without invalidating earlier ones.

**Independent Test**: With a placed signature, supply a valid `.p12` + password, sign; pyHanko + Acrobat confirm a valid clickable signature; a second signature leaves the first valid; tamper invalidates.

**Prerequisite**: Foundational spike T018 passed.

### Tests for User Story 2

- [X] T029 [P] [US2] Verify-test: signFirst produces a pyHanko-valid signature with an image appearance (/Subtype /Form); wrong password rejected (2 tests) in tests/signing/signFirst.test.ts
- [X] T030 [P] [US2] Verify-tests: incremental byte-append preserves prior signed bytes exactly; tamper fixture rejected by the gate (SC-007) in tests/signing/multiSign.test.ts. SC-009 (2nd sig leaves 1st valid) proven by the spike's plain+plain signed-2 (2 intact+valid sigs)
- [X] T031 [P] [US2] Playwright E2E (2 tests, passing): cert sign → download a real signed PDF (/ByteRange + Adobe.PPKLite), no external network; AND wrong-password → error shown, no download, in tests/e2e/us2-crypto-sign.spec.ts (+ .p12 fixture via global-setup)

### Implementation for User Story 2

- [X] T032 [US2] Certificate ingestion + node-forge parse + password verify (typed BadPasswordError) + signer CN in src/features/signing/cert.ts (FR-015)
- [X] T033 [US2] signFirst — visible **image-appearance** signature field (pdflibAddPlaceholder + swap AP.N form-XObject to draw the embedded image) + signer-p12 in src/features/signing/signFirst.ts. **pyHanko-VALIDATED intact+valid, ENTIRE_FILE** (FR-011/012). The hero feature works.
- [~] T034 [US2] signIncremental — byte-level placeholder-plain append, never re-serialize (prior bytes preserved, proven) in src/features/signing/signIncremental.ts (FR-013). KNOWN LIMITATION: no image appearance on incremental sigs, and after a signFirst first-sig, placeholder-plain doesn't re-find the pdf-lib AcroForm → pyHanko enumerates only the latest sig. Plain+plain multi-sign is fully valid (spike). Robust image-multi-sign = follow-up.
- [X] T035 [US2] Enforce ordering — in signWithCert, visual placements are baked via stampVisual BEFORE the crypto signFirst (stamps committed before signing) (FR-014). (Post-signature page-edit blocking in UI is implicit — no stamping happens after sign; explicit guard is a follow-up.)
- [X] T036 [US2] Detect existing signature (loadPdf.hasExistingSignature) and warn the user on open in App (FR-017). (Full incremental-allowed-vs-mutation distinction is a follow-up.)
- [X] T037 [P] [US2] Certificate sheet UI (cert upload, password field, remember toggle, sign action) in src/components/CertSheet.tsx
- [X] T038 [P] [US2] Disclosure UI — self-signed "validity unknown" + no-timestamp + on-device notice shown before signing in src/components/DisclosureBanner.tsx (FR-016)
- [X] T039 [US2] Opt-in certificate persistence (idb-keyval save/load/clear; never password/key; password re-entered) in src/features/persistence/certStore.ts (FR-021/022; contracts/persistence.md)

**Checkpoint**: ✅ US2 largely DONE — cryptographic single-signature flow works end-to-end (engine pyHanko-validated + Playwright E2E: pick .p12, enter password, get a real signed PDF; wrong password handled; opt-in remember-cert). Follow-ups: robust image-appearance MULTI-signature (T034 limitation), explicit post-sign edit guard, incremental-vs-mutation nuance.

---

## Phase 5: User Story 3 - Install to phone and use fully offline (Priority: P2)

**Goal**: Installable Android PWA that runs standalone and fully offline after first load.

**Independent Test**: Visit once online, install to home screen, enable airplane mode, launch from icon, complete a signing flow.

### Tests for User Story 3

- [X] T040 [P] [US3] Playwright E2E (production build via `e2e:pwa`): valid manifest + resolvable PNG icons + maskable; SW controls page; **offline reload still renders the app** in tests/e2e-pwa/offline.spec.ts (PASSING)

### Implementation for User Story 3

- [X] T041 [US3] manifest.webmanifest (standalone, theme/background colors) + real 192/512/maskable icons in public/icons (FR-025)
- [X] T042 [US3] Workbox precache of app shell + signing deps for full offline via vite-plugin-pwa in vite.config.ts (FR-019; honors `connect-src 'none'` per T019)

**Checkpoint**: ✅ US3 DONE — installable manifest + icons, and offline-after-first-load proven by a passing production-build E2E (also validates T019: precache works under the strict CSP).

---

## Phase 6: User Story 4 - Capture a paper signature and clean it up (Priority: P3)

**Goal**: Photograph a signature and optionally remove the paper background.

**Independent Test**: Capture/supply a photo of a signature on white paper, apply cleanup, place the cleaned overlay.

### Tests for User Story 4

- [X] T043 [P] [US4] Unit tests: removeBackground makes near-white pixels transparent, respects threshold, no mutation (3 tests) in tests/unit/bgClean.test.ts

### Implementation for User Story 4

- [X] T044 [US4] Camera capture input (accept=image/*, capture=environment) + "📷 Take photo" button in App (FR-004)
- [X] T045 [US4] Canvas background cleanup (luminance threshold → transparent PNG) in src/features/ingest/backgroundClean.ts (T043 green; optional, FR-029). Decode via <img> element (createImageBitmap fails in headless-shell Chromium).
- [X] T046 [US4] Skippable cleanup UI (preview on checkerboard + threshold slider + Use cleaned/Keep original + honest error) in src/components/CleanupSheet.tsx (FR-029). E2E-verified (tests/e2e/us4-cleanup.spec.ts).

**Checkpoint**: ✅ US4 DONE — camera capture wired; background cleanup works in-browser (E2E: add signature → Clean up → adjust slider → Use cleaned → stays placed). ALL FOUR USER STORIES COMPLETE.

**Checkpoint**: All four user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T047 [P] Error handling — friendly messages for encrypted PDF, corrupt/non-PDF file, wrong password, cleanup decode failure; certStore now degrades to memory-only silently when storage is denied (private mode/quota) (FR-028)
- [X] T048 [P] Honest-copy pass — reviewed: "not a legally-binding e-signature service" + "private & on-device" copy and the DisclosureBanner (self-signed/no-timestamp/on-device) are accurate; no overclaims (FR-027)
- [X] T049 [P] Best-effort memory cleanup — secrets (password, decrypted key) are never retained beyond the signing call (architectural); CertSheet state (cert bytes + password) is dropped on successful sign when it unmounts. Document/image are retained intentionally for continued editing (FR-023)
- [ ] T050 [P] Performance pass — NOT formally benchmarked. Placement uses lightweight pointer events + CSS transforms; large-PDF responsiveness unmeasured. Deferred (low urgency for a personal tool)
- [~] T051 [P] Accessibility — light pass: canvas has role=img + aria-label; all controls have text labels; inputs have placeholders/labels. A full audit (focus order, contrast tokens) is a follow-up
- [X] T052 Quickstart V1–V5 — covered by the automated suite: V1 us1 E2E, V2 crypto E2E + pyHanko gate, V3 multi-sign (spike; image-multi-sign caveat), V4 offline E2E, V5 cert-only persistence. `npm run verify:signatures` green
- [X] T053 [P] research.md updated with implementation deviations (Vite 5 pin, Image-decode, CSP stays 'none', multi-sign limit, pyHanko API-only)

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
  automation now runs in **GitHub Actions** (`.github/workflows/ci.yml`, task T061) on every push to
  `main` and every PR — build + tests + the pyHanko signature gate + Playwright/PWA E2E.
- Never re-serialize a signed PDF (incremental appends only) — the core invariant behind US2.
- Commit after each task or logical group.

---

## Addendum: In-app certificate generation + signature label (owner request, post-plan)

Amends the "BYO cert only" grill decision — see spec FR-018/FR-030.

- [X] T054 Generate a self-signed `.p12` Digital ID on-device (node-forge, keyUsage digitalSignature/nonRepudiation) + extract public cert DER in src/features/signing/generateCert.ts (+ 2 unit tests)
- [X] T055 Export helpers — download the `.p12` (Digital ID) and the public `.cer` (share for trust) via downloadBytes in src/features/signing/export.ts; wired into CertSheet "Create a certificate" panel
- [X] T056 Signature appearance shows "Digitally signed by {name}" text beside the image (Adobe-style), name from the cert CN, in src/features/signing/signFirst.ts (FR-030; signing tests assert the label text; pyHanko gate still green)
- [X] T057 CertSheet "Create one" flow (name + password → generate → download .p12/.cer → sign). E2E-verified in tests/e2e/us2-create-cert.spec.ts (create cert in-app → save .p12 → sign → signed PDF)
- [X] T058 Date line + user toggles — appearance renders optional "Digitally signed by {name}" and "Date: …" lines; CertSheet checkboxes toggle each on/off (both off → image only). Threaded SignRequest.showLabel/showDate → App → signFirst opts (FR-030/031; unit test asserts on/off)
- [X] T059 Uniform, non-clipping appearance text — single font/size/colour, sized to the widest line's real width + box height so long names/dates never clip (FR-030). Verified with a long-name demo
- [X] T060 Richer certificate subject — generateSelfSignedP12 takes CertSubject {commonName, organization?, organizationalUnit?, email?}; email in subject DN + subjectAltName; CertSheet gains optional Org/Division/Email inputs (FR-032; unit test parses cert + asserts O/OU/emailAddress + SAN)

- [X] T061 **GitHub Actions CI** (`.github/workflows/ci.yml`) — on every push to `main` and every PR: `verify` job (npm ci → pip install pyhanko → build → tests → **`npm run verify:signatures`** pyHanko gate) and `e2e` job (Playwright signing flows + PWA offline/installability, report uploaded on failure). **Genuinely closes analysis finding C1 / the Principle V CI deferral** — the previously-claimed local pre-push hook was never implemented, so the gate was honor-system until now.

**Note (format clarification):** `.p12`/`.pfx` (PKCS#12 = private key + cert) is the signing Digital ID Adobe uses. `.p7c`/`.cer` is the public-cert-only export used to establish trust (add signer to Trusted Identities) — not a signing format.

**Spec integration:** these additions are now reflected in spec.md (US2 scenarios 7-8; FR-030/031/032; SC-010), data-model.md (CertificateSubject/GeneratedCertificate, AppearanceOptions), contracts/signing-engine.md, and research.md (R12).
