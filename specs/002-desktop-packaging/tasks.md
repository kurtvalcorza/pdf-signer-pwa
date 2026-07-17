---
description: "Task list for Portable Offline Desktop Builds (002-desktop-packaging)"
---

# Tasks: Portable Offline Desktop Builds (Windows + Linux)

**Input**: Design documents from `/specs/002-desktop-packaging/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Constitution**: v1.1.0 — Principles I and III are NON-NEGOTIABLE.

**Tests**: **REQUIRED, not optional.** Principle V's test-first mandate targets "signature-producing
and PDF-manipulating code", and this feature writes none. But the feature's *entire deliverable* is
an artifact whose correctness must be **demonstrated, not inherited** (Principle V as amended: "a
distribution MUST NOT be published on the strength of another distribution's validator run").
Verification is the product here, so the gates are tasks, not polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Maps to a user story in spec.md (US1–US4)

## Path Conventions

Per plan.md § Structure Decision: the desktop shell lives in **`electron/`** at the repository root,
deliberately **outside `src/`**, so the web app's module graph is provably untouched (FR-019).

> **The rule that governs every task below**: `electron/` may know about the web app; the web app
> must not know about `electron/`. Any task that adds a desktop-only branch to
> `src/features/signing/**` is wrong — it voids the entire reason Electron was chosen over Tauri and
> re-opens the Principle V gate (FR-009).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Bring the packaging toolchain in without touching the web build.

- [ ] T001 Add `electron` and `electron-builder` as **devDependencies** in `package.json` (never
      `dependencies` — a runtime dep would leak the shell into the web bundle, FR-019/R9). Add
      scripts: `build:desktop`, `e2e:desktop`. **Do NOT add `electron-updater`** — FR-007 is
      satisfied by its absence, which is stronger than any configuration flag (R4).
- [ ] T002 [P] Create `tsconfig.electron.json` compiling `electron/**` for the Electron main
      process, excluded from the web `tsconfig.json` so the two graphs cannot silently merge.
      **⚠ The root `package.json` declares `"type": "module"` (line 5).** A plain CommonJS emit
      therefore produces `.js` files full of `require`/`exports` that Node resolves as **ESM** under
      that root type — the shell dies before the window ever opens, and the failure looks nothing
      like a module-format problem. Resolve it **explicitly**, one of:
      (a) add `electron/package.json` containing `{"type": "commonjs"}` — scopes the format to the
          shell without touching the web build (**recommended**; smallest blast radius, and
          `electron-builder` packs it into `asar` normally); or
      (b) emit `.cjs` via `.cts` sources; or
      (c) target ESM and verify Electron's ESM main-process support end-to-end in T005.
      Whichever is chosen, **T005 must prove it boots** — this is a "works on my machine until it's
      packaged" class of bug. *(Codex, PR #7.)*
- [ ] T003 [P] Extend `eslint.config.js` with a Node-environment block scoped to `electron/**`, and
      a rule forbidding imports from `electron` inside `src/**`.
- [ ] T004 Create `electron-builder.yml`: `appId`, `asar: true`, `files` limited to `dist/` +
      compiled `electron/`, `publish: null`. Targets are added per-story: **T018** (Windows
      `portable`), **T023** (Linux `AppImage`). *(Corrected: previously cited T024/T031, which are
      AppImage path verification and the release gate — following those refs would leave the builder
      config with no target until the wrong phase. Codex, PR #7.)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shell itself. Every user story depends on this.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Spike first — earn the right to build the rest

- [ ] T005 **SPIKE** in `electron/spike/` — prove the whole stack works before investing in it: a
      minimal main process loads the existing `dist/` over a custom scheme, opens a PDF, signs with
      `tests/e2e/fixtures/e2e-cert.p12`, and the output **passes `scripts/validate_pdf.py`**.
      Success criterion is a pyHanko pass, nothing less.
      **Why first**: 001's hardest-won lesson was that the signing stack breaks in
      environment-specific ways that look nothing like a signing bug — `createImageBitmap` worked in
      Chrome and failed in headless-shell (`specs/001-pdf-signer/research.md` § deviations). This
      spike de-risks Buffer/node-polyfill behaviour, `asar`, WASM (`pdfjs`), and `crypto` under
      Electron **in one throwaway artifact**. If it fails, the plan changes here — cheaply — not
      after ten tasks of UI and CI work. Delete or fold in once green.

### The shell

- [ ] T006 [P] Implement `electron/protocol.ts` — register the `app:` scheme with privileges
      `{ standard: true, secure: true, supportFetchAPI: true }` and serve `dist/` via
      `protocol.handle`. **`bypassCSP` MUST remain unset/false** and `allowServiceWorkers` is not
      needed (T012). Resolve every request path against the `dist` root and **reject traversal**
      (`..`) so the scheme cannot serve arbitrary host files. See
      [contracts/network-policy.md](contracts/network-policy.md), R2.
      **⚠ Highest-risk line in the feature**: `bypassCSP: true` silently voids `connect-src 'none'`
      — a NON-NEGOTIABLE Principle I breach that every existing test still passes through. T021
      asserts against it; do not rely on review.
- [ ] T007 [P] Implement `electron/paths.ts` — resolve the portable data directory per
      [contracts/portable-paths.md](contracts/portable-paths.md): `PORTABLE_EXECUTABLE_DIR` (Windows),
      `dirname(APPIMAGE)` (Linux), Electron default when unpackaged. Probe writability and return
      `mode: 'adjacent' | 'ephemeral' | 'default'`.
      **⚠ MUST NOT derive from `process.execPath`, `__dirname`, or `app.getAppPath()`** — all three
      point into a temp extraction (Windows) or read-only squashfs mount (Linux), not where the user
      put the file (R3). **MUST NOT** fall back to the OS user-data dir in any mode — that residue is
      what this feature exists to avoid (SC-005/SC-011). `ARGV0` is not a substitute for `APPIMAGE`.
- [ ] T008 [P] Implement `electron/network.ts` — `webRequest.onBeforeRequest` cancelling every
      request whose scheme is not `app:`/`blob:`/`data:`; `will-navigate` prevented outside `app:`;
      `setWindowOpenHandler` denying always, with the **single exact-string carve-out** handing the
      repo URL to `shell.openExternal` (contracts/network-policy.md § Carve-out).
      **⚠ `webRequest` does NOT see the main process.** It intercepts Chromium-session requests only;
      Node's `fetch`/`http`/`https`/`net` in main bypass it completely. Layer 3 (T008a) is what
      covers that — this file is not sufficient on its own, and an earlier draft of the contract
      wrongly claimed it was. *(Codex, PR #7.)*
- [ ] T008a [P] Add the **layer-3 Node-network prohibition** for `electron/**`, in two parts —
      **the first alone is not sufficient**:
      1. `eslint` `no-restricted-imports` / `no-restricted-globals` banning `node:http`,
         `node:https`, `node:net`, `node:dgram`, `node:tls` and global `fetch`.
      2. An **import allow-list** for `electron/**`: only `electron`, `node:path`, `node:fs`,
         `node:os`, `node:url` (and other explicitly-approved, non-network builtins) may be imported.
         Any package import is a lint error unless added to the allow-list by name.
      Permit Electron's `net.fetch` **only** in `electron/protocol.ts` for serving `app:` assets from
      disk.
      **Why the allow-list is load-bearing**: banning `node:http` does nothing about
      `import got from 'got'` (or `axios`, `undici`, or a helper whose transitive dep runs an
      updater). Those use Node networking that `webRequest` cannot see, and they pass a
      builtins-only rule cleanly — which would leave layer 3, the *only* main-process guard, trivially
      bypassable. Deny-listing names an attacker's imports; allow-listing names ours. *(Codex, PR #7 —
      P1.)*
- [ ] T008b [P] Add a **packaged-build dependency audit**: fail `build:desktop` if any module reachable
      from `electron/**` in the packaged output declares or pulls a network-capable dependency
      (`electron-updater`, `axios`, `got`, `undici`, `node-fetch`, …). Lint covers source; this covers
      what actually ships.
      **`blob:` MUST be allowed** or the signed-PDF download silently breaks (R10) — the most likely
      way this file goes wrong. The carve-out is matched by **exact string**, never by pattern: a
      runtime-assembled URL reaching `openExternal` would be a general-purpose exfiltration
      primitive bypassing every other layer.
- [ ] T009 Implement `electron/main.ts` — call `app.setPath('userData', …)` from T007 **before**
      `app.whenReady()` (after ready it is too late and state lands in the default location); create
      the window with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; wire T006
      and T008. Never call `crashReporter.start()` (a dump could contain in-memory key material —
      FR-012); disable Chromium metrics/reporting switches (R4).
- [ ] T010 Implement `electron/preload.ts` — minimal and `contextIsolated`; expose **only**
      `BuildMetadata` (T011) and the resolved data location/mode. Expose no filesystem, no shell, no
      network primitive to the renderer.
- [ ] T011 Inject `BuildMetadata` via a Vite `define` in `vite.config.ts` — `version`, `buildDate`
      (build/commit timestamp), **`engineVersion` + `engineDate`** (the resolved Electron/Chromium
      version and *its release date*), `commit`, `distribution`. Per
      [data-model.md](data-model.md) § BuildMetadata, the build **MUST fail** if any is absent or a
      placeholder, and none may be a runtime `Date.now()` (that yields age 0 forever, silently
      disabling T027). Inert for the web build (FR-019).
      **`engineDate` is the staleness input, not `buildDate`** (FR-015a) — a rebuild from an
      unchanged lockfile resets `buildDate` while shipping the same old engine.
- [ ] T012 Gate service-worker registration behind a build-time flag, **off by default**, at the
      registration call site only (`src/main.tsx`). Desktop sets it; the web build's **behaviour** is
      unchanged (FR-019). Registration/bootstrap only — never the signing path (R5, FR-009).
      *(Was "the web build stays byte-identical" — impossible and now contradicted by FR-019: T011's
      build metadata necessarily changes the bundle's bytes. Chasing byte-identity would steer an
      implementer to strip the metadata or treat an intended diff as a regression. The guarantee is
      behavioural + no desktop-only code in the web bundle (FR-019a). Codex, PR #7.)*
- [ ] T013 [P] Create `playwright.desktop.config.ts` targeting the **packaged** binary via
      `_electron.launch({ executablePath })`, reusing `tests/e2e/fixtures/`.

**Checkpoint**: The shell runs, serves the app, and provably signs. User stories can begin.

---

## Phase 3: User Story 1 - Sign a PDF on Windows with no install and no network (Priority: P1) 🎯 MVP

**Goal**: A single `.exe`, copied anywhere, signs a PDF fully offline and leaves nothing behind.

**Independent Test**: Build the binary, run it on Windows with networking disabled, complete a sign,
validate the output with pyHanko. Delivers complete value even if the Linux build never ships.

### Tests for User Story 1 ⚠️

> **Write these FIRST and see them FAIL.** They are the gate, not a formality.

- [ ] T014 [P] [US1] `tests/e2e-desktop/desktop-sign.spec.ts` — launch the **packaged** artifact,
      open `sample.pdf`, place `signature.png`, sign with `e2e-cert.p12` / `e2e-pass`, capture the
      saved file. Asserts the full US1 flow end-to-end.
- [ ] T015 [P] [US1] `tests/e2e-desktop/desktop-privacy.spec.ts` — assert each network layer
      **independently**, so no layer can mask another's failure:
      1. **Layer 1 (CSP) is alive** — from the renderer, attempt a `connect-src`-violating request
         and assert a **`securitypolicyviolation` event fires** with
         `effectiveDirective: 'connect-src'`. A CSP block emits that event; a `webRequest` cancel
         does **not** — this is the only signal that distinguishes the two.
      2. **`bypassCSP` is absent** — assert **directly against the scheme registration** that the
         `app:` privileges object contains no truthy `bypassCSP` (assert the value passed to
         `registerSchemesAsPrivileged`, not a behaviour downstream of it). Additionally assert a
         CSP-disallowed **`app:`-served resource** is blocked.
      3. **Layer 2, isolated from CSP** — issue the synthetic `https:` request through a
         **Chromium-session path the page CSP does not govern** (e.g. a main-process
         `session`-routed load / non-renderer request) and assert **`onBeforeRequest` performed the
         cancellation** — not merely that the request failed.
         **A renderer `fetch('https://…')` is the wrong probe**: `connect-src 'none'` blocks it
         first, so the assertion goes green even if the `webRequest` filter is missing or broken —
         layer 1 masking layer 2, the mirror image of the meta-tag mistake. *(Codex, PR #7 — P1.)*
      4. **`blob:` allowed** — a real signed-PDF download completes (proves T008 didn't over-block).

      > **Steps 1 and 2 prove DIFFERENT things — neither substitutes for the other.**
      > `bypassCSP` is **scheme- and resource-scoped**: it exempts resources *served over `app:`* from
      > the page CSP. A renderer `fetch('https://…')` is still governed by `connect-src`, so step 1
      > fires its event and goes green **even with `bypassCSP: true`**. Step 1 proves the CSP exists
      > and is enforced for `connect-src`; only **step 2** detects the privilege itself. Treating step
      > 1 as the `bypassCSP` guard is the same mistake as reading the meta tag, one level deeper.
      > *(Codex rounds 1 and 2, PR #7 — round 1 caught that reading the CSP string can't detect
      > `bypassCSP`; round 2 caught that my replacement still couldn't, because I'd conflated "the CSP
      > is alive" with "the privilege is absent". Do not read the CSP meta-tag string for step 1:
      > `bypassCSP` leaves the tag untouched.)*
- [ ] T016 [P] [US1] `tests/e2e-desktop/desktop-portable.spec.ts` — run the same binary from **two
      different directories**; assert each keeps its own state beside itself and **nothing** is
      written to the OS per-user data location. **Assert against the RESOLVED path, not a hardcoded
      spelling** — `%APPDATA%` on Windows; on Linux, `$XDG_CONFIG_HOME/<app>` when set, else
      `~/.config/<app>` (this suite is reused for the AppImage in T022).
      *(Asserting only `%APPDATA%` would let the Linux run pass while a bad fallback wrote to
      `~/.config`; asserting only `~/.config` misses Electron's actual location when
      `XDG_CONFIG_HOME` is set — either way the run goes green while leaving exactly the residue
      FR-011a/SC-011 forbid. Codex, PR #7.)*
      **Why two directories**: a single-location test passes even when the path was wrongly derived
      from `process.execPath` (R3). Two locations is the only thing that proves the resolution. This
      test is the difference between catching the bug and shipping it.
- [ ] T017 [P] [US1] `tests/e2e-desktop/desktop-readonly.spec.ts` — run from a non-writable
      directory; assert signing still works, the user is **told** persistence is unavailable, and
      nothing lands in the OS user-data dir (FR-011b).

### Implementation for User Story 1

- [ ] T018 [US1] Add the `portable` Windows target to `electron-builder.yml` (single file, no
      installer, no registry — FR-001).
- [ ] T019 [US1] Make T014–T017 pass. **No changes to `src/features/signing/**`** — if a failure
      seems to demand one, the shell is wrong (FR-009).
- [ ] T020 [US1] Surface the read-only/ephemeral state visibly in the UI **and disable opt-in
      persistence entirely in `ephemeral` mode** — the "remember" affordances are not offered, and
      `saveCertificate`/`saveSignature` are never reached (FR-011b,
      [contracts/portable-paths.md](contracts/portable-paths.md)).
      **Not a relocate**: the temp `userData` still makes IndexedDB work, so relocating alone would
      write the user's `.p12` to temp on read-only media — the exact residue FR-011b forbids.
      Note `src/features/persistence/certStore.ts:16–24` already degrades to memory-only **silently**
      — correct for web, insufficient here. Memory-only must be enforced by not writing, not by
      hoping a write throws.
- [ ] T020a [US1] Delete the ephemeral temp `userData` on quit and assert no leftovers in
      `tests/e2e-desktop/desktop-readonly.spec.ts`.
- [ ] T021 [US1] Extend `scripts/verify-signatures.mjs` (or add a desktop mode) to validate the PDF
      produced by T014 through `scripts/validate_pdf.py`. **This is the FR-010 gate**: evidence must
      come from the shipped artifact's own output, never inherited from the web run.

**Checkpoint**: US1 fully functional and independently **validated** — a working Windows portable
signer, proven offline against pyHanko. **MVP for local/private use only.**

> **Do NOT publish here.** "Independently shippable" means independently *buildable and testable*.
> The first **public** release requires US1+US2+US3+US4 (see Required scope): stopping at this
> checkpoint and publishing the `.exe` would ship without the Linux gate, the honesty disclosures, and
> the verification path FR-014 promises — all of which the release contract makes blocking.
> *(Codex, PR #7: this checkpoint said "independently shippable", contradicting the same file's
> release scope two sections later.)*

---

## Phase 4: User Story 2 - Sign a PDF on Linux from a single file (Priority: P1)

**Goal**: One AppImage, `chmod +x`, signs offline. No root, no package manager.

**Independent Test**: Build the AppImage, run it on Linux (or container) with networking disabled,
complete a sign, validate with pyHanko.

### Tests for User Story 2 ⚠️

- [ ] T022 [P] [US2] Run the `tests/e2e-desktop/` suite (T014–T017) against the AppImage on Linux via
      `playwright.desktop.config.ts`, with `executablePath` pointed at the built AppImage. Same
      assertions, second artifact — **not** an inherited pass (Principle V). The suite is shared; the
      *run* is not.

### Implementation for User Story 2

- [ ] T023 [US2] Add the `AppImage` Linux target to `electron-builder.yml` (single file, no root —
      FR-002). Deliberately **no `.deb`**: it is an installer, not a portable artifact.
- [ ] T023a [US2] Handle the **FUSE-less host** case (FR-002a): add a `tests/e2e-desktop/` run in a
      **container without `libfuse2`** asserting the app launches and signs successfully under
      `--appimage-extract-and-run`, and document that fallback prominently in `docs/desktop.md`
      (stating plainly that a plain double-click fails on such hosts, and giving the command).
      **Do not assert on the plain-launch failure message.** The AppImage runtime resolves FUSE and
      fails **before any application code exists**, so that output is the runtime's and we cannot
      suppress or reword it. The deliverable is a tested no-root path, not control of an error we
      never emit. *(Codex, PR #7 — the original wording promised "never a raw `libfuse.so.2` error",
      an overclaim I introduced while fixing the FUSE finding itself.)*
- [ ] T024 [US2] Verify `electron/paths.ts` resolves via `APPIMAGE` on a real AppImage (the mount
      path differs from the file path — R3), and make T022 pass.
- [ ] T025 [US2] Run the pyHanko gate (`scripts/validate_pdf.py` via `npm run verify:signatures`)
      against the PDF produced by the **AppImage** in T022 (FR-010).

**Checkpoint**: Both platforms sign and validate independently.

---

## Phase 5: User Story 3 - Understand what you are running (Priority: P2)

**Goal**: The user learns, without asking, that the binary is unsigned, never updates, and is the
same tool as the web app.

**Independent Test**: Inspect the release page and the app's info surface; each disclosure is
present, accurate, and stated without euphemism.

### Tests for User Story 3 ⚠️

- [ ] T026 [P] [US3] `tests/unit/staleness.test.ts` — `isStale` is false below the 180-day threshold
      and true above it; assert the computation is pure arithmetic over **`BuildMetadata.engineDate`**
      — and explicitly assert that **`buildDate` does NOT affect `isStale`** (a rebuild must not
      silence the warning; that regression is invisible without a test for it) — with **no network
      client reachable** from the code path (FR-015a); and assert the notice is
      **never shown when `distribution === 'web'`**, however old the build (guards T027's regression
      — this is the assertion that keeps the web app from lying).

### Implementation for User Story 3

- [ ] T027 [US3] Implement the staleness nudge in `src/components/StalenessNotice.tsx` (threshold
      constant + `isStale` derivation in `src/lib/buildMetadata.ts`, rendered from `src/App.tsx`) —
      passive, **non-blocking** notice once `ageInDays > STALENESS_THRESHOLD_DAYS` (**180**, a named
      constant — R6). Local clock comparison only; it MUST NOT regress into an update check
      (FR-006/007).
      **⚠ MUST NOT reach the web build at all (FR-019a).** Only a distribution that **bundles its own
      engine** ships a frozen one — the web PWA runs the user's own browser, which updates itself. If
      the notice rendered unguarded from shared `App.tsx`, the web app would, 180 days after any
      deploy, tell users "the bundled browser engine no longer receives security updates": **false**,
      a user-facing regression, and an overclaim by the very feature meant to enforce honesty
      (Principle IV).
      **A runtime `distribution !== 'web'` check is NOT enough** — it suppresses the notice but still
      ships its code to web users. Isolate it behind a **desktop-only module the web build never
      imports** (dynamic import resolved at build time, or a desktop-only entry), and assert in T038
      that the web bundle contains no staleness code. *(Codex rounds 1 and 2, PR #7: round 1 caught
      the missing guard; round 2 caught that a guard alone still violates the bundle requirement.)*
      Wording (FR-015b) must say the bundled engine no longer receives security updates, **without**
      implying a specific known vulnerability. **No "don't show again"** — that would create a new
      on-device store whose only purpose is suppressing a constitutionally required disclosure
      (data-model.md § Entities explicitly NOT introduced).
      **The clock is untrusted and that is accepted** (R6): a wrong clock yields a spurious or
      missing notice, and the only fix is a network time source, which Principle I forbids. Do not
      add skew detection.
- [ ] T028 [US3] Add an info/about surface showing version, build date, **engine version + engine
      date**, source commit, distribution, "this build does not update itself" (data-driven from
      `selfUpdates: false`), and the resolved data location + mode (FR-013, FR-015).
      **Must be desktop-only and excluded from the web bundle (FR-019a), same as T027** — asserted by
      T038's bundle check. Its content is desktop-specific by definition ("this build does not update
      itself", a local data path); shipped as shared `src` UI, the web PWA could render claims that
      are simply false of it. *(Codex, PR #7: T027 got the isolation requirement and T028 didn't,
      though both surface desktop-only claims.)*
- [ ] T029 [P] [US3] Write `docs/desktop.md` — the unsigned-binary disclosure: what SmartScreen shows
      (*"Windows protected your PC"* → **More info → Run anyway**), `chmod +x` on Linux, and how to
      verify instead. Must state plainly that **an attestation is not a code-signing certificate and
      does not remove the warning** (contracts/release-artifacts.md). Also record the honest temp-
      extraction caveat (R3): "leaves absolutely nothing, ever" is **not** an accurate claim.

**Checkpoint**: The binaries describe themselves honestly. Per the constitution's honesty gate, this
phase MUST ship with or before any public release — not as a follow-up.

---

## Phase 6: User Story 4 - Verify a download you did not build (Priority: P3)

**Goal**: Anyone can prove a binary came from this repo's workflow at a specific commit.

**Independent Test**: Publish a release, download on another machine, verify checksum + attestation.

### Implementation for User Story 4

- [ ] T030 [US4] Create `.github/workflows/release-desktop.yml` — matrix `windows-latest` (portable
      `.exe`) and `ubuntu-latest` (AppImage), both from **one commit**, no cross-compiling (R8).
      Leave `ci.yml` **untouched** (SC-008).
- [ ] T031 [US4] Run the **full** desktop gate in CI per platform — every item below is
      **blocking**; a release publishes only if all pass:
      1. Layer/flow E2E: T014–T017 (Windows), T022 (Linux)
      2. pyHanko on each artifact's **own** output: T021, T025
      3. **The monitored-network gate (T031a)** — the *primary* SC-004 check
      4. **The FUSE-less AppImage check (T023a)** — FR-002a
      5. Layer-3 **source lint (T008a) AND the packaged-output dependency audit (T008b)** — T008a
         alone misses network-capable deps that actually ship
      6. **The existing web gates (T038) green for the same commit** — SC-008/FR-019. `ci.yml` runs
         on pushes to `main`, PRs, and manual dispatch, so a tag-triggered release workflow would
         **not** re-run them: this job must either run them or declare an explicit dependency on a
         successful CI run for the same SHA. *(Codex, PR #7 — verified against `ci.yml`'s triggers.)*

      **If any platform's gate is red, nothing publishes** — no partial releases (SC-002,
      contracts/release-artifacts.md).
      *(Amended after Codex round 2: this listed only items 1–2, so CI could have published while
      never running the contract's primary SC-004 check or the FUSE-less check — the two gates added
      in round 1 landed in the contract and quickstart but never reached the task that enforces
      them. A gate that isn't in the release job is a comment.)*
- [ ] T031a [US4] Implement the **monitored-network gate**: run each packaged artifact with
      networking **available but intercepted** (firewall/proxy/packet capture) across launch → sign →
      idle → quit, and **fail the build on any DNS query or TCP/HTTP attempt**, successful or not
      (SC-004, contracts/network-policy.md § Verification).
      The offline run (T014's environment) proves the app *works* without a network; only this proves
      it *never reaches for one*.
- [ ] T032 [US4] Generate and publish `SHA256SUMS` per artifact (FR-017).
- [ ] T033 [US4] Add build-provenance attestation via `actions/attest-build-provenance` (or
      `actions/attest`, which GitHub now steers new implementations toward — either satisfies
      FR-018a). Permissions: `id-token: write`, `attestations: write`, `contents: write`.
      Free for public repos on all current plans — confirmed, no blocker (R8).
- [ ] T034 [US4] Document verification in `docs/desktop.md` + release template using the **pinned**
      command from [contracts/release-artifacts.md](contracts/release-artifacts.md) —
      `gh attestation verify <artifact> --repo … --signer-workflow …/release-desktop.yml
      --source-digest <sha>` — plus checksum comparison.
      **`--repo` alone is not the FR-018a proof**: an artifact attested by *any* workflow, ref, or
      commit in this repository satisfies it. Do not restate the command here if it drifts from the
      contract — link it. *(Codex, PR #7.)*

**Checkpoint**: Unsigned binaries have a real, user-executable mitigation.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T035 Update `README.md` and `CLAUDE.md` to describe **two distributions**. Both currently say
      "Installable on Android, deployed static on Vercel" / "Client-only, no backend" — accurate for
      web, incomplete once desktop ships. These are the **⚠ pending items** flagged in the
      constitution v1.1.0 Sync Impact Report; this task closes them. Do it **only now**, when the
      desktop build actually exists — documenting it earlier would have been fiction.
- [ ] T036 [P] Run every scenario in [quickstart.md](quickstart.md) on both platforms and record the
      results.
- [ ] T037 [P] Measure desktop cold-start and full-flow timings; append to `docs/perf.md` alongside
      the web figures. Windows cold start includes a temp extraction (R3) and is expected to dominate
      — **measure it rather than assuming**; SC-001's 60 s budget has enormous headroom (web: 977 ms).
- [ ] T038 Confirm the web distribution is behaviourally untouched: `npm run build && npm test &&
      npm run verify:signatures && npm run e2e && npm run e2e:pwa` all green **and unmodified**
      (SC-008/FR-019). If any needed editing to accommodate packaging, **fix the packaging, not the
      test**. Additionally assert the **web bundle contains no desktop-only code** — grep the built
      `dist/` for the staleness notice and any `electron` import (FR-019a).
      Note FR-019 is a **behavioural** guarantee, not byte-identity: the inert build-date metadata
      (T011) does change the bundle's bytes, which is why the requirement was reworded rather than
      pretended-at.
- [ ] T039 Re-run the plan's post-design Constitution Check against the built artifacts, and confirm
      `src/features/signing/**` has **zero** diff for this entire feature (FR-009 — the single
      constraint most likely to have eroded under implementation pressure).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. **BLOCKS every user story.** T005 (spike) gates the
  rest of the phase — if it fails, re-plan rather than push on.
- **US1 (Phase 3)**: depends on Foundational. Independently **buildable and validated** → **MVP for
  local/private use**. *Not* independently publishable — see Required scope.
- **US2 (Phase 4)**: depends on Foundational. Independent of US1 (shares the suite, runs its own).
- **US3 (Phase 5)**: depends on Foundational; needs a binary to describe, so in practice follows US1.
- **US4 (Phase 6)**: depends on US1/US2 producing artifacts worth attesting.
- **Polish (Phase 7)**: depends on all desired stories.

### Critical path

```text
T001 → T005 (SPIKE) → T006/T007/T008 → T009 → T014-T017 (fail) → T018/T019 → T021 (pyHanko) → MVP
```

### Parallel Opportunities

- **Phase 1**: T002, T003 together.
- **Phase 2**: T006, T007, T008 are three separate files with no interdependency — parallel. T009
  joins them and must wait.
- **Phase 3**: T014–T017 are four independent spec files — write all four in parallel.
- **US1 and US2** can proceed in parallel once Foundational lands (different builder targets, same
  suite).
- **T029, T036, T037** are documentation/measurement — parallel with each other.

---

## Parallel Example: Foundational shell

```bash
# Three independent modules, no shared state:
Task: "Implement electron/protocol.ts — app:// scheme, bypassCSP FALSE, traversal guard"
Task: "Implement electron/paths.ts — PORTABLE_EXECUTABLE_DIR / APPIMAGE resolution"
Task: "Implement electron/network.ts — allow-list, navigation locks, openExternal carve-out"
```

## Parallel Example: User Story 1 tests

```bash
# Write all four FIRST; all must FAIL before T018/T019:
Task: "desktop-sign.spec.ts — packaged binary, full signing flow"
Task: "desktop-privacy.spec.ts — CSP intact, blob allowed, https cancelled"
Task: "desktop-portable.spec.ts — two-folder state isolation"
Task: "desktop-readonly.spec.ts — visible memory-only degradation"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup
2. Phase 2: Foundational — **T005 spike must go green before anything else is built**
3. Phase 3: US1
4. **STOP and VALIDATE**: run the binary offline from a USB stick; pyHanko must pass on its output
5. A working, validated Windows portable signer exists — **for local/private use**. Publishing it
   requires US2+US3+US4 (Required scope): without them there is no Linux gate, no unsigned-binary
   disclosure, and none of the verification FR-014 promises.

### Incremental Delivery

1. Setup + Foundational → shell proven
2. + US1 → **MVP** (Windows portable) — local/private use only
3. + US2 → Linux AppImage — local/private use only
4. + US3 → honest disclosures (constitution honesty gate)
5. + US4 → CI-built, attested releases — **the first three are not publishable without this**; see
   Required scope below
6. Polish → docs describe two distributions

### Required scope for the first PUBLIC release: US1 + US2 + US3 + US4

All four. Not a recommendation — a gate:

- **US3** (P2) — shipping an unsigned, never-updating binary with **no disclosure** violates
  Principle IV, which v1.1.0 made explicit rather than implied.
- **US4** (P3) — FR-014's disclosure *promises a verification path in place of a code-signing
  certificate*. US4 **is** that path. Publishing US1–US3 first would ship a disclosure telling users
  to verify a checksum and attestation that **do not exist** — an overclaim produced by the honesty
  feature itself, which is worse than saying nothing. *(Codex, PR #7 — my original "US4 can follow"
  wording contradicted FR-014.)*
- **US1 + US2 together** — public releases are all-or-nothing (SC-002); no Windows-only release.

**US1–US3 without US4 are valid only for local or private builds** that are never handed to another
person. The story priorities remain the *build* order; they are not a release ladder.

---

## Notes

- **Three ways this feature fails silently** — each has a dedicated assertion, because none would be
  caught by ordinary review or by the existing suite:
  1. `bypassCSP: true` (T006) → voids `connect-src 'none'`; caught by **T015**.
  2. Data dir from `process.execPath` (T007) → state in temp; caught by **T016** (two folders).
  3. `blob:` blocked (T008) → downloads die; caught by **T015**.
- **FR-009 is the constraint under most pressure.** A desktop-only branch in the signing path voids
  the Electron-over-Tauri rationale and re-opens the Principle V gate. **T039** checks for a zero
  diff in `src/features/signing/**`.
- Evidence is per-distribution: a green web suite says **nothing** about the artifact you are about
  to publish (Principle V, v1.1.0).
- Commit after each task or logical group; stop at any checkpoint to validate independently.
