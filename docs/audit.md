# Repository Audit Notes

Last updated for the current `work` branch.

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
4. **User-facing documentation was missing a full usage guide.** `docs/user-guide.md` now explains visual stamps, digital signatures, counter-signing already-signed PDFs, self-signed certificates, remembered data, and troubleshooting.

## Known environment limitations in this container

- `npm run verify:signatures` generated the signed fixtures through Vitest, but the final validation step requires `pyHanko`. Installing it with `python3 -m pip install --user pyhanko` was blocked by the container's package-index proxy (`403 Forbidden`). Install `pyHanko` locally or in CI before relying on the full signature verification gate.
- `npm run e2e` could not launch because the Playwright Chromium binary is not installed. Installing it with `npx playwright install chromium` was blocked by the browser download CDN returning `403 Forbidden`. Run `npx playwright install chromium` in an environment with browser-download access, then rerun the E2E suite.
