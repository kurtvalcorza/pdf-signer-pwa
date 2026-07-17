# PDF Signer PWA — Agent Context

Privacy-first, offline-first, client-only PWA for signing PDFs on-device (visual stamp + PKCS#12
digital signature). Installable on Android, deployed static on Vercel.

- **Constitution**: [.specify/memory/constitution.md](.specify/memory/constitution.md) (**v1.1.0**) —
  6 principles; I (zero-server) and III (crypto correctness) are NON-NEGOTIABLE. v1.1.0 generalized
  the browser-specific wording so the product is **two distributions from one codebase** (web PWA +
  portable desktop): "installable" and the network prohibition are now defined per distribution, and
  validator evidence (V) is explicitly **per-distribution — never inherited by assertion**.
- **Design notes (technical origin)**: [DESIGN.md](DESIGN.md) — the original technical design doc; the formal, technology-agnostic spec is `specs/001-pdf-signer/spec.md`.

<!-- SPECKIT START -->
## Active feature: 002-desktop-packaging (planning)

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

1. `bypassCSP: true` on the `app://` scheme silently voids `connect-src 'none'` — every test still
   passes. Assert the CSP from *inside* the packaged app.
2. Deriving the data dir from `process.execPath` writes state to a **temp extraction**, not next to
   the artifact. Use `PORTABLE_EXECUTABLE_DIR` / `APPIMAGE`. Test from **two** folders.
3. Any desktop-only branch in the signing path voids the whole reason Electron was chosen over Tauri
   (FR-009) and re-opens the Principle V gate.

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
