# User Guide

PDF Signer PWA is an offline-first browser app for adding visible signature images and optional certificate-backed digital signatures to PDFs. It is designed for private, on-device use: your PDF, signature image, certificate, and password are processed in your browser.

## What you can create

### Visual stamp

A visual stamp draws your signature image onto the PDF page. It is useful when a recipient only needs a visible handwritten-style signature.

- Output shows the image on the page.
- It is not cryptographically verifiable.
- Use this only on unsigned PDFs. Stamping page content after a PDF is already signed can invalidate existing signatures.

### Digital signature

A digital signature uses a `.p12` / `.pfx` Digital ID. The placed signature image becomes the visible appearance of a clickable PDF signature field.

- Output can be validated in readers such as Adobe Acrobat.
- The signature is tamper-evident: changes to covered bytes are reported by compliant validators.
- Self-signed certificates usually show as “unknown” or “not trusted” until the recipient trusts your public certificate.
- The app works offline, so it does not add a trusted timestamp.

## Sign a new, unsigned PDF

1. Open the app and choose **Open PDF**.
2. Choose **Add signature** to upload a PNG/JPEG signature image, or **Take photo** on a mobile device.
3. Drag and resize the signature on the visible page.
4. Optional: choose **Clean up background** to remove paper/background from a photographed signature.
5. Choose **Sign with a digital certificate (.p12)…**.
6. Choose an existing `.p12` / `.pfx`, or create a self-signed certificate in the app.
7. Enter the certificate password.
8. Optional: toggle the “Digitally signed by” label and date line.
9. Choose **Sign & Download**.

If you place multiple signature images before certificate signing, the selected placement becomes the cryptographic signature field. Other placements are baked as visual stamps first, then the cryptographic signature is applied.

## Counter-sign an already-signed PDF

When the opened PDF already contains signatures, the app switches to a non-invalidating incremental signing path.

1. Open the already-signed PDF.
2. Add and position the signature image for your new signature.
3. Choose **Sign with a digital certificate (.p12)…**.
4. Enter your certificate and password, then choose **Sign & Download**.

The app appends a new visible digital signature field without rewriting the earlier signed bytes. Existing signatures should remain valid unless the PDF has a certification or field-lock policy that forbids adding another signature. Extra visual-only stamps are skipped on already-signed PDFs because page-content stamping would invalidate prior signatures.

## Create a self-signed certificate

If you do not already have a `.p12` / `.pfx` Digital ID:

1. Choose **Sign with a digital certificate (.p12)…**.
2. Choose **Don’t have a certificate? Create one**.
3. Enter your full name and password. Organization, unit, and email are optional.
4. Choose **Create certificate**.
5. Save the `.p12` somewhere private. It contains your encrypted private key and can sign documents when unlocked with the password.
6. Save/share the `.cer` if recipients need to add your public certificate to their trust store.

Keep the `.p12` and password safe. The app cannot recover the password.

## Remembered data

By default, files stay in memory for the current browser session.

You can explicitly opt in to remember:

- a signature image, stored as image bytes and format; and/or
- a certificate, stored as the password-protected `.p12` bytes.

The app does not remember PDFs, certificate passwords, or decrypted private-key material. You can clear remembered signatures and certificates from the app UI.

## Troubleshooting

- **“Incorrect certificate password.”** Re-enter the password for the `.p12` / `.pfx` file.
- **Signed PDF cannot be counter-signed.** The PDF may have a certification or field-lock policy that forbids adding another signature field.
- **Signature appears untrusted.** A self-signed certificate is cryptographically intact but not trusted until the recipient trusts your public `.cer`.
- **Password-protected PDF fails to open.** Remove the PDF password before signing.
- **Mobile viewer does not show validation details.** Many mobile PDF viewers show the image but not the signature validation panel. Use a desktop reader for validation details.
