# PDF Signer PWA — Agent Context

Privacy-first, offline-first, client-only PWA for signing PDFs on-device (visual stamp + PKCS#12
digital signature). Installable on Android, deployed static on Vercel.

- **Constitution**: [.specify/memory/constitution.md](.specify/memory/constitution.md) (**v1.2.0**) —
  6 principles; I (zero-server) and III (crypto correctness) are NON-NEGOTIABLE. v1.1.0 generalized
  the browser-specific wording so the product is **two distributions from one codebase** (web PWA +
  portable desktop): "installable" and the network prohibition are now defined per distribution, and
  validator evidence (V) is explicitly **per-distribution — never inherited by assertion**.
  v1.2.0 adds a third distribution, a native Android app package (feature 003).
- **Design notes (technical origin)**: [DESIGN.md](DESIGN.md) — the original technical design doc; the formal, technology-agnostic spec is `specs/001-pdf-signer/spec.md`.

<!-- SPECKIT START -->
## Active feature: 003-android-packaging (US1–US4 implemented and gated locally; release pending)

- **Tasks: [specs/003-android-packaging/tasks.md](specs/003-android-packaging/tasks.md)**: 49 tasks.
  Open: Kurt's T036 (two-phone transfer), T039 (release key) and T040 (`android-release`
  environment), then T041 (commit the fingerprint), the first tagged release (Kurt's yes) and T049.
  `spike-android/` is git-excluded reference code until T049 deletes it.
- User docs: [docs/android.md](docs/android.md). Gate: `scripts/android-gate.mjs` (emulator, signed
  APK); static checks: `scripts/android-check-apk.mjs`.

Native Android APK: a Kotlin shell hosting the UNCHANGED `dist/` in a WebView on
`https://appassets.androidplatform.net`, no network permission, signed in CI from a GitHub
Environment secret, gated by sign + counter-sign on the signed APK.

- Spec: [specs/003-android-packaging/spec.md](specs/003-android-packaging/spec.md)
- **Plan: [specs/003-android-packaging/plan.md](specs/003-android-packaging/plan.md)**: Constitution
  Check (v1.2.0) passes before and after design
- Research: [specs/003-android-packaging/research.md](specs/003-android-packaging/research.md)
- Data model, contracts, quickstart: same folder

**Traps this feature must not fall into** (see research.md):

1. `allowBackup="false"` alone does **not** stop device-to-device transfer on API 31+; only
   `dataExtractionRules` does (R10).
2. "No INTERNET permission" covers the app's UID, not the system WebView provider, which uploads
   its own metrics and crash reports. Opt out of metrics and disclose crash reports. Never claim
   nothing can leave (R6).
3. A path handler that returns `null` falls through to the network, and one that adds a CSP header
   governs workers (R2, R3).
4. A repository secret is readable by every workflow. "Release job only" needs a GitHub
   Environment (R12).

## Previous feature: 002-desktop-packaging (shipped)

Portable offline desktop builds — Windows portable `.exe` + Linux AppImage via Electron. Additive:
the web PWA stays primary and unchanged (FR-019).

- Spec: [specs/002-desktop-packaging/spec.md](specs/002-desktop-packaging/spec.md)
- **Plan: [specs/002-desktop-packaging/plan.md](specs/002-desktop-packaging/plan.md)** — Constitution
  Check ✅ pass (initial + post-design)
- Research: [specs/002-desktop-packaging/research.md](specs/002-desktop-packaging/research.md)
- Data model: [specs/002-desktop-packaging/data-model.md](specs/002-desktop-packaging/data-model.md)
- Contracts: [specs/002-desktop-packaging/contracts/](specs/002-desktop-packaging/contracts/)
- Quickstart: [specs/002-desktop-packaging/quickstart.md](specs/002-desktop-packaging/quickstart.md)

**Three traps this feature must not fall into** (see research.md):

1. `bypassCSP: true` on the `app://` scheme silently exempts `app:`-served resources from
   `connect-src 'none'` — every test still passes. **Assert the value passed to
   `registerSchemesAsPrivileged` directly.** Do *not* try to catch this by reading the CSP or probing
   `connect-src`: `bypassCSP` leaves the meta tag untouched and is scheme-scoped, so both go green
   with the bug live.
2. Deriving the data dir from `process.execPath` writes state to a **temp extraction**, not next to
   the artifact. Use `PORTABLE_EXECUTABLE_DIR` / `APPIMAGE`. Test from **two** folders.
3. Any desktop-only branch in the signing path voids the whole reason Electron was chosen over Tauri
   (FR-009) and re-opens the Principle V gate.
4. `session.webRequest` does **not** see the main process. Node `fetch`/`http` in `electron/main`
   bypass it — an eslint **import allow-list** (not a deny-list; `import got from 'got'` walks past
   that) is the only guard there.

**Two lessons from the 002 review** (48 findings over 4 rounds), worth applying to any spec work here:

- **A claim must not outrun its mechanism.** 8 of the 48 were guarantees nothing enforced — "secrets
  never reach swap" (the OS pages memory), "no evidence the app ever ran" (prefetch/Defender), "never
  shows a libfuse error" (fails before our code runs). Before writing MUST NEVER, name the mechanism.
- **Fix the claim everywhere, not where it was cited.** Most findings after round 1 were earlier fixes
  that never reached sibling docs — `research.md`, `data-model.md`, `plan.md`, and this file each kept
  teaching a corrected mistake. Grep the whole repo for the claim, not the line.

## Shipped feature: 001-pdf-signer

- Spec: [specs/001-pdf-signer/spec.md](specs/001-pdf-signer/spec.md)
- **Plan: [specs/001-pdf-signer/plan.md](specs/001-pdf-signer/plan.md)**
- Research: [specs/001-pdf-signer/research.md](specs/001-pdf-signer/research.md)
- Data model: [specs/001-pdf-signer/data-model.md](specs/001-pdf-signer/data-model.md)
- Contracts: [specs/001-pdf-signer/contracts/](specs/001-pdf-signer/contracts/)
- Quickstart: [specs/001-pdf-signer/quickstart.md](specs/001-pdf-signer/quickstart.md)

**Stack**: TypeScript + React 18 + Vite + Tailwind + `vite-plugin-pwa`; `pdfjs-dist` (preview);
`pdf-lib` + `@signpdf/*` + `node-forge` (signing); `idb-keyval` (opt-in cert). Client-only, no
backend. Verification gate: pyHanko / `pdfsig` (`npm run verify:signatures`) + Acrobat spot-check.

**Load-bearing risk**: visible image-appearance signature field + multi-signature via incremental
updates (never re-serialize signed bytes). First task is a signing-engine spike.
<!-- SPECKIT END -->
