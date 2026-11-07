# Implementation Plan: Native Android App (Offline, Bundled)

**Branch**: `003-android-packaging` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-android-packaging/spec.md`

## Summary

Ship a third distribution: a signed Android APK whose only UI is a WebView running the **unchanged**
`dist/` build from inside the package, on the reserved `https://appassets.androidplatform.net`
origin. The OS enforces the network ban: the APK declares no permissions at all, a dependency
allow-list keeps libraries from adding network code, and both are checked on the built APK. A thin
Kotlin shell does only what the WebView can't:

- the system file picker and the camera intent, with no runtime permissions;
- saving through the system save dialog, using a document-start script that intercepts the shared
  app's `blob:` download clicks without modifying shared code;
- FLAG_SECURE;
- backup and device-transfer exclusion;
- a native engine-version check.

The release job signs the APK from a GitHub Environment secret and gates publication on a sign plus
counter-sign run of **that** signed APK on an emulator, validated by pyHanko. A throwaway spike
proves the risky parts first, then stops for review.

## Technical Context

**Language/Version**: Kotlin (the version that ships with AGP 9), JDK 21 toolchain. The injected
shell script is plain JavaScript with no build step. The shared app stays TypeScript/React/Vite,
unchanged.

**Primary Dependencies**: `androidx.webkit` (WebViewAssetLoader, document-start scripts, web message
listener, service-worker control), `androidx.activity` (ActivityResult), `androidx.core`
(FileProvider). Exact versions are pinned at the spike in a version catalog, plus Gradle dependency
verification. Nothing else, enforced by the allow-list (R5).

**Storage**: the shared app's IndexedDB inside WebView, in the app's private data directory,
excluded from backup and transfer (R10). The shell itself stores nothing.

**Testing**: JVM unit tests for the shell (path normalisation, MIME map, no added headers, accept
mapping, version comparison, file-name sanitising). `scripts/android-check-apk.mjs` for static APK
checks. `scripts/android-gate.mjs` drives the signed APK on an emulator through adb and
`uiautomator`, then runs `scripts/validate_pdf.py`. The shared Vitest and Playwright suites run
unchanged.

**Target Platform**: Android 8.0+ (minSdk 26), target and compile SDK 36. System WebView: hard
minimum 119, plus a per-release validated floor (R11).

**Project Type**: mobile app shell around an existing static web build.

**Performance Goals**: SC-001, under 60 s from opening a PDF to a saved signed copy on a mid-range
phone. Saving a 100 MB PDF must complete without building a base64 string of the whole file (R7).

**Constraints**: zero declared permissions; zero changes to `src/`, `index.html` or
`vite.config.ts` (SC-006, C9); no secret in the repository, a log or an artifact (FR-021); every
release check runs on the published APK (Principle V).

**Scale/Scope**: about 6 Kotlin files, one injected script, three XML resource files, two Node
scripts, one workflow job, one user doc.

## Constitution Check

*Against constitution v1.2.0. Run before Phase 0, and again after Phase 1 (below).*

| Principle | Obligation for Android | How this plan meets it | Status |
|---|---|---|---|
| **I. Zero-server** (NON-NEGOTIABLE) | CSP retained; no network permission; native code must not attempt network | CSP meta tag untouched and the handler adds no headers (R3); zero permissions, with `tools:node="remove"` against merging and an APK check (R5, C1); a dependency allow-list for "no attempt" (R5, C2); navigation locked to the origin (R2) | ✅ |
| **II. Offline-first & installable** | A self-contained package that runs with no network from first launch | `dist/` inside the APK, served locally; SW routed through the same handler (R4); the gate runs with airplane mode on before first launch (Q3) | ✅ |
| **III. Crypto correctness** (NON-NEGOTIABLE) | The same signing engine, no distribution branch | Shared build unchanged and asset hashes compared with `dist/` (C7); a shared-code diff check (C9); the save interception acts only *after* signing, on the finished bytes (R7) | ✅ |
| **IV. Honest posture** | Disclose that the engine depends on the device, the install from outside the store, and no self-update; warn locally below the validated floor | About panel and engine notice (contract §5, R11); the WebView provider's crash reports named, not hidden (R6) | ✅ |
| **V. Real readers** | The gate runs on output from the Android package itself | The signed release APK is driven on an emulator; pyHanko on its output (R13, C10) | ✅ |
| **VI. Data minimisation** | Opted-in data stays on the device, excluded from backup and transfer | `allowBackup=false` plus `dataExtractionRules` covering cloud and D2D (R10, C5); the shell stores nothing; captures are transient | ✅ (D2D half by mechanism until Q9) |
| Tech constraints | Distribution (c) is named; nothing further | APK on the same GitHub release, same commit (FR-019) | ✅ |
| Privacy gate | Android permission check | C1 in the release job | ✅ |

No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-android-packaging/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: R1–R16
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1: Q1 spike first, then Q2–Q10
├── contracts/
│   ├── shell-bridge.md  # shell ↔ web app: serving, injected script, save messages, chooser, disclosures
│   └── apk-checks.md    # C1–C12 release checks
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks), NOT created here
```

### Source Code (repository root)

```text
android/                                   # new: the shell (Gradle project)
├── settings.gradle.kts
├── build.gradle.kts
├── gradle/libs.versions.toml              # pinned versions
├── gradle/verification-metadata.xml       # dependency checksums
├── dependency-allowlist.txt               # exact coordinates (C2)
├── SIGNING_FINGERPRINT                    # public cert SHA-256 (C3)
└── app/
    ├── build.gradle.kts                   # copies ../dist → generated assets/www at build
    └── src/
        ├── main/AndroidManifest.xml
        ├── main/kotlin/io/github/kurtvalcorza/pdfsigner/
        │   ├── MainActivity.kt            # FLAG_SECURE, WebView setup, engine check
        │   ├── AppAssetHandler.kt         # path handler + SW client (R2, R4)
        │   ├── FileChooser.kt             # onShowFileChooser + capture (R8)
        │   ├── SaveBridge.kt              # web message listener + CREATE_DOCUMENT (R7)
        │   └── EngineCheck.kt             # hard minimum / validated floor (R11)
        ├── main/assets/shell/shell.js     # injected script (contract §2)
        ├── main/res/xml/{data_extraction_rules,backup_rules,file_paths}.xml
        └── test/kotlin/…                  # JVM unit tests
scripts/
├── android-check-apk.mjs                  # new: C1–C7, C9
└── android-gate.mjs                       # new: C8, C10–C12
docs/android.md                            # new: install, verify, disclosures
.github/workflows/release-desktop.yml      # gains an `android` job; `publish` needs it
src/ index.html vite.config.ts             # UNCHANGED (C9)
```

**Structure Decision**: The shell is a self-contained Gradle project under `android/`, alongside
`electron/` for desktop. It consumes `dist/` as build input and owns nothing the web app reads. The
release workflow keeps its file name, so links in `docs/desktop.md` stay valid. It gains one job
plus one `needs:` entry.

## Phases after this plan

1. **Spike (Q1), then stop.** Throwaway, never committed. It proves R2, R4, R5 (library manifests),
   R7, R8, R9 and R13's driver, and records the WebView version. The findings go into research.md
   and the spike is deleted.
2. `/speckit-tasks`, only after the owner reviews the spike.
3. Shell, checks, gate, docs, release job (tasks).
4. Owner actions before the first Android release: create the key and its offline backup, create
   the `android-release` environment and its secrets, commit `android/SIGNING_FINGERPRINT`, and run
   Q9 on two phones when available.

## Open decisions (owner)

Settled within the spec and constitution, so not asked now. Each is listed because a spike finding
could reopen it:

- **R7 fallback**: if wrapping the anchor click proves unreliable, the simpler route is a 5-line
  `window.nativeShell` seam in `export.ts`. That would breach SC-006 ("0 Android-specific changes to
  shared code") and needs the owner's yes plus a spec amendment.
- **R13 fallback**: if the `uiautomator dump` driver can't operate the system dialogs reliably, the
  gate moves to a UI Automator instrumentation test (a test APK in CI, not signed with the release
  key).
- **Application ID** `io.github.kurtvalcorza.pdfsigner` can never change after the first release.

## Post-design Constitution re-check

Re-checked after writing research.md, data-model.md and both contracts:

- **I**: the one remaining path out is the WebView provider's own uploads (R6). The plan discloses
  it rather than claiming it away. Metrics are opted out. Crash reports depend on the device
  setting. ✅
- **III**: the injected script never touches signing, `fetch` or storage, and acts only on finished
  `blob:` downloads (contract §2). ✅
- **V**: the gate's driver works on the release APK because the accessibility tree ignores
  FLAG_SECURE. If the spike disproves that, R13's fallback still runs on the release APK. ✅
- **VI**: the D2D half of SC-004 is mechanism-only until Q9 runs. Release notes state the mechanism
  and claim no more. ✅

Gate result: **PASS**, with no unresolved clarifications.

## Complexity Tracking

None.
