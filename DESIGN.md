# Functional & Technical Specifications: Hybrid PDF Signer PWA (Image-Signature Edition)

> **⚠ Historical design note — superseded in places; not the authority on current scope.**
> This is the original technical design doc that seeded the project (2026-07-13). It is preserved as
> the record of the initial thinking. Two things it describes are **no longer true**: the `.p12` is
> not *"optional"* and there is no *"Apply & Download"* without one — certificate signing is the only
> path to an output (PR #4 `a1a83ab`). The authorities are
> [`specs/001-pdf-signer/spec.md`](specs/001-pdf-signer/spec.md) for scope and
> [`.specify/memory/constitution.md`](.specify/memory/constitution.md) for principles.

## 1. Executive Summary
The objective is to build a privacy-first, zero-server-storage Progressive Web App (PWA) optimized for mobile and desktop browsers. The app allows users to open a PDF, upload an image of their signature (PNG/JPEG) or snap a picture of it, visually position it on the document, and optionally wrap the entire file in a secure PKCS#12 (`.p12`/`.pfx`) cryptographic digital signature.

---

## 2. Core Architecture & Privacy Guarantees
* **Strictly Client-Side:** All image processing, cryptographic operations, and PDF compiling must happen locally in the browser runtime.
* **No Server Footprint:** No files (PDFs, signature images, or `.p12` certificates) are ever uploaded to a server.
* **Offline First:** Fully functional without an internet network connection once the PWA assets are cached via Service Workers.

---

## 3. Detailed Component Specifications

### 3.1. Asset Ingestion Module
* **PDF Upload:** Standard HTML `<input type="file" accept=".pdf">`.
* **Signature Image Upload:** Standard HTML `<input type="file" accept="image/png, image/jpeg, image/jpg">`.
  * *Mobile optimization:* On iOS and Android, this input naturally prompts the user with an option to either "Choose from Photo Library" or **"Take Photo"** (allowing them to snap a picture of a handwritten signature on paper instantly).
* **Certificate Upload:** Optional `<input type="file" accept=".p12,.pfx">` with a corresponding password text field.

### 3.2. Visual Processing & Placement Engine
* **Image Normalization:**
  * When a JPEG or PNG signature is uploaded, the app reads it into an HTML5 `<canvas>` element.
  * *Optional Enhancement:* Apply a basic canvas threshold filter to automatically strip away off-white paper backgrounds, turning a physical photo into a crisp, transparent signature overlay.
* **Drag-and-Drop Canvas Overlay:**
  * Displays a responsive visual preview of the PDF pages.
  * The signature image is placed as a floating, draggable HTML element (`div` or canvas snippet) over the PDF preview.
  * Implements touch gestures (`touchstart`, `touchmove`, `touchend`) to allow smooth mobile dragging, alongside pinch-to-zoom or corner drag-handles for resizing the signature image to fit the document's signature line.

### 3.3. Hybrid PDF Compiling Engine (`pdf-lib` & `node-forge`)

#### Tier A: Visual Electronic Stamping (Image Embed)
* Read the signature image as an ArrayBuffer.
* Use `pdf-lib`'s native image embedding functions:
  ```javascript
  // Handles both transparent PNGs and standard JPEGs
  const signatureImage = isPNG ? await pdfDoc.embedPng(imageBuffer) : await pdfDoc.embedJpg(imageBuffer);
  ```
* Read the user-defined coordinates and dimensions from the visual editor UI.
* **Path selection (depends on whether a `.p12` is supplied):**
  * **Electronic-only (no `.p12`):** Use `page.drawImage()` to draw the signature permanently onto the targeted PDF page coordinates. This is a flat visual stamp with no cryptographic meaning.
  * **Digital signature (`.p12` supplied):** Do **not** draw the image as page content. Instead the image becomes the **appearance stream of the signature field** (see Tier B), so the visible signature and the cryptographic signature are the same object — clickable in Acrobat, with a validity panel.

#### Tier B: Cryptographic Seal — Integrated Signature Field (Acrobat-compatible)

The goal is a signature that behaves like an Adobe Acrobat digital signature: the visible image **is** the signature field's appearance, and clicking it in a compliant reader shows the certificate and validity status. This requires the image and the PKCS#7 to live in the **same AcroForm signature field**, not as two independent artifacts.

**Object model to construct (this is the load-bearing part):**
1. **Image XObject** — embed the (optionally background-stripped) signature PNG/JPEG via `pdf-lib`'s `embedPng`/`embedJpg`.
2. **Appearance stream (`/AP /N`)** — a Form XObject whose content stream draws the image XObject (`q … /Img Do Q`) at the field's rectangle.
3. **Signature widget annotation** — with a **visible `/Rect`** at the user-chosen page coordinates, referencing the appearance stream. This is what the user clicks.
4. **AcroForm signature field (`/FT /Sig`)** — links the widget to a signature dictionary (`/V`) that holds `/ByteRange` and `/Contents`. Register the field in the document `/AcroForm` (set `SigFlags` = 3).

**Signing sequence (order is mandatory):**
1. Build the field + widget + image appearance above.
2. Add a **signature placeholder** — a signature dict with a zero-filled `/Contents` hex string sized for the CMS, plus a `/ByteRange` template. (`@signpdf/placeholder-pdf-lib`.)
3. **Save** the PDF. The saved bytes now define the two `/ByteRange` segments (everything except the `/Contents` gap).
4. `node-forge` decrypts the `.p12` with the password → private key + certificate chain.
5. Compute **SHA-256** over the ByteRange segments, produce a **detached PKCS#7 (CMS)** signature. (`@signpdf/signpdf` + `@signpdf/signer-p12`.)
6. **Splice** the hex-encoded CMS into the `/Contents` gap **without shifting a single byte**.

**Why the order matters:** any page-content change (including a Tier-A `drawImage`) *after* the placeholder is added would move byte offsets and invalidate the `/ByteRange`. That is why, in digital-signature mode, the image is carried as the field appearance in step 1 rather than stamped as page content — it becomes part of the signed bytes and is therefore tamper-evident.

> **Tooling note:** `pdf-lib` has no high-level "add signature field" API — the widget/field/appearance dictionaries are built with its low-level object API (`context.obj` / `context.register`). The `@signpdf` toolchain handles the ByteRange placeholder and the CMS splice; wiring the **image appearance onto the visible widget** is the custom ~20% this spec is explicitly committing to.

---

## 4. UI/UX User Flow (Mobile Target)

```
[Step 1: Files] ---------> [Step 2: Place Image] -----> [Step 3: Cryptography] --> [Step 4: Done]
 Upload PDF                 Upload/Snap Sign Image       Optional: Upload .p12      Download PDF
                            Drag/Scale on PDF Page       Input Password             Purge Memory
```

1. **Upload:** User selects a PDF document.
2. **Signature Capture:** User taps "Add Signature Image". They select an existing image or use their mobile camera to photograph a signature written on plain white paper.
3. **Positioning:** The user uses one finger to drag the signature image over the contract's signature line and uses a slider or pinch gesture to scale it.
4. **Finalize:** User taps "Apply & Download". If they choose to secure it cryptographically, they type their `.p12` password. The PWA processes the files in under two seconds and initiates a browser file download.

---

## 5. Technical Stack & Dependencies

* **Core Interface:** React, Vue, or Vanilla JS styled with Tailwind CSS for mobile viewports.
* **PDF Engine:** `pdf-lib` (embeds image assets, builds the signature field/widget/appearance dictionaries via its low-level object API).
* **PDF Rendering (preview):** `pdf.js` for on-screen page rendering behind the drag-and-drop overlay.
* **Signature Placeholder + Splice:** `@signpdf/signpdf` with `@signpdf/placeholder-pdf-lib` (adds the `/ByteRange` + `/Contents` placeholder and splices the CMS in byte-safe).
* **Crypto Engine:** `@signpdf/signer-p12` (over `node-forge`) — decodes the `.p12` and produces the detached PKCS#7/CMS signature. Note: **`pdf-lib` alone cannot sign** — it has no ByteRange/placeholder/signature API; the `@signpdf` layer is required.
* **PWA Manifest (`manifest.json`):** Set to standalone display mode to eliminate the mobile browser's top/bottom navigation bars, maximizing space for document viewing.
* **Service Worker:** Caches all application bundles locally for immediate offline utility.

---

## 6. Security Hardening Specs

* **Camera Privacy:** The app only requests ephemeral access to the device camera via the browser's native file picker input. It does not stream or record video data.
* **Memory Destruction:** Immediately after generating the final PDF output blob, clear all local JavaScript state references to the `imageBuffer`, `p12Buffer`, and `password` string to prevent data remnants from lingering in browser memory.
* **Data Isolation:** Implement a strict Content Security Policy (CSP) with `connect-src 'none'` so the app cannot make outbound network requests — a strong, auditable enforcement control that documents and signature images never leave the device. (Note: this is an enforced control, not a mathematical proof.)

---

## 7. Known Limitations & Honest Caveats

* **Certificate trust drives the green check.** A reader (Acrobat, etc.) only shows "Signed and valid" if the signing certificate chains to a trusted root (Adobe AATL or the OS trust store). A **self-signed `.p12`** shows "validity unknown / yellow" until the user manually trusts it — identical to signing with a self-signed Digital ID in Acrobat. The app cannot change this; it is a property of the certificate.
* **No timestamp / no LTV.** The offline, no-network guarantee means there is **no RFC-3161 trusted timestamp (TSA)** and no long-term validation material. Signatures verify now, but validity becomes ambiguous once the signing certificate expires. This is an inherent trade-off of the offline design, not a bug.
* **"Clickable validity" is a desktop-reader feature.** Acrobat and most desktop readers render the signature-field appearance and expose the validity panel. Many **mobile default PDF viewers** will show the image but not the click-to-validate panel. The output is still a valid signed PDF everywhere.
* **Memory wiping is best-effort.** JavaScript strings are immutable and GC is non-deterministic; the app can **drop references** to `imageBuffer`, `p12Buffer`, and the password to minimize residency, but cannot guarantee the bytes are zeroed out of memory. Framing should be "minimize residency," not "prevent all remnants."
* **Background threshold is fragile.** Naive luminance thresholding struggles with colored ink, camera shadows, and JPEG artifacts. It stays an *optional enhancement*, never on the critical signing path.
