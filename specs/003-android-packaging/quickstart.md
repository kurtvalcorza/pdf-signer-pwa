# Quickstart: validating the Android app (003)

Run guide, not an implementation. Mechanisms are in [research.md](research.md), interfaces in
[contracts/](contracts/), checks in [contracts/apk-checks.md](contracts/apk-checks.md).

## Prerequisites

- Toolchain as confirmed in research.md (Android CLI, JDK 21, SDK with platform 36, build-tools
  36.1.0, platform-tools, emulator, the API 36 `google_apis` x86_64 image, WHPX).
- `npm ci && npm run build` (produces `dist/`).
- Python validator: `pip install --require-hashes -r scripts/requirements-verify.txt`.
- Fixtures: `node scripts/make-e2e-fixtures.mjs` (sample PDF, signature image, test `.p12`) and the
  certified fixture from `tests/signing/fixtures/policy/`.
- An AVD on API 36 `google_apis` x86_64. On this Windows machine, launch the emulator through the
  8.3 short path, or with `ANDROID_AVD_HOME` set to a path without spaces on `C:` (R14).

## Q1 — The spike (FR-022): do this first, then STOP for review

Throwaway. It lives in `spike-android/`, listed in `.git/info/exclude` so it can't be committed,
and is deleted once its findings are written into research.md.

1. Scaffold with `android create empty-activity`, strip Compose, and add only `androidx.webkit`,
   `androidx.activity` and `androidx.core`.
2. Implement just enough of [contracts/shell-bridge.md](contracts/shell-bridge.md): the path
   handler and SW client, the injected save interception, the file chooser, FLAG_SECURE, and the
   manifest from R5, R6 and R10. No engine check, no About panel.
3. Copy `dist/` into the spike's `assets/www/` and build a debug-signed APK.
4. `aapt2 dump permissions` → **no permissions** (proves R5's inference about library manifests).
5. Boot the emulator, enable airplane mode **before** installing, install, and launch.
6. Push the fixtures to `Download/`. Drive the flow with `uiautomator dump` + `input` (the R13
   driver, proving it works): open the PDF, place the signature, sign with the `.p12`, and save.
7. Re-open the saved PDF, counter-sign and save again. `adb pull` both.
8. `python scripts/validate_pdf.py <signed>.pdf <countersigned>.pdf` → integrity and policy pass.
9. Record, as findings: the WebView version; whether the SW installed; whether the `.mjs` worker
   loaded; whether the injected script ran under the page CSP; whether the file name arrived;
   whether `screencap` is black; any request the 404 path or the SW triggered; and whether the
   `uiautomator` driver could operate the system picker and save dialog.

**Stop here.** Report the findings with evidence and wait for the owner's review before Phase 2
(`/speckit-tasks`) or any production code. A finding that overturns R7 (the save interception) or
R13 (the gate driver) is a decision for the owner (see plan.md, Open decisions).

## Q2 — Release APK checks (static)

`node scripts/android-check-apk.mjs <signed.apk> --dist dist` → C1–C7 and C9 pass, and each prints
its evidence.

## Q3 — Sign and counter-sign on the shipped APK

`node scripts/android-gate.mjs <signed.apk>` with airplane mode on from first launch → C10 passes.
Expected: two PDFs pulled, both validating on integrity and policy (US1 AS1–AS2, SC-002).

## Q4 — Refusals carry over

In the same gate run: the certified fixture is refused for certificate signing (C11, US1 AS3), a
wrong password shows the shared app's message and saves nothing (US1 AS4), and cancelling the save
dialog writes nothing and shows nothing (US1 AS5).

## Q5 — No network, even with a network

Turn airplane mode off, run Q3 again, then `adb shell dumpsys netstats detail` for the app UID →
0 bytes (C12, US2 AS1–AS2, SC-003).

## Q6 — Content hidden

With a document open, `adb exec-out screencap -p > s.png` → the app window is black. The recents
thumbnail is blank (C8, FR-023).

## Q7 — Engine floor

On an AVD whose WebView is below the validated floor but at least 119: the notice appears and
signing still works. Below 119, or with WebView disabled (`adb shell pm disable-user` on the
provider): the refusal screen appears and the web app never loads (R11).

## Q8 — Remembered items and cloud backup

Opt in to remembering the certificate. Then
`adb shell bmgr transport com.android.localtransport/.LocalTransport` and
`adb shell bmgr backupnow io.github.kurtvalcorza.pdfsigner` → the package contributes no backup data
(US3 AS1, cloud half). Choose Forget → the item is gone (US3 AS2). Uninstall and reinstall →
nothing remains (US3 AS3).

## Q9 — Device-to-device transfer (owner, two physical phones)

The emulator can't run this. Set up a new phone from an old one that has the app with a remembered
certificate: the app either doesn't transfer, or transfers with no remembered items (US3 AS1, D2D
half). Until this runs, SC-004 rests on the mechanism alone (C5), and release notes must not claim
more.

## Q10 — Verify before installing (US5)

Following `docs/android.md`: `sha256sum -c SHA256SUMS`, `gh attestation verify
pdf-signer-<version>.apk --repo kurtvalcorza/pdf-signer-pwa`, and `apksigner verify --print-certs`
→ the fingerprint equals `android/SIGNING_FINGERPRINT`. Under 5 minutes (SC-005). Installing the
next release over this one keeps remembered items (US5 AS2, SC-007).
