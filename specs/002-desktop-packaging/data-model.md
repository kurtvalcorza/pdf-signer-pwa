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
| `commit` | string | Full source commit SHA. Traceability (FR-018). |
| `distribution` | `'web' \| 'windows-portable' \| 'linux-appimage'` | Identifies the artifact. |
| `selfUpdates` | `false` | Constant. Present so the disclosure is data-driven, not a hardcoded string (FR-015). |

**Derived — not stored**:

- `ageInDays` = `now - buildDate`. Recomputed per read; never cached to disk.
- `isStale` = `ageInDays > STALENESS_THRESHOLD_DAYS` (**180**, R6).

**Validation**:

- A desktop build **MUST** fail to build if `buildDate` or `commit` is absent or a placeholder.
  Shipping "unknown" would make the staleness nudge silently inoperative — a Principle IV defect that
  no test would otherwise catch.
- `buildDate` **MUST NOT** be `Date.now()` evaluated at runtime (that yields age 0 forever).

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

| Condition | `mode` | `path` |
|---|---|---|
| `PORTABLE_EXECUTABLE_DIR` set (Windows portable) | `adjacent` | `<PORTABLE_EXECUTABLE_DIR>/pdf-signer-data` |
| `APPIMAGE` set (Linux AppImage) | `adjacent` | `<dirname(APPIMAGE)>/pdf-signer-data` |
| Adjacent dir exists but is not writable | `ephemeral` | throwaway temp dir, discarded on exit |
| Unpackaged (dev) | `default` | Electron's default `userData` |

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

**Note on the existing code**: `src/features/persistence/certStore.ts` already swallows storage
failures and degrades to memory-only silently (`certStore.ts:16–24`). The *code path* therefore
already survives read-only media — the work FR-011b adds is making that degradation **visible**,
which is a shell/UI concern, not a persistence-layer change.

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
| `gateResult` | `'passed'` | **A build may only reach this entity's published state with a passing pyHanko run against its own output** (FR-010, Principle V). |

**Validation**:

- `gateResult` **MUST** come from a run against *this artifact's* output — never copied from the web
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
