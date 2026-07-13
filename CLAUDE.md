# PDF Signer PWA — Agent Context

Privacy-first, offline-first, client-only PWA for signing PDFs on-device (visual stamp + PKCS#12
digital signature). Installable on Android, deployed static on Vercel.

- **Constitution**: [.specify/memory/constitution.md](.specify/memory/constitution.md) (v1.0.0) —
  6 principles; I (zero-server) and III (crypto correctness) are NON-NEGOTIABLE.
- **Design spec (technical)**: [specs.md](specs.md)

<!-- SPECKIT START -->
## Active feature: 001-pdf-signer

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
