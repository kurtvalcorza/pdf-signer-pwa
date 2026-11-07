# Feature Specification: Native Android App (Offline, Bundled)

**Feature Branch**: `003-android-packaging`

**Created**: 2026-11-07

**Status**: Draft

**Input**: User description: "003-android-packaging: a native Android distribution of PDF Signer, as a third distribution beside the web PWA and the portable desktop builds. A minimal shell hosts the UNCHANGED web build in a WebView, served from inside the APK (no server, works fully offline). The app should not request the INTERNET permission, so network isolation is enforced by the OS. Native code is limited to what WebView cannot do: picking PDFs, images and .p12 files, saving the signed PDF, and the camera for signature capture. The signing engine stays shared and unmodified; any Android-only branch in the signing path is forbidden. Opt-in persistence must keep its consent and truthful-deletion guarantees. Distribution: a signed APK attached to the GitHub release from the same commit as the web and desktop builds, with checksums and build provenance; the app never updates itself; Kurt holds the signing key. Validator evidence is per-distribution: a PDF signed by the installed APK must validate in pyHanko, including counter-signing. First deliverable after the spec and plan is a throwaway spike that proves exactly that."

## Overview

PDF Signer already installs on Android as a web app through the browser. This feature adds a
**third distribution**: an installable Android app package that carries the same application inside
it, so it works with no network at all from the first launch, never depends on the website, and is
barred by the operating system itself from opening network connections.

It is additive. The web app stays the primary distribution and is unchanged, as are the desktop
builds. The Android app runs the **same** application code, including the same signing engine, and
adds only a thin layer for the things the embedded browser view cannot do on its own: opening files
from the device, saving the signed result, and taking a photo of a signature.

Who it is for: people who sign on an Android phone and want a self-contained app that cannot reach
the network, without trusting a website to keep serving the same code.

## Constitutional Impact — ✅ RESOLVED (amended to v1.2.0 on 2026-11-07)

The constitution v1.1.0 named two distributions and required an amendment for any other. The owner
approved a MINOR amendment on 2026-11-07, and v1.2.0 names this one. It states the obligations below
per principle and leaves the mechanisms to this spec and its data model:

- **Principle I (network)**: the Android distribution's strongest available prohibition is the
  operating system's permission model, on top of the retained content policy. Both must apply.
- **Principle II (installable)**: "installable" for Android means a self-contained app package,
  installed without the store, that needs no network to run.
- **Principle IV (disclosure)**: unlike desktop, this distribution does **not** bundle its browser
  engine. It runs on the device's system web view, which the operating system updates. Its distinct
  weaknesses are different: it is installed from outside the store, it never updates itself, and its
  engine version depends on the device. Each must be disclosed.
- **Principle V (evidence)**: the release gate must run against output produced by the Android
  artifact itself.
- **Principle VI (data)**: on-device stores now include app-private storage, which the platform can
  copy off the device through backup and device-to-device transfer unless the app forbids it.

## Clarifications

### Session 2026-11-07

- Q: How is the constitution amended for a third distribution? → A: A MINOR amendment to v1.2.0
  that names Android and states its obligations per principle; mechanisms stay in this spec.
- Q: Should the app hide its content from screenshots and the recent-apps view? → A: Yes, always,
  for the whole app (FR-023).
- Q: Who signs the package and where does the key live? → A: The release job signs it using a key
  the owner creates once and stores as an encrypted repository secret, available to the release job
  only, with an offline backup the owner keeps (FR-021).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign a PDF on an Android phone with no network (Priority: P1)

A person installs the app package, turns on airplane mode, opens a PDF stored on the phone, places
their signature image, signs it with their `.p12` certificate, and saves the signed PDF back to the
phone. Nothing about the experience differs from the web app except how files are opened and saved.

**Why this priority**: This is the whole reason the distribution exists. Without it nothing else
matters.

**Independent Test**: On a phone or emulator with every network disabled from first launch, sign a
sample PDF with a test certificate, copy the saved file off the device, and validate it with the
project's signature validator. It passes on integrity and modification policy.

**Acceptance Scenarios**:

1. **Given** a freshly installed app on a device with no network, **When** the user opens a PDF,
   places a signature and signs with a `.p12`, **Then** a signed PDF is saved where the user chose
   and validates as intact and policy-compliant.
2. **Given** an already-signed, uncertified PDF, **When** the user counter-signs it in the app,
   **Then** both signatures validate, exactly as on the web.
3. **Given** a certified PDF, **When** the user opens it, **Then** the app refuses certificate
   signing with the same explanation the web app gives.
4. **Given** a wrong certificate password, **When** the user signs, **Then** the same error appears
   and nothing is saved.
5. **Given** the user cancels the save dialog, **Then** no file is written and no error appears.

---

### User Story 2 - Trust that the app cannot reach the network (Priority: P1)

A person who cares about privacy wants to know the app cannot send their document anywhere, and wants
to be able to check that claim rather than take it on faith.

**Why this priority**: Provable privacy is the product. On Android this distribution can offer a
stronger guarantee than the web, so it must actually deliver and state it.

**Independent Test**: Inspect the released package's declared permissions: network access is absent.
Run the app through a full signing flow on a device with a network available and confirm no traffic
leaves the app.

**Acceptance Scenarios**:

1. **Given** the released package, **When** its permissions are listed, **Then** it declares no
   network permission.
2. **Given** the app running on a device with a network, **When** the user completes a signing flow,
   **Then** the app opens no network connection.
3. **Given** the app's own information screen, **When** the user opens it, **Then** it states that
   the app has no network permission, and how to confirm that in the device settings.

---

### User Story 3 - Keep a remembered certificate safely on this phone only (Priority: P2)

A person opts in to remembering their certificate and signature image on the phone. They expect them
to stay on this phone: not copied into a cloud backup, not moved to a new phone, and actually gone
when they choose Forget or uninstall the app.

**Why this priority**: The web and desktop builds already guarantee consent and truthful deletion.
Android adds a new way for stored data to leave the device, so that guarantee needs explicit work
here.

**Independent Test**: Opt in, then run the platform's backup and device-transfer tooling and confirm
neither carries the stored certificate. Choose Forget and confirm the record is gone. Uninstall and
reinstall and confirm nothing remains.

**Acceptance Scenarios**:

1. **Given** a remembered certificate, **When** the device performs a cloud backup or a transfer to a
   new device, **Then** the certificate and signature image are not included.
2. **Given** a remembered certificate, **When** the user chooses Forget, **Then** it is removed, or a
   failure is shown, exactly as on the web.
3. **Given** the app is uninstalled, **When** it is reinstalled, **Then** no remembered item remains.
4. **Given** any state, **Then** the certificate password and decrypted key material are never
   stored.

---

### User Story 4 - Capture a signature with the camera (Priority: P2)

A person signs a sheet of paper, photographs it from inside the app, cleans up the background and
places it, as the web app allows.

**Why this priority**: Camera capture is part of the existing product, so the Android app should not
regress it, but signing works without it.

**Independent Test**: From the signature step, take a photo, clean it up and sign. The image appears
in the signed PDF's appearance.

**Acceptance Scenarios**:

1. **Given** the signature step, **When** the user chooses to take a photo, **Then** the device camera
   opens and the captured image is placed.
2. **Given** the user declines the camera, **Then** they can still pick an image file instead, and
   the app does not ask again on every launch.
3. **Given** a photo above the image limits, **Then** it is refused with the same message as the web.

---

### User Story 5 - Verify the app package before installing it (Priority: P3)

A person downloads the app package from the project's release page and wants to confirm it is the
genuine build from the published source before allowing an install from outside the store.

**Why this priority**: Installing from outside the store asks the user to switch off a protection, so
the project owes them a way to verify what they install. It matters less than the app working.

**Independent Test**: Follow the published verification steps against the release's package: the
checksum, the build provenance and the signing certificate fingerprint all match.

**Acceptance Scenarios**:

1. **Given** the release page, **When** the user follows the documented checks, **Then** the
   checksum and provenance verify, and the package's signing certificate fingerprint matches the one
   published in the repository.
2. **Given** a later release, **When** the user installs it over an earlier one, **Then** the update
   succeeds and the remembered items survive, because both are signed by the same key.

### Edge Cases

- **The device's system web view is old or disabled**: the app must state its minimum supported
  version, refuse to run below it with an explanation, and never silently produce a signature on an
  engine it has not been validated against.
- **The system web view is updated while the app is open**: the app may be restarted by the
  platform; any unsaved work is lost, and that must not leave a partial or corrupt file.
- **A file is opened from another app** (for example "Open with" from a file manager or email): if
  supported, it goes through the same limits and checks as a picked file; if not supported, the app
  does not appear in the chooser at all.
- **The chosen save location is removable storage that disappears**: the save fails with an
  intelligible message, and no partial file is reported as saved.
- **The user switches apps mid-signing** and the platform reclaims memory: on return, the app either
  restores its state or starts clean, never a half-signed document.
- **Another app tries to launch this app's internals or read its files**: nothing is exposed beyond
  the intended entry point.
- **Very large inputs**: the existing limits apply unchanged (100 MB and 5,000 pages per PDF, 20 MB
  and 40 megapixels per image, 1 MB per certificate). Low-memory phones may fail below those limits;
  they must fail with a message, not a crash.
- **The app is installed over a package signed with a different key**: the platform refuses; the
  documentation explains why and that the earlier app must be removed first, which deletes its
  remembered items.
- **Screen capture and the recent-apps thumbnail** would show the open document and the password
  field, so the app hides its content from both (FR-023). The user cannot screenshot their own
  document inside the app; they can open the saved file elsewhere.

## Requirements *(mandatory)*

### Functional Requirements

**Same application, unmodified**

- **FR-001**: The Android app MUST run the same web build the web and desktop distributions ship,
  from the same commit, with no Android-specific branch anywhere in the signing or PDF-mutation path.
- **FR-002**: All behaviour of the shared application MUST carry over unchanged: input limits,
  certified-PDF refusal, render cancellation and stale-page guards, consent and deletion semantics,
  and every user-facing message.
- **FR-003**: The app MUST work fully on first launch with no network ever having been available.

**Network isolation**

- **FR-004**: The app package MUST NOT declare any permission that grants network access.
- **FR-005**: The shared application's content policy MUST remain in force inside the app, scoped to
  documents only, so that it never governs worker scripts (the issue 16 lesson).
- **FR-006**: Nothing in the native layer, including any bundled library, may open a network
  connection. A dependency that does so is prohibited even if the missing permission would block it.

**Files in and out**

- **FR-007**: Users MUST be able to pick a PDF, a signature image and a `.p12` certificate from
  device storage through the system file picker, with the same accepted types as the web app.
- **FR-008**: Users MUST be able to save the signed PDF to a location they choose through the system
  save dialog, with the suggested file name the web app uses.
- **FR-009**: Users MUST be able to save a generated certificate and its public certificate the same
  way.
- **FR-010**: The app MUST request only the permissions it uses at the moment it uses them, and MUST
  work with storage access granted per file rather than broad storage permissions.

**Camera**

- **FR-011**: Users MUST be able to capture a signature photo with the device camera from the
  signature step; refusing camera access MUST leave file picking available.

**On-device data**

- **FR-012**: Opt-in persistence MUST keep the existing guarantees: consent per certificate,
  confirmed removal, failures shown, never the password or decrypted key.
- **FR-013**: The app's stored data MUST be excluded from cloud backup and device-to-device transfer.
- **FR-014**: The app MUST NOT expose its internal screens, stored data or files to other apps,
  beyond the launcher entry point and any document-opening entry point this spec adopts.
- **FR-015**: The app's information screen MUST state where remembered items live and that
  uninstalling removes them.

**Disclosure**

- **FR-016**: The app and its release notes MUST disclose that it is installed from outside the
  store, never updates itself, and depends on the device's system web view for its engine, together
  with the minimum version it supports.
- **FR-017**: The app MUST tell the user, without any network request, when the system web view it
  is running on is below the minimum validated version.
- **FR-018**: The release MUST publish the package's signing certificate fingerprint in the
  repository and in the verification instructions.

**Release**

- **FR-019**: The Android package MUST be built from the same commit as the web and desktop
  artifacts, attached to the same release, and covered by the same checksum file and build
  provenance.
- **FR-020**: The release MUST NOT publish the Android package unless a PDF signed and counter-signed
  by that package has passed the signature validator on integrity and modification policy, and the
  network-permission check has passed.
- **FR-021**: The package MUST be signed with a key the project owner controls, and every later
  release MUST be signed with the same key so updates install over earlier versions. The release
  job signs it, with the key held as an encrypted repository secret that only the release job can
  read. The owner keeps an offline backup. The key MUST NOT appear in the repository, a build log or
  a published artifact.
- **FR-023**: The app MUST hide its content from screenshots, screen recording and the recent-apps
  preview at all times, and its disclosure MUST say so.

**First deliverable**

- **FR-022**: Before any production app code, a throwaway spike MUST demonstrate, on an emulator or
  device with no network, that the bundled application signs and counter-signs PDFs that pass the
  signature validator, and that the picker and save paths work. The spike is then deleted; only its
  findings carry forward.

### Key Entities

- **Android package**: the installable artifact. Attributes: version, source commit, minimum system
  web view version, declared permissions, signing certificate fingerprint.
- **Validated engine floor**: the oldest system web view version the release gate has validated, and
  the basis for the warning in FR-017.
- **Signing key**: owned by the project owner; must persist across every release, because losing it
  ends in-place updates for every user.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a mid-range Android phone with every network disabled since install, a first-time
  user goes from opening a PDF to a saved, signed copy in under 60 seconds, the same budget as the
  web app.
- **SC-002**: 100% of signatures and counter-signatures produced by the released package in the
  release gate pass the validator on integrity and modification policy.
- **SC-003**: The released package declares 0 network permissions, and a full signing flow on a
  networked device produces 0 outbound connections from the app.
- **SC-004**: After opting in and running a device backup and a device-to-device transfer, 0
  remembered items appear in either.
- **SC-005**: A user following the published verification steps can confirm the package's checksum,
  provenance and signing fingerprint in under 5 minutes.
- **SC-006**: Every behaviour covered by the shared application's automated tests behaves identically
  in the Android app, with 0 Android-specific changes to shared code.
- **SC-007**: A version update installs over the previous version with remembered items intact.

## Assumptions

- **Store**: distribution is a signed package on the GitHub release only, matching the owner's
  decision on 2026-11-07. A store listing is out of scope.
- **Users** install apps from outside the store knowingly. The documentation explains the platform
  warnings, as the desktop documentation explains its unsigned-binary warnings.
- **Minimum platform**: Android 8.0 or later, whose system web view is updatable through the store.
  The plan confirms the floor against the shared application's needs (workers, WebAssembly,
  IndexedDB), and the release gate validates it.
- **Save behaviour**: the system save dialog, letting the user choose the location, rather than
  writing silently to a downloads folder.
- **Opening files from other apps** is out of scope for the first release. The app does not
  register to open PDFs, which keeps FR-014's entry points to the launcher alone. It can be added
  later with the same checks as a picked file.
- **Updates**: no self-update. Users install new releases themselves, as on desktop, under the same
  best-effort release policy with no patch-time commitment.
- **Spike**: runs on an emulator or a USB-connected phone using the Android CLI installed on
  2026-11-01, whose SDK components were installed on 2026-11-07.
- **Engine versions**: the "minimum supported version" in the edge cases is a hard minimum below
  which the app cannot run at all. It is distinct from the validated floor of FR-017, below which
  it runs with a warning (plan research R11).

## Dependencies

- **Constitution amendment** naming the Android distribution: done, v1.2.0 (see Constitutional
  Impact).
- **Android CLI and SDK** working on this machine: done 2026-11-07. The licence is accepted, and
  the platform, build tools, emulator and system image are installed (plan research R14 records the
  one-time "Unable to establish loopback connection" failure and its workaround).
- **A signing key** created and held by the owner before the first release.
- The shared application's release workflow, which this feature extends with an Android job and
  gate.
