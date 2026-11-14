# Data Model: Native Android App (003)

The shared application's entities (document, signature image, certificate, opt-in records) are
unchanged; see [../001-pdf-signer/data-model.md](../001-pdf-signer/data-model.md). This file covers
only what the Android distribution adds. References in brackets point to [research.md](research.md).

## Android package (release artifact)

| Field | Source | Rule |
|---|---|---|
| `applicationId` | build config | `io.github.kurtvalcorza.pdfsigner`; never changes [R15] |
| `versionName` | `package.json` `version` | equal to the web and desktop version of the same release (FR-019) |
| `versionCode` | derived | `major*10000 + minor*100 + patch`; strictly increasing across releases |
| `sourceCommit` | CI `GITHUB_SHA` | same commit as the web and desktop artifacts |
| `minSdk` / `targetSdk` | build config | 26 / 36 [R15] |
| `declaredPermissions` | APK (`aapt2 dump permissions`) | MUST contain nothing but the app's own signature-level `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` from `androidx.core`; never a network permission (FR-004, C1) |
| `signingCertSha256` | APK (`apksigner verify --print-certs`) | MUST equal `android/SIGNING_FINGERPRINT` (FR-018, FR-021, C3) |
| `webViewHardMin` | build constant | 119 [R11] |
| `webViewValidatedFloor` | gate run | the WebView major the release gate ran on; written into the build's metadata [R11] |
| file name | release job | `pdf-signer-<versionName>.apk`, no spaces |

**Invariants**: debuggable is false, WebView debugging is off, and the only exported component is the
launcher activity (C4, C6). Publishing requires every check in
[contracts/apk-checks.md](contracts/apk-checks.md) to pass (FR-020).

## Engine check (runtime, per launch)

Input: the system WebView package's `versionName`, from the package manager (no network).

```text
major < webViewHardMin                       → REFUSED   (native screen; web app never loaded)
webViewHardMin ≤ major < webViewValidatedFloor → UNVALIDATED (web app loads; native notice shown)
major ≥ webViewValidatedFloor                → OK        (no notice)
no WebView provider / disabled               → REFUSED   (same screen, different reason)
```

The notice has no "don't show again": that would be a new on-device store used to suppress a
required disclosure (the same rule as desktop's staleness notice, `electron/preload.js:48`).

## Save request (shell bridge message, transient)

Created by the injected script when the shared app clicks a `blob:` download anchor
([contracts/shell-bridge.md](contracts/shell-bridge.md)).

| Field | Rule |
|---|---|
| `id` | per-request counter; chunks and the result are matched by it |
| `name` | the anchor's `download` value; native code strips path separators and control characters, and keeps the extension |
| `mime` | the Blob's type; one of `application/pdf`, `application/x-pkcs12`, `application/x-x509-ca-cert`, `application/x-pem-file`, else `application/octet-stream` |
| `size` | bytes; MUST be ≤ 100 MB + 1 MB headroom, or it is refused before the save dialog opens |
| payload | one `ArrayBuffer`, or base64 chunks of ≤ 1 MB in order |

State transitions:

```text
RECEIVING → (all bytes, size matches) → AWAITING_LOCATION → (user picks) → WRITING → SAVED
    │                                       │                               │
    └─ size mismatch / timeout → FAILED     └─ user cancels → CANCELLED     └─ IOException → FAILED (document deleted)
    └─ save-failed from the page → FAILED
```

`save-failed` with no transfer begun (the blob could not be read before `save-begin`) is shown as a
failed save on its own. A location that arrives with no save awaiting it (the process died while
the dialog was open) is deleted only when the provider reports its size as exactly 0; an existing
file the user picked to overwrite, or one of unknown size, is kept.

Only `SAVED` shows "Saved". `CANCELLED` shows nothing (US1 AS5). `FAILED` shows the reason. Bytes
are held in memory only and dropped on any terminal state; nothing is written to app storage.

## Capture file (transient)

A camera capture writes to `cache/capture/<random>.jpg` through a non-exported `FileProvider`. WebView reads
a chooser URI lazily, when the page reads the file, so the photo is not deleted the moment it is
handed over: it is deleted when the next file chooser opens, when the activity is destroyed, and
with the whole `cache/capture/` directory on every launch. It is never a remembered item.

## On-device stores and their exclusion

| Store | Holds | Backup / D2D |
|---|---|---|
| WebView IndexedDB (app data dir) | opt-in certificate and signature (shared app's `idb-keyval`) | excluded: every domain in `data_extraction_rules.xml` and `backup_rules.xml`; `allowBackup=false` [R10] |
| WebView Cache Storage | service worker precache (application code only) | excluded by the same rules |
| `cache/capture/` | at most one photo, transiently | excluded; cleared per launch |
| Shell's own storage | **none**: the shell keeps no preferences, logs or files | n/a |

Uninstalling removes the app data directory, and with it every row above (US3 AS3).

## Signing key (owner-held, never in the repository)

| Item | Where | Rule |
|---|---|---|
| keystore + passwords | GitHub Environment `android-release` secrets, plus the owner's offline backup | readable only by the job bound to that environment, only from `v*` tags [R12] |
| certificate SHA-256 | `android/SIGNING_FINGERPRINT` (public, committed) | the value every release is checked against |
| keystore file at build time | `$RUNNER_TEMP` | deleted in an `if: always()` step; never in the workspace, a log or an artifact |
