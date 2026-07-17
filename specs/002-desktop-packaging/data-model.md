# Phase 1 Data Model: Portable Offline Desktop Builds

**Feature**: `002-desktop-packaging` | **Date**: 2026-07-17

> **Scope note**: this feature introduces **no new user-content entities**. The PDF, signature image,
> certificate, and signature appearance are all defined in
> [`001-pdf-signer/data-model.md`](../001-pdf-signer/data-model.md) and are **unchanged** (FR-020).
> The entities here are *build and shell* concepts. If an entity below ever grows a field holding
> user content, that is a design error.

---

## BuildMetadata

Compile-time constants injected into the bundle. Read-only at runtime; the sole input to the
staleness nudge (FR-015/015a).

| Field | Type | Rules |
|---|---|---|
| `version` | string | Semver, from `package.json`. Displayed to the user (FR-015). |
| `buildDate` | ISO-8601 string | Injected at build time (CI build/commit timestamp). **MUST** be embedded, never fetched (FR-015a). |
| `engineDate` | ISO-8601 string | **Release date of the bundled Electron/Chromium version.** Derived at build time from the resolved `electron` version. |
| `engineVersion` | string | The packaged Electron/Chromium version. Displayed alongside the build (FR-015). |
| `commit` | string | Full source commit SHA. Traceability (FR-018). |
| `distribution` | `'web' \| 'windows-portable' \| 'linux-appimage'` | Identifies the artifact. |
| `selfUpdates` | `false` | Constant. Present so the disclosure is data-driven, not a hardcoded string (FR-015). |

**Derived — not stored**:

- `engineAgeInDays` = `now - engineDate`. Recomputed per read; never cached to disk.
- `isStale` = `engineAgeInDays > STALENESS_THRESHOLD_DAYS` (**180**, R6).
- `buildAgeInDays` = `now - buildDate` — **displayed only** (FR-015 traceability). MUST NOT feed
  `isStale`.

**⚠ Staleness is measured from `engineDate`, NOT `buildDate`.** The disclosure's subject is the
**frozen browser engine** — so the honest input is the engine's age, not the artifact's. A rebuild
today from an unchanged lockfile resets `buildDate` and would silently suppress the warning while
shipping a Chromium that is a year old and unpatched: the notice would go quiet exactly when it
matters most, and a routine CI rerun would be enough to do it. `buildDate` remains displayed
(FR-015 traceability) but MUST NOT drive `isStale`. *(Codex, PR #7 — a genuinely new insight, not a
propagation fix: the original design measured the wrong thing.)*

**Validation**:

- A desktop build **MUST** fail to build if `buildDate`, `engineDate`, `engineVersion`, or `commit`
  is absent or a placeholder. Shipping "unknown" would make the staleness nudge silently inoperative
  — a Principle IV defect that no test would otherwise catch.
- `buildDate`/`engineDate` **MUST NOT** be `Date.now()` evaluated at runtime (that yields age 0
  forever).

**Trust boundary**: `isStale` compares an embedded constant against the **device clock**, which is
untrusted and unverifiable offline. A wrong clock yields a spurious or missing notice. This is
accepted (R6) — the only fix is a network time source, which Principle I forbids. Do not add skew
detection.

---

## PortableDataLocation

Resolved once, before `app.whenReady()`, and applied via `app.setPath('userData', …)` (R3). Not
persisted — recomputed every launch.

| Field | Type | Rules |
|---|---|---|
| `mode` | `'adjacent' \| 'ephemeral' \| 'default'` | See state transitions. |
| `path` | absolute path | The resolved `userData` directory. |
| `writable` | boolean | Probed at startup, before the window opens. |

**Resolution rules** (R3):

| Condition | `mode` | `path` | Opt-in persistence |
|---|---|---|---|
| `PORTABLE_EXECUTABLE_DIR` set (Windows portable) | `adjacent` | `<PORTABLE_EXECUTABLE_DIR>/pdf-signer-data` | available |
| `APPIMAGE` set (Linux AppImage) | `adjacent` | `<dirname(APPIMAGE)>/pdf-signer-data` | available |
| Adjacent dir exists but is not writable | `ephemeral` | throwaway temp dir, **deleted on quit** | **DISABLED** — never offered, never written |
| Unpackaged (dev) | `default` | Electron's default `userData` | available |

**`ephemeral` MUST disable opt-in persistence, not merely relocate it.** The temp `userData` exists
solely because Electron needs a writable cache directory — but it also makes IndexedDB *work*, so a
relocate-only implementation would write the user's remembered certificate to temp on a machine where
they chose read-only media. Memory-only is enforced by **not writing**, never by expecting a write to
fail. See [contracts/portable-paths.md](contracts/portable-paths.md). *(Codex, PR #7.)*

**Prohibited by construction** — these are the ways this entity goes wrong:

- **MUST NOT** derive the path from `process.execPath`, `__dirname`, or `app.getAppPath()`. All three
  point into a temp extraction (Windows) or a read-only squashfs mount (AppImage), not where the user
  put the file (R3). This is the single most likely implementation bug in the feature.
- **MUST NOT** fall back to the OS per-user application-data directory in any mode. That would leave
  residue after the artifact is deleted, breaking FR-011b, SC-005, and SC-011.

**State transitions**:

```text
launch
  └─> resolve (env vars)
        ├─ adjacent + writable   ──> normal: opt-in persistence available
        ├─ adjacent + read-only  ──> ephemeral: memory-only for the session,
        │                            user informed (FR-011b — visibly, not silently)
        └─ unpackaged            ──> default (dev only)
```

**⚠ Note on the existing code — it does NOT already survive this.** `certStore.ts:16–24` swallows
storage failures and degrades to memory-only silently, but that path **only runs when a write
fails**. In `ephemeral` mode Electron is deliberately pointed at a writable temp `userData`, so
IndexedDB writes **succeed** and the failure path never fires — the user's `.p12` lands in temp until
cleanup, violating the memory-only promise. The required work is therefore **disabling opt-in
persistence in `ephemeral` mode** (the affordance is unreachable; `saveCertificate`/`saveSignature`
are never called), not merely surfacing a degradation. *(Corrected 2026-07-17: this note previously
claimed the existing code path "already survives read-only media", which understated the work to a
UI concern and would have licensed a relocate-only implementation. Codex, PR #7 — P1.)*

---

## DesktopBuild

One published artifact for one platform (spec § Key Entities).

| Field | Type | Rules |
|---|---|---|
| `platform` | `'windows-portable' \| 'linux-appimage'` | macOS excluded (FR-004). |
| `version` | string | Matches `BuildMetadata.version`. |
| `commit` | string | Matches `BuildMetadata.commit` (FR-018). |
| `filename` | string | Single file (FR-001/002). |
| `sha256` | string | Published checksum (FR-017). |
| `attestation` | reference | Sigstore build-provenance attestation (FR-018a, R8). |
| `codeSigned` | `false` | Constant in this feature. Drives the FR-014 disclosure. |
| `gateResult` | `'passed'` | **Requires EVERY blocking gate to pass, not pyHanko alone** — see below. |

**`gateResult: 'passed'` means all of these, per artifact:**

1. pyHanko validates a signature produced by **this** artifact (FR-010)
2. The **monitored-network** run recorded **zero** outbound attempts (SC-004 — the *primary* gate)
3. Layer E2E: CSP alive, `bypassCSP` absent, layer 2 cancels, `blob:` allowed
4. Layer-3 lint + packaged dependency audit (no Node HTTP client)
5. Portable-state (two folders) + read-only degradation (FR-011a/b)
6. **[Linux]** FUSE-less host via extract-and-run (FR-002a)

*(Corrected 2026-07-17: this field previously meant a passing pyHanko run and nothing else. An
artifact can validate its signatures perfectly while shipping a Node-side update check, telemetry, or
DNS attempts — so an entity modelling release state on FR-010 alone would mark exactly that build
publishable. It must mirror the release contract and T031, not a single requirement. Codex, PR #7 —
P1.)*

**Validation**:

- `gateResult` **MUST** come from runs against *this artifact's* output — never copied from the web
  build or the other platform's run (Principle V, v1.1.0: evidence is not inherited by assertion).
- A `DesktopBuild` with `codeSigned: false` **MUST** be accompanied by the FR-014 disclosure. The
  attestation does **not** satisfy this: it proves provenance, not authority, and it does not remove
  the SmartScreen warning (R8). Conflating the two would be an overclaim (Principle IV).

---

## Release

A set of `DesktopBuild`s published together from one commit.

| Field | Type | Rules |
|---|---|---|
| `tag` | string | Release tag. |
| `commit` | string | One commit for all builds — they **MUST NOT** be built from different sources. |
| `builds` | `DesktopBuild[]` | Both platforms. |
| `disclosures` | text | Unsigned-binary statement + verification instructions (FR-014). |

**Validation**: a release **MUST NOT** publish if *any* platform's gate failed (FR-010, SC-002).
Partial releases are forbidden — shipping one platform while the other's signature gate is red would
imply an equivalence that was never demonstrated.

---

## Entities explicitly NOT introduced

Recorded so a future reader can see these were considered and rejected, not overlooked:

- **UpdateManifest / release feed** — would require a network fetch (FR-006/007).
- **TelemetryEvent / CrashReport** — forbidden (FR-006; Principle I).
- **UserPreferences store** — no new persistence; the desktop shell stores nothing the web app
  doesn't (Principle VI). The staleness notice **MUST NOT** persist a "don't show again" flag, as
  that would create a new on-device store to suppress a disclosure the constitution requires.
