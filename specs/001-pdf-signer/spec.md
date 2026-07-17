# Feature Specification: PDF Signer PWA

**Feature Branch**: `001-pdf-signer`

**Created**: 2026-07-13

**Status**: Shipped & live (https://pdf-signer-pwa.vercel.app) — **amended 2026-07-17**, see § Amendment: certificate-only signing

**Input**: User description: "Privacy-first, zero-server, offline-first PWA to sign PDFs entirely on-device. Open a PDF, add a signature image (upload or phone camera), visually place/scale it, and optionally apply a PKCS#12 (.p12) cryptographic digital signature that Adobe Acrobat validates (the image IS the clickable signature field). Both the visual image stamp and the p12 digital signature are core v1. Minimalist UI where the document is the center. Mobile-first (Android/Chrome), installable PWA, deployed static on Vercel."

**Terminology**: "Tier A" = the **visual image stamp** (the signature image drawn onto the page). "Tier B" = the **cryptographic PKCS#12 signature** (the placed image becomes the appearance of a real, verifiable signature field). These labels are used interchangeably with the plain-language terms across the plan, tasks, and design notes. **Post-amendment, Tier A exists only *inside* Tier B** — as the signature field's appearance — never as a standalone output.

> **Note on the Input line above**: it is preserved verbatim as the historical record of the original request ("*optionally* apply a PKCS#12… Both the visual image stamp and the p12 digital signature are core v1"). It describes what was asked for on 2026-07-13, not what shipped. The amendment below is the authority on current scope.

## Amendment: certificate-only signing (2026-07-17)

**What changed in the code**: PR #4 (`a1a83ab`) removed the image-only "Stamp image & Download" flow. Certificate signing became the **only** path to an output. This shipped and is live.

**Why** (Principle IV — honest security posture): a visible mark with no cryptography behind it produces a document that *looks* signed and carries no verifiable claim whatsoever. A recipient cannot distinguish it from a real signature by looking, which is precisely the confusion the product exists to resolve. PR #2 first attempted to manage this with "unmistakable stamp-vs-certificate labeling"; the trajectory to removal in #4 reflects that labeling cannot fix an artifact whose whole failure mode is that it looks like something it isn't. The app now refuses to produce a signed-looking file that isn't signed.

**Cost, stated honestly**: this removed the original zero-friction MVP. A user with no certificate can no longer produce anything — they must now generate one in-app (FR-018). That is a real usability loss, accepted deliberately in exchange for never emitting a document that overstates its own trustworthiness.

**Documents amended in this change** (docs had drifted from shipped code for ~4 days):

| Artifact | Was | Now |
|---|---|---|
| Constitution **Principle III** scope note | "Both tiers ship in v1 — Tier A AND Tier B" | Enumeration **removed** — governance no longer duplicates product scope (v1.1.0) |
| **FR-005** | ".p12 optional, when signing desired" | Certificate required for any output |
| **FR-010** | "MUST produce downloadable PDF when no certificate is used" | Superseded — MUST NOT produce signed-looking output without a certificate |
| **US1** | "Place a visible signature **and download the PDF**"; standalone MVP | "Place a visible signature **on the page**"; foundation, not independently shippable |
| **US2** rationale | "US1 delivers value without it" | US2 is the only path to an output |

**Audited and found already compliant — no change required**: `signatureStore.ts` / `certStore.ts` (Principle VI — opt-in, disclosed, clearable, minimal record; password and key material never persisted); README (Principle IV — already rewritten to match cert-only reality); `GitHubLink.tsx` (Principle I — inline SVG and plain navigation; carries no user content).

**Process lesson**: PRs #1–#6 were authored outside the Spec Kit lifecycle and merged straight to `main`. The code was reviewed; the spec and constitution were not consulted, so they silently went stale while continuing to be cited as authority. The constitution's `v1.1.0` amendment adds a structural fix — governance no longer enumerates scope, so this particular class of drift cannot recur — but the general lesson stands: **a change that alters what the product does owes its spec an update in the same PR.**

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Place a visible signature on the page (Priority: P1)

> **Amended 2026-07-17** (see § Amendment: certificate-only signing). US1 was originally *"Place a visible signature **and download the PDF**"* — a standalone stamp-and-download MVP. Placement remains P1 and remains the foundation everything builds on, but it is no longer independently *shippable*: the only way to obtain a file is US2's certificate signature, whose visible face this placement becomes.

A person opens a PDF on their phone, adds an image of their signature (choosing an existing image or snapping a photo of a signature on paper), drags it onto the signature line, and resizes it to fit — establishing exactly where and how large their signature will appear. Nothing leaves their device.

**Why this priority**: This is the foundation of the product — the open → place loop that every output depends on. It is P1 because nothing else can happen without it, not because it delivers a file on its own. *(Originally justified as "a user who only ever does this already has a complete, useful, private signing tool"; that ceased to be true when stamp-only output was removed.)*

**Independent Test**: Load a sample PDF, add a signature image, position and scale it over a signature line — the placement is honoured at the chosen page, position, and size, and is carried through to the signed output in US2. No network request carrying document or image data occurs.

**Acceptance Scenarios**:

1. **Given** a PDF is open and a signature image has been added, **When** the user drags the image over the page, **Then** the signature is positioned at the exact location and size chosen, and that placement is what appears in the signed output.
2. **Given** a multi-page PDF, **When** the user navigates to page 3 and places the signature there, **Then** the signature appears only on page 3 in the output.
3. **Given** the user is offline, **When** they perform the open → place flow, **Then** it completes successfully with no network access. *(Amended 2026-07-17: was "open → place → **download**". Downloading requires a certificate and now belongs to US2, whose offline signing is covered there; asserting a download here would either fail against the shipped app or tempt an implementer to reintroduce the removed stamp-only export.)*
4. **Given** a signature image with a transparent or white background, **When** it is placed, **Then** it renders cleanly over the document content without an opaque box (subject to background handling in US4).

---

### User Story 2 - Apply cryptographic digital signature(s) with a .p12 (Priority: P2)

A person cryptographically signs the document with a PKCS#12 (`.p12`/`.pfx`) certificate — one they already have, OR one they create in the app (a self-signed Digital ID, since most casual users have none). They supply/create the certificate and its password; each placed signature image becomes the visible face of a real digital signature field, shown Adobe-style as the image plus "Digitally signed by {name}" and a date (both optional). When the signed PDF is opened in Adobe Acrobat, each signature is clickable and shows the certificate and validity status. Multiple signatures can be applied, and adding a later signature does not invalidate an earlier one.

**Why this priority**: Core to v1 and the product's differentiator. It depends on the placement loop from US1 and makes the signature verifiable and tamper-evident. *(Amended 2026-07-17: originally reasoned "US1 delivers value without it" — since stamp-only output was removed, US2 is the **only** path to an output, and US1 delivers no file without it. The P1/P2 ordering is retained as a build-order dependency, not a value ranking.)*

**Independent Test**: With a document that has one or more placed signatures, supply a valid `.p12` + password, sign, and validate the output with a standards-compliant validator (and open in Acrobat): each signature verifies, the visible image is the appearance of a clickable signature field, and a second signature added afterward leaves the first still valid.

**Acceptance Scenarios**:

1. **Given** a placed signature image and a valid `.p12` + correct password, **When** the user signs, **Then** the output contains a digital signature whose visible appearance is the placed image and which validates as intact/unmodified in a compliant reader.
2. **Given** a document that already carries one valid cryptographic signature, **When** the user adds a second cryptographic signature, **Then** both signatures validate in a compliant reader — the second is applied as an incremental update that does not alter the bytes covered by the first.
3. **Given** an incorrect certificate password, **When** the user attempts to sign, **Then** the app reports the password is wrong and produces no output, without leaking the attempted password anywhere off-device.
4. **Given** a self-signed certificate, **When** the document is signed and opened in a reader, **Then** the signature is cryptographically intact but shows "validity unknown / not trusted", and the app has disclosed this outcome to the user beforehand.
5. **Given** a signed document, **When** any byte covered by a signature is altered afterward, **Then** a compliant reader reports that signature as invalid.
6. **Given** the user wants both visual-only stamps and a cryptographic signature, **When** they proceed, **Then** the app requires visual-only (non-cryptographic) stamps to be committed before cryptographic signing, and communicates this ordering, because page-content changes after signing would invalidate signatures.
7. **Given** a user with no certificate, **When** they choose "create a certificate", enter at least a full name (and optionally organization, division, email) and a password, **Then** the app generates a self-signed `.p12` on-device, lets them export the `.p12` (Digital ID) and the public `.cer` (to share for trust), and lets them sign with it immediately.
8. **Given** the user is signing with a certificate, **When** they toggle the "Digitally signed by {name}" label and/or the date off, **Then** the signature appearance shows only the signature image; with either on, the text is uniform and fully visible (never clipped).

---

### User Story 3 - Install to the phone and use fully offline (Priority: P2)

A person installs the app to their Android home screen from the browser and later opens it as a standalone app with no address bar, signing documents even with no internet connection.

**Why this priority**: The install + offline experience is central to the "private, always-available" promise, but the signing capability (US1/US2) must exist first for installation to be worth anything.

**Independent Test**: Visit the app once online, install it to the home screen, enable airplane mode, launch from the icon, and complete a full signing flow — the app opens in standalone mode and works with no network.

**Acceptance Scenarios**:

1. **Given** the app has been visited once, **When** the user chooses "Install app", **Then** an icon is added to the home screen and launches the app in standalone (no browser chrome).
2. **Given** the device is fully offline after first load, **When** the user launches the installed app, **Then** all signing features function without error.

---

### User Story 4 - Capture a paper signature and clean it up (Priority: P3)

A person without a digital signature image photographs their handwritten signature on plain paper; the app removes the paper background so the signature overlays the document cleanly.

**Why this priority**: A convenience that lowers the barrier for users with no pre-made signature image. Valuable but not required for the core loop, and the background-cleanup step is best-effort.

**Independent Test**: Take (or supply) a photo of a signature on white paper, apply the cleanup, and confirm the background is substantially removed and the signature can be placed as a clean overlay.

**Acceptance Scenarios**:

1. **Given** the user taps "Add signature", **When** they choose the camera option on a phone, **Then** the device camera opens and the captured photo becomes the signature image.
2. **Given** a photographed signature on off-white paper, **When** background cleanup is applied, **Then** the paper background is substantially removed, leaving the ink strokes over a transparent background.

---

### Edge Cases

- **Password-protected / encrypted input PDF**: the app detects it cannot process an encrypted PDF and informs the user rather than failing silently.
- **Very large or high-page-count PDF**: the app remains responsive or clearly indicates progress; it does not crash the tab.
- **Corrupt or non-PDF file**: rejected with a clear message.
- **Corrupt `.p12` or unsupported certificate**: reported clearly; no output produced.
- **Already-signed PDF**: the app communicates whether adding a signature will invalidate an existing one (adding page content invalidates a prior signature).
- **On-device storage unavailable or denied** (private mode, quota): the app still functions in memory-only mode; opt-in persistence features degrade gracefully.
- **First launch with no network**: if the app was never cached, it cannot load; once cached, offline works. This boundary is communicated.
- **Signature placed partially off-page**: prevented or clamped to page bounds.

## Requirements *(mandatory)*

### Functional Requirements

**Ingestion & viewing**
- **FR-001**: Users MUST be able to open a local PDF file from their device.
- **FR-002**: The system MUST render a visual preview of the PDF pages, with the document as the dominant element of the screen.
- **FR-003**: Users MUST be able to navigate between pages of a multi-page document.
- **FR-004**: Users MUST be able to add a signature image by selecting an existing image file (PNG/JPEG) or, on a mobile device, capturing one with the camera.
- **FR-005**: Users MUST supply a `.p12`/`.pfx` certificate and its password (bringing their own, or generating one in-app per FR-018) in order to produce any output. *(Amended 2026-07-17: was "optionally supply … when cryptographic signing is desired". Signing is no longer optional — see § Amendment: certificate-only signing.)*

**Placement (Tier A)**
- **FR-006**: Users MUST be able to drag a signature image to any position over the visible page.
- **FR-007**: Users MUST be able to resize a signature image (e.g., pinch or handles) to fit a signature line.
- **FR-008**: The system MUST place each signature on the specific page the user targeted, at the position and size chosen, and MUST prevent placement outside page bounds.
- **FR-009**: Users MUST be able to place multiple signatures/initials on a document, including across multiple pages.
- **FR-010**: ~~The system MUST produce a downloadable PDF with all placed signatures visible at their chosen locations when no certificate is used (visual stamps).~~ **SUPERSEDED 2026-07-17 — see § Amendment: certificate-only signing.** The system MUST NOT produce a signed-looking output without a certificate. Placement (Tier A) is retained as the *visible appearance* of a real signature field, never as a standalone deliverable.

**Cryptographic signing (Tier B)**
- **FR-011**: When a certificate is supplied, the system MUST produce standards-compliant PDF digital signature(s) that a compliant reader validates as covering the document and intact when unmodified.
- **FR-012**: Each visible signature image MUST be the appearance of a digital signature field (a clickable signature in a compliant reader), not a separate decorative element, when a certificate is used.
- **FR-013**: The system MUST support multiple cryptographic signatures on one document such that adding a later signature (as an incremental update) does NOT invalidate earlier signatures.
- **FR-014**: The system MUST require any visual-only (non-cryptographic) stamps to be committed before cryptographic signing begins, and MUST communicate this ordering, because page-content changes after signing invalidate signatures.
- **FR-015**: The system MUST verify the certificate password before signing and MUST report an incorrect password without producing output.
- **FR-016**: The system MUST disclose, before signing, that a self-signed or untrusted certificate will show as "validity unknown" in readers, and that signatures are not timestamped.
- **FR-017**: The system MUST detect and clearly communicate when an action would invalidate a pre-existing signature on the document (distinguishing an allowed incremental signature addition from a disallowed page-content change).
- **FR-018**: The system MUST accept a user-supplied `.p12`/`.pfx`, AND **MUST** be able to generate a self-signed `.p12` Digital ID on-device for users who have none. *(Amended 2026-07-17: was "MAY generate". Promoted to MUST because FR-005 now makes a certificate mandatory for **any** output — under `MAY`, an implementation could omit generation and leave every certless user with no way to produce anything at all. `MAY` was defensible only while stamp-only export existed as a fallback; it no longer does.)* It MUST allow exporting the generated `.p12` (the signing Digital ID) and the public certificate (`.cer`, for others to trust). It does not act as a certificate authority for third parties. *(Amends the original "BYO only" decision at the product owner's request.)*
- **FR-030**: When signing with a certificate, the signature appearance MUST be able to show, beside the signature image (Adobe-style), a "Digitally signed by {name}" label (name = certificate common name) and a date line. The appearance text MUST be uniform and sized to fit its box so it never clips.
- **FR-031**: The user MUST be able to toggle the appearance label and the date line independently on or off; with both off, the appearance is the signature image alone.
- **FR-032**: When generating a certificate in-app (FR-018), the user MUST be able to supply a full name (required) and optionally an organization, division/unit, and email; these MUST be recorded in the certificate subject (email also as a subjectAltName).

**Privacy & data handling**
- **FR-019**: The system MUST perform all document, image, and cryptographic processing on-device, and MUST NOT transmit any PDF, signature image, certificate, password, or derived material off the device.
- **FR-020**: The system MUST default to memory-only handling and MUST NOT persist the user's document, signature image, or certificate to on-device storage unless the user explicitly opts in.
- **FR-021**: The system MUST offer an opt-in option to remember the user's certificate (`.p12` file) and, independently, the last-used signature image for reuse across sessions; each MUST be disclosed at the point of opt-in and be clearable by the user, and neither may be auto-saved. Remembering the document is out of scope for v1.
- **FR-022**: The system MUST NEVER persist the certificate password or decrypted private-key material to any store, even when the certificate is remembered — the password MUST be re-entered each session.
- **FR-023**: After producing output, the system MUST drop in-memory references to sensitive material (document, image, decrypted key, password) on a best-effort basis.

**Offline & installability**
- **FR-024**: After first successful load, the system MUST function fully with no network connection.
- **FR-025**: Users MUST be able to install the app to their device home screen and launch it in a standalone (no browser chrome) mode.

**UX & honesty**
- **FR-026**: The interface MUST keep the document as the central, dominant element. Primary controls (add signature, add certificate, sign/export) MUST live in a collapsing bottom sheet that reduces to a thin bar so the document remains visible while placing a signature.
- **FR-027**: The system MUST present itself as a privacy convenience and tamper-evidence tool and MUST NOT claim to produce legally-binding or qualified electronic signatures, nor present legal advice.
- **FR-028**: The system MUST provide clear, user-friendly feedback for all error conditions listed in Edge Cases.
- **FR-029**: Background cleanup of a photographed signature MUST be offered as an optional step and MUST NOT be required to place a signature.

### Key Entities *(include if feature involves data)*

- **Document**: the PDF the user is signing; has pages and page dimensions; exists only in memory unless the user opts into persistence.
- **Signature Image**: the visual signature (uploaded or captured); may have an original and a background-cleaned variant.
- **Certificate (.p12)**: the user's PKCS#12 container holding a private key and certificate chain; unlocked transiently with a password; never persisted with its password or decrypted key.
- **Signature Placement**: the chosen page, position, and size of the signature on the document.
- **Signed Output**: the resulting PDF — either a visual stamp (Tier A) or a cryptographically signed document with an integrated signature field (Tier B).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from opening a PDF to downloading a visibly-signed copy in under 60 seconds on a mid-range Android phone, without instruction.
- **SC-002**: 100% of documents signed with a valid certificate validate as intact/unmodified in a standards-compliant validator and open with a clickable signature in Adobe Acrobat.
- **SC-003**: Zero network requests carrying document, image, certificate, or password data occur during any operation (observably verifiable).
- **SC-004**: After first load, 100% of core signing flows complete successfully with the device offline.
- **SC-005**: The app is installable to the Android home screen and launches in standalone mode.
- **SC-006**: On a signing-flow screen, the document occupies the majority of the viewport, with primary controls reachable without obscuring the signature target.
- **SC-007**: An altered signed document is reported as invalid by a compliant reader in 100% of tamper tests.
- **SC-008**: No user document or password remains in on-device storage after a session; a certificate or signature image remains only if the user explicitly opted in to remember it (and can clear it).
- **SC-009**: Adding a second cryptographic signature leaves the first signature valid in a compliant reader in 100% of multi-signature tests.
- **SC-010**: A user with no certificate can create one in-app and produce a validly-signed PDF in a single session, and can export both the `.p12` and the public `.cer`.

## Assumptions

- Target users are individuals signing their own documents on a personal Android device (Chrome); desktop browsers are supported, iOS is best-effort.
- Users bring their own `.p12`/`.pfx` certificate when they want cryptographic signing; the app does not generate certificates or act as a certificate authority in v1.
- Input PDFs are not encrypted/password-protected; encrypted PDFs are detected and rejected rather than decrypted.
- "Under 2 seconds" processing from the source material is a goal, not a guarantee, and depends on document size and device.
- Signatures are not timestamped and do not include long-term validation material, an accepted consequence of offline operation.
- Multiple cryptographic signatures are applied serially (incremental updates); the app does not need to support certifying/locking (DocMDP) signatures in v1 — approval signatures that permit further signing are sufficient.
- The hosting platform serves static application assets only and never receives user content.
- Standard web/mobile performance and error-handling expectations apply unless stated otherwise.

## Resolved Decisions

The three initial open questions were resolved with the product owner:

- **Multi-signature scope**: v1 supports **full multi-signature** — multiple placements across pages and multiple cryptographic signature fields, applied via incremental signing so earlier signatures remain valid (FR-009, FR-013, FR-014).
- **Certificate source**: originally bring-your-own `.p12` only; **later amended** (owner request) to ALSO support in-app self-signed `.p12` generation + export of the `.p12` and public `.cer` (FR-018). Rationale: most casual users have no certificate, and Adobe signs with a `.p12` Digital ID (not a `.p7c`, which is the public-cert-only export used for trust).
- **Persistence for v1**: **remember the certificate and/or the last-used signature image** as independent opt-in conveniences (never the password or key); documents are not remembered (FR-020, FR-021, FR-022).
