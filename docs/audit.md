# Repository Audit Notes

## Security review of 2026-11-07 (issue #16)

Status of each finding on the remediation branches. "Verified" means reproduced or tested here, not
inherited from the review.

| ID | Status | Verified by |
| :--- | :--- | :--- |
| SEC-01, 06 | Forge 1.4.3 on `main`. The v0.1.0 binaries still carry 1.4.0 until a new release replaces them. | Zero-iteration fixture accepted by 1.4.0 under any password, rejected now (`p12Malformed.test.ts`). |
| SEC-02 | Fixed. Every certified PDF is refused, because appending a field breaks certification at every /P. | pyHanko fixtures and `validate_pdf.py`. |
| SEC-03, 07 | Sandbox on; Electron 43.8.7. | Desktop E2E and `verify-packaged.mjs`. |
| SEC-04, 05 | Fixed. | `us2-remember-cert.spec.ts`, with the consent test shown to fail without the fix. |
| SEC-08, 09 | Limits and cancellable, atomic rendering. | `sec-limits-render.spec.ts`. Main-thread parsing of an accepted file cannot be cancelled. |
| SEC-10 | Heartbeat, nonce and a reclaim mutex. | Eight simultaneous launches on a stale lock produce one winner. |
| SEC-11 | Claims corrected; `vercel.json` sends CSP and frame protections. | Not yet observed on a deployment. |
| SEC-12 | Actions pinned, permissions scoped per job. | Runs on the next release. Tag protection is a repository setting. |
| SEC-13 | New certificates use AES-256 with 12-character passwords. | Opened with OpenSSL-backed `cryptography`. Acrobat import needs a manual check. |
| SEC-14 | Lint, audit and policy gates in CI. | The Windows gate samples sockets, so a packet-level gate stays open in issue #12. |

`audit:gate` accepts one known exception: `crypto-js` via `@signpdf/placeholder-plain`, which has no
upstream fix and does not reach the production bundle. The gate fails if that stops being true.

Last updated for the incremental counter-signature appearance work (PR #5).

## Automated checks used during this audit

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run verify:signatures` (requires Python `pyHanko` for the final validation step)
- `npm run e2e` (requires an installed Playwright browser)

## Findings addressed

1. **ESLint did not cover Node scripts correctly.** The project lint command failed on `scripts/*.mjs` because Node globals such as `Buffer`, `console`, and `process` were not declared for JavaScript script files. The ESLint config now applies Node globals to scripts and config files.
2. **Privacy wording was inaccurate for remembered certificates.** A remembered `.p12` contains an encrypted private key, so the accurate statement is that the app never stores the certificate password or decrypted private-key material.
3. **File inputs could ignore repeated same-file selections.** Browser file inputs may not fire `change` when the same file is selected twice. The PDF, image, and camera inputs now clear their value after reading the selected file.
4. **User-facing documentation was missing a full usage guide.** The README now explains signing a PDF with a Digital ID, counter-signing already-signed PDFs, creating a self-signed certificate in-app, remembered data and privacy, and troubleshooting.

## Known environment limitations in this container

- `npm run verify:signatures` generated the signed fixtures through Vitest, but the final validation step requires `pyHanko`. Installing it with `python3 -m pip install --user pyhanko` was blocked by the container's package-index proxy (`403 Forbidden`). Install `pyHanko` locally or in CI before relying on the full signature verification gate.
- `npm run e2e` could not launch because the Playwright Chromium binary is not installed. Installing it with `npx playwright install chromium` was blocked by the browser download CDN returning `403 Forbidden`. Run `npx playwright install chromium` in an environment with browser-download access, then rerun the E2E suite.
