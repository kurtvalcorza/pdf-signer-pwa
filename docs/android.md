# PDF Signer — Android app

The Android app is the **same web app** as the PWA and the desktop builds. It ships inside the APK
and runs in the phone's system WebView. A small native shell adds only what WebView can't do on its
own: opening files, saving the signed PDF, and taking a photo of a signature. Signing runs in the
shared engine without changes, so an Android signature comes from the same code that the web unit
tests and the pyHanko gate check.

- **File**: `pdf-signer-<version>.apk`, attached to the same GitHub release as the web and desktop
  builds and built from the same commit.
- **App ID**: `io.github.kurtvalcorza.pdfsigner`.
- **Android**: 8.0 (API 26) or later, with Android System WebView 119 or later.

## Installing from outside the store

The app is **not on the Play Store**. You install the APK yourself, so Android asks you to allow the
app you opened it from (a browser or file manager) to install unknown apps. That warning is
expected. Check the download first (see *Verifying a download* below), allow the
install for that one app, and turn the permission off again afterwards if you prefer.

## No network permission

The app declares **no network permission**, so Android doesn't let it open network connections. To
check on your phone, open Settings → Apps → PDF Signer: under Permissions it says *"No permissions
requested"*. The release gate also signs a PDF with networking turned on and checks that Android
recorded no traffic for the app.

What that does **not** cover: the system WebView is a separate app with its own network access.
PDF Signer turns off WebView usage metrics and Safe Browsing for itself. WebView **crash reports**,
though, are sent by the WebView app according to your phone's *usage & diagnostics* setting (on
most phones under Settings → Google; the place varies by maker), and PDF Signer has no switch of its
own that turns them off. A crash report can contain memory from the crashed process. If that matters to you, turn
usage & diagnostics off.

## The engine depends on your phone

The app does not bundle its own engine. It runs in the phone's **Android System WebView**, which
updates with the phone (through the Play Store or system updates), not with this app. How the app
behaves therefore depends on the device.

- **Hard minimum: WebView 119.** On anything older, or if WebView is turned off or missing, the app
  shows a screen saying why and **never loads the web app**. Update Android System WebView or turn
  it back on, then open the app again.
- **Validated floor: the version in `android/VALIDATED_WEBVIEW`** (133 for this release). The
  release gate ran on that WebView version. Between the minimum and the floor, the app works but
  shows a notice that this engine was not tested. The notice needs no network, and it goes away once
  WebView is updated.

The app's **About** panel shows the app version, the source commit and the WebView version it's
running on.

## Screenshots are blocked

Screenshots, screen recording and the recent-apps preview are **blocked the whole time the app is
open** (Android's `FLAG_SECURE`), so a document, certificate or password can't end up in a
screenshot or in a screen share. Screenshots taken in the app come out black. To look at or share a
signed PDF, open the saved file in another app.

## Large files

PDFs above about 25 MB may fail to sign on Android because of the system WebView's memory limit.
The app says so and nothing is saved. Use the web or desktop version for those files.

## Remembered items and uninstalling

Remembering a certificate or a signature is opt-in, exactly as in the web app. Both stay in this
app's private storage on this phone:

- they are **excluded from backups and from transfer to a new phone**;
- **Forget** deletes the item;
- **uninstalling the app deletes everything it stored.**

Your password and the decrypted key are never stored. A photo taken for a signature stays in the
app's cache only while it's in use, and is deleted at the latest the next time the app starts.

## No self-update

The app **does not update itself**, and it can't check for updates because it has no network
access. To update it, download a newer APK from the releases page, verify it, and install it over
the old one. Your remembered items are kept.

An update installs over the old version only if **both are signed with the same key**. Every
release is signed with the project's one release key, so updates just work. If Android refuses with
*"App not installed"* and says the package conflicts with an existing one, the APK you have was
signed with a different key: it is **not** from this project's releases. Don't install it. Removing
the old app to make room for it would also **delete your remembered certificate and signature**.

Security fixes reach you only when you install a newer release. Web, desktop and Android share one
release train, cut from one commit each time.

## Verifying a download

Don't take the release page's word for it; check the file yourself:

```bash
# 1. Checksum (the same SHA256SUMS file covers the web, desktop and Android files)
sha256sum -c SHA256SUMS --ignore-missing

# 2. Build provenance: which workflow built it, and from which commit
gh attestation verify pdf-signer-<version>.apk \
  --repo kurtvalcorza/pdf-signer-pwa \
  --signer-workflow kurtvalcorza/pdf-signer-pwa/.github/workflows/release-desktop.yml \
  --source-digest <expected-commit-sha>

# 3. Signing key: the certificate must be the project's release key
apksigner verify --print-certs pdf-signer-<version>.apk
```

`apksigner` comes with the Android SDK build-tools. Compare the line `Signer #1 certificate SHA-256
digest:` with [`android/SIGNING_FINGERPRINT`](../android/SIGNING_FINGERPRINT) in the repository.
`apksigner` prints the digest in lowercase with no colons, while the file uses the uppercase,
colon-separated form from `keytool`, so convert one before comparing:

```bash
tr -d ':' < android/SIGNING_FINGERPRINT | tr 'A-F' 'a-f'
```

The attestation proves *what built* the APK. The signing key proves *who released it*, and it is
what Android checks when you install an update. Pin both `--signer-workflow` and `--source-digest`:
`--repo` on its own only proves that *some* workflow in this repository built the file.
