# Feature Specification: Portable Offline Desktop Builds (Windows + Linux)

**Feature Branch**: `002-desktop-packaging`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Package the existing PDF Signer PWA as portable, single-file, offline desktop applications for Windows (portable .exe) and Linux (AppImage) — no installer, no registry writes, no network. The desktop build must preserve every constitutional guarantee of the web app (zero-server, offline-first, crypto correctness, on-device data minimization) and must reuse the same rendering engine the existing test suite and pyHanko signature gate already validate against, so existing correctness evidence carries over. Binaries are unsigned (no Authenticode / notarization) and this must be disclosed honestly to users. macOS is explicitly out of scope. The web PWA on Vercel remains the primary distribution and must continue to work unchanged."

> **Note on the Input line above**: preserved verbatim as the historical record of the request. Its
> phrase *"so existing correctness evidence carries over"* is **not** the requirement — FR-010 and
> Constitution V require the signature gate to run against each packaged artifact's own output. The
> shared engine buys **probability, not proof**. See Assumptions § Chosen approach.

## Overview

The signing application currently reaches users as an installable web app. This feature adds a
second, parallel distribution: a **single-file, run-anywhere desktop application** for Windows and
Linux that never contacts a network and keeps everything it writes in **one folder beside itself** —
delete the artifact and that folder, and no application or user data remains.

> **This is the product's top-level claim, so it is scoped precisely** (Principle IV): it covers
> **application and user data**. It does **not** claim zero footprint. A bundled engine writes
> cache/profile data into that folder on every launch whether or not the user opts into anything; the
> Windows portable target extracts its own program files to temp while running (a crash can leave
> them); and the OS records that an executable ran in places no application can reach. **A privacy
> tool, not an anti-forensics tool.** See SC-005. *(Amended 2026-07-17: previously "leaves no trace on
> the host machine unless the user asks it to" — a top-level promise the design cannot keep, and the
> sentence most likely to become release copy. Codex, PR #7.)*

The value is not new signing capability — it is **reach and provability**. A user who cannot or will
not trust a URL (an air-gapped machine, a locked-down workstation, a reviewer who wants to inspect
what they are running) can copy one file onto the machine, run it, sign a document, and then remove
it **along with the one data folder it creates beside itself** — leaving no application or user data
behind.

> **Scope of the "no trace" claim** (Principle IV): it covers **data the application writes**, which
> all lives in one folder beside the artifact (SC-005). It does **not** and cannot cover
> OS-controlled traces of having run an executable at all — prefetch, execution history, antivirus
> records, shell MRU. This is a privacy tool, **not an anti-forensics tool**, and no surface may
> imply otherwise.

This feature deliberately adds **no new user-facing signing behaviour**. Every existing capability
(visual stamp, PKCS#12 signing, in-app certificate generation, counter-signing) behaves identically.

## Clarifications

### Session 2026-07-17

- **Q: A bundled browser engine ships frozen and never receives security patches, but FR-006/FR-007
  forbid any network contact — so the app cannot check for updates. How is staleness handled
  honestly?**
  **A: Frozen + local age nudge.** The app never contacts a network. It knows its own build date and,
  once a build exceeds a staleness threshold, displays a passive notice telling the user the build is
  aging and to check for a newer one. This is a local clock comparison only — zero requests — so
  FR-006/FR-007 remain intact while Principle IV (honest posture) is satisfied actively rather than
  by a one-time disclosure the user forgets. → FR-015, FR-015a.

- **Q: The web app allows opt-in persistence of a signature/certificate. On a portable app, where
  should that store live?**
  **A: Beside the executable.** State lives in a directory adjacent to the binary, not in the OS
  user-data location. Deleting the app's folder therefore removes everything (SC-005 stays literally
  true), portable media carries the user's opt-in store with it, and on read-only media the shell
  **disables the opt-in "remember" affordances outright** so nothing is written. This preserves
  FR-020 (existing capability holds on desktop) without contradicting the portability promise.
  → FR-011, FR-011a, FR-011b, FR-013.
  *(Corrected 2026-07-17: this originally said read-only media "degrades to memory-only using the
  same graceful-degradation path the web app already has". It doesn't — the web path only triggers
  when a storage **write fails**, and ephemeral mode gives Electron a writable temp `userData`, so
  IndexedDB succeeds and a remembered `.p12` would land in temp. Memory-only must be enforced by not
  writing. Codex, PR #7.)*

- **Q: The binaries are unsigned, so nothing vouches for them. What should the release/provenance
  process be?**
  **A: CI build + provenance attestation.** Both artifacts are built by the existing CI pipeline and
  published with checksums *and* a signed build-provenance attestation, so any user can
  cryptographically verify that a binary was produced by the project's own workflow from a specific
  commit — not from an individual's machine. This is the strongest honest substitute available for a
  code-signing certificate at zero recurring cost. → FR-017, FR-018, FR-018a.

## Constitutional Impact — ✅ RESOLVED (amended to v1.1.0 on 2026-07-17)

> **Status**: The amendment landed *before* planning, so this feature's Constitution Check runs
> against text that actually describes it. All five collisions below are closed. Principles III and
> V were left untouched, and V was **strengthened** in passing: validator evidence is now explicitly
> per-distribution and cannot be inherited by assertion — which is what FR-010 already demanded.
> Retained below as the amendment's rationale record.

The constitution (v1.0.0) described the product in **browser-and-Vercel-specific language**. This
feature does not violate the *intent* of any principle — it arguably strengthens Principles I and II
— but it contradicts the *letter* of several clauses. These are recorded here so the collision is
resolved by amendment rather than by quiet reinterpretation during implementation.

| Constitution text | Collision | Proposed resolution |
|---|---|---|
| **I**: "execute entirely within the **browser runtime**"; "hosting platform (Vercel) serves static assets only" | A desktop app has no browser and no host. The *intent* (user content never leaves the device) is honoured more strictly than the web app, since there is no origin server at all. | Amend I to speak of "the local runtime on the user's device", and treat the absence of a server as the general case with Vercel as one instance. |
| **I**: "A strict CSP with `connect-src 'none'` MUST be enforced" | A packaged app still has a CSP, but the enforceable network guarantee shifts from CSP alone to CSP **plus** runtime denial of outbound requests. | Amend I to require the *strongest available* network prohibition per distribution; add a desktop-specific requirement (FR-005). |
| **II**: "installable to the **Android home screen**"; "ship a valid **web app manifest**" | Meaningless for a `.exe`/AppImage. | Amend II so "installable" is defined per distribution: PWA manifest for web, portable binary for desktop. |
| **Technology Constraints**: "**Runtime**: Browser-only PWA"; "**Deployment**: Static build to Vercel" | Directly contradicted. | Amend to name web and desktop as two supported distributions from one codebase. |
| **VI**: persistence scoped to browser stores "(IndexedDB, localStorage, …)" | A desktop app has a writable user-data directory that browser-storage language does not describe, and a *portable* app implies leaving nothing behind. | Amend VI to cover any on-device store including a desktop data directory; see FR-011/FR-013. |

**Assessment**: MINOR amendment (new/expanded guidance; no principle removed or redefined) →
constitution **v1.1.0**. ✅ **Ratified 2026-07-17.** Principles III (crypto correctness) and V
(verify against real readers) are **unchanged and fully binding** on this feature.

**Also added by the amendment** (beyond the five collisions, arising from this feature's
clarifications): Principle IV now carries a **distribution-specific disclosure** obligation — a
distribution that bundles its own engine ships it frozen and MUST tell the user when its build has
gone stale, determined locally with no network request; and a distribution with unsigned artifacts
MUST disclose that and offer a verification path instead. This makes FR-014/FR-015a constitutional
requirements rather than merely this feature's good intentions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign a PDF on Windows with no install and no network (Priority: P1)

A user copies a single `.exe` onto a Windows machine — one with no internet connection, or one where
they lack rights to install software. They double-click it, the signing app opens in its own window,
and they complete the full existing flow: open a PDF, place a signature image, sign with a `.p12`,
and save the signed file. Everything the app wrote lives in **one folder beside the `.exe`**; they
delete the `.exe` and that folder, and **no application or user data remains on the machine**.

> *(Amended 2026-07-17, twice, both by Codex review on PR #7. It first said deleting the `.exe` alone
> left "no evidence" — false, since a bundled engine writes cache files into its data folder every
> launch. The corrected version still claimed the machine "retains no evidence the app ever ran" —
> also false, and not ours to promise: running any executable can leave OS-controlled traces
> (execution history, prefetch, Defender records, shell recent-file entries) that no application can
> reach or erase. The guarantee is scoped to what the app writes: **no application or user data
> residue**. It is not an anti-forensics tool and must never imply it is.)*

**Why this priority**: This is the feature. Windows is the platform where "I can't install things"
and "this machine is offline" most commonly co-occur, and it is the author's own platform, so it is
the build that can be verified first and most thoroughly.

**Independent Test**: Fully testable by building the binary, running it on a Windows machine with
networking disabled, completing a sign, and validating the output with the existing pyHanko gate.
Delivers complete standalone value even if the Linux build never ships.

**Acceptance Scenarios**:

1. **Given** a Windows machine with no network connection, **When** the user runs the portable
   binary from an arbitrary directory (Desktop, USB stick, `Downloads`), **Then** the application
   opens and is fully usable with no error or degraded state — **excluding the OS's own
   unsigned-binary warning** (SmartScreen), which is expected and disclosed (US3, FR-014).
   *(Amended 2026-07-17: this required "no error, **prompt**, or degraded state", which the feature's
   own US3 guarantees is impossible — an unsigned downloaded `.exe` triggers SmartScreen by design,
   and only a code-signing certificate suppresses it. The P1 acceptance criterion contradicted the
   P2 disclosure describing the same moment. Codex, PR #7.)*
2. **Given** the application is open, **When** the user opens a PDF, places a signature image, and
   signs with a valid `.p12` and password, **Then** the resulting file is structurally equivalent to
   one produced by the web app for the same inputs, and passes the automated signature validator.
3. **Given** the user has signed a document and closed the app, **When** the user deletes the binary
   **and its adjacent data folder** and inspects the machine, **Then** no application data remains
   anywhere on the system — in particular nothing in `%APPDATA%` — except files the user explicitly
   saved. *(Amended 2026-07-17: deleting the binary alone is not sufficient, and the app must say so
   — a bundled engine writes cache files beside itself on every launch. See SC-005.)*
4. **Given** the application is running, **When** any attempt is made to reach the network, **Then**
   it fails — the app functions identically whether or not a connection exists.

---

### User Story 2 - Sign a PDF on Linux from a single file (Priority: P1)

A Linux user downloads one AppImage, marks it executable, and runs it. No package manager, no root,
no dependency resolution. The full signing flow works offline exactly as on Windows.

**Why this priority**: Equal in value to US1 and shares essentially all of its machinery — the same
codebase and packaging pipeline emit both. It is P1 because it was requested as a co-equal target,
not as a follow-on.

> **"Independent" here means independently *buildable and testable*, NOT independently *publishable*.**
> A **public release** is all-or-nothing: if either platform's signature gate is red, neither
> publishes ([contracts/release-artifacts.md](contracts/release-artifacts.md), SC-002). US1 can reach
> a working, validated Windows artifact without US2 existing — that is the independence claimed — but
> shipping Windows-only to users while Linux is broken would imply an equivalence never demonstrated.
> *(Clarified 2026-07-17: the original wording said "US1 can ship without it", which read as a licence
> to publish a partial release and directly contradicted the release contract. Codex, PR #7.)*

**Independent Test**: Build the AppImage, run it on a Linux machine (or container) with networking
disabled, complete a sign, validate with pyHanko.

**Acceptance Scenarios**:

1. **Given** a Linux machine with no package manager access and no root, **When** the user makes the
   AppImage executable and runs it, **Then** the application opens and is fully usable.
1a. **Given** a Linux machine **without FUSE/libfuse2**, **When** the user runs the AppImage with the
   documented no-root fallback (`--appimage-extract-and-run`), **Then** the application opens and is
   fully usable, and the full signing flow passes its gate on that host (FR-002a).
   *(Amended 2026-07-17: this previously required that a plain double-click "never" show a raw
   `libfuse.so.2` error or package-install advice. **We cannot promise that** — the AppImage runtime
   resolves FUSE and fails **before any application code exists to catch it**, so that message is the
   runtime's, not ours. Promising to suppress output we never emit is precisely the
   mechanism-can't-deliver-the-guarantee pattern this review kept finding — and I introduced it while
   fixing the FUSE finding itself. What we can actually deliver: a documented, **tested** fallback
   that needs no root. Codex, PR #7.)*
2. **Given** the AppImage is running offline, **When** the user completes the signing flow, **Then**
   the output passes the automated signature validator.
3. **Given** the user deletes the AppImage **and its adjacent data folder**, **When** the machine is
   inspected, **Then** no application data remains except files the user explicitly saved (see
   SC-005).

---

### User Story 3 - Understand what you are running and what it cannot do (Priority: P2)

Before or while running the desktop app, a user learns three things without having to ask: that the
binary is **not signed by a recognised authority** and what that means; that it **never updates
itself**, so security fixes require downloading a new build; and that this is the **same tool** as
the web app with the same non-legal-advice positioning.

**Why this priority**: Principle IV (honest security posture) is binding, and this feature creates
two *new* honesty obligations that do not exist for the web app — an unverified binary and a frozen,
non-updating runtime. Shipping the binaries without these disclosures would be a defect under IV.
It is P2 only because the binaries must exist before they can be described.

**Independent Test**: Inspect the release page and the app's about/info surface; verify each of the
three disclosures is present, accurate, and stated without euphemism.

**Acceptance Scenarios**:

1. **Given** a user encounters a security warning on first run (Windows SmartScreen or equivalent),
   **When** they consult the release documentation, **Then** they find an explicit, plain statement
   that the binary is unsigned, why the warning appears, and how to verify the download instead.
2. **Given** the application is running, **When** the user looks for version information, **Then**
   they can see which build they have and a statement that it does not self-update.
3. **Given** the app describes its own security properties anywhere, **When** those claims are read
   against actual behaviour, **Then** no claim overstates what the desktop build enforces.

---

### User Story 4 - Verify a download you did not build (Priority: P3)

A cautious user (or the author, on a second machine) wants assurance that the binary they downloaded
is the one that was published, given that no code-signing certificate vouches for it.

**Why this priority**: This is the honest substitute for code signing. It is P3 because US1/US2 are
usable without it and it is meaningless until releases exist — but without it, "unsigned" has no
mitigation at all.

**Independent Test**: Publish a release, download the artifact on a different machine, confirm its
checksum matches the published value, **and independently verify its build-provenance attestation
against the source commit and build workflow**. *(Amended 2026-07-17: the test stopped at the
checksum, which only proves the download equals the published asset — it says nothing about who
produced that asset, and would pass for a binary built on a laptop and uploaded by hand. Since
FR-018a exists precisely to prove CI built it from a stated commit, the attestation check is the
test. Codex, PR #7.)*

**Acceptance Scenarios**:

1. **Given** a published release, **When** a user downloads a binary, **Then** a published checksum
   for that exact artifact is available and matches the downloaded file.
2. **Given** a release artifact, **When** a user traces its origin, **Then** they can identify the
   exact source commit it was built from.

---

### Edge Cases

- **No write access to the working directory** (read-only USB or network share): the app must still
  open and sign; the opt-in "remember" affordances are **not offered**, and the user is told why.
  **This does NOT mirror the web app's storage-failure handling** — that path only fires when a write
  *fails*, and Electron is given a writable temp `userData`, so writes would *succeed* and a
  remembered `.p12` would land on the host. Memory-only is enforced by **not writing**. Rules:
  [contracts/portable-paths.md](contracts/portable-paths.md). *(Amended 2026-07-17: this edge case
  still deferred to the web behaviour after the mechanism was corrected everywhere else — and sitting
  in the authoritative spec, it could justify a relocate-only implementation. Codex, PR #7.)*
- **A second copy launched while one is running**: two instances of a portable app must not corrupt
  each other's opt-in store or deadlock over it.
- **The user saves a signed file to a path that no longer exists** (unplugged USB): must fail with a
  recoverable message, never with silent loss of the signed bytes.
- **Antivirus quarantines the unsigned binary mid-run**: outside the app's control, but the failure
  must not produce a half-written signed PDF.
- **A large scanned/image-heavy PDF** — currently unmeasured even on web (per `docs/perf.md`).
  Desktop has more memory headroom than mobile, so no regression is expected, but the desktop build
  MUST NOT be claimed to have fixed it.
- **Host has no GPU / software rendering only** (VM, RDP session, minimal container): the app must
  render and sign, even if placement dragging is less smooth than the measured web figures.

## Requirements *(mandatory)*

### Functional Requirements

**Distribution & portability**

- **FR-001**: The system MUST produce a Windows desktop application delivered as a **single
  executable file** that runs without an installer, without administrator rights, and **without the
  installer or the application writing to the Windows registry**. *(Scoped 2026-07-17: previously an
  unqualified "without writing to the Windows registry". Windows itself records execution traces in
  registry-backed locations (e.g. compatibility/MRU data) that no application can prevent — so the
  unqualified promise fails under inspection even when the app does everything right. Consistent with
  the rest of the no-trace scoping: we promise what we control. Codex, PR #7.)*
- **FR-002**: The system MUST produce a Linux desktop application delivered as a **single executable
  file** that runs without root and without installing shared dependencies onto the host.
- **FR-002a**: The Linux artifact MUST remain usable on hosts **without FUSE/libfuse configured**,
  via a **documented and tested no-root fallback** (`--appimage-extract-and-run`). The release
  documentation MUST state plainly that a plain double-click fails on such hosts and give the
  fallback command. *(Added 2026-07-17: an AppImage self-mounts via FUSE, and many current
  distributions — plus most minimal containers and locked-down systems — do not ship `libfuse2` by
  default. On those hosts the standard advice is "install libfuse2" — a package manager and root,
  exactly what this feature promises users won't need. **The app cannot intercept that failure**: it
  happens in the AppImage runtime before any application code runs, so the requirement is to
  document and test the fallback, not to control the error. Codex, PR #7.)*
- **FR-003**: Both desktop applications MUST run from any location the user can execute from,
  including removable media, without configuration.
- **FR-004**: The system MUST NOT produce or publish a macOS artifact under this feature. *(Out of
  scope: the unsigned-binary mitigation available on Windows and Linux — "accept the warning" —
  does not exist on macOS, where an un-notarized app is commonly refused outright.)*

**Zero-network (Principle I)**

- **FR-005**: The desktop applications MUST be incapable of transmitting user content off-device.
  Beyond the existing content-level policy, the desktop runtime MUST deny outbound network requests
  at the runtime level, so the guarantee does not rest on a single mechanism.
- **FR-006**: The desktop applications MUST be fully functional with no network interface present,
  and MUST NOT contact any host at any point in their lifecycle — including start-up, version or
  update checks, telemetry, crash reporting, and font/asset loading.
- **FR-007**: The desktop applications MUST NOT self-update, and MUST NOT check whether an update
  exists. *(Follows from FR-006; stated separately because auto-update is the default behaviour of
  desktop application frameworks and must be actively disabled.)*

**Correctness (Principles III & V — unchanged, binding)**

- **FR-008**: For identical inputs, a document signed by a desktop application MUST be structurally
  equivalent to one signed by the web application, and MUST pass the same automated signature
  validation gate.
- **FR-009**: The desktop applications MUST execute the same signing implementation as the web
  application, on a rendering/crypto engine equivalent to the one the existing automated test suite
  and signature gate run against. A desktop build MUST NOT introduce a second, separately-maintained
  signing path.
- **FR-010**: The automated signature validation gate MUST be run against output produced by a
  desktop build before that build is published. *(Principle V: existing web evidence does not
  transfer by assertion — it transfers only once demonstrated on the artifact being shipped.)*

**On-device data minimization (Principle VI)**

- **FR-011**: The desktop applications MUST NOT write user content to any on-device store unless the
  user explicitly opted in, consistent with existing web behaviour.
- **FR-011a**: Any data the desktop applications persist MUST be written to a location **adjacent to
  the executable**, and MUST NOT be written to the operating system's per-user application-data
  location. Deleting the application's own folder MUST remove all data the application has stored.
- **FR-011b**: When the location adjacent to the executable is not writable (read-only media, a
  restricted share), the desktop applications MUST remain fully functional for signing and MUST
  degrade to memory-only operation with a clear, non-blocking explanation — never a crash and never
  a silent fallback to another location on the host.
- **FR-012**: The desktop applications MUST NEVER write a certificate password or decrypted
  private-key material to **any store the application creates or controls** — including its data
  directory, temporary files, logs, and crash dumps. *(Absolute carve-out; no opt-in. This is why the
  shell never calls `crashReporter.start()` and adds no disk logging.)*
- **FR-012a**: The applications MUST NOT claim that secrets cannot reach disk **at all**. During
  signing, the password and decrypted key necessarily exist in process memory, and an OS with a
  pagefile/swap enabled may page that memory out — outside any application's control, and not
  preventable by the mechanisms in this feature. Where this is surfaced, it MUST be described as
  best-effort, consistent with the constitution's existing position that in-memory secret handling is
  "best-effort reference-dropping, never … guaranteed erasure". *(Added 2026-07-17: FR-012 originally
  said "MUST NEVER persist … swap-backed application state" — an absolute nothing in this design
  enforces, i.e. a false security claim of exactly the kind Principle IV forbids. The constitution was
  already honest here; this requirement had overclaimed past it. Codex, PR #7.)*
- **FR-013**: The user MUST be able to remove all data the desktop application has stored, and MUST
  be told where that data lives — including that deleting the application folder removes it
  (FR-011a).

**Honest posture (Principle IV)**

- **FR-014**: Published desktop binaries MUST be accompanied by an explicit disclosure that they are
  **not signed by a recognised code-signing authority**, what security warning this causes, and what
  the user can do instead to verify authenticity.
- **FR-015**: The desktop applications MUST expose their build version and build date, and MUST
  state that they do not self-update.
- **FR-015a**: Once the **bundled engine's** age exceeds a defined staleness threshold, the desktop
  applications MUST passively inform the user that the engine is ageing and that a newer build should
  be obtained. This determination MUST be made **entirely locally** by comparing the embedded
  **engine release date** (`engineDate`, see [data-model.md](data-model.md) § BuildMetadata) against
  the device clock — it MUST NOT involve any network request (FR-006). The notice MUST NOT block
  signing.
  **⚠ MUST NOT be driven by the artifact's build date.** A rebuild from an unchanged lockfile resets
  `buildDate` while shipping the identical year-old engine — so a routine CI rerun would silence the
  warning exactly when it matters most. *(Amended 2026-07-17: this requirement still said "the
  embedded build date" after the data model had corrected the metric to `engineDate` — and since this
  FR is the authority an implementer follows, T011/T026/quickstart all mirrored the wrong measure.
  Codex, PR #7 — P1.)*
- **FR-015b**: The staleness notice MUST be accurate about *why* it matters — that the application
  bundles a browser engine which does not receive security updates — without overclaiming a specific
  known vulnerability. *(Principle IV.)*
- **FR-016**: The desktop applications MUST NOT claim any security property the web app does not
  have, and MUST carry the same non-legal-advice positioning.

**Release integrity**

- **FR-017**: Each published desktop binary MUST have a published checksum that a user can verify
  independently.
- **FR-018**: Each published desktop binary MUST be traceable to the exact source commit it was
  built from.
- **FR-018a**: Desktop binaries MUST be produced by the project's automated build pipeline, not by
  an individual's machine, and MUST be published with a **verifiable build-provenance attestation**
  binding each artifact to its source commit and build workflow. A user MUST be able to verify that
  attestation independently, without trusting the release page's contents. *(This is the honest
  substitute for the code-signing certificate the project does not have — FR-014.)*

**Non-regression**

- **FR-019**: The existing web PWA MUST continue to build, deploy, and **function unchanged**.
  Desktop packaging MUST NOT alter the web application's **behaviour** or its existing gates, MUST
  NOT add any network or persistence capability to it, and MUST NOT surface any desktop-only UI in
  it. *(Amended 2026-07-17: previously also forbade altering "bundle contents". That was
  unachievable as written and therefore misleading — the build-date metadata this feature injects
  (FR-015) is inert, but it does change the web bundle's bytes, so the requirement was violated by
  its own design from the start. The meaningful guarantee is **behavioural**, and it is stated as
  such. Codex, PR #7.)*
- **FR-019a**: Desktop-only user-facing code (e.g. the staleness notice, FR-015a) MUST NOT be
  included in the web bundle at all — suppressing it at runtime via a `distribution` check is
  insufficient. It MUST be isolated behind a module the web build never imports, so the web app does
  not ship code for a distribution it is not.
- **FR-020**: All **shared** functional requirements of the signing application (`001-pdf-signer`) —
  signing, placement, certificate handling, appearance, privacy, and persistence — MUST hold in the
  desktop applications. This feature adds distribution, not capability.
  **Explicitly excluded: 001's web-distribution requirements**, which are meaningless or actively
  wrong for a packaged app — e.g. FR-025 ("install the app to their device home screen"), the web app
  manifest, and service-worker precache (see FR-019a and R5). *(Scoped 2026-07-17: FR-020 previously
  imported **all** of 001's FRs, which read literally makes the desktop spec impossible to satisfy and
  would push an implementer toward fabricating PWA/installability behaviour inside Electron. The
  constitution (v1.1.0) already defines "installable" per distribution; FR-020 must not re-import the
  web's definition. Codex, PR #7.)*

### Key Entities

- **Desktop Build**: A published, runnable artifact for one platform. Attributes: target platform,
  version, source commit, checksum, signed status (always "unsigned" in this feature).
- **Release**: A set of Desktop Builds published together from one source commit, with disclosures
  and checksums.
- **Portable Application State**: Any data the desktop app writes to the host. Ideally empty.
  Governed by FR-011/FR-012/FR-013.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from "I have the file" to "I have a signed PDF" on a machine with **no
  network connection and no installation rights**, in under 60 seconds (matching the web app's
  existing budget), on both target platforms.
- **SC-002**: **100%** of desktop-produced signatures pass the automated signature validator — the
  same pass rate demanded of the web build. Any failure blocks the release.
- **SC-003**: A signed document produced on desktop and one produced on web, from identical inputs,
  are **structurally equivalent** and both validate.
- **SC-004**: The application makes **zero** network requests across its entire lifecycle, observed
  from outside the app (not merely asserted internally).
- **SC-005**: All **user content and application state** the app writes lives in **one** directory
  adjacent to the artifact. After running the app and deleting **the artifact and that adjacent
  folder**, a user finds **zero** residual user content or application state anywhere on the host —
  in particular, nothing in the operating system's per-user application-data location.
  **Two scoping caveats, both disclosed rather than glossed** (Principle IV):
  (a) the Windows portable target extracts **its own program files** to a temp directory while
  running and removes them on exit — a hard crash can leave them, and they are program code, never
  user content;
  (b) OS-controlled traces of having run an executable (prefetch, execution history, antivirus
  records, shell MRU) are outside any application's reach. **This is a privacy tool, not an
  anti-forensics tool.**
  *(Amended 2026-07-17, twice. The original promised zero residue after deleting **the binary alone**
  — false, since a bundled engine writes cache files into its data directory every launch. The
  corrected version still said "zero residual **application data**" unqualified, which the
  portable-paths contract's own temp-extraction caveat contradicts. Codex, PR #7.)*
- **SC-006**: A user encountering a first-run security warning can find an accurate explanation of
  why it appears in **under 1 minute**, without contacting the author.
- **SC-007**: A user can independently verify a downloaded binary's build provenance — confirming
  the exact source commit and that it was produced by the project's own automated pipeline — without
  having to trust the release page's contents.
- **SC-010**: A build whose date is past the staleness threshold shows the user an accurate ageing
  notice, and does so while making **zero** network requests (verified alongside SC-004).
- **SC-011**: An opt-in store written by the desktop app is fully removed by deleting the
  application folder, with **zero** residue in the operating system's per-user application-data
  location.
- **SC-008**: **100%** of the existing web test suite and signature gate continue to pass, and the
  deployed web app is unchanged.
- **SC-009**: Each single-file artifact is a practical download — obtainable on a typical connection
  without special handling. *(Expected magnitude: a few hundred MB, since a full browser engine is
  bundled. A documented cost, not a defect.)*

## Assumptions

- **Chosen approach**: The desktop build wraps the existing web application in a runtime that
  bundles its own browser engine (Electron), rather than using the host's system webview. This is a
  deliberate trade: a much larger artifact in exchange for running on the *same engine family the
  existing test suite and signature gate already validate against*, which makes a passing desktop
  gate **likely** and makes a failure a real bug rather than an engine gap. **It does NOT mean web
  evidence transfers**: FR-010 and Constitution V still require the gate to run against the packaged
  artifact's own output, because `asar` layout, `app://` serving, node polyfills, and the packaged
  engine are all untested by any web run. *(Amended 2026-07-17: this previously said "correctness
  evidence carries over", which contradicted FR-010 and could have been cited to weaken T005/T021/
  T025. The engine choice buys **probability**, never **proof**. Codex, PR #7.)*
  A system-webview approach (Tauri) would produce a far smaller binary but would run the
  signing path on a different engine (WebKitGTK on Linux), requiring the Principle V gate to be
  re-earned there. Recorded as the assumption behind FR-009; revisit in `/speckit-plan` if wrong.
- **Unsigned is accepted for now.** Code-signing certificates (Authenticode) are a recurring paid
  cost with hardware-token key custody. This feature ships unsigned and *discloses* it (FR-014).
  Buying a certificate is a future decision, not a blocker.
- **The author's platform is Windows.** Windows builds and manual verification are native; Linux
  verification runs in WSL or a container. Neither is assumed to be a real end-user's machine.
- **No new signing, UI, or document capability** is introduced. If a desktop-only affordance (native
  file dialogs, file associations, "Open with") proves desirable, it is a **separate feature** —
  including it here would put non-shared code in the signing path and undermine FR-009.
- **The web PWA remains primary.** Desktop is additive; the browser-installable path is unaffected.
- **Existing opt-in persistence semantics carry over** unchanged in intent, pending Q2's resolution
  of *where* that store lives for a portable app.
- **Distribution is via the existing public GitHub repository**, consistent with the current
  pipeline.

## Dependencies

- The existing `001-pdf-signer` application, its test suite, and its pyHanko signature gate.
- ✅ A **constitution amendment to v1.1.0** (see Constitutional Impact) — **landed 2026-07-17**,
  before planning. No longer a blocker.
