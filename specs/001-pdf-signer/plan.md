# Implementation Plan: PDF Signer PWA

**Branch**: `001-pdf-signer` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-pdf-signer/spec.md`

## Summary

A privacy-first, offline-first, client-only Progressive Web App that lets a user open a PDF,
place one or more signature images (uploaded or camera-captured), and optionally apply one or
more standards-compliant PKCS#12 digital signatures — entirely on-device. The technical crux is
Tier B: producing an Acrobat-verifiable signature where the placed image is the **appearance of
the signature field itself**, and supporting **multiple signatures via incremental updates** so
a later signature never invalidates an earlier one. The UI keeps the document dominant with a
collapsing bottom sheet for controls.

## Technical Context

**Language/Version**: TypeScript 5.x, targeting ES2022 browsers; Node 20 for build/tooling.

**Primary Dependencies**: React 18 + Vite 5 + `vite-plugin-pwa` (Workbox) + Tailwind CSS;
`pdfjs-dist` (page preview); `pdf-lib` (PDF assembly + signature field/widget/appearance
construction); `@signpdf/signpdf` + `@signpdf/placeholder-pdf-lib` + `@signpdf/placeholder-plain`
+ `@signpdf/signer-p12` (over `node-forge`) for ByteRange placeholder, CMS signing, byte-safe
splice, and incremental subsequent signatures; `idb-keyval` (opt-in certificate persistence);
`vite-plugin-node-polyfills` (Buffer/process polyfills required by node-forge/@signpdf).

**Storage**: In-memory by default. IndexedDB (via `idb-keyval`) is used ONLY for the opt-in
"remember certificate" convenience (stores the password-protected `.p12` bytes; NEVER the
password or decrypted key) and the opt-in "remember signature" convenience (stores the last-used
signature image bytes + format). Both are explicit, disclosed, clearable, and never auto-saved.
No document persistence.

**Testing**: Vitest (unit/component); Playwright (E2E, headless Chromium — drives real
in-browser signing and captures output); pyHanko CLI (Python — signature validation, the
enforceable gate) with poppler `pdfsig` as fallback; Adobe Acrobat manual spot-check per
release.

**Target Platform**: Evergreen browsers; Android/Chrome primary and installable as a PWA;
desktop browsers supported; iOS best-effort.

**Project Type**: Client-only single-page web application (frontend only; no backend, no
serverless handling of user content).

**Performance Goals**: 60 fps drag/pinch placement on a mid-range Android; open → place → export
in under 60 s unaided (SC-001); single-signature signing of a typical document under ~2 s (goal);
precache bundle small enough for a fast install.

**Constraints**: CSP `connect-src 'none'` (target) — zero network for user data; fully
functional offline after first load; no CDN / all assets same-origin; all secrets in memory only;
**a signed PDF is NEVER re-serialized** (subsequent signatures are byte-level incremental
appends only).

**Scale/Scope**: Single user; one primary signing screen plus bottom-sheet flows; multi-page
PDFs of reasonable size (tens of MB); multiple signatures per document.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates derived from Constitution v1.0.0 (6 principles):

| Principle | Gate | Status |
|-----------|------|--------|
| I. Zero-Server, Client-Side Only (NON-NEG) | No network path carries user data; static hosting only; CSP `connect-src 'none'` | ✅ Design honors — no XHR/fetch of user data; files via `<input>`; see research R9 (CSP) |
| II. Offline-First & Installable | SW precache of shell + all signing deps; valid manifest; installable | ✅ `vite-plugin-pwa`/Workbox precache; manifest + icons in Phase 1 |
| III. Cryptographic Correctness (NON-NEG) | Real PKCS#7/CMS over correct ByteRange; no page mutation after placeholder; no mocked crypto; multi-sig via incremental updates | ✅ Design honors — see research R3/R4; **early spike required** to de-risk visible appearance + incremental multi-sign |
| IV. Honest Security Posture & Purpose | UI discloses self-signed/no-timestamp; no legal-binding claims | ✅ FR-016/FR-022/FR-027; disclosure copy in Phase 1 UI contract |
| V. Verify Against Real Readers (Test-First) | pyHanko/`pdfsig` validation gate + Acrobat spot-check; TDD | ⚠️ Honored, but CI deferred (git local per owner) → gate runs via `npm run verify:signatures`, **enforced by a local pre-push git hook (task T008)** until GitHub Actions is wired. Documented, not skipped |
| VI. On-Device Data Minimization | In-memory default; opt-in cert + signature image (disclosed, clearable); never password/key/document | ✅ FR-020/021/022; `idb-keyval` cert + signature store |

**Result**: PASS. No violations. One accepted, documented deviation: the V gate is currently
local-only (CI deferred) — it remains mandatory to run, just not yet automated on push.

## Project Structure

### Documentation (this feature)

```text
specs/001-pdf-signer/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (internal module contracts)
│   ├── signing-engine.md
│   ├── viewer-placement.md
│   └── persistence.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
public/
├── manifest.webmanifest
└── icons/                    # 192, 512, maskable PWA icons

src/
├── main.tsx                  # app entry, SW registration
├── App.tsx                   # top-level layout (document-dominant + bottom sheet)
├── components/               # presentational: DocumentStage, SignatureOverlay,
│                             #   BottomSheet, CertSheet, DisclosureBanner
├── features/
│   ├── viewer/               # pdf.js rendering + page navigation
│   ├── placement/            # drag/pinch model, normalized coordinates
│   ├── signing/              # THE ENGINE: Tier A stamp + Tier B crypto + incremental multi-sign
│   ├── ingest/               # image input (upload + camera capture) + optional background cleanup
│   └── persistence/          # opt-in certificate + signature store (idb-keyval)
├── lib/                      # coordinate transforms, pdf byte utils, csp/manifest helpers
└── styles/                   # Tailwind entry

tests/
├── unit/                     # Vitest
├── e2e/                      # Playwright (headless Chromium)
└── signing/                  # produce signed output → validate with pyHanko/pdfsig

scripts/
└── verify-signatures.mjs     # runs pyHanko/pdfsig over test-produced PDFs (the V gate)

index.html · vite.config.ts · tailwind.config.ts · package.json · tsconfig.json · .gitignore
```

**Structure Decision**: Single client-only project, organized by feature folders under `src/`.
The `signing/` feature is the load-bearing module and is isolated behind a contract
(`contracts/signing-engine.md`) so it can be tested and validated independently of the UI.

## Complexity Tracking

No constitution violations. Two sources of essential complexity are documented (not violations,
but flagged so they are designed deliberately):

| Complexity | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Dual placeholder strategy (pdf-lib-built field for the first signature; byte-level `placeholder-plain` incremental append for subsequent signatures) | Full multi-signature (FR-013) requires never re-serializing signed bytes; `pdf-lib.save()` rewrites the whole file and would break prior signatures | A single pdf-lib-based flow re-serializes on every save → invalidates earlier signatures. Rejected as incompatible with Principle III |
| Ordering constraint: all Tier-A visual (page-content) stamps committed before any Tier-B signature | Page-content changes after a signature invalidate it (Principle III / FR-014) | Allowing stamps after signing silently corrupts signatures. Rejected |
