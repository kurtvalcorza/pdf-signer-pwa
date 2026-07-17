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
5. Delete **folder A and its `pdf-signer-data/`** → all its state is gone.

> **Deleting the binary alone is NOT sufficient**, and the docs must not claim otherwise: a bundled
> engine writes cache/GPU/profile files into `pdf-signer-data/` on every launch, opt-in or not. The
> promise is **"one place"**, not "one file" (SC-005).

**Why step 4 matters**: a single-location test passes even when the path was derived from
`process.execPath` (which points into a temp extraction, R3). Two locations is what proves the
resolution is right. Skipping it is how this bug ships.

### 3. Read-only media degrades visibly, not silently (FR-011b)

1. Run the artifact from read-only media (or a directory with writes denied).

**Expected**: signing fully works; the user is **told** persistence is unavailable this session; the
opt-in "remember" affordances are **not offered at all**; **nothing** is written to the OS user-data
directory as a fallback; the temp `userData` is removed on quit.

> **Check that no `.p12` reached the disk.** Ephemeral mode still gives Electron a writable temp
> `userData` for its own cache — which means IndexedDB *works*. If persistence is merely relocated
> rather than **disabled**, the remembered certificate silently lands in temp on a machine where the
> user deliberately chose read-only media. Memory-only must be enforced by not writing, not by hoping
> a write fails.

### 4. Each network layer holds *independently* (Principle I) — ⚠ the highest-consequence check

1. **Layer 1 (CSP) alone** — trigger a `connect-src` violation in the renderer and assert a
   **`securitypolicyviolation` event** fires. Also assert the `app:` scheme's privileges contain no
   truthy `bypassCSP`.
2. **Layer 2** — a synthetic `https:` request is cancelled.
3. **`blob:` still allowed** — a real signed-PDF download completes (R10).
4. **Layer 3** — no Node HTTP client exists in the packaged `electron/**`.

> **Do not test layer 1 by reading the CSP meta tag.** `bypassCSP: true` leaves the tag untouched —
> the string still reads `connect-src 'none'` and the check passes with the bug live. And the `https:`
> request in step 2 is killed by layer 2 whether or not layer 1 works, so it can never prove the CSP.
> Only the `securitypolicyviolation` event distinguishes them: CSP emits it, `webRequest` does not.
> This is the one assertion standing between a copy-pasted tutorial line and a NON-NEGOTIABLE
> principle violation shipping green — so it must actually be capable of failing.

### 5. Zero network across the lifecycle (SC-004)

Observed from **outside** the app — the spec says "not merely asserted internally".

1. **Primary gate**: run with networking **available but monitored** (firewall/proxy/packet capture
   that logs and blocks) across launch → sign → idle → quit. **Fail on any DNS or TCP/HTTP attempt**,
   successful or not.
2. **Separate check**: run with no network interface and complete scenario 1 — the app must behave
   identically.

> Step 2 alone is **not** sufficient and must not be reported as if it were: with no interface, a
> stray telemetry or update call fails instantly, records nothing, and the app still signs — so the
> run goes green while the attempt happened. "Works offline" and "makes no requests" are different
> claims, and only step 1 proves the second.

### 6. Staleness nudge (SC-010, FR-015a)

1. Build with an **`engineDate`** older than the 180-day threshold (or override the constant in a
   test).
2. Launch.
3. **Then rebuild with a fresh `buildDate` but the same `engineDate`** and launch again.

**Expected**: (1–2) a passive, non-blocking notice about the ageing bundled engine, **zero** network
requests, signing unaffected. (3) **the notice still appears** — a rebuild must not silence it.

> Step 3 is the point of the scenario. Staleness derives from `engineDate`, never `buildDate`: a
> rebuild from an unchanged lockfile ships the identical old engine, so measuring the artifact's age
> would mute the warning exactly when it matters — and a routine CI rerun would be enough to do it.

### 7. Web build unaffected (SC-008, FR-019)

```bash
npm run build && npm test && npm run verify:signatures && npm run e2e && npm run e2e:pwa
```

**Expected**: all green, unchanged. If any of these needed editing to accommodate desktop packaging,
FR-019 is broken — fix the packaging, not the test.

### 8. Release verification (SC-007, FR-017/018a)

```bash
sha256sum -c SHA256SUMS
gh attestation verify PDF-Signer-<version>-portable.exe \
  --repo kurtvalcorza/pdf-signer-pwa \
  --signer-workflow kurtvalcorza/pdf-signer-pwa/.github/workflows/release-desktop.yml \
  --source-digest <expected-commit-sha>
```

**Expected**: checksum matches; the attestation verifies against the **expected workflow and source
commit**.

> **`--repo` alone is not enough**, though it looks like it is: it proves *some* attesting workflow in
> this repository produced the artifact. Any other workflow in the repo — or a build from an
> unexpected ref or commit — satisfies it. Since FR-018a exists to prove *what* built the binary and
> *from which commit*, the verification the docs hand users must pin **both**. *(Codex, PR #7.)*

**Note**: none of this removes the SmartScreen warning — only a code-signing certificate would
(`release-artifacts.md`).

## First-run expectations (so they aren't mistaken for bugs)

- **Windows**: SmartScreen shows *"Windows protected your PC"* → **More info → Run anyway**. Expected
  and disclosed (FR-014); the binary is unsigned by design in this feature.
- **Linux**: `chmod +x PDF-Signer-*.AppImage` before first run.
- **Windows cold start** includes a temp extraction (R3) and will be slower than the AppImage. Measure
  it rather than assuming; SC-001's 60 s budget has enormous headroom (web measures 977 ms).

## Definition of done for a release

- [ ] Both artifacts build from **one commit** on CI runners (not a laptop)
- [ ] Scenarios 1–8 pass **on both platforms**
- [ ] pyHanko passes against **each artifact's own output** (FR-010) — not inherited
- [ ] Checksums + provenance attestation published (FR-017, FR-018a) — **US4 is part of the first
      public release, not a follow-up**: FR-014's disclosure promises a verification path, so
      publishing without one ships an overclaim
- [ ] Unsigned-binary + no-self-update disclosures on the release page (FR-014, FR-015)
- [ ] AppImage verified on a **FUSE-less** host via the documented fallback (FR-002a)
- [ ] Existing web gates green and untouched (SC-008)
- [ ] **If any platform's gate is red, nothing publishes** (SC-002)
