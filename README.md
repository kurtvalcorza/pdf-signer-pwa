# PDF Signer PWA

**Live app:** https://pdf-signer-pwa.vercel.app

Sign PDFs on your phone or computer — **privately**. Everything happens on your own device; your
document, your signature image, and your Digital ID **never leave it** and are **never uploaded**.
Works offline once loaded, and installs like a normal app on Android.

---

## Contents

- [What you can do](#what-you-can-do)
- [Install it on your phone](#install-it-on-your-phone)
- [Sign a PDF — step by step](#sign-a-pdf--step-by-step)
- [Create a Digital ID inside the app](#create-a-digital-id-inside-the-app)
- [Sign a PDF that is already signed (counter-signing)](#sign-a-pdf-that-is-already-signed-counter-signing)
- [Handy extras](#handy-extras)
- [Troubleshooting](#troubleshooting)
- [Is my signature legally valid?](#is-my-signature-legally-valid)
- [Your privacy](#your-privacy)
- [For developers](#for-developers)

---

## What you can do

- **Add your signature to any PDF** — upload a signature image or snap a photo of your signature on
  paper, place and resize it on the page.
- **Apply a real digital signature** using a `.p12` / `.pfx` **Digital ID** (PKCS#12 certificate).
  Your signature image becomes the visible, clickable signature that a PDF reader like Adobe Acrobat
  can verify — shown Adobe-style as *"Digitally signed by {your name}"* with the date (both optional).
- **Don't have a Digital ID?** Create a self-signed one right in the app.
- **Sign a PDF that someone else already signed** — your signature is *added* without breaking theirs,
  on **any page**, and it shows your signature image too.
- **Clean up a photographed signature** — remove the white paper background so it sits cleanly on the
  document.
- **Remember your signature** on your device so you don't have to re-add it next time (optional).

---

## Install it on your phone

1. Open **https://pdf-signer-pwa.vercel.app** in **Chrome on Android**.
2. Tap the **⋮** menu → **Install app** (or **Add to Home screen**).
3. Launch it from your home screen like any other app. After the first load it works **offline**.

> On a computer, you can use it right in the browser — no install needed.

---

## Sign a PDF — step by step

1. **Open PDF** — tap *Open PDF* and choose the document. It appears on screen. If it has more than
   one page, use **‹ Prev / Next ›** to move between pages.
2. **Add your signature** — tap **Add signature** to pick a signature image (PNG/JPEG), or **📷 Take
   photo** to capture one with your camera.
3. **Place it** — drag the signature to where it belongs and drag its corner to resize. Put it on
   whichever page you like.
4. **Sign with your Digital ID** — tap **Sign with a digital certificate (.p12)…**, then:
   - Choose your `.p12` / `.pfx` file and enter its password, **or** create a new Digital ID (see
     below).
   - Optionally toggle whether the visible signature shows *"Digitally signed by {name}"* and the date.
   - Tap **Sign & Download**. Your signed PDF downloads to your device.

That's it — the downloaded PDF carries a cryptographic signature that a PDF reader can validate, with
your signature image as its visible appearance.

---

## Create a Digital ID inside the app

A **Digital ID** (a `.p12`/`.pfx` certificate) is what makes a signature verifiable. If you don't
have one:

1. In the certificate step, choose **Create a certificate**.
2. Fill in your **name**, and optionally organization, unit, and email.
3. The app generates a self-signed Digital ID on your device. You can:
   - **Export the `.p12`** — keep this safe; it's your signing key, protected by the password you set.
   - **Export the public `.cer`** — share this with people who need to *trust* your signature (see
     [validity](#is-my-signature-legally-valid)).

Your password and private key are **never uploaded** and never stored unless you explicitly opt in to
remembering the certificate.

---

## Sign a PDF that is already signed (counter-signing)

You can add your signature to a PDF that someone has **already** digitally signed — for example a
document routed to several approvers.

- Open the already-signed PDF. The app detects it and tells you it will **append** your signature
  **without altering the signed pages**, so the existing signatures **stay valid**.
- Place your signature on **any page**, then sign with your Digital ID as usual.
- Your signature is added as a new, **visible** signature field (with your image) on top of the
  document, and everyone's earlier signatures remain intact and verifiable.

**One limitation:** on an already-signed PDF, only the signature you're adding gets a visible
appearance. Extra decorative image *stamps* (beyond your signature) can't be baked in, because that
would rewrite the already-signed pages and break the existing signatures — so those are skipped.

---

## Handy extras

- **Clean up background** — after adding a photographed signature, tap **Clean up background** and
  drag the slider to strip the white paper so only the ink remains.
- **Remember this signature** — tick the box to save your signature image **on this device** for next
  time. Only the image is saved (never your document or certificate password), and you can **Forget**
  it anytime. Cleaning a remembered signature's background asks you to opt in again, so a stale copy is
  never reused.

---

## Troubleshooting

- **"Incorrect certificate password."** Re-enter the password for your `.p12` / `.pfx` file.
- **"This signed PDF could not be counter-signed…"** The PDF has a certification or field-lock
  policy that forbids adding another signature. That's the document author's choice — it can't be
  overridden without breaking their signature.
- **"This PDF is password-protected…"** Remove the PDF's open password first, then sign it.
- **My signature shows as untrusted / "validity unknown".** Expected for a self-signed Digital ID —
  it's cryptographically intact but not *trusted* until the recipient adds your public `.cer` to their
  trust store. See [validity](#is-my-signature-legally-valid).
- **My phone's PDF viewer doesn't show signature details.** Many mobile viewers render the image but
  not the validation panel. Open the file in a desktop reader (e.g. Adobe Acrobat) to see validation.

---

## Is my signature legally valid?

Please read this honestly:

- **Self-signed Digital IDs show as "validity unknown"** in PDF readers until the reader is told to
  **trust** your certificate (that's what the exported `.cer` is for). This is normal for
  self-signed IDs and doesn't mean the signature is broken.
- **Signatures are not timestamped.** Because the app is fully offline, it can't contact a trusted
  time source, so signatures have no long-term/qualified validation.
- This app is **not** a legally-binding or qualified e-signature service. It produces a genuine
  cryptographic signature, but whether that satisfies a particular legal or organizational requirement
  is up to you and the certificate you use.

---

## Your privacy

- **Nothing leaves your device.** All PDF, image, and cryptographic work happens in your browser. A
  strict security policy (`connect-src 'none'`) makes uploading your data structurally impossible —
  the app *cannot* send it anywhere.
- **Minimal on-device storage.** Your content stays in memory by default. The only things that can be
  saved are an **opt-in** remembered certificate and/or signature image — **never** your PDF, your
  certificate password, or decrypted private-key material.
- **Works offline.** After the first load, you can sign with no internet connection at all.

---

## For developers

```bash
npm install
npm run dev        # dev server
npm run build      # production build (PWA + service worker)
npm run preview    # serve the built app
npm test           # unit + signing tests (Vitest)
npm run e2e        # end-to-end (Playwright)
npm run e2e:pwa    # offline / installability (production build)
```

### Signature verification gate

The cryptographic signing path is verified with **pyHanko** — every produced signature (including
counter-signatures with a visible appearance) must be **intact + valid**, and a tampered fixture must
be rejected:

```bash
pip install pyhanko
npm run verify:signatures   # produces signed PDFs and validates them with pyHanko
```

### Tech

TypeScript · React · Vite · `vite-plugin-pwa` · `pdf-lib` · `pdf.js` · `@signpdf/*` · `node-forge`.
Client-only; deploys as a static site (e.g. Vercel).

Signing engine highlights: a first signature embeds the image as the signature field's appearance
stream (`signFirst`); counter-signatures are byte-level **incremental updates** built from the parsed
PDF graph (`signIncremental` / `incrementalUpdate`) so they work on any page and any PDF structure —
now with a visible image appearance too — without ever rewriting the already-signed bytes.

### Spec

Built spec-driven (GitHub Spec Kit). See [`specs/001-pdf-signer/`](specs/001-pdf-signer/) for the
spec, plan, tasks, and design notes, and
[`.specify/memory/constitution.md`](.specify/memory/constitution.md) for the project constitution.
