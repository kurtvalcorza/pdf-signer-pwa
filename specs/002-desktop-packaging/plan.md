# Implementation Plan: Portable Offline Desktop Builds (Windows + Linux)

**Branch**: `002-desktop-packaging` | **Date**: 2026-07-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-desktop-packaging/spec.md`

## Summary

Wrap the existing web application in Electron and emit two portable, single-file, offline artifacts —
a Windows `portable .exe` and a Linux AppImage — via `electron-builder`. No installer, no registry,
no network, no auto-update.

The application code is **reused wholesale**. The desktop shell is a thin main process that does four
things the browser did for us: serves `dist/` over a custom `app://` scheme (R2), relocates the data
directory next to the artifact (R3), denies outbound network at the runtime level (R4), and stays out
of the way of everything else. There is **no desktop-specific signing code** (FR-009) — that
constraint is the entire reason Electron was chosen over a smaller system-webview runtime, since it
keeps the engine aligned with the suite that already validates the signing path.

Correctness is not inherited: the pyHanko gate runs against a signing flow driven through the
**packaged binary** on each platform before either publishes (FR-010, Principle V).

## Technical Context

**Language/Version**: TypeScript 5.6 (unchanged); Node ≥ 20 for the build toolchain

**Primary Dependencies**: `electron` + `electron-builder` (**devDependencies only** — must never
enter the web bundle). Existing runtime stack unchanged: React 18, Vite 5, `pdfjs-dist`, `pdf-lib`,
`@signpdf/*`, `node-forge`, `idb-keyval`. **Deliberately absent**: `electron-updater` (FR-007 is
satisfied by absence, not configuration).

**Storage**: IndexedDB via `idb-keyval`, unchanged — relocated by pointing Electron's `userData` at a
directory adjacent to the artifact (R3). No new persistence code.

**Testing**: Vitest (83 existing unit tests, unchanged); Playwright for the desktop E2E via
`_electron.launch({ executablePath })` against the **packaged** binary (R7); `scripts/validate_pdf.py`
(pyHanko) as the release gate on desktop-produced output.

**Target Platform**: Windows 10/11 x64 (portable `.exe`); Linux x86_64 (AppImage). macOS explicitly
out of scope (FR-004).

**Project Type**: Desktop application shell over an existing single-page web application — two
distributions, one codebase (Constitution v1.1.0, Technology & Deployment Constraints).

**Performance Goals**: Inherit 001's budgets (SC-001: full flow < 60 s; measured 977 ms on web).
Desktop has more headroom than a throttled Pixel 7, so no new targets. Cold-start of the portable
`.exe` includes a temp extraction (R3) and is expected to dominate — measure, don't assume.

**Constraints**: Zero network at runtime (enforced by four independent layers, R4); no installer/
registry/root; state adjacent to the artifact or nowhere (R3); artifacts ~150–250 MB (SC-009,
accepted); unsigned binaries (FR-014).

**Scale/Scope**: 2 artifacts, 1 shell (main + preload), ~1 build config, 1 CI workflow addition, 1
new E2E harness. No new user-facing capability (FR-020).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Constitution version**: **v1.1.0** — amended 2026-07-17, *before* this plan, specifically so this
feature could be checked against text that describes it. The five browser-specific collisions are
closed; see [spec.md](spec.md) § Constitutional Impact for the record.

### Initial check (pre-Phase 0)

| Principle | Verdict | Basis |
|---|---|---|
| **I. Zero-Server, Client-Side Only** (NON-NEG) | ✅ **Pass — strengthened** | There is no server *at all* in this distribution, which is the strongest possible reading of the principle. v1.1.0 requires the strongest prohibition available: CSP is retained **and** joined by runtime-level outbound denial (FR-005, R4). **Sharpest risk**: `bypassCSP: true` on the custom scheme would silently void `connect-src 'none'` (R2) — mitigated by an in-app CSP assertion in the gate, not by review. |
| **II. Offline-First & Installable** | ✅ **Pass** | v1.1.0 defines "installable" per distribution; a self-contained artifact needing no installer or elevation is the desktop form (FR-001/002/003). Offline is total, not best-effort (FR-006). |
| **III. Cryptographic Correctness** (NON-NEG) | ✅ **Pass** | Signing path untouched and shared; FR-009 forbids a second implementation. The scope note in v1.1.0 ("a distribution MUST NOT carry a separate or divergent signing implementation") is satisfied by construction — the desktop shell contains no PDF or crypto code. |
| **IV. Honest Security Posture** | ✅ **Pass — with new obligations** | This feature *creates* two weaknesses the web app lacks, and v1.1.0 now makes disclosing them constitutional rather than optional: frozen bundled engine → local staleness nudge (FR-015a/b, R6); unsigned artifacts → plain disclosure + verification path (FR-014, FR-018a). Both ship **in this feature**, per the honesty gate ("MUST ship its disclosure in the same change, not in a follow-up"). |
| **V. Verify Against Real Readers** (Test-First) | ✅ **Pass** | v1.1.0: evidence is per-distribution, not inherited. The gate runs against output from the **packaged** artifact on each platform before publish (FR-010, R7). Same engine family makes success *likely*; the run makes it *demonstrated*. |
| **VI. On-Device Data Minimization** | ✅ **Pass** | v1.1.0 generalizes persistence to any on-device store incl. an app data directory. State goes adjacent to the artifact (FR-011a) — never the OS user-data dir, even as a fallback (R3). Absolute carve-outs (password, private key) untouched: the shell adds no persistence and no logging (FR-012). |

**Result**: ✅ **PASS — no violations, no justifications required.** One intentional web/desktop
divergence (service-worker registration, R5) is recorded in Complexity Tracking below; it is outside
the signing path and therefore not an FR-009 violation.

### Post-design re-check (after Phase 1)

Re-evaluated against `data-model.md`, `contracts/`, and `quickstart.md`.

| Principle | Verdict | What the design changed |
|---|---|---|
| **I** | ✅ Pass | Design adds nothing that can reach a network: no HTTP server (R2 rejected `127.0.0.1`), no updater dependency, `will-navigate` prevented, `setWindowOpenHandler` denied. `contracts/network-policy.md` states the allow-list (`app:`/`blob:`/`data:`) that the gate asserts. **One carve-out**, added 2026-07-17 after an audit found this design would have silently killed the shipped "View source on GitHub" link (FR-020 breach): that one compile-time-constant URL is handed to the OS browser via `shell.openExternal`. The app itself still issues zero requests and no user content moves; allow-listed by exact string, never by pattern. |
| **II** | ✅ Pass | Artifacts confirmed self-contained; no runtime remote fetch anywhere in the design. |
| **III** | ✅ Pass | Phase 1 produced **zero** additions to `src/features/signing/**`. Design is shell-only. |
| **IV** | ✅ Pass | Staleness threshold fixed at a named constant (180 days, R6); disclosure surfaces are contracted, not aspirational. Honest caveat recorded: temp extraction (R3) and "attestation ≠ removing the SmartScreen warning" (R8). |
| **V** | ✅ Pass | `quickstart.md` makes the packaged-binary → pyHanko path the runnable release gate. |
| **VI** | ✅ Pass | Read-only-media fallback explicitly refuses the OS user-data dir (R3/FR-011b) — the design closes the one path that would have leaked residue. |

**Result**: ✅ **PASS.** No new violations introduced by the design. Proceed to `/speckit-tasks`.

## Authority map — where each rule lives (READ THIS FIRST)

**One claim, one home.** Every normative rule below has exactly **one** authoritative document. Every
other document **references** it and MUST NOT restate it.

| Domain | **Sole authority** | Everything else does |
|---|---|---|
| Network layers, allow-list, scheme privileges & timing, `openExternal` carve-out, SC-004 verification | **[contracts/network-policy.md](contracts/network-policy.md)** | link to it |
| Data-directory resolution, `ephemeral` mode, cleanup promise & its caveats | **[contracts/portable-paths.md](contracts/portable-paths.md)** | link to it |
| Release gates, provenance, checksums, disclosure content | **[contracts/release-artifacts.md](contracts/release-artifacts.md)** | link to it |
| Entities & their fields (incl. staleness inputs) | **[data-model.md](data-model.md)** | link to it |
| WHAT & WHY — user stories, FR/SC | **[spec.md](spec.md)** | link to it |
| Decisions & rationale — *why* an option was chosen, alternatives, sources | **[research.md](research.md)** | link to it |
| Actionable work items | **[tasks.md](tasks.md)** | link to it |

**Why this exists.** Codex review of this PR produced **61 findings across 5 rounds at a flat ~13/round**,
and the large majority were *the same corrected claim still standing in a sibling document* — a P1 in
`research.md` for a rule already fixed in `data-model.md`, `CLAUDE.md` still teaching a guard proven
useless two rounds earlier, the constitution still measuring staleness by build date after the data
model moved to engine date.

That is **exactly** the failure this feature's own constitution amendment diagnosed: *"a constitution
that duplicates the spec will drift from it every time scope moves"*. I removed the constitution's
duplication and then reproduced it across ten documents — so every fix needed applying nine times, and
each round found the copies I missed. Correcting copies faster does not converge; **deleting the
copies does.**

**Rule for anyone editing these docs — including future agents:** if you are about to *restate* a rule
that already has an authority above, link instead. If a rule needs changing, change it in its
authority and nowhere else. `research.md` explains **why**; the contracts define **what**; `tasks.md`
says **do it**. When those blur, they drift.

## Project Structure

### Documentation (this feature)

```text
specs/002-desktop-packaging/
├── plan.md              # This file
├── spec.md              # Feature spec (clarified 2026-07-17)
├── research.md          # Phase 0 output — R1..R10
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output — build + verify guide
├── checklists/
│   └── requirements.md  # Spec quality checklist (passing)
├── contracts/
│   ├── network-policy.md    # What the runtime may and may not request
│   ├── portable-paths.md    # Where state lives, per platform
│   └── release-artifacts.md # What a release publishes and how it verifies
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
electron/                    # NEW — desktop shell only; no PDF/crypto code lives here
├── main.ts                  # app lifecycle, window, protocol, session policy
├── preload.ts               # minimal, contextIsolated; exposes build metadata only
├── protocol.ts              # app:// scheme handler over dist/ (R2, path-safe)
├── paths.ts                 # portable userData resolution (R3)
└── network.ts               # runtime outbound denial + navigation locks (R4)

electron-builder.yml         # NEW — win: portable, linux: AppImage
tsconfig.electron.json       # NEW — main/preload compile separately from the web app

src/                         # UNCHANGED except one flag site (R5) + build-date read (R6)
├── features/signing/**      # ← MUST remain untouched (FR-009 / Principle III)
├── features/persistence/**  # ← unchanged; follows userData automatically (R3)
└── ...

tests/
├── e2e-desktop/             # NEW — Playwright over the PACKAGED binary (R7)
│   ├── desktop-sign.spec.ts     # full flow → signed PDF → pyHanko gate
│   ├── desktop-privacy.spec.ts  # CSP intact, no network, state location
│   └── fixtures -> reuse tests/e2e/fixtures (signature.png, e2e-cert.p12, sample-large.pdf)
└── ...                      # existing suites UNCHANGED (FR-019 / SC-008)

playwright.desktop.config.ts # NEW
.github/workflows/
├── ci.yml                   # existing — untouched (SC-008)
└── release-desktop.yml      # NEW — matrix build, checksums, attestation (R8)
```

**Structure Decision**: A new top-level `electron/` directory holds the entire desktop shell, kept
**outside `src/`** so the web application's module graph is provably untouched (FR-019). The split is
enforced structurally rather than by convention: `electron/` compiles under its own
`tsconfig.electron.json`, and Electron itself is a devDependency, so a stray import of shell code
from `src/` fails the web build rather than silently shipping.

The rule to hold the line on: **`electron/` may know about the web app; the web app must not know
about `electron/`.**

**Same repository, not a separate one** (decision recorded 2026-07-18). The desktop shell lives in
this repo, not a spun-off one, because the entire correctness argument rests on **one shared signing
engine**: the desktop build compiles the *same* `src/features/signing/**` into the *same* renderer
bundle, so the shared engine is a structural fact, not a version pin. A separate repo would make
"shared" mean "shared by whatever version was last pulled in" — precisely the *inherited-by-assertion*
failure Principle V (v1.1.0) forbids — and would turn the release contract's "both artifacts from one
commit" into a cross-repo coordination problem that drifts silently (e.g. a signing fix landing on web
but not yet on desktop). The isolation a split would buy already exists structurally (devDependency +
`tsconfig.electron.json` + the lint boundary above), so a split adds coordination cost for no
containment gain. The one real concern it appears to solve — Electron heaviness polluting the web
deploy — is handled by `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on the deploy runner (T001); nothing in
`src/` imports `electron`, so the web bundle is unaffected and `electron-builder` never runs there.

`src/` changes are **limited to this list** — all outside the signing path (FR-009), none importing
from `electron/`:

| Change | Why | Requirement |
|---|---|---|
| Service-worker registration flag (`src/main.tsx`) | off by default; desktop skips the SW | R5 |
| Read injected build/engine metadata (`src/lib/buildMetadata.ts`) | version, build date, engine age | R6, FR-015 |
| Staleness notice (desktop-only renderer module) | included **only in the desktop build; never imported by `src/App.tsx`** | FR-015a, **FR-019a** |
| About/info surface (**desktop-only**, same isolation as the notice) | version, engine, commit, no-self-update, data location | FR-013, FR-015, **FR-019a** |
| Disable "remember" affordances in `ephemeral` mode | memory-only enforced by not writing | FR-011b |

**`src/features/signing/**` — zero diff** (FR-009, Principle III). T039 checks this.

*(Amended 2026-07-17: this previously said `src/` changes "only" for the SW flag and build date,
while tasks T020/T027/T028 require the UI work above. An implementer treating the structure rule as
authoritative would have read the FR-011b/FR-015 disclosures as forbidden drift and dropped them —
the structure rule would have deleted the honesty requirements. Codex, PR #7.)*

## Complexity Tracking

> Filled because the design carries one intentional divergence worth naming, even though the
> Constitution Check passes with no violations.

| Divergence | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Service worker not registered in desktop builds (R5) | The SW exists to precache for offline web use. In a packaged app every asset is already local behind our own `app://` handler, so the SW adds a second cache layer with its own staleness semantics and forces an extra scheme privilege (`allowServiceWorkers`) — risk for zero benefit. | Keeping the SW in desktop was rejected: it would make the offline guarantee depend on Workbox cache correctness *in addition to* packaging, and a stale precache across versions is a real failure mode with no upside when the files ship inside the binary. Implemented as a build flag **off by default**, so the web build's **behaviour** is unchanged (FR-019 — a behavioural guarantee, not byte-identity, since this feature's inert build metadata necessarily changes the bundle), and it touches registration only — never the signing path (FR-009). |
| ~150–250 MB artifacts (SC-009) | Bundling Chromium is what keeps the engine aligned with the suite that validates the signing path (R1). | Tauri (~5–10 MB) rejected **for now**: WebKitGTK on Linux would run the signing path on an engine the project has never validated, and Principle V (v1.1.0) forbids inheriting that evidence by assertion. Revisit only after the gate is earned there. |
