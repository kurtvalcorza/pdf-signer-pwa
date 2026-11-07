<!--
SYNC IMPACT REPORT
==================
Version change: 1.1.0 → 1.2.0
Bump rationale: MINOR. Adds a third distribution, a native Android app package (feature 003), with
its obligation stated under each affected principle. Nothing is removed or redefined: every rule for
web and desktop is unchanged, and the new clauses only add. Approved by the owner on 2026-11-07.

Modified principles (titles unchanged):
- I. Zero-Server, Client-Side Only: adds the Android network prohibition (content policy retained,
  plus no network permission so the OS denies access).
- II. Offline-First & Installable: adds Android's installable form.
- IV. Honest Security Posture & Purpose: adds the Android disclosures. It runs on the system web
  view rather than a bundled engine, so the frozen-engine clause does not apply as written; its own
  weaknesses are named instead.
- V. Verify Against Real Readers: names the Android package in the per-distribution rule.
- VI. On-Device Data Minimization: adds platform backup and device-to-device transfer as ways stored
  data leaves a device, which must be excluded.

Modified sections: Technology & Deployment Constraints (lists the third distribution); Development
Workflow & Quality Gates (privacy gate covers the Android permission check).
Added sections: none. Removed sections: none.

Templates: plan, spec and tasks templates read the constitution at runtime and need no change.
Docs: CLAUDE.md lists distributions and should mention 003 when its plan lands.
Deferred TODOs: none.
-->

# PDF Signer PWA Constitution

## Core Principles

### I. Zero-Server, Client-Side Only (NON-NEGOTIABLE)

All document processing, image manipulation, and cryptographic operations MUST execute entirely
within the local runtime on the user's device. No PDF, signature image, `.p12` certificate,
password, or derived material may ever be transmitted to, logged by, or stored on any server. The
general rule is that **no server participates in the product at all**; where a distribution has a
hosting platform (e.g. Vercel for the web app), that platform serves static assets only and MUST NOT
receive user content.

Every distribution MUST enforce the **strongest network prohibition available to it**, and MUST NOT
rely on a single mechanism where more than one is available:

- **Web**: a strict Content Security Policy with `connect-src 'none'` MUST be enforced, so the
  application is structurally incapable of making outbound requests with user data.
- **Packaged/desktop**: the CSP above MUST be retained AND the runtime MUST additionally deny
  outbound network requests at the runtime level, so the guarantee does not rest on document policy
  alone.
- **Android**: the CSP above MUST be retained AND the app package MUST declare no permission that
  grants network access, so the operating system denies it. Native code and bundled libraries MUST
  NOT attempt network access, even though the missing permission would block it.

Any feature that would require server-side processing of user content is out of scope by definition
and MUST be rejected, not worked around.

**Rationale**: The entire value proposition is provable privacy. A single network path for user
content collapses the guarantee; this principle is the product, not an optimization. Distributions
differ in the mechanisms available to enforce it, but never in the guarantee itself.

### II. Offline-First & Installable

After first acquisition, the application MUST be fully functional with no network connection. Every
dependency required for signing (PDF engine, crypto libraries, renderer) MUST be present locally —
no CDN, no runtime remote fetch (this also follows directly from Principle I).

**"Installable" is defined per distribution**; each supported distribution MUST satisfy its own
form:

- **Web**: a service worker MUST precache the application shell and every signing dependency, and
  the app MUST ship a valid web app manifest (standalone display, 192px + 512px + maskable icons,
  HTTPS) so it is installable to the Android home screen. Assets MUST be served same-origin.
- **Packaged/desktop**: the application MUST be delivered as a self-contained artifact that runs
  without an installer, without elevated privileges, and without installing shared dependencies onto
  the host.
- **Android**: the application MUST be delivered as a self-contained app package, installable
  without the store, that runs fully from its first launch with no network ever available.

**Rationale**: A privacy tool that only works online is a contradiction; offline capability is both a
UX feature and a reinforcement of the zero-network guarantee. The *guarantee* is universal; only the
packaging that delivers it is distribution-specific.

### III. Cryptographic Correctness & Standards Compliance (NON-NEGOTIABLE)

When a `.p12` is supplied, the output MUST be a standards-compliant PDF digital signature that a
compliant reader (e.g., Adobe Acrobat) validates: a detached PKCS#7/CMS signature over a correct
`/ByteRange`, housed in an AcroForm signature field. The signing sequence MUST respect byte-range
integrity — the signature placeholder is added, the file is saved, the ByteRange is hashed, the CMS
is produced, and it is spliced into `/Contents` WITHOUT shifting any byte. No page-content mutation
may occur after the placeholder is inserted. Cryptography MUST NOT be mocked, stubbed, faked, or
"approximated" in shipped code paths; a signature the app presents as valid MUST actually verify.

**Rationale**: A signing tool whose signatures do not verify is worse than useless — it is
misleading. Correctness here is a safety property, not a feature toggle.

**Gating note**: This principle gates from day one and applies to **every distribution equally** —
it is never deferred to a future release, and no distribution is exempt. A distribution MUST NOT
carry a separate or divergent signing implementation.

**Sharing the implementation is not sharing the evidence.** A shared signing path removes
*implementation* divergence; it does **not** establish the correctness of any packaged output, which
still depends on that distribution's own packaging, asset serving, bundled engine, and runtime. Each
artifact MUST still earn its own validator run under Principle V. *(Corrected in v1.1.0: an earlier
draft of this note said the shared path meant "correctness is established once rather than
re-litigated per platform" — which is exactly the inherit-by-assertion Principle V forbids, stated
inside a NON-NEGOTIABLE principle where it would have outranked V. Codex, PR #7.)*

**This constitution does not enumerate product scope.** Which capabilities ship, and in what form, is
defined by the feature specs under `specs/` — the single source of truth. Governance states what is
non-negotiable, not what exists. *(This clause was added in v1.1.0 after the prior enumeration went
stale: it named a visual-stamp-only output as shipping v1 for days after the code had removed it. A
constitution that duplicates the spec will drift from it every time scope moves, and a governance
document that is quietly false is worse than one that is silent.)*

> **Pointing at `specs/` only helps if `specs/` is true.** When this clause was introduced, the
> spec's own `data-model.md` and `contracts/signing-engine.md` still described the removed
> stamp-only export as an active path — so deleting the enumeration here would have **relocated** the
> drift rather than removed it, while promoting the stale documents to sole authority. Those were
> corrected in the same amendment. **Any future amendment that moves authority to another document
> MUST verify that document is accurate first** — otherwise it launders a false claim into a more
> authoritative place. *(Codex, PR #7 — the sharpest finding of that review.)*

### IV. Honest Security Posture & Purpose (No Overclaiming)

**Purpose & non-goal**: The product is positioned as a privacy-preserving convenience and
tamper-evidence tool — a private way to cryptographically sign a PDF entirely on-device, where the
user's signature image is the visible appearance of that real signature. *(Amended in v1.1.0: this
sentence previously read "visibly sign and **optionally** cryptographically seal". Cryptographic
signing is not optional — it is the only path to any output. The stale wording survived here one
paragraph away from the Principle III scope note corrected in the same amendment, and would have
been citable to justify describing crypto as optional in UI or marketing — reintroducing the exact
overclaim FR-005/FR-010 were amended to remove. Codex, PR #7.)* It does NOT claim to produce legally-binding, qualified, or advanced electronic
signatures in any jurisdiction, and MUST NOT present itself as legal advice or as a substitute for a
qualified trust-service provider. UI and copy MUST reflect this positioning.

Every security or privacy claim surfaced to the user MUST be accurate and, where possible,
auditable. Specifically: the CSP is described as an enforced control, not a mathematical proof;
in-memory secret handling is described as best-effort reference-dropping, never as guaranteed
erasure (JavaScript cannot guarantee zeroing); a self-signed certificate is presented as "validity
unknown" until trusted, matching reader behavior; the absence of a trusted timestamp (no RFC-3161 /
no LTV, a consequence of offline operation) MUST be disclosed where signature longevity matters.
Marketing language that outruns technical reality is a defect.

**Distribution-specific disclosure**: A distribution MUST disclose the weaknesses it introduces that
other distributions do not have. In particular:

- A distribution that **bundles its own engine** ships that engine frozen: it receives no security
  updates for the life of the artifact. This MUST be disclosed, and the application MUST inform the
  user **when the engine it bundles has become stale**. That determination MUST be made locally and
  MUST NOT involve any network request — Principle I is not negotiable to satisfy this one. A
  one-time notice that is easy to miss does not satisfy this obligation.
  *(Governance states the obligation and its constraints. It deliberately does **not** specify the
  metric, threshold, or mechanism — those live in the feature spec and data model, which are the
  single source of truth for scope. An earlier draft of this clause prescribed "an embedded **build
  date** compared against the device clock"; that is the wrong measure — a rebuild from an unchanged
  lockfile resets the build date while shipping the same year-old engine, silencing the warning
  exactly when it matters. The data model corrected this to the engine's own release date, and this
  clause had kept the superseded mechanism. Duplicating a mechanism into governance is how it rots.
  Codex, PR #7 — P1.)*
- A distribution whose artifacts are **not signed by a recognised code-signing authority** MUST
  disclose that plainly, explain the resulting warnings, and offer a verification path in its place.
- A distribution that **runs on the device's system engine** rather than bundling one (Android) is
  not frozen, but its engine version depends on the device. It MUST disclose that dependency, and
  MUST warn the user locally, with no network request, when the engine is below the oldest version
  its release gate validated. It MUST also disclose that it is installed from outside the store and
  never updates itself.

**Rationale**: Users making trust decisions about signed documents deserve claims that hold up to
scrutiny. Overclaiming — including implying legal weight the design cannot deliver offline, or
letting a user assume a frozen bundled engine is current — destroys the credibility the privacy
story depends on. A weakness that cannot be fixed MUST still be named.

### V. Verify Against Real Readers (Test-First)

Signature-producing and PDF-manipulating code MUST be developed test-first: an executable check is
written and seen to fail before the implementation is written. Beyond unit tests, any change to the
signing path MUST be verified end-to-end by validating produced output with a standards-compliant
validator — not merely by asserting internal state. The **enforceable CI authority** is an
automatable open-source validator (**pyHanko** preferred, or poppler's `pdfsig`) that confirms the
PKCS#7/CMS signature and `/ByteRange` integrity on every signing-path change. **Adobe Acrobat is
used as a periodic manual spot-check** (appearance rendering, click-to-validate behavior, trust-
prompt UX) but is NOT the CI gate, because it cannot run headless. A signing change is not "done"
until the automated validator passes; Acrobat spot-checks confirm the human-facing experience.

**Evidence is per-distribution and MUST NOT be inherited by assertion.** A distribution MUST NOT be
published on the strength of another distribution's validator run: the gate MUST be executed against
output actually produced by the artifact being shipped, including the Android package on its own
system engine. Sharing an implementation (Principle III)
makes a passing result *likely*; it does not make it *demonstrated*. Where a distribution runs on a
different engine, that engine MUST earn its own passing gate before its artifacts are published.

**Rationale**: PDF signing has many subtle, silent failure modes (byte offsets, appearance streams,
field wiring) that pass internal assertions but fail real validators. An automatable validator makes
correctness an enforceable gate rather than a discipline-dependent ritual; Acrobat spot-checks catch
appearance/UX issues a validator does not model. Engines differ in ways that are invisible until
they are not — a shared code path is an argument for expecting success, never a substitute for
observing it.

### VI. On-Device Data Minimization

User content is handled in memory by default. The application MUST NOT persist the user's PDF,
signature image, or certificate to **any on-device store** — including but not limited to IndexedDB,
localStorage, sessionStorage, Cache Storage, an application data directory, or the file system —
unless the user has explicitly opted in for a named convenience (e.g., remembering recent documents
or a certificate). That persistence MUST be disclosed at the point of opt-in, MUST be clearable by
the user, and the user MUST be able to learn where it lives.

Two carve-outs are absolute and admit no opt-in: the `.p12`/certificate **password** MUST NEVER be
persisted, and **decrypted private-key material** MUST NEVER be written to any store — both exist
only transiently in memory during a signing operation. This prohibition extends to indirect
persistence such as temporary files, logs, and crash dumps.

Precached application assets (Principle II) cover application code ONLY, never user content.

Opted-in data MUST stay on the device it was stored on. Where the platform can copy application data
off the device, through cloud backup or device-to-device transfer (Android), that data MUST be
excluded from both; otherwise the opt-in disclosure would be false.

**Rationale**: "Zero-server" is hollow if the user's certificate and password sit in storage on a
shared or lost device. Minimizing on-device residency — and forbidding secret persistence outright —
is the on-device half of the privacy guarantee. The store's technology is irrelevant to the risk, so
the rule names the behaviour, not the API.

## Technology & Deployment Constraints

- **Distributions**: The product ships from **one codebase** as (a) a **web PWA** — the primary
  distribution, targeting Android/Chrome as the primary install platform, with desktop browsers
  supported and iOS best-effort (Safari PWA limitations acknowledged) — (b) **packaged desktop
  builds** for Windows and Linux, delivered as portable single-file artifacts — and (c) a **native
  Android app package** that hosts the same web build in the device's system web view, distributed
  on the GitHub release (added in v1.2.0). Any further distribution requires an amendment. A distribution MUST NOT fork the signing path (Principle III).
- **Core stack**: Vite + React + `vite-plugin-pwa` (manifest + Workbox service worker); `pdf-lib`
  for PDF assembly and signature-field/appearance construction; `pdf.js` for on-screen preview;
  `@signpdf/signpdf` + `@signpdf/placeholder-pdf-lib` + `@signpdf/signer-p12` (over `node-forge`)
  for the ByteRange placeholder, CMS signing, and byte-safe splice. `pdf-lib` alone MUST NOT be
  relied on for signing — it has no signing API.
- **Deployment**: The web app is a static build deployed to Vercel (Vite preset, `dist` output),
  with no serverless functions handling user content. Desktop artifacts are built by the project's
  automated pipeline and published from the public GitHub repository. Public GitHub repo with Vercel
  auto-deploy remains the standard pipeline for the web distribution.
- **Signature validation (dev/CI tooling)**: `pyHanko` (preferred) or poppler `pdfsig` runs in CI to
  validate produced signatures (Principle V), per distribution. These are development/test
  dependencies and never ship in a client artifact.
- **Dependencies**: Prefer lightweight, well-maintained libraries. New dependencies that pull in
  network calls, telemetry, or remote asset loading are prohibited (Principle I) — this applies with
  particular force to packaging runtimes, which commonly default to auto-update and crash reporting
  and MUST have both disabled.

## Development Workflow & Quality Gates

- **Spec-driven**: Work flows through the Spec Kit lifecycle — constitution → specify → plan →
  tasks → implement. Each feature has a spec before code.
- **Constitution Check**: Every plan MUST pass a Constitution Check gate before Phase 0 and re-check
  after design. Violations MUST be justified in writing or the design revised.
- **Signing-path gate**: No change touching the cryptographic or PDF-mutation path merges without
  (a) test-first coverage and (b) a passing automated-validator check (pyHanko / poppler `pdfsig`)
  on a produced signature (Principle V). Acrobat spot-check before releasing signing-path changes.
- **Release gate (per distribution)**: No artifact of any distribution is published until the
  automated validator has passed against output produced by **that** artifact (Principle V).
- **Privacy gate**: Any change that introduces or could introduce an outbound network request
  carrying user-derived data is blocked and MUST be redesigned (Principle I). The web CSP MUST
  remain `connect-src 'none'`; packaged distributions MUST additionally keep runtime-level outbound
  denial in force, and the Android package MUST be checked for the absence of network permissions.
- **Data-minimization gate**: Any change that writes user content to on-device storage MUST be
  behind an explicit, disclosed opt-in; any change that persists a certificate password or decrypted
  private key is blocked outright (Principle VI).
- **Honesty gate**: Any change that alters what the product claims about itself — or that introduces
  a distribution-specific weakness (frozen engine, unsigned artifact) — MUST ship its disclosure in
  the same change, not in a follow-up (Principle IV).
- **Review**: Changes are reviewed for compliance with these principles; complexity must be
  justified against the simplest design that satisfies the spec.

## Governance

This constitution supersedes other development practices for the PDF Signer PWA. Where a proposed
change conflicts with a principle, the principle prevails unless the constitution is formally
amended first.

- **Amendments** require a documented rationale, a version bump per the policy below, and
  propagation of any affected guidance into dependent templates and docs.
- **Versioning policy** (semantic): MAJOR for backward-incompatible governance or principle
  removals/redefinitions; MINOR for a new principle/section or materially expanded guidance; PATCH
  for clarifications and non-semantic refinements.
- **Compliance review**: All plans and reviews MUST verify adherence to the Core Principles. The two
  NON-NEGOTIABLE principles (I and III) admit no exceptions; a change that violates either MUST NOT
  ship.

**Version**: 1.2.0 | **Ratified**: 2026-07-13 | **Last Amended**: 2026-11-07
