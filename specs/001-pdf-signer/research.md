# Phase 0 Research: PDF Signer PWA

Resolves the unknowns and technology choices behind the plan. Format per decision:
**Decision / Rationale / Alternatives considered**. Highest-risk items are flagged **SPIKE**.

---

## R1 — Frontend framework & styling

**Decision**: React 18 + Vite 5 + Tailwind CSS.
**Rationale**: Owner-selected. Rich ecosystem for gesture/state handling; Vite gives fast builds
and first-class `vite-plugin-pwa`; Tailwind suits a mobile-first, document-dominant layout.
**Alternatives considered**: Preact (~35 KB lighter, near-drop-in) — attractive for a precached
PWA but ecosystem/familiarity favored React. Vanilla — smallest bundle but hand-rolled state and
gestures slow the build.

## R2 — PDF page preview

**Decision**: `pdfjs-dist` renders pages to a canvas behind the placement overlay. The pdf.js
worker is bundled locally (Vite worker import), never loaded from a CDN.
**Rationale**: pdf.js is the de-facto browser PDF renderer; local worker satisfies the no-CDN
constraint (Principle I/II). Rendering reads from an in-memory ArrayBuffer — no network.
**Alternatives considered**: Rendering via `<embed>`/native viewer — no control over overlay
coordinates or page geometry. Rejected.

## R3 — Visible signature-field appearance (image) — **SPIKE**

**Decision**: Build the signature artifacts with `pdf-lib`'s low-level object API: embed the
image as an XObject, create a Form XObject appearance stream (`/AP /N`) that draws it, attach it
to a **visible** signature widget (`/Rect` at the placement), and register an AcroForm signature
field (`/FT /Sig`, `SigFlags` 3). Use `@signpdf` only for the ByteRange placeholder + CMS splice.
**Rationale**: A clickable, validity-showing signature (FR-011/012) requires the image to be the
field's appearance, in the same object as the crypto. `@signpdf/placeholder-pdf-lib` can add a
placeholder and a widget rect, but wiring an **image appearance** onto the visible widget is not
turnkey — it is manual pdf-lib dictionary construction.
**SPIKE (do first, before UI polish)**: prove a single visible image-appearance signature that
Acrobat renders as clickable and pyHanko validates. This is the project's primary risk.
**Alternatives considered**: Decoupled page-content stamp + invisible signature — simpler but
loses clickable-validity (rejected by owner). Server-side signing — violates Principle I.

## R4 — Multiple signatures via incremental updates — **SPIKE**

**Decision**: The **first** signature may be built on a pdf-lib-assembled document (full save is
fine before any signature exists). Every **subsequent** signature is added by a **byte-level
incremental update** using `@signpdf/placeholder-plain` on the already-signed bytes — the signed
PDF is **never** re-loaded through `pdf-lib.save()`.
**Rationale**: `pdf-lib` rewrites (re-serializes) the entire file on save, which changes offsets
and breaks any existing signature. PDF incremental updates append new objects + xref without
touching prior bytes, so earlier signatures stay valid (FR-013, SC-009). This is exactly how
multi-signer PDFs work.
**Ordering rule**: all Tier-A visual (page-content) stamps must be committed before the first
Tier-B signature; after the first signature, only incremental signature additions are allowed —
no further page-content mutation (FR-014). The UI enforces and communicates this.
**SPIKE**: prove signature #2 leaves signature #1 valid in pyHanko + Acrobat.
**Alternatives considered**: Re-saving through pdf-lib for each signature — breaks prior
signatures (rejected). A certifying/DocMDP first signature — unnecessary for v1 and would block
further signing; approval signatures suffice (see Assumptions).

## R5 — Cryptographic signing primitive

**Decision**: `@signpdf/signer-p12` (which uses `node-forge`) produces a detached SHA-256
PKCS#7/CMS signature from the user's `.p12` + password. Runs fully in-browser.
**Rationale**: node-forge is pure JS (browser-capable) and parses PKCS#12; @signpdf handles the
ByteRange digest + splice. No native/WASM crypto needed.
**Dependency note**: node-forge/@signpdf expect Node globals (`Buffer`, `process`) — provide via
`vite-plugin-node-polyfills`. Verified as a known, contained integration step.
**Alternatives considered**: WebCrypto SubtleCrypto for the digest/sign — cannot parse PKCS#12
or build CMS on its own; would require hand-rolling ASN.1. Rejected for v1.

## R6 — Coordinate mapping (screen ↔ PDF user space)

**Decision**: Store each placement as **normalized page coordinates** (x, y, w, h in 0..1
relative to the page box) + page index + page rotation, captured from the pdf.js viewport. At
export, convert to PDF points using the page MediaBox and rotation (pdf.js origin is top-left;
PDF user space origin is bottom-left).
**Rationale**: Normalized coords are resolution/zoom-independent, so placement survives preview
scaling and device pixel ratio, and maps deterministically to `pdf-lib` page geometry.
**Alternatives considered**: Storing raw CSS pixels — breaks under zoom/DPR/rotation. Rejected.

## R7 — On-device persistence (opt-in certificate only)

**Decision**: `idb-keyval` stores the password-protected `.p12` bytes in IndexedDB **only** when
the user opts in ("remember certificate"); a single, disclosed, clearable entry. The password and
any decrypted key material are never written — the password is re-entered each session
(FR-021/022).
**Rationale**: Satisfies Principle VI and the owner's "remember cert" choice while keeping the
absolute secret carve-out. The stored `.p12` is already password-encrypted at rest.
**Alternatives considered**: Remembering documents/images — out of scope for v1 (owner). Storing
the password (even encrypted) — forbidden by Principle VI. Rejected.

## R8 — Verification harness (the Principle V gate)

**Decision**: `scripts/verify-signatures.mjs` runs **pyHanko** (`pyhanko sign validate`) over
signed PDFs produced by the signing tests, with poppler `pdfsig` as a fallback/cross-check.
Playwright drives the real in-browser flow and exports output for validation. Vitest covers
units (coordinate math, byte-range assembly, placeholder logic). Acrobat is a manual per-release
spot-check (appearance rendering, click-to-validate UX).
**CI note**: GitHub Actions is deferred (git local per owner) — the gate runs locally via
`npm run verify:signatures` and MUST pass before any signing-path change is considered done.
Wiring Actions later makes it automatic; the gate itself exists now.
**Alternatives considered**: Acrobat-only verification — not automatable (rejected as the gate;
kept as spot-check). Trusting internal assertions only — the exact failure mode Principle V
forbids.

## R9 — Content Security Policy — **SPIKE (small)**

**Decision**: Target CSP:
`default-src 'self'; connect-src 'none'; img-src 'self' data: blob:; script-src 'self';
worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none';
form-action 'none'`.
**Rationale**: The app never fetches user data; files arrive via `<input>`, everything else is
precached. `connect-src 'none'` makes outbound data exfiltration structurally impossible
(Principle I).
**SPIKE**: confirm Workbox precaching coexists with `connect-src 'none'` (service-worker fetch of
same-origin assets runs in the SW context, governed by the SW response's own CSP, not the page's
`connect-src`). **If** precache requires it, fall back to `connect-src 'self'` — still no
third-party origins, still zero user-data egress; disclose the exact policy honestly per
Principle IV. Decision is `'none'` unless the spike proves it blocks precache.
**Alternatives considered**: `connect-src 'self'` from the start — slightly weaker guarantee than
necessary; only adopt if required.

## R10 — Signature background cleanup (US4, optional)

**Decision**: Client-side canvas processing — luminance threshold to alpha with a user-adjustable
threshold slider, producing a transparent-background PNG. Offered as an optional step; never
required (FR-024/029).
**Rationale**: Cheap, fully local, good enough for clean white-paper photos; the slider handles
lighting variance.
**Alternatives considered**: Otsu auto-thresholding or ML matting — heavier, deferrable to v1.1;
noted as future enhancement. Kept simple per plan.

## R11 — PWA shell, manifest & installability

**Decision**: `vite-plugin-pwa` (Workbox `generateSW`) precaches the app shell + all signing
deps for offline; `manifest.webmanifest` with `display: standalone`, `theme_color`,
`background_color`, and 192 / 512 / maskable icons.
**Rationale**: Turnkey manifest + service worker generation with local asset bundling satisfies
Principles I and II and Android installability (FR-019/020/025).
**Alternatives considered**: Hand-written service worker — more control, more maintenance;
unnecessary for a precache-only strategy.

## Open risks carried into Phase 1

- **Primary risk**: R3 + R4 (visible image appearance + incremental multi-signature). Mitigation:
  a signing-engine spike is the first implementation task, validated by pyHanko + Acrobat before
  any UI work depends on it.
- **Secondary**: R9 CSP/precache interaction — small spike, honest fallback documented.
