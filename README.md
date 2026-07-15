# PDF Signer PWA

**Live:** https://pdf-signer-pwa.vercel.app — install it from Android Chrome (menu → Install app).

A privacy-first, **offline-first** Progressive Web App that signs PDFs entirely **on your device** —
nothing is ever uploaded. Add a signature image (upload or phone camera), place it on the document,
and optionally apply a real **PKCS#12 digital signature** that Adobe Acrobat validates. Installable
on Android.

## Features

- **Visual signature stamp** — open a PDF, drag/scale a signature image, download.
- **Cryptographic signature (Tier B)** — sign with a `.p12`/`.pfx` Digital ID; the image becomes the
  clickable, verifiable signature-field appearance, Adobe-style ("Digitally signed by {name}" + date,
  both toggleable).
- **Create a certificate in-app** — generate a self-signed Digital ID (name, organization, unit,
  email); export the `.p12` and the public `.cer` (to share for trust).
- **Camera capture + background cleanup** — snap a signature on paper, strip the white background.
- **Installable & offline** — works with no network after first load.

## Privacy

- **Zero-server**: all PDF, image, and cryptographic processing happens in the browser. A strict CSP
  (`connect-src 'none'`) makes outbound data exfiltration structurally impossible.
- **On-device data minimization**: content is in-memory by default. Only an explicitly
  opted-in signature image and/or password-protected `.p12` certificate may be remembered;
  PDFs, certificate passwords, and decrypted private-key material are never persisted.
- **Honest about limits**: self-signed certificates show as "validity unknown" until trusted;
  signatures are not timestamped (a consequence of offline operation). This is **not** a legally-
  binding / qualified e-signature service.

## Development

```bash
npm install
npm run dev        # dev server
npm run build      # production build (PWA + service worker)
npm run preview    # serve the built app
npm test           # unit + signing tests (Vitest)
npm run lint       # ESLint over app, tests, and scripts
npm run e2e        # end-to-end (Playwright)
npm run e2e:pwa    # offline/installability (production build)
```

### Signature verification gate

The cryptographic signing path is verified with **pyHanko** (Python):

```bash
pip install pyhanko
npm run verify:signatures   # produces signed PDFs and validates them with pyHanko
```

## User guide

See [docs/user-guide.md](docs/user-guide.md) for step-by-step signing, counter-signing, certificate, persistence, and troubleshooting guidance. See [docs/audit.md](docs/audit.md) for the latest repository-audit notes.

## Tech

TypeScript · React · Vite · `vite-plugin-pwa` · `pdf-lib` · `pdf.js` · `@signpdf/*` · `node-forge`.
Client-only; deploys as a static site (e.g. Vercel).

## Spec

Built spec-driven (GitHub Spec Kit). See [`specs/001-pdf-signer/`](specs/001-pdf-signer/) for the
spec, plan, tasks, and design notes, and [`.specify/memory/constitution.md`](.specify/memory/constitution.md)
for the project constitution.
