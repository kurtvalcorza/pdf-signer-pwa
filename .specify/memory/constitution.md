<!--
SYNC IMPACT REPORT
==================
Version change: (template / unratified) → 1.0.0
Bump rationale: Initial ratification of the project constitution (MAJOR baseline).

Modified principles: N/A (first ratification)
Refined during ratification review (constitution "grill"): scope committed to both
tiers in v1; V names an automatable validator as the CI authority; IV adds the
purpose/non-goal statement; added Principle VI. Kept at 1.0.0 (uncommitted, no prior
consumer) — refinements are part of the initial ratification, not a later amendment.
Added principles:
  - I. Zero-Server, Client-Side Only (NON-NEGOTIABLE)
  - II. Offline-First & Installable
  - III. Cryptographic Correctness & Standards Compliance (NON-NEGOTIABLE)
  - IV. Honest Security Posture & Purpose (No Overclaiming)
  - V. Verify Against Real Readers (Test-First)
  - VI. On-Device Data Minimization
Added sections:
  - Technology & Deployment Constraints (Section 2)
  - Development Workflow & Quality Gates (Section 3)
  - Governance

Templates requiring updates:
  - ✅ .specify/templates/plan-template.md — Constitution Check gate is generic
    ("[Gates determined based on constitution file]"); no hardcoded principle
    references to change. Gates are derived per-plan from this file.
  - ✅ .specify/templates/spec-template.md — mandatory sections unaffected.
  - ✅ .specify/templates/tasks-template.md — no principle references; unaffected.
  - ✅ .specify/templates/checklist-template.md — unaffected.

Follow-up TODOs: none. All placeholders resolved.
-->

# PDF Signer PWA Constitution

## Core Principles

### I. Zero-Server, Client-Side Only (NON-NEGOTIABLE)

All document processing, image manipulation, and cryptographic operations MUST execute
entirely within the browser runtime on the user's device. No PDF, signature image, `.p12`
certificate, password, or derived material may ever be transmitted to, logged by, or stored
on any server. The hosting platform (Vercel) serves static assets only and MUST NOT receive
user content. A strict Content Security Policy with `connect-src 'none'` MUST be enforced so
the application is structurally incapable of making outbound requests with user data. Any
feature that would require server-side processing of user content is out of scope by
definition and MUST be rejected, not worked around.

**Rationale**: The entire value proposition is provable privacy. A single network path for
user content collapses the guarantee; this principle is the product, not an optimization.

### II. Offline-First & Installable

After first load, the application MUST be fully functional with no network connection. A
service worker MUST precache the application shell and every dependency required for signing
(PDF engine, crypto libraries, renderer). The app MUST ship a valid web app manifest
(standalone display, 192px + 512px + maskable icons, HTTPS) so it is installable to the
Android home screen. All assets MUST be bundled and served same-origin — no CDN, no runtime
remote fetch (this also follows directly from Principle I).

**Rationale**: A privacy tool that only works online is a contradiction; offline capability is
both a UX feature and a reinforcement of the zero-network guarantee.

### III. Cryptographic Correctness & Standards Compliance (NON-NEGOTIABLE)

When a `.p12` is supplied, the output MUST be a standards-compliant PDF digital signature that
a compliant reader (e.g., Adobe Acrobat) validates: a detached PKCS#7/CMS signature over a
correct `/ByteRange`, housed in an AcroForm signature field. The signing sequence MUST respect
byte-range integrity — the signature placeholder is added, the file is saved, the ByteRange is
hashed, the CMS is produced, and it is spliced into `/Contents` WITHOUT shifting any byte. No
page-content mutation may occur after the placeholder is inserted. Cryptography MUST NOT be
mocked, stubbed, faked, or "approximated" in shipped code paths; a signature the app presents
as valid MUST actually verify.

**Rationale**: A signing tool whose signatures do not verify is worse than useless — it is
misleading. Correctness here is a safety property, not a feature toggle.

**v1 scope note**: Both tiers ship in v1 — the visual image stamp (Tier A) AND the integrated
PKCS#12 signature (Tier B). This principle therefore gates from day one, not from a future
release.

### IV. Honest Security Posture & Purpose (No Overclaiming)

**Purpose & non-goal**: The product is positioned as a privacy-preserving convenience and
tamper-evidence tool — a private way to visibly sign and optionally cryptographically seal a
PDF entirely on-device. It does NOT claim to produce legally-binding, qualified, or advanced
electronic signatures in any jurisdiction, and MUST NOT present itself as legal advice or as a
substitute for a qualified trust-service provider. UI and copy MUST reflect this positioning.

Every security or privacy claim surfaced to the user MUST be accurate and, where possible,
auditable. Specifically: the CSP is described as an enforced control, not a mathematical
proof; in-memory secret handling is described as best-effort reference-dropping, never as
guaranteed erasure (JavaScript cannot guarantee zeroing); a self-signed certificate is
presented as "validity unknown" until trusted, matching reader behavior; the absence of a
trusted timestamp (no RFC-3161 / no LTV, a consequence of offline operation) MUST be disclosed
where signature longevity matters. Marketing language that outruns technical reality is a
defect.

**Rationale**: Users making trust decisions about signed documents deserve claims that hold up
to scrutiny. Overclaiming — including implying legal weight the design cannot deliver offline —
destroys the credibility the privacy story depends on.

### V. Verify Against Real Readers (Test-First)

Signature-producing and PDF-manipulating code MUST be developed test-first: an executable
check is written and seen to fail before the implementation is written. Beyond unit tests, any
change to the signing path MUST be verified end-to-end by validating produced output with a
standards-compliant validator — not merely by asserting internal state. The **enforceable CI
authority** is an automatable open-source validator (**pyHanko** preferred, or poppler's
`pdfsig`) that confirms the PKCS#7/CMS signature and `/ByteRange` integrity on every signing-
path change. **Adobe Acrobat is used as a periodic manual spot-check** (appearance rendering,
click-to-validate behavior, trust-prompt UX) but is NOT the CI gate, because it cannot run
headless. A signing change is not "done" until the automated validator passes; Acrobat
spot-checks confirm the human-facing experience.

**Rationale**: PDF signing has many subtle, silent failure modes (byte offsets, appearance
streams, field wiring) that pass internal assertions but fail real validators. An automatable
validator makes correctness an enforceable gate rather than a discipline-dependent ritual;
Acrobat spot-checks catch appearance/UX issues a validator does not model.

### VI. On-Device Data Minimization

User content is handled in memory by default. The application MUST NOT persist the user's PDF,
signature image, or certificate to any on-device store (IndexedDB, localStorage,
sessionStorage, Cache Storage, the file system) unless the user has explicitly opted in for a
named convenience (e.g., remembering recent documents or a certificate), and that persistence
MUST be disclosed at the point of opt-in and be clearable by the user. Two carve-outs are
absolute and admit no opt-in: the `.p12`/certificate **password** MUST NEVER be persisted, and
**decrypted private-key material** MUST NEVER be written to any store — both exist only
transiently in memory during a signing operation. The service-worker precache (Principle II)
covers application assets ONLY, never user content.

**Rationale**: "Zero-server" is hollow if the user's certificate and password sit in browser
storage on a shared or lost device. Minimizing on-device residency — and forbidding secret
persistence outright — is the on-device half of the privacy guarantee.

## Technology & Deployment Constraints

- **Runtime**: Browser-only PWA. Target Android/Chrome as the primary install platform;
  desktop browsers are supported. iOS is best-effort (Safari PWA limitations acknowledged).
- **Core stack**: Vite + React + `vite-plugin-pwa` (manifest + Workbox service worker);
  `pdf-lib` for PDF assembly and signature-field/appearance construction; `pdf.js` for on-screen
  preview; `@signpdf/signpdf` + `@signpdf/placeholder-pdf-lib` + `@signpdf/signer-p12` (over
  `node-forge`) for the ByteRange placeholder, CMS signing, and byte-safe splice. `pdf-lib`
  alone MUST NOT be relied on for signing — it has no signing API.
- **Deployment**: Static build to Vercel (Vite preset, `dist` output). No serverless functions
  handling user content. Public GitHub repo with Vercel auto-deploy is the standard pipeline.
- **Signature validation (dev/CI tooling)**: `pyHanko` (preferred) or poppler `pdfsig` runs in
  CI to validate produced signatures (Principle V). These are development/test dependencies and
  never ship in the client bundle.
- **Dependencies**: Prefer lightweight, well-maintained libraries. New dependencies that pull in
  network calls, telemetry, or remote asset loading are prohibited (Principle I).

## Development Workflow & Quality Gates

- **Spec-driven**: Work flows through the Spec Kit lifecycle — constitution → specify → plan →
  tasks → implement. Each feature has a spec before code.
- **Constitution Check**: Every plan MUST pass a Constitution Check gate before Phase 0 and
  re-check after design. Violations MUST be justified in writing or the design revised.
- **Signing-path gate**: No change touching the cryptographic or PDF-mutation path merges
  without (a) test-first coverage and (b) a passing automated-validator check (pyHanko / poppler
  `pdfsig`) on a produced signature (Principle V). Acrobat spot-check before releasing
  signing-path changes.
- **Privacy gate**: Any change that introduces or could introduce an outbound network request
  carrying user-derived data is blocked and MUST be redesigned (Principle I). CSP MUST remain
  `connect-src 'none'`.
- **Data-minimization gate**: Any change that writes user content to on-device storage MUST be
  behind an explicit, disclosed opt-in; any change that persists a certificate password or
  decrypted private key is blocked outright (Principle VI).
- **Review**: Changes are reviewed for compliance with these principles; complexity must be
  justified against the simplest design that satisfies the spec.

## Governance

This constitution supersedes other development practices for the PDF Signer PWA. Where a
proposed change conflicts with a principle, the principle prevails unless the constitution is
formally amended first.

- **Amendments** require a documented rationale, a version bump per the policy below, and
  propagation of any affected guidance into dependent templates and docs.
- **Versioning policy** (semantic): MAJOR for backward-incompatible governance or
  principle removals/redefinitions; MINOR for a new principle/section or materially expanded
  guidance; PATCH for clarifications and non-semantic refinements.
- **Compliance review**: All plans and reviews MUST verify adherence to the Core Principles.
  The two NON-NEGOTIABLE principles (I and III) admit no exceptions; a change that violates
  either MUST NOT ship.

**Version**: 1.0.0 | **Ratified**: 2026-07-13 | **Last Amended**: 2026-07-13
