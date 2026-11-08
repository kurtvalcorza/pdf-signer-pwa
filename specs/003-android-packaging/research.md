# Research: Native Android App (003)

Phase 0 output for [plan.md](plan.md). Each item is **Decision / Rationale / Alternatives**, and each
says whether it is **confirmed** (evidence named) or **inferred** (and what confirms it). Items
marked *spike* are confirmed or overturned by the FR-022 spike before any production code.

Toolchain, confirmed 2026-11-07 on this machine: Android CLI 1.1.16717390, JDK 21.0.13, SDK at
`%LOCALAPPDATA%\Android\Sdk` with `platforms/android-36`, `build-tools/36.1.0`, `platform-tools`
37.0.1, `emulator` 37.2.13 and `system-images/android-36/google_apis/x86_64` (5.6 GB). WHPX is
usable (`emulator -accel-check`). CLI templates: `empty-activity` (Compose, AGP 9) and
`empty-activity-lightbuild`.

---

## R1 — Shell technology: Kotlin, one Activity, one WebView, no Compose

**Decision**: A Kotlin app with a single `ComponentActivity` whose whole content is a `WebView`.
The CLI's `empty-activity` template is the starting point, with Compose removed.

**Rationale**: The shell's UI is the shared web app. Compose, Material and AppCompat would add
dependencies, and therefore manifest entries and network-capable code paths (FR-006), for nothing
on screen. Fewer dependencies keep the R5 allow-list short.

**Alternatives**: Capacitor or Cordova (rejected: a plugin ecosystem with its own bridge, the
opposite of a minimal audited shell); Trusted Web Activity (rejected: it runs in the user's browser
against the website, so it is neither bundled nor network-isolated); Flutter WebView (rejected: a
second runtime for no gain).

## R2 — Serving `dist/` from the package: WebViewAssetLoader on the `appassets` origin

**Decision**: The Vite build is copied at build time into the APK's `assets/www/`. A
`WebViewAssetLoader` on `https://appassets.androidplatform.net` serves it through **one custom
path handler at `/`**, which:

- maps `/` to `index.html` and every other path to `assets/www/<path>`;
- rejects any path that normalises outside `www/` (`..`, encoded separators, absolute paths);
- sets MIME types from an explicit map (`.html`, `.js` and `.mjs` → `text/javascript`, `.css`,
  `.webmanifest`, `.png`, `.wasm` → `application/wasm`), never from a guess;
- returns an explicit **404 response** for a missing file, never `null`. `null` tells WebView to
  fall through to the network, which fails without the permission, but the request should not be
  attempted at all.

`shouldOverrideUrlLoading` allows only that origin. One exception: the shared app's repository
link, matched exactly, goes to the system browser through `ACTION_VIEW`. Any other URL is dropped.
Multiple windows are off, so `target=_blank` and `window.open` create nothing.

**Rationale**: `dist/` uses root-absolute URLs (`/assets/index-*.js`,
`/assets/pdf.worker.min-*.mjs`, `/sw.js`, `/manifest.webmanifest`), confirmed from the current
`dist/` listing, so it must be served at an origin root. A secure `https` origin is what workers,
module workers, IndexedDB and service workers need, and `file://` provides none of them reliably.
The `appassets.androidplatform.net` host is reserved for this purpose, so it can never resolve to a
real server. The repository link is a fixed URL that carries no user data; handing over *any* URL
would let a modified build exfiltrate data through the browser's network access.

**Alternatives**: `file:///android_asset/` (rejected: opaque origin, no service worker, module
workers blocked); a localhost HTTP server in the app (rejected: it needs INTERNET); the stock
`AssetsPathHandler` at `/assets/` (rejected: it collides with Vite's own `/assets/` directory and
can't map `/` to `index.html`).

*Spike*: confirm that `.mjs` module workers load with the explicit MIME, and that the 404 path
issues no request.

## R3 — The content policy stays as-is, and stays off workers

**Decision**: No change. The CSP is the `<meta http-equiv>` in `index.html`, and the path handler
adds **no** response headers.

**Rationale**: Confirmed from `index.html:17`: the policy is a meta tag, so it governs documents
only. A header on worker or `sw.js` responses would govern them, which is the issue 16 lesson
(precaching and worker WASM broke), and the handler sends none. FR-005 therefore holds by
construction, and [contracts/apk-checks.md](contracts/apk-checks.md) C7 asserts that the handler
adds no `Content-Security-Policy` header.

## R4 — Service worker: route it through the same handler

**Decision**: Install a `ServiceWorkerClientCompat` (via `ServiceWorkerControllerCompat`) whose
`shouldInterceptRequest` delegates to the same asset loader. The shared `registerSW` call
(`src/main.tsx:7`) then works unchanged.

**Rationale**: WebView service-worker fetches bypass the page's `WebViewClient`. Without the SW
client, `sw.js` and its precache requests would go to the network, fail, and leave the shared app's
offline logic in a state no other distribution has. Routing them keeps SC-006 (identical
behaviour). The precache duplicates about 2.7 MB of assets into Cache Storage, a cost accepted for
identical behaviour.

**Alternatives**: Blocking registration in the shell (rejected: an Android-only behaviour change);
an Android-specific build without the PWA plugin (rejected: FR-001 requires the same build).

*Spike*: confirm the SW installs and precaches with no network request.

## R5 — No network permission, and nothing merges one in

**Decision**: Three mechanisms, each checked on the **built APK**, not on source:

1. The app manifest declares no permissions of its own, and adds
   `<uses-permission android:name="android.permission.INTERNET" tools:node="remove"/>` (and the
   same for `ACCESS_NETWORK_STATE`) so a library manifest cannot merge them back in.
2. A **dependency allow-list** (`android/dependency-allowlist.txt`) of exact Maven coordinates.
   The build fails if the resolved runtime classpath contains anything else. Gradle dependency
   verification (`android/gradle/verification-metadata.xml`) pins their checksums.
3. The release check runs `aapt2 dump permissions` on the signed APK and fails on any permission
   except one: `androidx.core`'s self-granted, signature-level
   `<applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which grants nothing outside the
   app (C1, spike S3).

**Rationale**: The 002 lesson is that a guarantee needs a mechanism, and that a deny-list is walked
past (the `got` import case). Without INTERNET the app's UID is outside the `inet` group, so the
kernel refuses socket creation: that is the enforcement. The allow-list covers FR-006 (*no
attempt*), which the permission alone does not, since a library could still try and fail. The
check on the APK catches what a source review cannot see, namely manifest merging.

**Confirmed**: the mechanism is Android's documented permission model. **Inferred**:
`androidx.webkit`, `androidx.core` and `androidx.activity` declare no network permission in their
manifests (*spike*: `aapt2 dump permissions` on the spike APK).

## R6 — What the WebView provider can still send, which the app's permission doesn't cover

**Decision**: In the manifest, `android.webkit.WebView.MetricsOptOut = true` and
`android.webkit.WebView.EnableSafeBrowsing = false`. At runtime,
`WebSettingsCompat.setSafeBrowsingEnabled(false)` is also set. The disclosure (FR-016) states
honestly what remains.

**Rationale**: This is where the claim could outrun the mechanism. The app's own UID cannot open
sockets, but the **system WebView provider** (Google's WebView or Chrome) runs separate processes
under its own UID, with its own network access. WebView usage metrics are uploaded through the
provider, not the app. The manifest opt-out is the documented per-app control. WebView crash
reports are also uploaded by the provider, gated by the device's own "usage & diagnostics" setting.
Inferred: there is no per-app opt-out, and a crash dump can contain process memory. So US2's claim
must read "the app has no network permission and opens no connection". It must **not** read
"nothing about your session can ever leave the device". The disclosure names the crash-report case
and the device setting that controls it.

**Inferred, to confirm** (*spike* plus documentation check): the exact metadata names, and whether
any per-app crash-report opt-out exists. If one exists, it is adopted.

## R7 — Saving: the shell's injected script intercepts blob downloads

**Decision**: The shared app saves by clicking a `blob:` anchor with `download`
(`src/features/signing/export.ts:4-9`, confirmed). WebView can't hand a `blob:` URL to native code,
and `connect-src 'none'` blocks `fetch(blobUrl)` even from an evaluated script. The shell therefore
injects one script at document start (`WebViewCompat.addDocumentStartJavaScript`, restricted to the
app origin) that:

- wraps `URL.createObjectURL` / `revokeObjectURL` to keep a `url → Blob` map (entries removed on
  revoke);
- wraps `HTMLAnchorElement.prototype.click`. For an anchor with `download` and a `blob:` `href`
  present in the map, it reads the Blob with `blob.arrayBuffer()` and posts `{name, mime, bytes}`
  through a `WebMessageListener` restricted to the app origin. The download is **not** passed to
  the original `click`;
- leaves every other anchor and blob untouched.

Native code opens `ACTION_CREATE_DOCUMENT` with the suggested name and MIME type, and writes the
bytes. If the user cancels, nothing is written (US1 AS5). On an `IOException` it deletes the
half-written document and shows a native message, so a partial file is never reported as saved
(edge case). A `DownloadListener` that ignores everything is also set, so nothing reaches
`DownloadManager`.

**Rationale**: Shared code stays untouched (FR-001, SC-006): the injected script is the shell's
equivalent of Electron's download handling, and of `electron/preload.js`, which already injects UI.
A `WebMessageListener` is used instead of `addJavascriptInterface` because it is restricted to an
origin allow-list, while a JavaScript interface is exposed to every frame and origin. Large PDFs
(up to 100 MB) are sent as an `ArrayBuffer` message where `WEB_MESSAGE_ARRAY_BUFFER` is supported,
and otherwise in base64 chunks of 1 MB, so no 133 MB string is built.

**Alternatives**: A `window.nativeShell.save()` seam in `export.ts` (rejected for now: it changes
shared code, against SC-006, though it would be simpler and less fragile. It is the fallback if the
spike shows prototype wrapping is unreliable, and then needs the owner's yes, because SC-006 says 0
changes); `addJavascriptInterface` (rejected: no origin restriction); `DownloadListener` alone
(rejected: it receives a `blob:` URL that native code can't read, and no file name).

*Spike*: confirm that a document-start script runs under the page's `script-src 'self'` (an
embedder-injected script is not subject to page CSP; inferred), that the suggested name arrives,
and that a 100 MB save completes.

## R8 — Picking files and the camera: `onShowFileChooser`, with no permissions at all

**Decision**: `WebChromeClient.onShowFileChooser` maps the input's `accept` to MIME types and opens
`ACTION_OPEN_DOCUMENT` (per-file grant, FR-010). The mapping uses the shared app's accept values,
confirmed in source:

| Input | `accept` | Picker MIME types |
|---|---|---|
| PDF (`App.tsx:433`) | `.pdf` | `application/pdf` |
| Signature image (`App.tsx:444`) | `image/png,image/jpeg` | `image/png`, `image/jpeg` |
| Camera (`App.tsx:455`) | `image/*` + `capture` | camera (below) |
| Certificate (`CertSheet.tsx:149`) | `.p12,.pfx` | `application/x-pkcs12`, plus `application/octet-stream` (providers label `.p12` inconsistently) |

When `FileChooserParams.isCaptureEnabled()` is true, the shell sends `ACTION_IMAGE_CAPTURE` with an
output URI from a non-exported `FileProvider` (`grantUriPermissions`, a single `cache/capture/`
path, and the file deleted at the next chooser, when the activity is destroyed, and on every
launch; not at hand-over, because WebView reads the URI lazily). The app declares **no CAMERA
permission**: a camera-app intent needs none, *unless* the app declares CAMERA, in which case the
intent requires it to be granted. If no camera app exists or the user backs out, the callback gets
`null` and the image file picker still works (FR-011). The shared app's limits apply because
WebView hands it an ordinary `File` (FR-002).

**Rationale**: Zero runtime permissions is the strongest form of FR-010. Cancelling must always call
the callback with `null`, otherwise WebView never opens a chooser again.

*Spike*: picker and capture round trip, cancellation, and a `.p12` showing up in the picker.

## R9 — Hide content: FLAG_SECURE always

**Decision**: `window.setFlags(FLAG_SECURE, FLAG_SECURE)` in `onCreate`, before the content view.
On API 33+ also `setRecentsScreenshotEnabled(false)`.

**Rationale**: FR-023. FLAG_SECURE blanks screenshots, screen recording, casting to non-secure
displays and the recents thumbnail. It doesn't affect the accessibility tree, so the adb-driven gate
(R13) still works. The check: `adb exec-out screencap` of the running app is entirely black (C8).

## R10 — Backup and device transfer: excluded through both mechanisms

**Decision**: `android:allowBackup="false"`, `android:fullBackupContent="@xml/backup_rules"`
(excludes every domain, for API 26–30), and `android:dataExtractionRules="@xml/data_extraction_rules"`
whose `<cloud-backup>` **and** `<device-transfer>` sections each exclude every domain (`root`,
`file`, `database`, `sharedpref`, `external`, and the `device_*` variants).

**Rationale**: Android's documentation says that for apps targeting Android 12 (API 31) and later,
`allowBackup="false"` disables cloud backup but **does not** disable device-to-device transfer; only
`dataExtractionRules` controls that. A plan that set `allowBackup` alone would make US3 AS1 false on
every current phone. The remembered certificate lives in WebView's IndexedDB under the app data
directory, so excluding all domains covers it without naming WebView internals.

**Evidence plan**: cloud backup is checked behaviourally on the emulator (`bmgr` with the local
transport: run a backup and confirm the package contributes no data). The emulator **can't** run a
device-to-device transfer, so that half is checked by mechanism (the merged manifest and the rules
file, C5). A behavioural D2D test needs two physical phones and the owner (quickstart Q9). SC-004 is
therefore partly inferred until Q9 runs, and the plan says so.

## R11 — WebView engine floor: refuse below the hard minimum, warn below the validated floor

**Decision**: Two numbers, both checked natively from
`WebViewCompat.getCurrentWebViewPackage().versionName` before the page loads:

- **Hard minimum = major 119.** Below it the shell shows a native screen explaining that the
  system web view is too old, how to update it, and that nothing was loaded. It never loads the
  app. This is the spec's "refuse to run below it" edge case.
- **Validated floor = the WebView major the release gate ran on** (recorded per release in the
  build). From 119 up to the validated floor, the app runs, and a native, non-blocking notice says
  that this engine version was not validated. This is FR-017 and the constitution's "warn
  locally".

There's no network request in either case: the version is read from the package manager.

**Rationale**: Confirmed from the current `dist/`: `Promise.withResolvers` is used without a
polyfill in both bundles (40+ call sites, from pdf.js), and Chromium shipped it in **119**. Below
119 the app fails at startup, so refusal is honest rather than cautious. The two numbers keep apart
"can't work" and "not proven", which the spec's edge case and FR-017 had blurred together. Devices
on Android 8+ with Play services get WebView updates through the store. Devices without them may be
stuck below 119, and are refused with an explanation.

**Alternatives**: Bundle a polyfill (rejected: it changes the shared build for one distribution);
a single floor (rejected: either it refuses working devices, or it hides that they were never
validated).

## R12 — Package signing: CI signs from an environment secret

**Decision**:

- The owner creates the key **once** with `keytool` (RSA 4096, validity 30 years, a PKCS12
  keystore) on his own machine, keeps an offline backup, and records the certificate's SHA-256
  fingerprint in `android/SIGNING_FINGERPRINT` (public).
- The keystore (base64) and its passwords go into a **GitHub Environment** `android-release`, as
  environment secrets. The environment allows deployments from `v*` tags only. Only the Android
  release job names that environment, so no other job, branch or pull-request workflow can read the
  secrets.
- The job writes the keystore to `$RUNNER_TEMP` (outside the workspace, so it can't be uploaded as
  an artifact or committed). It signs with `apksigner sign --v2-signing-enabled true
  --v3-signing-enabled true`, passing passwords as `--ks-pass env:…`, never on the command line.
  It deletes the keystore in an `if: always()` step. Then `apksigner verify --print-certs` must
  match `android/SIGNING_FINGERPRINT` (C3).

**Rationale**: FR-021 says "available to the release job only", and a plain *repository* secret
doesn't do that: every workflow on the repository can read it. An environment with a tag rule is
the mechanism. v3 signing enables key rotation later through a signing lineage, if the key ever has
to change. That needs the old key, which is what the offline backup is for.

**Alternatives**: Owner signs locally and uploads (rejected by the owner, 2026-11-07); Play App
Signing (out of scope, no store).

## R13 — The release gate runs on the shipped, signed APK

**Decision**: `scripts/android-gate.mjs` drives the **signed release APK** on an emulator, with no
test APK and no debug build:

1. Install the APK and enable airplane mode before the first launch.
2. `adb push` the fixture PDF, signature image and test `.p12` into `Download/`.
3. Drive the UI with `adb shell uiautomator dump` (read the accessibility tree) and
   `adb shell input tap` / `input text`. The same works in the system picker and save dialog.
4. Sign once, `adb pull` the result, then open it again and counter-sign, and pull again.
5. Run `scripts/validate_pdf.py` on both files (integrity and modification policy, the same
   validator as `verify:signatures`).
6. Read the per-UID network statistics (`dumpsys netstats`): 0 bytes for the app UID (SC-003).

In CI the gate runs on `ubuntu-latest` with KVM, using a pinned emulator action and the API 36
`google_apis` x86_64 image. The image's WebView version becomes the release's validated floor
(R11).

**Rationale**: Principle V requires output from the artifact being shipped. A debug or
"gate variant" build would be a different artifact, and WebView DevTools (the usual driver) needs
`setWebContentsDebuggingEnabled(true)`, which the release build must not have (C6). The
accessibility tree is unaffected by FLAG_SECURE, and works across apps, including DocumentsUI.

**Alternatives**: Espresso-Web (rejected: the instrumentation APK must share the app's signature,
which puts the signing key in the test path); a DevTools-enabled build (rejected: wrong artifact).

**Driver rules** (spike S9, confirmed): dump twice after a launch, since the first dump can show
the WebView with no children; and tap only from a fresh dump, by resource id where one exists
(`android:id/button1` is the save dialog's SAVE), because positions shift when the keyboard closes.

**Risk, named**: driving through `uiautomator dump` is the most fragile part of the plan, since it
depends on the system picker's layout. If the spike finds it unreliable, the fallback is a
UI Automator instrumentation test, which can drive other apps without sharing the target's
signature, at the cost of a test APK in CI.

## R14 — Windows-local quirks

- **Confirmed**: `emulator.exe -accel-check` mis-splits the SDK path at the space in
  `Kurt Valcorza` and prints "Unknown argument", though it still reports WHPX usable. Locally, run
  the emulator through the 8.3 short path (`C:\Users\KURTVA~1\...`), or set `ANDROID_AVD_HOME` to a
  path without spaces on `C:`. Never on `D:`.
- **Confirmed**: the CLI's first component download failed from the agent shell with "Unable to
  establish loopback connection" and succeeded from the owner's terminal. Later downloads worked
  from both. Cause not isolated. If it recurs, run that one command in a normal terminal.

## R15 — Versioning and identity

**Decision**: `applicationId` = `io.github.kurtvalcorza.pdfsigner`. `versionName` = `package.json`
`version`, and `versionCode` = `major*10000 + minor*100 + patch` (0.1.1 → 101). `minSdk` 26
(Android 8.0, spec assumption), `targetSdk` and `compileSdk` 36.

**Rationale**: The application ID and signing key can never change without breaking updates (US5
AS2), so they are fixed before the first release. Deriving the version from `package.json` keeps
the release aligned with the web and desktop builds (FR-019).

## R16 — Lessons carried in

| Source | Lesson | Where it lands |
|---|---|---|
| 002 | A claim needs a mechanism | R5 (APK check, not source), R6 (provider uploads disclosed), R10 (D2D half inferred, said so), R12 (environment, not repo secret) |
| 002 | Fix the claim everywhere | The spec's Dependencies and Spike assumption now describe the working CLI; the plan's claims are checked against research in the post-design re-check |
| 002 | Allow-list, not deny-list | R5 dependency allow-list |
| 002 | Any shell-only branch in signing voids the design | R7 intercepts only the *save* after signing; the signing path is untouched (C9 diff check) |
| Issue 16 | CSP must not govern workers | R3: no headers from the handler |
| Issue 16 | Input limits, render guards, certified-PDF refusal | Carried unchanged because the shared build is unchanged; the gate checks certified refusal (quickstart Q4) |
| Issue 16 | Release asset names | The APK name has no spaces: `pdf-signer-<version>.apk` |

---

## Spike findings (Q1, run 2026-11-07/08)

The spike was a debug build of the plan's shell, built from the `bbfa0f7` `dist/`, on the
`medium_phone` AVD: Android 16 (API 36), `google_apis_playstore` x86_64, system WebView
**133.0.6943.137**, software GPU. Airplane mode was on from before the install. Driven only through
`uiautomator dump` + `input`.

| # | Item | Result | Evidence |
|---|---|---|---|
| S1 | **Sign + counter-sign validate** (FR-022, C10) | ✅ **PASS** | `validate_pdf.py`: signed sig[0] integrity ✅, policy ✅, modification NONE, entire file; counter-signed sig[0] FORM_FILLING (allowed) and sig[1] NONE, entire file; `RESULT: PASS`, exit 0. Trust is false (self-signed e2e cert), as in the web gate |
| S2 | R5: no network permission | ✅ confirmed | `aapt2 dump permissions`: no INTERNET or network permission in the merged APK. With the network **up** (the shell's ping replied), `nc` run as the app UID fails with `socket: Operation not permitted`, so the kernel enforces it. `dumpsys netstats`: 0 traffic records for the app UID |
| S3 | R5: what libraries merge in | ⚠ two additions | `androidx.core` adds a self-granted, signature-level `<pkg>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. `androidx.profileinstaller` (via activity) adds `ProfileInstallReceiver` with `exported=true`, guarded by `android.permission.DUMP`. `androidx.startup`'s `InitializationProvider` is `exported=false`. C1 and C4 as written would fail on the first two |
| S4 | R2: serving | ✅ confirmed | The `.mjs` pdf.js worker loads with the explicit MIME. The one miss in two launches was `favicon.ico` → explicit 404. 0 off-origin requests and 0 blocked navigations logged |
| S5 | R4: service worker | ✅ confirmed | `app_webview/Default/Service Worker/CacheStorage` = 1,440 KB after first launch, against a precache of 1,330.62 KiB, so it installed and precached through the handler with no network |
| S6 | R7: save interception | ✅ confirmed | The document-start script ran under the page's `script-src 'self'` ("SHELL injected"). The `download` name arrived (`sample-signed.pdf`, then `sample-signed-signed.pdf`), sent as one ArrayBuffer (11,764 and 29,861 bytes), and written through `CREATE_DOCUMENT`. `DownloadListener` never fired. **Not tested**: a 100 MB save, cancel, a failed write |
| S7 | R8: pickers | ✅ for PDF, image, `.p12` | `accept` arrived as `[.pdf]`, `[image/png, image/jpeg]`, `[.p12, .pfx]`. All three picked through DocumentsUI with `allowContentAccess=false`. **Not tested**: camera capture |
| S8 | R9: FLAG_SECURE | ✅ confirmed | `screencap` with the app open: 0 non-black pixels of 1,350 sampled. The accessibility tree is still fully readable |
| S9 | R13: adb driver | ✅ works, with two rules | It drove the app, the picker and the save dialog. (a) The first dump after launch can show the WebView with no children, so dump twice. (b) Positions shift when the keyboard closes, so always tap from a fresh dump, by resource id where one exists (`android:id/button1` for SAVE) |
| S10 | R1: toolchain | ✅, with notes | Kotlin is built into AGP 9.0.1 (no Kotlin plugin; it compiled). The CLI template targets SDK 37 and tried `platforms/android-37`, whose package is `android-37.0`. AGP installed `build-tools/36.0.0` on its own. `android emulator create medium_phone` chose and downloaded `google_apis_playstore` unasked. The first Gradle run took ~10 min (downloads), later runs 20 s |
| S11 | Copy | ⚠ shared text | The remember-signature checkbox says "kept in this browser", which is inaccurate in the app and on desktop alike. Fixing it is a wording change for every distribution, not an Android branch |

**Consequences, approved by the owner on 2026-11-08 and applied** to the contracts, plan, data
model and R5/R13:

1. **S3, C1**: allow exactly one permission, the app's own
   `<applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` with signature protection, and fail on
   anything else. Alternatively remove it with `tools:node="remove"`. The shell registers no
   receivers, but core may use it internally. Recommended: allow it explicitly, since it grants
   nothing outside the app.
2. **S3, C4**: remove `ProfileInstallReceiver` with `tools:node="remove"`, keeping the launcher as
   the only exported component. It only speeds up first launch through baseline profiles.
3. **S11**: the shared label is now "Remember this signature on this device (image only)". The
   "kept on this device" wording would have repeated "on this device", so the browser clause was
   dropped. It is a neutral fix, made as its own commit.
4. **S9** goes into `android-gate.mjs` as fixed rules. The remaining untested items (100 MB save,
   cancel, camera, certified refusal, backup, engine floor) become gate and quickstart tasks
   (Q3–Q8), not spike work.

## US1 gate, local (T027, run 2026-11-08)

`scripts/android-gate.mjs` against the production shell in `android/`, built with
`npm run build:android` and signed with a **throwaway local test key** created in the session
scratchpad (`CN=PDF Signer LOCAL TEST KEY - not for release`; never the release key, never in the
repository). The APK under test had SHA-256 `E92FF7B9…1369511`. AVD `medium_phone`, API 36
`google_apis_playstore` x86_64, 2 GB RAM, WebView 133.0.6943.137, with airplane mode on before
installing.

| Case | Result | Evidence |
|---|---|---|
| Static (pre-C1/C4) | ✅ | `aapt2 dump permissions`: only `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, declared at signature level. The launcher is the only exported component (`ProfileInstallReceiver` removed, both providers `exported=false`). `versionCode=101`, `versionName=0.1.1`. `assets/www` holds all 10 `dist/` files |
| Unit tests | ✅ 30/30 | `PathRulesTest` 8, `SaveRulesTest` 18, `AcceptRulesTest` 4 (`testDebugUnitTest`; AGP 9 creates no release unit-test task) |
| C2 | ✅ | `verifyDependencyAllowlist` resolves 36 coordinates, all allow-listed; `verification-metadata.xml` covers 350 components, and a `--rerun-tasks` release build passes it |
| T016 smoke | ✅ | Offline first launch shows the start screen. The only miss is `favicon.ico` → 404, with no 403s. `Service Worker/CacheStorage` holds 1,440 KB (checked on a debug build of the same code, since `run-as` refuses the release build) |
| C10 sign + counter-sign | ✅ PASS | `sample-signed.pdf` (11,764 B): integrity, policy, `ModificationLevel.NONE`. `sample-signed-signed.pdf` (29,861 B): sig[0] `FORM_FILLING`, sig[1] `NONE`; trust=False because the e2e certificate is self-signed |
| AS4 wrong password | ✅ | "Incorrect certificate password." shown; no `SAVE begin` in the log and no save dialog |
| AS5 cancel | ✅ | `SAVE cancelled`; no "Saved"; no new file in `Download/` |
| AS3 / C11 certified | ✅ | `certified-p1.pdf` shows the shared "cannot be signed here" message; certificate signing isn't offered |
| R7 `--large-mb 25` | ✅ PASS | 26,224,591 B in, 26,234,451 B saved through `CREATE_DOCUMENT`, byte count matches the shell log, validator PASS |
| R7 `--large-mb 50` and `95` | ❌ renderer OOM | The WebView renderer dies while the **shared engine signs** (before any save message): `Renderer process … crash detected (code 5)`. 95 MiB also fails on the same AVD at 4 GB RAM (MemTotal 4,013,808 kB), so it's a renderer limit, not device RAM |

**Finding G1 (shell, fixed)**: before the fix, a renderer crash took the whole app down
(`crash wasn't handled by all associated webviews`), which breaks the spec edge case "they must fail
with a message, not a crash". `MainActivity.onRenderProcessGone` now drops the dead WebView,
recreates the activity and shows "The app ran out of memory … Nothing was saved." The gate reports
that state separately from a crash.

**Finding G2 (open, owner decision)**: on this AVD the shared signing engine can't sign a PDF near
the 100 MB limit inside the WebView renderer; the ceiling is between 25 and 50 MiB. No test in this
repository has signed a near-100 MB PDF on any distribution (`sec-limits-render.spec.ts` checks only
that oversized inputs are refused), so this may not be Android-specific. Fixing it means changing the
shared engine's memory use, which SC-006 keeps out of this feature. T026's "~100 MB" acceptance is
therefore not met; the gate's `--large` defaults to 95 MiB and fails with the reason.

**G2 measurement (2026-11-08, owner asked to measure desktop first)**: the same shared engine in
desktop Chromium (Playwright, dev build) signs the identical 95 MiB fixture in 6.3 s and the
output passes `validate_pdf.py`; 50 MiB signs in 4.3 s. The probe was a temporary spec, deleted
afterwards. On the Android WebView, 37 MiB also runs out of memory, so the ceiling on this AVD is
between 25 and 37 MiB. The limit belongs to the Android WebView renderer, an isolated process
whose memory the app can't raise (`largeHeap` affects only the app process). It isn't a defect in
the shared engine that also shows up on desktop.

**G2 decision (owner, 2026-11-08)**: investigate the shared engine's peak memory in a **separate
feature**, not in 003 (it would change shared code; SC-006). Until then the Android gate's
`--large` runs at 25 MiB, which passes. The US2 disclosures (T033, T043) state the Android ceiling.

## US2 checks, local (T034, run 2026-11-08)

Same AVD and test key as the US1 run. The APK under test had SHA-256 `75A88779…EDBE4AF2`, floor 133.

| Quickstart | Result | Evidence |
|---|---|---|
| Q2 static (`android-check-apk.mjs`) | ✅ C1 C3 C4 C5 C6 C7 C9 | C1: one permission, signature level (`0x2`). C3: v2+v3 verified; the fingerprint isn't pinned until T041. C5: cloud-backup, device-transfer and full-backup-content each exclude all 9 domains (resource IDs resolved through `aapt2 dump resources`, since release paths are shortened). C7: 11/11 `dist/` files match by SHA-256. C9: one shared-path commit, `7676207` (neutral label fix), with no shell mentions |
| Q2 negative controls | ✅ fail as expected | Debug APK + tampered `dist/` + wrong fingerprint → C3 (v3 missing, or fingerprint mismatch), C6 (debuggable), C7 (`differs index.html`, `missing extra.txt`). A colon-separated fingerprint is accepted |
| Q5 / C12 network on | ✅ 0 records | Airplane mode off, sign + validate, `dumpsys netstats --poll` then `detail`: 0 traffic records for the app UID. Positive control: the same parser finds records for UIDs 1000, 1051, 10101 and others. Settings → Apps → PDF Signer shows "No permissions requested" and "Mobile data usage: No data used" |
| Q6 / C8 content hidden | ✅ | Screencap with a document open: 0 of 1,458 grid samples are non-black. Positive control: the launcher gives 1,458/1,458. The recent-apps card for the app is solid black (checked by eye) |
| Q7 REFUSED | ✅ | `pm disable-user` on the provider → `engine=REFUSED reason=DISABLED`, the native screen shows, and there's no WebView in the tree. The provider was re-enabled afterwards |
| Q7 UNVALIDATED | ✅ | Temporary local build with `VALIDATED_WEBVIEW=999` (restored to 133, never committed) → `engine=UNVALIDATED`, the banner shows, and sign + counter-sign still pass C10 |
| About panel | ✅ | Every contract §5 item is on screen, plus the 25 MB Android ceiling (G2). `AboutInfoTest` asserts each item |

**Findings fixed during the run:**

- **G3, Q7:** `WebViewCompat.getCurrentWebViewPackage()` returns the provider already loaded, which still reads as enabled after `pm disable-user`, so the app loaded a blank WebView. MainActivity now reads the live `getApplicationEnabledSetting` (readable here: `1`, then `3`), and falls back to the loaded package's flag only if that can't be read.
- **G4, edge-to-edge:** targetSdk 36 forces edge-to-edge, so the page drew under the status bar, and a tap on the shell's About button (y=62) landed on the system bar. The WebView now sits in a container inset by the system bars, display cutout and keyboard, as in a browser. The About button moved to y=125, and the shared app's top row is no longer under the status bar.

## US3 and US4 checks, local (T035, T038, run 2026-11-08)

Same AVD (WebView 133.0.6943.137) and test key. The APK under test had SHA-256 `cc25fc2c…e7119fa1`.
One gate run, `--skip-negative --camera --backup`, passed end to end. `android-check-apk.mjs`
passed C1 C3 C4 C5 C6 C7 C9 on the same APK: still one permission, and no `CAMERA`.

| Check | Result | Evidence |
|---|---|---|
| US3 positive control | ✅ | After ticking "Remember this certificate" and signing, a fresh launch shows `e2e-cert.p12` with a Forget button. Without this, the checks below would prove nothing |
| US3 AS1, cloud half | ✅ | `bmgr` local transport, `backupnow` → `Package io.github.kurtvalcorza.pdfsigner with result: Backup is not allowed`. Positive control on the same transport: `com.android.providers.settings` → `Success`. The emulator's backup state is restored afterwards |
| US3 AS2 Forget | ✅ | After Forget, a fresh launch shows nothing remembered |
| US3 AS3 uninstall | ✅ | Remember again, uninstall, reinstall: nothing remembered |
| US3 D2D half | by mechanism | `data_extraction_rules` `<device-transfer>` excludes all 9 domains (C5). Behavioural check is T036 [OWNER] |
| US4 AS1 | ✅ | Take photo → the emulator's camera app (`com.android.camera2`) → shutter → Done. The shell hands over 64,107 bytes; Clean up background → Use cleaned → sign, and the output passes `validate_pdf.py`. Page-1 image XObjects (pyHanko reader): 0 in `sample.pdf`, 1 (1440×1920) in the output |
| US4 AS2 | ✅ | Back out of the camera → `CHOOSER capture cancelled`, nothing placed, and "Add signature" picks `signature.png`. A second Take photo opens the camera with no permission prompt. No prompt naming PDF Signer appeared at any point |
| US4 AS3 | ✅ | The virtual camera can't exceed 40 MP, so a pushed PNG whose header claims 8000×6000 (48 MP) goes through "Add signature", which uses the same `readImageFile` as the camera input. The app refuses it with "This image is too large. The limit is 40 megapixels." and places nothing |

**Notes:**

- WebView's accessibility tree reports every checkbox as `checked="false"`, so the gate can't read
  the Remember box. Its effect is checked instead (the positive control above).
- **Capture file deletion, claim corrected:** the data model said the photo is deleted "once it's
  handed to WebView". WebView reads a chooser URI lazily, when the page reads the file, so deleting
  it at hand-over would race that read. As built, it's deleted at the next chooser, when the
  activity is destroyed, and with all of `cache/capture/` on every launch. The data model,
  contract §6, R8 and T037 now say so. The deletion itself isn't observed: release builds refuse
  `run-as`, so the app's cache isn't readable from adb.
- A gate bug found on the way: a previous case's `sample-signed.pdf` made the save dialog write
  `sample-signed (1).pdf`, and the gate pulled the stale file. Its byte-count check caught it. The
  gate now deletes the target name before each save.
