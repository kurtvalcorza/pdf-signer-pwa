---
description: "Task list for 003-android-packaging"
---

# Tasks: Native Android App (Offline, Bundled)

**Input**: Design documents from `specs/003-android-packaging/`. Load [plan.md](plan.md),
[research.md](research.md) (R1–R16, spike findings S1–S11), [data-model.md](data-model.md),
[contracts/shell-bridge.md](contracts/shell-bridge.md), [contracts/apk-checks.md](contracts/apk-checks.md),
and [quickstart.md](quickstart.md) before starting any task.

**Tests**: The spec makes verification a requirement: FR-020's release gate, the C1–C12 checks and
SC-002 to SC-007. So check and gate tasks are included. JVM unit tests cover only the shell's pure
logic, which is factored into plain Kotlin files so the tests need no Android runtime and no new
test dependency beyond JUnit.

**Reference code**: `spike-android/` (git-excluded, never committed) holds working spike versions
of the manifest, rules files, `MainActivity.kt` and `shell.js`. Port from it, don't copy it
blindly: production splits the code per plan.md and applies the spike's consequences (S3, S9).
T049 deletes it.

**Hard rules for every task**:
- No Android-specific change to `src/`, `index.html` or `vite.config.ts` (SC-006, C9). A
  distribution-neutral fix there is its own commit, listed as neutral.
- No signing key, keystore or password in the repository, a log or an artifact (FR-021). Only the
  public fingerprint is committed.
- `[OWNER]` tasks are Kurt's. An agent prepares the instructions and waits; it never creates or
  handles the key itself.
- Commit only when asked; push, PR, tag and merge each need Kurt's yes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md
- **[OWNER]**: Kurt performs it

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: the `android/` Gradle project, pinned and allow-listed, building an APK that contains `dist/`.

- [ ] T001 Create the Gradle project in `android/`: `settings.gradle.kts` (the spike's repository block, `rootProject.name = "pdf-signer-android"`, `include(":app")`), root `build.gradle.kts` (`android-application` plugin, `apply false`), `gradle.properties` (from the spike), and the wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`) copied from `spike-android/`, keeping `distributionSha256Sum`
- [ ] T002 Create `android/gradle/libs.versions.toml` pinning exactly: AGP `9.0.1`, `androidx.core:core` `1.18.0`, `androidx.activity:activity` `1.13.0`, `androidx.webkit:webkit` `1.18.0`, `junit:junit` `4.13.2` (test only). No other library
- [ ] T003 Create `android/app/build.gradle.kts`: `namespace` and `applicationId` = `io.github.kurtvalcorza.pdfsigner` (permanent, R15); `compileSdk = 36`, `targetSdk = 36`, `minSdk = 26`; `versionName` read from `../package.json` `version`; `versionCode = major*10000 + minor*100 + patch` (0.1.1 → 101, data model: "strictly increasing across releases"); Java/Kotlin toolchain 21; `buildConfig = true` with fields `WEBVIEW_HARD_MIN = 119`, `WEBVIEW_VALIDATED_FLOOR` (read from `android/VALIDATED_WEBVIEW`) and `SOURCE_COMMIT` (env `GITHUB_SHA`, else `git rev-parse HEAD`); `isMinifyEnabled = false`; dependencies `core`, `activity`, `webkit`, plus `testImplementation(junit)`
- [ ] T004 In `android/app/build.gradle.kts`, register a task that copies `../dist/**` into a generated assets directory under `www/`, and adds it with `androidComponents.onVariants { it.sources.assets?.addGeneratedSourceDirectory(...) }`. The build must fail with a clear message if `../dist/index.html` is missing. `dist/` is never committed into `android/`
- [ ] T005 [P] Create `android/VALIDATED_WEBVIEW` containing the single line `133`, the WebView major of the gate image (spike S10, R11). T042 asserts it in CI
- [ ] T006 [P] Add `android/.gradle/`, `android/build/`, `android/app/build/`, `android/local.properties` to `.gitignore`
- [ ] T007 [P] Create `android/dependency-allowlist.txt` with one Maven coordinate per line (`group:artifact:version`), listing every artifact `./gradlew :app:dependencies --configuration releaseRuntimeClasspath` resolves today. Add a `verifyDependencyAllowlist` task in `android/app/build.gradle.kts`, run before `preBuild`, that fails on any resolved coordinate not in the file (C2, R5: an allow-list, not a deny-list)
- [ ] T008 Generate `android/gradle/verification-metadata.xml` with `./gradlew --write-verification-metadata sha256 :app:assembleRelease`, and confirm a second build passes verification (C2)
- [ ] T009 Add `scripts/build-android.mjs` (runs `gradlew.bat` on Windows, `./gradlew` elsewhere, in `android/`, with `shell:false` and discrete argv, as in `scripts/verify-signatures.mjs`), plus a `build:android` script in `package.json`: `npm run build && node scripts/build-android.mjs assembleRelease`

**Checkpoint**: `npm run build:android` produces an unsigned release APK containing `assets/www/index.html`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: a shell that loads the unchanged app from the package, offline, with the manifest guarantees. Every story depends on it.

- [ ] T010 Create `android/app/src/main/AndroidManifest.xml`, porting the spike's manifest plus spike S3:
  - `INTERNET` and `ACCESS_NETWORK_STATE` with `tools:node="remove"`;
  - `<receiver android:name="androidx.profileinstaller.ProfileInstallReceiver" tools:node="remove"/>`;
  - `allowBackup="false"`, `fullBackupContent="@xml/backup_rules"`, `dataExtractionRules="@xml/data_extraction_rules"`;
  - meta-data `android.webkit.WebView.MetricsOptOut = true` and `android.webkit.WebView.EnableSafeBrowsing = false`;
  - the launcher `MainActivity` as the only exported component;
  - a `FileProvider` with authority `io.github.kurtvalcorza.pdfsigner.capture`, `exported="false"`, `grantUriPermissions="true"`.
- [ ] T011 [P] Create `android/app/src/main/res/xml/data_extraction_rules.xml` (every domain excluded in **both** `<cloud-backup>` and `<device-transfer>`, R10), `backup_rules.xml` (every domain excluded) and `file_paths.xml` (`<cache-path name="capture" path="capture/"/>` only), ported from the spike. Add `res/values/strings.xml` (`app_name` = "PDF Signer"), `themes.xml` and the launcher icons from the spike
- [ ] T012 [P] Create `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/PathRules.kt` (pure Kotlin, no Android imports). It provides `resolve(path): Resolved`, returning either `Asset(assetPath = "www/<p>", mime, encoding)` or `NotFound`:
  - `""` maps to `index.html`;
  - leading `/`, `..`, `\`, `%` and empty segments return `NotFound`;
  - MIME comes from contract §1's explicit map, with `.js` and `.mjs` as `text/javascript`, `.wasm` as `application/wasm`, and anything unknown as `application/octet-stream`;
  - `headers()` always returns an empty map.
- [ ] T013 [P] Create `android/app/src/test/kotlin/io/github/kurtvalcorza/pdfsigner/PathRulesTest.kt`: root → index.html; traversal, encoded and absolute paths → NotFound; `.mjs` → `text/javascript`; unknown → octet-stream; `headers()` is empty (the C7 header assertion: no `Content-Security-Policy`, R3)
- [ ] T014 Create `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/AppAssetHandler.kt`: a `WebViewAssetLoader.PathHandler` at `/` on `appassets.androidplatform.net` that uses `PathRules`. It returns an explicit 404 `WebResourceResponse` and **never `null`** (R2). Also an `intercept(request)` used by both the page client and the `ServiceWorkerClientCompat`: off-origin requests get 403 and a log line, never a fall-through (R2, R4, spike S4–S5)
- [ ] T015 Create `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/MainActivity.kt`, a `ComponentActivity` with contract §6's invariants:
  - `FLAG_SECURE` set before any content, and `setRecentsScreenshotEnabled(false)` on API 33+ (R9, FR-023);
  - WebView settings: JavaScript and DOM storage on; `allowFileAccess`, `allowContentAccess`, multiple windows and Safe Browsing off;
  - `setWebContentsDebuggingEnabled` only when the app is debuggable;
  - a `DownloadListener` that ignores every request;
  - `shouldOverrideUrlLoading` allows only the app origin; exactly `https://github.com/kurtvalcorza/pdf-signer-pwa` goes to `ACTION_VIEW`; anything else is dropped;
  - `cache/capture/` cleared on launch;
  - the SW client from T014 registered when `SERVICE_WORKER_BASIC_USAGE` and `SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST` are supported;
  - loads `https://appassets.androidplatform.net/`.
- [ ] T016 Build, install on the `medium_phone` AVD with airplane mode on before installing, and confirm from logcat and `uiautomator dump` that the shared app's start screen appears, the only miss is `favicon.ico` → 404, and `app_webview/Default/Service Worker/CacheStorage` is non-empty (Q1 baseline, spike S4–S5). Run the emulator through the 8.3 short path with `-gpu swiftshader_indirect` (R14)

**Checkpoint**: the unchanged app runs from the APK offline. Stories can start.

---

## Phase 3: User Story 1 - Sign a PDF on an Android phone with no network (Priority: P1) 🎯 MVP

**Goal**: open, sign, counter-sign and save offline, with output that pyHanko validates (FR-001–FR-003, FR-007–FR-009, FR-020).

**Independent Test**: Q3 + Q4. The gate signs and counter-signs on the signed release APK with airplane mode on from first launch, and `scripts/validate_pdf.py` passes both files on integrity and modification policy.

- [ ] T017 [P] [US1] Create `android/app/src/main/assets/shell/shell.js`, porting the spike's script and doing exactly contract §2 items 1–2: blob registry, plus download interception on `HTMLAnchorElement.prototype.click` for `download` + `blob:` + registered anchors only. It sends `save-begin` and then one ArrayBuffer, falling back to base64 chunks of ≤ 1 MB plus `save-end`. It touches no `fetch`, `XMLHttpRequest`, `WebSocket`, worker, storage or `#root`
- [ ] T018 [P] [US1] Create `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/SaveRules.kt` (pure Kotlin), applying data-model "Save request" verbatim:
  - `name`: "strips path separators and control characters, and keeps the extension";
  - `mime`: "one of `application/pdf`, `application/x-pkcs12`, `application/x-x509-ca-cert`, `application/x-pem-file`, else `application/octet-stream`";
  - `size`: "MUST be ≤ 100 MB + 1 MB headroom, or it is refused before the save dialog opens";
  - a state machine `RECEIVING → AWAITING_LOCATION → WRITING → SAVED`, with `CANCELLED` and `FAILED` terminal states;
  - refusal of a second `save-begin` while one is active, a size mismatch, or a malformed message.
- [ ] T019 [P] [US1] Create `android/app/src/test/kotlin/io/github/kurtvalcorza/pdfsigner/SaveRulesTest.kt` covering every rule and transition in T018, including `../x.pdf` → `.._x.pdf` (no separator survives), size 101 MB + 1 refused, and a second begin refused
- [ ] T020 [US1] Create `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/SaveBridge.kt`:
  - `addWebMessageListener("pdfSignerShell", {app origin})`, dropping messages from other origins or sub-frames;
  - drives `SaveRules`, then `ACTION_CREATE_DOCUMENT` with the sanitised name and MIME, writing with `openOutputStream(uri, "wt")`;
  - on `IOException`, `DocumentsContract.deleteDocument` and a native message;
  - only SAVED shows "Saved", CANCELLED shows nothing, FAILED shows the reason;
  - bytes held in memory only and dropped on every terminal state;
  - replies `save-result` (contract §3).
- [ ] T021 [P] [US1] Create `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/AcceptRules.kt` (pure Kotlin) mapping accept values to MIME types per contract §4's table: `.pdf` → `application/pdf`; `image/png`, `image/jpeg` → as given; `.p12`, `.pfx` → `application/x-pkcs12` + `application/octet-stream`; anything else → refused. Accept entries arrive both as separate items and comma-joined (spike S7). Add `AcceptRulesTest.kt` in `android/app/src/test/kotlin/io/github/kurtvalcorza/pdfsigner/`
- [ ] T022 [US1] Create `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/FileChooser.kt`: `onShowFileChooser` using `AcceptRules` and `ActivityResultContracts.OpenDocument`, single selection, and the callback called **exactly once** on every path (cancel, error, refusal → `null`). No runtime permission is requested (FR-010). The capture branch is T037
- [ ] T023 [US1] Wire `shell.js` (`addDocumentStartJavaScript`, app origin only), `SaveBridge` and `FileChooser` into `MainActivity.kt`. Rebuild and repeat the spike's manual sign → save on the AVD as a smoke test
- [ ] T024 [US1] Create `scripts/android-gate.mjs` implementing R13, including spike S9's driver rules: dump twice after launch, and tap only from a fresh dump, by resource id where one exists (`android:id/button1` = SAVE). The script:
  - takes `<apk>` and `--adb`;
  - installs the APK and enables airplane mode before first launch;
  - pushes `tests/e2e/fixtures/sample.pdf`, `signature.png` and `e2e-cert.p12` (password `e2e-pass`) to `Download/`;
  - signs, saves, reopens the result, counter-signs on page 2 and saves again;
  - pulls both files and runs `python scripts/validate_pdf.py` on them (C10);
  - exits non-zero on any failure, printing the validator output.
- [ ] T025 [US1] Extend `scripts/android-gate.mjs` with three cases:
  - a wrong password shows the shared app's error and no save dialog opens (US1 AS4);
  - cancelling the save dialog logs nothing saved and leaves no new file in `Download/` (US1 AS5);
  - the certified fixture from `tests/signing/fixtures/policy/` (generated by `scripts/make_policy_fixtures.py`) is refused for certificate signing with the shared app's message (US1 AS3, C11).
- [ ] T026 [US1] Extend `scripts/android-gate.mjs` with a `--large` case: generate a ~100 MB PDF in a temp directory (pdf-lib, under `LIMITS.pdfBytes`), sign it, and confirm the save completes with matching byte count and validates (R7, spike S6 untested item)
- [ ] T027 [US1] Locally build a release APK, sign it with a **throwaway local test keystore created in the session scratchpad** (never the release key, never in the repository), run `node scripts/android-gate.mjs` against it on the AVD, and record the result in `specs/003-android-packaging/research.md` under the spike findings as "US1 gate, local"

**Checkpoint**: US1 is done when the gate passes C10, C11, AS4, AS5 and `--large` on a signed release APK. That's the MVP.

---

## Phase 4: User Story 2 - Trust that the app cannot reach the network (Priority: P1)

**Goal**: prove and disclose the network ban (FR-004–FR-006, FR-016, FR-017, US2 AS1–AS3).

**Independent Test**: Q2 + Q5 + Q6 + Q7. `android-check-apk.mjs` passes C1–C7 and C9; the gate with the network on shows 0 traffic records for the app UID; the screencap is black; the About panel states the network claim.

- [ ] T028 [P] [US2] Create `scripts/android-check-apk.mjs <apk> --dist dist [--fingerprint android/SIGNING_FINGERPRINT] [--base <ref>]`, implementing C1, C3–C7 and C9 from contracts/apk-checks.md with `aapt2` and `apksigner` from the SDK's newest build-tools:
  - **C1**: allow only `<applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which must also be declared with `protectionLevel=signature`.
  - **C4**: the launcher is the only exported component.
  - **C5**: both rule sections exclude every domain.
  - **C6**: `debuggable` false, plus both meta-data values.
  - **C7**: SHA-256 of every `assets/www/**` entry equals `dist/`; no file missing or extra.
  - **C9**: `git diff <base>..HEAD -- src/ index.html vite.config.ts`, case-insensitive grep for `pdfSignerShell|appassets|androidplatform|android`.

  Each check prints the evidence it judged and never prints a secret.
- [ ] T029 [US2] Extend `scripts/android-gate.mjs` with `--network-on`: disable airplane mode, run the US1 sign flow, then read `adb shell dumpsys netstats detail` and fail on any traffic record (`set=DEFAULT|FOREGROUND|BACKGROUND`) for the app UID, which `cmd package list packages -U` provides (C12, SC-003, spike S2). Re-enable airplane mode afterwards
- [ ] T030 [US2] Extend `scripts/android-gate.mjs` with C8: with a document open, `adb exec-out screencap -p` and fail if any sampled pixel below the status bar is non-black (spike S8 method: 40 px grid)
- [ ] T031 [P] [US2] Create `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/EngineCheck.kt` (pure Kotlin) implementing data-model "Engine check" verbatim: `major < webViewHardMin → REFUSED`; `webViewHardMin ≤ major < webViewValidatedFloor → UNVALIDATED`; `major ≥ webViewValidatedFloor → OK`; no WebView provider, or disabled → REFUSED. It parses the major from `versionName` (`133.0.6943.137` → 133). Add `EngineCheckTest.kt` in `android/app/src/test/kotlin/io/github/kurtvalcorza/pdfsigner/`
- [ ] T032 [US2] In `MainActivity.kt`, read `WebViewCompat.getCurrentWebViewPackage(this)` **before** creating the WebView. REFUSED shows a native screen (layout `res/layout/refused.xml`) explaining that the system web view is too old or disabled, how to update or enable it, and that nothing was loaded; the web app is never loaded. UNVALIDATED loads the app and asks `shell.js` to show the notice. There's no "don't show again" and no stored preference (data model, R11)
- [ ] T033 [US2] Add contract §2 item 3 to `android/app/src/main/assets/shell/shell.js` and `MainActivity.kt`: a shell-owned "About this app" button and panel in its own DOM node outside `#root`, with text supplied by native code over the same message channel. The panel lists every bullet in contract §5:
  - version, source commit, installed from outside the store, never updates itself;
  - the WebView version in use, the validated floor, and that the engine depends on the device;
  - no network permission, how to confirm it in Settings, and the crash-report caveat (R6);
  - remembered items stay in this app only, are excluded from backup and transfer, and are deleted on uninstall;
  - screenshots and recents are blocked.

  Plus the UNVALIDATED banner.
- [ ] T034 [US2] Run Q2, Q5, Q6 and Q7 on the AVD. For Q7's REFUSED case, `adb shell pm disable-user com.google.android.webview` (re-enable afterwards). For UNVALIDATED, a temporary local build with `WEBVIEW_VALIDATED_FLOOR=999`, never committed. Record the results in `research.md`

**Checkpoint**: US2 is done when C1–C9 and C12 pass with evidence, and the About panel states each contract §5 item.

---

## Phase 5: User Story 3 - Keep a remembered certificate safely on this phone only (Priority: P2)

**Goal**: opt-in data never leaves through backup or transfer, and Forget and uninstall are truthful (FR-012–FR-015).

**Independent Test**: Q8 on the AVD, and Q9 on two phones ([OWNER]).

- [ ] T035 [US3] Extend `scripts/android-gate.mjs` with `--backup`:
  - opt in to "Remember this certificate";
  - `adb shell bmgr transport com.android.localtransport/.LocalTransport`, then `adb shell bmgr backupnow io.github.kurtvalcorza.pdfsigner`, and fail if the package contributes backup data (US3 AS1, cloud half);
  - choose Forget and confirm the item is gone (AS2);
  - uninstall, reinstall and confirm nothing remains (AS3).
- [ ] T036 [OWNER] [US3] Run Q9 on two physical phones (device-to-device setup with a remembered certificate on the old phone) and report the result. An agent then records it in `research.md` R10 and updates SC-004's "mechanism only" note in `plan.md`

**Checkpoint**: US3's cloud half is behavioural, and the D2D half is by mechanism until T036.

---

## Phase 6: User Story 4 - Capture a signature with the camera (Priority: P2)

**Goal**: the camera path works with no CAMERA permission, and refusing it leaves the picker (FR-011).

**Independent Test**: on the AVD's virtual camera, take a photo, clean it up, sign, and the image is in the signed PDF. Backing out of the camera leaves "Add signature" working.

- [ ] T037 [US4] Add the capture branch to `android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/FileChooser.kt`: when `isCaptureEnabled()`, create `cache/capture/<random>.jpg` and launch `ActivityResultContracts.TakePicture` with its `FileProvider` URI. Delete the file after it's handed to WebView (data model "Capture file"). No camera app or back-out → callback `null`. The manifest declares **no** `CAMERA` permission (R8)
- [ ] T038 [US4] Verify on the AVD: capture → clean up → sign → validate (US4 AS1); back out → the image picker still works and nothing is asked again (AS2); a capture over `LIMITS.imagePixels` (40,000,000 px) is refused with the shared app's message (AS3; use an emulator camera resolution or a pushed oversized image if the virtual camera can't exceed it). Record in `research.md`

**Checkpoint**: US4 is done; C1 still shows no new permission.

---

## Phase 7: User Story 5 - Verify the app package before installing it (Priority: P3)

**Goal**: a release that ships a signed, gated, verifiable APK next to the web and desktop artifacts (FR-018–FR-021).

**Independent Test**: Q10. Checksum, attestation and fingerprint verify in under 5 minutes, and an update installs over the previous version with remembered items intact.

- [ ] T039 [OWNER] [US5] Create the release key on your own machine: `keytool -genkeypair -keystore pdf-signer-release.p12 -storetype PKCS12 -keyalg RSA -keysize 4096 -validity 10950 -alias pdf-signer`. Keep an offline backup, and give the agent **only** the certificate's SHA-256 fingerprint (`keytool -list -v`), which goes into `android/SIGNING_FINGERPRINT` (R12). Losing the key ends in-place updates for every user
- [ ] T040 [OWNER] [US5] Create the GitHub Environment `android-release` on kurtvalcorza/pdf-signer-pwa, with a deployment rule allowing tags `v*` only, and environment secrets `ANDROID_KEYSTORE_B64` (base64 of the keystore), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` (R12: environment, not repository, secrets)
- [ ] T041 [US5] Commit `android/SIGNING_FINGERPRINT` (one line, the uppercase colon-separated SHA-256 from T039) after T039
- [ ] T042 [US5] Add an `android` job to `.github/workflows/release-desktop.yml` on `ubuntu-latest` with `environment: android-release`. Every action is pinned by commit SHA, as the existing jobs are. The job:
  - `npm ci && npm run build`; `setup-java` 21; `node scripts/build-android.mjs assembleRelease`;
  - writes the keystore from the secret to `$RUNNER_TEMP`;
  - signs with `apksigner sign --v2-signing-enabled true --v3-signing-enabled true --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD`;
  - deletes the keystore in an `if: always()` step;
  - names the output `pdf-signer-<version>.apk`;
  - runs `scripts/android-check-apk.mjs` with `--fingerprint`;
  - boots the API 36 `google_apis` x86_64 emulator with KVM, using a pinned emulator action;
  - asserts the emulator's WebView major equals `android/VALIDATED_WEBVIEW`, failing on a mismatch;
  - runs `scripts/android-gate.mjs` with `--network-on`, `--backup` and `--large`;
  - computes `SHA256SUMS-Android` and runs `actions/attest-build-provenance`;
  - uploads the APK and its checksum.
- [ ] T043 [US5] In `.github/workflows/release-desktop.yml`, make `publish` `needs: [build, android]`. Merge `SHA256SUMS-Android` into the single `SHA256SUMS` through the existing awk step (no spaces in the APK name), attach the APK, and add `docs/android.md` needles (`does not update itself`, `apksigner verify --print-certs`, `gh attestation verify`, `no network permission`) to the docs check
- [ ] T044 [US5] Create `docs/android.md` covering:
  - install from outside the store and the platform warning;
  - verification: `sha256sum -c SHA256SUMS`, `gh attestation verify pdf-signer-<version>.apk --repo kurtvalcorza/pdf-signer-pwa`, and `apksigner verify --print-certs` compared with `android/SIGNING_FINGERPRINT`;
  - the FR-016 disclosures: outside the store, never updates itself, engine depends on the device, hard minimum WebView 119, validated floor from `android/VALIDATED_WEBVIEW`;
  - the R6 crash-report caveat and the device setting that controls it;
  - FLAG_SECURE, and what it means for screenshots;
  - remembered items and uninstall;
  - why an install over a differently signed package fails and what removing the old app deletes.

  Link it from `README.md`.
- [ ] T045 [US5] Verify SC-007 locally: build versionCode N and N+1 with the throwaway test key, install N, opt in to remembering a certificate, install N+1 over it with `adb install -r`, and confirm the remembered certificate is still offered. Record in `research.md`

**Checkpoint**: US5 is done when a tag (Kurt's yes) produces a release whose APK passes Q10.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T046 Add an `android` job to `.github/workflows/ci.yml` for pull requests:
  - `npm ci && npm run build`;
  - `./gradlew verifyDependencyAllowlist testDebugUnitTest assembleRelease` (unsigned);
  - `node scripts/android-check-apk.mjs` for C1, C2 and C4–C7, plus C9 with `--base origin/main`;
  - no secrets and no environment (C9 "run in CI on PRs, not only on release").
- [ ] T047 [P] Update `CLAUDE.md` (SPECKIT block: 003 status implemented, the spike removed) and `README.md` (Android as the third distribution, linking `docs/android.md`)
- [ ] T048 [P] Run `/speckit-analyze` across spec.md, plan.md and tasks.md, and fix any claim that drifted (the 002 lesson: grep the whole repository for a corrected claim)
- [ ] T049 Delete `spike-android/` and remove its line from `.git/info/exclude`. This is permanent: the folder is git-excluded, so there's no undo. Do it only after T001–T048 are done and Kurt confirms. Confirm first that no file outside it references `spike-android/` except the historical notes in research.md and tasks.md

---

## Dependencies & Execution Order

- **Setup (T001–T009)** → **Foundational (T010–T016)** → stories.
- **US1 (T017–T027)** is the MVP and comes first: its gate script (T024) is the base that US2–US5 extend.
- **US2 (T028–T034)** needs T024 for T029–T030. T028 and T031 can start right after Phase 2.
- **US3 (T035–T036)** needs T024. T036 is [OWNER] and can happen any time after T027.
- **US4 (T037–T038)** needs T022.
- **US5 (T039–T045)**:
  - T041 needs T039; T042 needs T026, T028, T029, T035 and T040; T043 needs T042 and T044.
  - T039 and T040 are [OWNER] and can run in parallel with everything else.
- **Polish**: T046 after T028; T049 last.

Within a story, pure `*Rules.kt` files and their tests come before the Android classes that use them.

## Parallel Opportunities

- Phase 1: T005, T006, T007 together.
- Phase 2: T011, T012 and T013 together, while T010 is written.
- US1: T017, T018/T019 and T021 together (separate files), then T020, T022 and T023 in order.
- US2: T028 and T031 together, alongside US1's gate work.
- [OWNER] T036, T039 and T040 run on Kurt's schedule, in parallel with all agent tasks.

```text
# Example: start US1's independent files at once
T017 shell.js        android/app/src/main/assets/shell/shell.js
T018 SaveRules.kt    android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/SaveRules.kt
T021 AcceptRules.kt  android/app/src/main/kotlin/io/github/kurtvalcorza/pdfsigner/AcceptRules.kt
```

## Implementation Strategy

1. **MVP = Phases 1–3**: an APK that signs and counter-signs offline and passes the gate locally on
   a test-key-signed release build (T027). Stop and review.
2. **US2** next: it's P1, and the evidence that makes the privacy claim honest.
3. **US3, US4** in either order.
4. **US5** once Kurt has done T039 and T040. The first tagged release with an APK needs his yes.
5. **Polish**, then T049 removes the spike.

Total: 49 tasks (Setup 9, Foundational 7, US1 11, US2 7, US3 2, US4 2, US5 7, Polish 4), 3 of
them [OWNER] (T036, T039, T040). Tagging the first release is Kurt's yes, not a task.
