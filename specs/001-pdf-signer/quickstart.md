# Quickstart & Validation Guide: PDF Signer PWA

How to run the app and prove the feature works end-to-end. This is a validation guide — see
[data-model.md](./data-model.md) and [contracts/](./contracts/) for details; implementation lives
in `tasks.md`.

## Prerequisites

- Node 20+ and npm.
- Python 3.11+ with **pyHanko** (`pip install pyhanko`) — the signature-validation gate
  (constitution V). Optional cross-check: poppler `pdfsig`.
- A test `.p12`/`.pfx` + password (a self-signed test certificate is fine).
- A sample multi-page PDF.

## Setup & run

```bash
npm install
npm run dev            # Vite dev server
npm run build          # production build (PWA assets + service worker)
npm run preview        # serve the built PWA locally
```

## Validation scenarios

### V1 — Visual stamp, offline (US1, SC-001/003/004)
1. `npm run preview`, open the app, load the sample PDF.
2. Add a signature image, drag/scale it onto page 1, tap Apply & Download.
3. Open the output in any viewer → signature visible at the chosen spot.
4. Repeat with DevTools offline (or airplane mode after first load) → still works.
5. In DevTools Network, confirm **no request** carries PDF/image data (SC-003).

### V2 — Cryptographic signature is valid & clickable (US2, SC-002/007)
1. With a placed signature, supply the test `.p12` + password, sign, download.
2. `npm run verify:signatures` → pyHanko reports the signature intact and covering the document.
3. Open in Adobe Acrobat → the signature is **clickable** and shows the certificate/validity
   (self-signed → "validity unknown", as disclosed, FR-016).
4. Alter one byte of the output → pyHanko/Acrobat report it **invalid** (SC-007).

### V3 — Multi-signature keeps earlier signatures valid (FR-013, SC-009)
1. Sign once, then add a second signature and sign again.
2. `npm run verify:signatures` → **both** signatures validate; signature #1 still intact
   (proves incremental signing, research R4).

### V4 — Install as a PWA on Android (US3, SC-005)
1. Serve the built app over HTTPS (or `npm run preview` via a tunnel).
2. On Android Chrome → "Install app" → launches standalone (no browser chrome).
3. Enable airplane mode → full signing flow still works.

### V5 — On-device data minimization (US, SC-008)
1. Sign without opting into "remember certificate" → after reload, IndexedDB has no user data.
2. Opt in to remember the certificate → only the `.p12` bytes persist; password is NOT stored and
   must be re-entered (FR-021/022). "Clear certificate" removes it.

## The verification gate (constitution V)

```bash
npm run verify:signatures   # runs pyHanko / pdfsig over test-produced PDFs
```

Must pass before any signing-path change is done. CI (GitHub Actions) is deferred — run this
locally for now; wiring Actions later automates it.

## First implementation milestone (de-risk)

Per research R3/R4, the **first** task is a signing-engine spike: one visible image-appearance
signature that Acrobat renders as clickable and pyHanko validates, plus a second incremental
signature that leaves the first valid. Everything else builds on that proof.
