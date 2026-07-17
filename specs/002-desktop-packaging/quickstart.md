# Quickstart: Building & Verifying the Desktop Builds

**Feature**: `002-desktop-packaging` | **Date**: 2026-07-17

How to build the portable artifacts and — more importantly — how to **prove** they satisfy the
constitution before publishing. This is a validation guide; implementation lives in `tasks.md`.

## Prerequisites

- Node ≥ 20, `npm ci` (as today)
- **pyHanko** — `pip install pyhanko` (the Principle V gate; a missing install is an environment
  problem that has bitten this project before, not a code failure)
- Linux artifacts build on Linux (WSL or a container); Windows artifacts on Windows. No
  cross-compiling (R8).

## Build

```bash
npm run build              # the existing web build → dist/  (unchanged; FR-019)
npm run build:desktop      # electron-builder → release/ (portable .exe / AppImage per host)
```

## The gate — run this before believing anything

Principle V (v1.1.0): evidence is **per-distribution and not inherited by assertion**. A green web
suite says nothing about the artifact you are about to publish.

```bash
npm run e2e:desktop        # Playwright drives the PACKAGED binary through a real signing flow
npm run verify:signatures  # pyHanko validates the PDF that binary produced
```

`e2e:desktop` must launch the **packaged** artifact (`_electron.launch({ executablePath })`), not
Electron-from-`node_modules` against source — that is the only thing that exercises `asar` packing,
the `app://` handler, and the `userData` relocation, which is where packaging bugs actually live.

## Validation scenarios

Each maps to a success criterion. Scenarios 1–4 are the ones that catch the failures this design is
most likely to produce.

### 1. Offline signing works (SC-001, SC-002, FR-006) — US1/US2

1. Disable networking entirely (disconnect the interface — don't just trust the policy).
2. Run the artifact from an arbitrary folder.
3. Open a PDF → place a signature → sign with `tests/e2e/fixtures/e2e-cert.p12` (password
   `e2e-pass`).
4. Save the output; run it through pyHanko.

**Expected**: identical behaviour to a networked run; signature validates.

### 2. State is adjacent, and actually portable (SC-005, SC-011, FR-011a) — ⚠ the subtle one

1. Copy the artifact to **folder A**, run it, opt into remembering a certificate, close it.
2. Confirm `pdf-signer-data/` exists **beside the artifact in folder A**.
3. Confirm **nothing** was written to `%APPDATA%` / `~/.config`.
4. **Copy the same artifact to folder B and run it** — it must **not** see folder A's certificate.
5. Delete folder A → all its state is gone.

**Why step 4 matters**: a single-location test passes even when the path was derived from
`process.execPath` (which points into a temp extraction, R3). Two locations is what proves the
resolution is right. Skipping it is how this bug ships.

### 3. Read-only media degrades visibly, not silently (FR-011b)

1. Run the artifact from read-only media (or a directory with writes denied).

**Expected**: signing fully works; the user is **told** persistence is unavailable this session;
**nothing** is written to the OS user-data directory as a fallback.

### 4. The CSP survived packaging (Principle I) — ⚠ the highest-consequence check

1. From inside the **packaged** app, read the effective CSP.
2. Assert `connect-src 'none'` is present.
3. Assert a synthetic `https:` request is cancelled, **and** that a real signed-PDF download still
   completes (proving `blob:` remains allowed — R10/network-policy).

**Why**: `bypassCSP: true` on the custom scheme silently voids the CSP while every other test still
passes (R2). This assertion is the only thing standing between a copy-pasted tutorial line and a
NON-NEGOTIABLE principle violation shipping green.

### 5. Zero network across the lifecycle (SC-004)

Observed from **outside** the app — the spec says "not merely asserted internally". Run with no
network interface and complete scenario 1; the app must behave identically.

### 6. Staleness nudge (SC-010, FR-015a)

1. Build with a `buildDate` older than the 180-day threshold (or override the constant in a test).
2. Launch.

**Expected**: passive, non-blocking notice about the ageing bundled engine; **zero** network
requests; signing unaffected.

### 7. Web build unaffected (SC-008, FR-019)

```bash
npm run build && npm test && npm run verify:signatures && npm run e2e && npm run e2e:pwa
```

**Expected**: all green, unchanged. If any of these needed editing to accommodate desktop packaging,
FR-019 is broken — fix the packaging, not the test.

### 8. Release verification (SC-007, FR-017/018a)

```bash
sha256sum -c SHA256SUMS
gh attestation verify PDF-Signer-<version>-portable.exe --repo kurtvalcorza/pdf-signer-pwa
```

**Expected**: checksum matches; attestation verifies against the source commit and workflow.
**Note**: this does **not** remove the SmartScreen warning — only a code-signing certificate would
(`release-artifacts.md`).

## First-run expectations (so they aren't mistaken for bugs)

- **Windows**: SmartScreen shows *"Windows protected your PC"* → **More info → Run anyway**. Expected
  and disclosed (FR-014); the binary is unsigned by design in this feature.
- **Linux**: `chmod +x PDF-Signer-*.AppImage` before first run.
- **Windows cold start** includes a temp extraction (R3) and will be slower than the AppImage. Measure
  it rather than assuming; SC-001's 60 s budget has enormous headroom (web measures 977 ms).

## Definition of done for a release

- [ ] Both artifacts build from **one commit** on CI runners (not a laptop)
- [ ] Scenarios 1–7 pass **on both platforms**
- [ ] pyHanko passes against **each artifact's own output** (FR-010) — not inherited
- [ ] Checksums + provenance attestation published (FR-017, FR-018a)
- [ ] Unsigned-binary + no-self-update disclosures on the release page (FR-014, FR-015)
- [ ] Existing web gates green and untouched (SC-008)
- [ ] **If any platform's gate is red, nothing publishes** (SC-002)
