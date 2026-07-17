# Phase 0 Research: Portable Offline Desktop Builds

**Feature**: `002-desktop-packaging` | **Date**: 2026-07-17 | **Constitution**: v1.1.0

Resolves every unknown in the plan's Technical Context. Findings are ordered by how much they shape
the design; **R2, R3, and R4 are load-bearing** — getting any of them wrong produces a build that
looks fine and violates a NON-NEGOTIABLE principle silently.

---

## R1 — Runtime shell: Electron vs Tauri

**Decision**: **Electron** + `electron-builder`.

**Rationale**: Principle V (as amended in v1.1.0) now says explicitly that validator evidence is
per-distribution and **cannot be inherited by assertion**, and that a distribution on a different
engine "MUST earn its own passing gate". Both options must therefore run the pyHanko gate. The
difference is what happens when it *fails*: on Electron the engine matches what the 78 existing unit
tests and the Playwright suite already validate, so a failure is a real bug; on Tauri (WebKitGTK on
Linux) a failure could be an engine gap in `canvas`, `crypto.getRandomValues`, WASM, or PDF
rendering, each needing separate diagnosis and possibly a per-engine workaround inside the signing
path — which FR-009 forbids.

We have direct evidence this risk is not hypothetical: 001 already hit `createImageBitmap` working
in Chrome and failing in headless-shell Chromium (`specs/001-pdf-signer/research.md`, deviations).
That was a *Chromium-to-Chromium* difference. A Chromium-to-WebKit difference is strictly larger.

**Cost accepted**: ~150–250 MB per artifact vs ~5–10 MB. Recorded in SC-009 as a documented cost.

**Alternatives considered**:

- **Tauri** — rejected for now, not permanently. Attractive if artifact size ever becomes a real
  user complaint; revisiting means re-earning the Principle V gate on WebKitGTK first.
- **Neutralino / system webview via Go/C#** — same engine-divergence problem as Tauri, smaller
  ecosystem, no gain.
- **PWA install only (status quo)** — already works and remains the primary distribution, but does
  not satisfy the "single file, no URL, air-gapped machine" use case that motivates this feature.

---

## R2 — Loading the app: custom scheme, NOT `file://`

**Decision**: Serve the built `dist/` over a **custom privileged scheme** (`app://`) registered with
`protocol.registerSchemesAsPrivileged` + `protocol.handle`. Do **not** load `file://`.

**Rationale**: `file://` is not a secure context and is not a "standard" scheme, so ES modules hit
CORS restrictions, the FileSystem/Fetch APIs error, and service workers cannot register. Electron's
docs are explicit that to replace `http` you must register the scheme as **standard**; registering
as standard+secure is what unlocks Fetch API, ServiceWorker registration, and V8 code cache.

**⚠ Load-bearing constraint — `bypassCSP` MUST remain `false`.** The privilege list includes
`bypassCSP`, which "allows resources served through that scheme to bypass Content Security Policy
restrictions". Principle I (v1.1.0) requires the desktop build to keep the CSP **and** add runtime
denial — CSP is not replaced by runtime denial, it is joined by it. Setting `bypassCSP: true` (easy
to copy from a tutorial) would silently disable `connect-src 'none'` and void half of Principle I's
enforcement while every test still passed. This is the single highest-risk line in the feature.

Privileges to set: `{ standard: true, secure: true, supportFetchAPI: true }`. `allowServiceWorkers`
only if R5 concludes we keep the SW. `bypassCSP`, `corsEnabled`, `stream` — not needed; leave unset.

**Handler must be path-safe**: resolve requested paths against the `dist` root and reject anything
escaping it (`..`), so the scheme cannot serve arbitrary host files.

**Alternatives considered**:

- **`file://` + `webSecurity: false`** — rejected outright. Disabling web security to work around a
  loading problem would defeat the CSP that Principle I mandates.
- **Local HTTP server on `127.0.0.1`** — rejected. It opens a listening socket, which contradicts
  the spirit of FR-005/FR-006 and gives the app a network surface it currently cannot have.

---

## R3 — Portable state location (FR-011a/b)

**Decision**: Before `app.whenReady()`, call `app.setPath('userData', <dir adjacent to the
artifact>/**pdf-signer-data**)`, resolving the artifact directory per platform. *(Corrected
2026-07-17: this said `/data`, while the path contract, data model, and quickstart all specify
`pdf-signer-data/`. An implementation following the research doc would write state to a folder the
cleanup instructions and portability tests never look in — so residue would survive a "correct"
cleanup and the tests would still pass. One name: `pdf-signer-data/`. Codex, PR #7.)*

| Platform | Source of truth | Notes |
|---|---|---|
| Windows portable | `process.env.PORTABLE_EXECUTABLE_DIR` | Set by electron-builder's `portable` target |
| Linux AppImage | `dirname(process.env.APPIMAGE)` | `APPIMAGE` holds the **absolute path of the AppImage file** |
| Dev / unpackaged | fall back to Electron default | Keeps `npm run dev` sane |

**Rationale**: relocating `userData` is a **one-line seam that requires zero application-code
change** — `idb-keyval`/IndexedDB in `src/features/persistence/certStore.ts` lives under `userData`,
so it follows automatically. This keeps FR-009 clean (no desktop branch in app code) while
satisfying FR-011a.

**⚠ Load-bearing gotcha — `process.execPath` is WRONG here.** The electron-builder `portable` target
**extracts the app into a temp directory** (`%LOCALAPPDATA%\Temp\<guid>.tmp\app`) and launches from
there. So `process.execPath`, `__dirname`, and `app.getAppPath()` all point at **temp**, not at where
the user put the `.exe`. Deriving the data directory from any of them would write state into a temp
folder — appearing to work in testing, then losing the user's remembered certificate on the next run
(new GUID), and quietly violating FR-011a. `PORTABLE_EXECUTABLE_DIR` exists precisely for this.

Symmetrically on Linux, an AppImage is a mounted squashfs: `process.execPath` points inside the
read-only mount (`/tmp/.mount_XXXX`). `APPIMAGE` is the documented way to get the real file path.
Note `ARGV0` is *not* a substitute — it reports how the AppImage was invoked (and gives the symlink
path when launched through one), whereas `APPIMAGE` is the absolute path of the actual file.

**FR-011b (read-only media)**: if the adjacent directory is not writable, do **not** fall back to the
OS user-data directory — that would leave residue on the host and break SC-005/SC-011. Instead leave
`userData` on a throwaway temp path for the session and surface the memory-only state to the user.
The existing `certStore` already swallows storage failures and degrades silently
(`certStore.ts:16-24`), so the *code* already survives this; the work is making the degradation
**visible** (FR-011b demands a clear explanation, and the current behaviour is deliberately silent).

**Residue caveat (honesty, SC-005)**: the Windows portable target's temp extraction means the app
*does* write its own program files to temp while running; the launcher cleans them up on exit, but a
hard crash can leave them. This is **application code, never user content** (user content stays in
`userData`, which we relocate), so FR-012 is unaffected — but SC-005 must be assessed against *user
data*, and the temp-extraction behaviour should be stated plainly rather than glossed. Do not claim
"leaves absolutely nothing on the machine, ever".

---

## R4 — Runtime network denial + disabling framework phone-home (FR-005/006/007)

**Decision**: Layer four independent controls; do not rely on any single one.

1. **CSP unchanged** — the existing `connect-src 'none'` meta tag in `index.html` ships as-is
   (`bypassCSP` false per R2).
2. **Runtime request denial** — `session.defaultSession.webRequest.onBeforeRequest` cancels every
   request whose scheme is not `app:`/`blob:`/`data:`. This is part of the "runtime-level outbound
   denial" Principle I (v1.1.0) mandates for packaged distributions, and it catches Chromium-session
   requests CSP does not govern.
   **⚠ It does NOT cover the main process.** `session.webRequest` sees Chromium-session traffic only;
   Node's `fetch`/`http`/`https`/`net` in main bypass it entirely. *(Corrected 2026-07-17 — this note
   originally claimed it catches "main-process fetches", which is **false** and, left in the design
   input, could be cited to implement T008 as sufficient and re-open the very Layer 3 bypass the
   contract now closes. Codex, PR #7 — P1.)* Main-process traffic is covered **only** by layer 3
   below.
3. **Node-side prohibition (the ONLY main-process guard)** — no Node network API may be imported or
   called in `electron/**`, enforced by an eslint **import allow-list** (not merely a deny-list of
   `node:http` etc., which `import got from 'got'` walks straight past) plus a packaged-build
   dependency audit. See [contracts/network-policy.md](contracts/network-policy.md) § Layer 3.
4. **No auto-updater** — `electron-updater` is simply **not a dependency**. FR-007 is satisfied by
   absence, which is stronger than configuration: there is no flag to accidentally flip.
4. **Crash reporter off** — Electron's `crashReporter` does not upload unless `start()` is called,
   so the rule is "never call it". Additionally disable Chromium's own metrics/reporting via command
   line switches, and set `app.setAppLogsPath` expectations so no diagnostics accumulate.

**Also**: block `will-navigate` and `setWindowOpenHandler` to `deny`, so no in-app link can navigate
the window to a remote origin or spawn one.

**Verification (SC-004)** must be observed from **outside** the app — the spec says "not merely
asserted internally". The **primary release gate is a live-but-monitored network** (firewall/proxy/
packet capture) across launch → sign → idle → quit, failing on **any** DNS/TCP/HTTP attempt.

*(Corrected 2026-07-17: this originally preferred running with **no network interface** for the
release gate. That proves the app *works* offline — it cannot prove the app never *tries*: a Node-side
update check, telemetry ping, or DNS lookup fails instantly against a dead interface, records
nothing, and the signing flow stays green. Since this file is the design input for that gate, the
weaker method here would have propagated into the implementation. The offline run is retained as a
**separate** check of a different property. Codex, PR #7 — P1.)*

---

## R5 — Service worker in the desktop build

**Decision**: **Do not register the service worker** in desktop builds. Achieve this with a
build-time flag consumed at the registration call site only.

**Rationale**: The SW exists to make the *web* app work offline by precaching. In a packaged app
every asset is already local and served by our own `app://` handler — the SW would add a second
caching layer with its own invalidation semantics, plus a stale-content risk across versions, for
zero benefit. Keeping it would also force `allowServiceWorkers` on the scheme (more privilege for
nothing).

**FR-009 check**: this touches **registration/bootstrap only, never the signing path**. FR-009
forbids a divergent *signing* implementation; a build-flag at the SW registration site is not that.
Still, it is the one intentional web/desktop divergence in the feature and must be called out in the
plan's Complexity Tracking rather than buried.

**FR-019 check**: implemented as a flag that is **off by default**, so the web build's behaviour is
identical to today unless the desktop build explicitly sets it. *(FR-019 is a **behavioural**
guarantee — byte-identity is impossible once this feature injects build metadata (T011), so claiming
it would make the requirement self-violating. The web bundle must additionally contain **no**
desktop-only code, FR-019a.)*

---

## R6 — Local staleness nudge (FR-015a/b)

**Decision**: Inject the build date at **build time** (a Vite `define` constant, sourced from the CI
build timestamp / commit date), compare against `Date.now()` at runtime, and render a passive,
non-blocking notice once past the threshold.

**Threshold**: **180 days (6 months)**. Rationale: Chromium ships stable releases roughly every 4
weeks; six months is ~6 releases behind — late enough to avoid nagging about a fresh build, early
enough that the warning precedes a genuinely ancient engine. Recorded as a named constant so it is
one edit, not a hunt.

**Constraints**:

- **Zero network** (FR-015a) — this is arithmetic on an embedded constant, nothing else. It cannot
  regress into an update check.
- **Clock is untrusted, and that's acceptable.** A user with a wrong system clock gets a wrong nudge.
  The failure is benign in both directions (a spurious notice, or a missing one) and the alternative
  — asking a server for the time — is forbidden. Do not attempt to detect clock skew.
- **Wording** (FR-015b) must say the bundled engine stops receiving security updates, without
  implying a specific known vulnerability.
- Must not block signing.

**Alternatives considered**: shipping an expiry that disables the app — rejected, user-hostile and
would strand an air-gapped user mid-task, which is exactly this feature's audience.

---

## R7 — Running the signature gate against desktop output (FR-010, Principle V)

**Decision**: Drive the **packaged binary** with Playwright's Electron support
(`_electron.launch({ executablePath })`), complete a real signing flow, capture the output PDF, and
feed it to the existing `scripts/validate_pdf.py` / `npm run verify:signatures`.

**Rationale**: Principle V (v1.1.0) requires evidence from "output actually produced by the artifact
being shipped". Launching the *packaged* binary — rather than Electron-from-`node_modules` against
source — is the only thing that satisfies that wording, and it also exercises `asar` packing, the
`app://` handler, and the `userData` relocation, all of which are exactly where packaging bugs live.

**Reuse**: the existing fixtures (`tests/e2e/fixtures/`: `signature.png`, `e2e-cert.p12` /
`e2e-pass`, `sample-large.pdf`) and `scripts/validate_pdf.py` carry over unchanged. This is a new
harness around existing assertions, not new assertions.

**Cross-platform**: the Windows binary is verifiable natively on the dev machine and in CI; the
AppImage runs in CI's Linux runner. Both must pass before either publishes (FR-010).

---

## R8 — CI build + provenance attestation (FR-018a)

**Decision**: Build both artifacts in GitHub Actions; publish to GitHub Releases with SHA-256
checksums **and** a Sigstore-backed build-provenance attestation.

**Mechanics**:

- Use **`actions/attest-build-provenance`**. Note: as of v4 it is a thin wrapper over
  `actions/attest`, and GitHub now steers new implementations toward `actions/attest` directly —
  either satisfies FR-018a; prefer whichever the docs currently recommend at implementation time.
- Required permissions: **`id-token: write`** (mint the OIDC token for the Sigstore signing
  certificate), **`attestations: write`** (persist it), `contents: read`/`write` (read source /
  upload release assets).
- Attestations bind the artifact's **digest** to a SLSA provenance predicate in in-toto format,
  signed with a short-lived Sigstore certificate.
- Users verify with **`gh attestation verify <artifact> --repo kurtvalcorza/pdf-signer-pwa`**.

**✅ Availability confirmed**: artifact attestations are available on **all current GitHub plans for
public repositories**; private/internal repos require Enterprise Cloud. `pdf-signer-pwa` is public,
so this is free and available — no blocker.

**Why this and not code signing**: an Authenticode certificate proves *who built it*; attestation
proves *what built it, from which commit*. The latter is free, verifiable by anyone, and is the
honest mitigation FR-014 promises in place of a certificate. It does **not** stop the SmartScreen
warning — nothing but a real certificate does. That distinction must not blur in the docs.

**Build matrix**: `windows-latest` for the portable `.exe`, `ubuntu-latest` for the AppImage. Do not
cross-compile; native runners avoid an entire class of toolchain problems for zero cost.

---

## R9 — Not regressing the web build (FR-019)

**Decision**: Desktop packaging is **additive** — a separate `electron-builder` config plus new
main/preload entry points and a separate build script. `vite.config.ts` gains at most the build-date
`define` (R6), which is inert for the web build.

**Guards**:

- Electron and `electron-builder` are **devDependencies** — they must never enter the web bundle.
- The desktop main/preload live outside `src/` (see plan's Structure Decision) so the web build's
  module graph is untouched.
- The existing web gates (`npm run build`, 78 unit tests, `verify:signatures`, Playwright, PWA E2E)
  must stay green and unmodified; SC-008 is measured by exactly that.

---

## R10 — Saving the signed PDF in Electron

**Decision**: Change nothing in app code; let Electron's default download handling show the OS save
dialog.

**Rationale**: the app triggers downloads via a `blob:` URL + `<a download>` (this is also why the
US1 E2E excludes `blob:`/`data:` from its "no external request" assertion — see 001's research). In
Electron this raises the session's `will-download` event, whose default behaviour is a save dialog —
which is the desired desktop UX and requires no code change, preserving FR-009 and FR-020.

**Watch**: `blob:` must be allow-listed in the R4 request filter, or downloads break. This is the
most likely way R4's filter goes wrong.

---

## Open risks carried into the plan

| Risk | Why it matters | Mitigation |
|---|---|---|
| `bypassCSP: true` copied from a tutorial | Silently voids the page CSP for `app:`-served resources; every test still passes (NON-NEGOTIABLE Principle I) | **Assert the scheme registration directly** — the privileges object passed to `registerSchemesAsPrivileged` must contain no truthy `bypassCSP` — plus a CSP-disallowed `app:` resource. *(Corrected 2026-07-17: originally "assert the shipped CSP from inside the packaged app", which **cannot fail** for this bug — `bypassCSP` leaves the CSP meta tag untouched, and the privilege is scheme-scoped so a `connect-src` probe fires either way. Leaving the weaker mitigation here would steer the E2E straight back to the bypassable guard. Codex, PR #7.)* |
| Data dir derived from `process.execPath` | Writes state to temp; user silently loses remembered cert; violates FR-011a | Use `PORTABLE_EXECUTABLE_DIR` / `APPIMAGE`; test by running the binary from two different folders |
| R4 filter blocks `blob:` | Signed-PDF download silently breaks | Covered by the desktop E2E, which downloads a real signed file |
| Staleness nudge quietly becomes an update check | Violates FR-006/007 and Principle I | No network client in main; SC-004 observed externally |
| Desktop-only branch creeps into signing path | Voids the entire rationale for Electron over Tauri (R1) | FR-009; flagged in the requirements checklist |

## Sources

- [electron-builder — portable target / `PORTABLE_EXECUTABLE_DIR`](https://github.com/electron-userland/electron-builder/issues/3186), [temp-extraction behaviour](https://github.com/electron-userland/electron-builder/issues/1612)
- [AppImage — environment variables (`APPIMAGE`, `ARGV0`)](https://docs.appimage.org/packaging-guide/environment-variables.html)
- [Electron — `protocol` API (`registerSchemesAsPrivileged`, `protocol.handle`, `bypassCSP`)](https://www.electronjs.org/docs/latest/api/protocol)
- [Electron — Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Playwright — Electron class (`_electron.launch`, `executablePath`)](https://playwright.dev/docs/api/class-electron)
- [GitHub — `actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance)
- [GitHub Docs — artifact attestations (plan availability, `gh attestation verify`)](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
