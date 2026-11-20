# Repository Audit Notes

## Security review of 2026-11-07 (issue #16)

Status of each finding on the remediation branches. "Verified" means reproduced or tested here, not
inherited from the review.

| ID | Status | Verified by |
| :--- | :--- | :--- |
| SEC-01, 06 | Forge 1.4.3 from v0.1.1. The v0.1.0 binaries carry 1.4.0 and should not be used. | Zero-iteration fixture accepted by 1.4.0 under any password, rejected now (`p12Malformed.test.ts`). |
| SEC-02 | Fixed, then narrowed in v0.3.0 (spec 004, [RFC 23-1](rfc-23-1-certified-empty-field.md)). Appending a field still breaks certification at every /P, so the app never appends one to a certified PDF. At P=2 and P=3 it signs into an empty signature field the author prepared, after checking the field and every revision since the certification (fail closed, 8 signed revisions at most); everything else certified is refused with a reason. | pyHanko fixtures (`make_policy_fixtures.py`) and `validate_pdf.py --expect-certification-level FORM_FILLING` on every fill output of the gate, the web build and the desktop build (`scripts/verify-signatures.mjs`, `us7-certified-field.spec.ts`, `desktop-sign.spec.ts`). The gate also checks that pyHanko and pdf-lib enumerate the same signature fields on every fixture, and that pyHanko's own fill of the split-widget field is a violation. Pending: Android (`android-gate.mjs --certified-field`, never run on an emulator; first run on the v0.3.0 tag, T040) and Acrobat Reader (T045, owner): _version and result not yet recorded._ |
| SEC-03, 07 | Sandbox on; Electron 43.8.7; fuses burned, the Node inspector now off too (#33); cookie encryption kept at Electron's default (off) by decision (#36, 2026-11-19): the app sets no cookies (persistence is IndexedDB), and on Linux the fuse may create a desktop-keyring item, which no real GNOME/KDE run has ruled out. | Desktop E2E on Windows and Linux in CI; `check-fuses.mjs` reads the release and gate-only probe binaries on both OSes (CI and release); `verify-packaged.mjs` drives the probe, which differs from the release only by the inspector fuse byte. `--no-sandbox` has no fuse, and the archive integrity fuse has no effect on Linux. |
| SEC-04, 05 | Fixed. | `us2-remember-cert.spec.ts`, with the consent test shown to fail without the fix. |
| SEC-08, 09 | Limits and cancellable, atomic rendering. | `sec-limits-render.spec.ts`. Main-thread parsing of an accepted file cannot be cancelled. |
| SEC-10 | Heartbeat written into the lock, nonce and a reclaim mutex; an old lock with a live PID is watched for one beat. | Eight simultaneous launches on a stale lock produce one winner, and a live holder keeps the folder. |
| SEC-11 | Claims corrected; `vercel.json` sends CSP and frame protections on documents only. | `tests/e2e-pwa/deploy-headers.spec.ts` applies those rules to the real build. Not yet observed on a deployment. |
| SEC-12 | Actions pinned, permissions scoped per job. | Runs on the next release. Tag protection is a repository setting. |
| SEC-13 | New certificates use AES-256 with 12-character passwords. | Opened with OpenSSL-backed `cryptography`. Acrobat import needs a manual check. |
| SEC-14 | Lint, audit and policy gates in CI. | The Windows release gate now decides at connect time (`scripts/windows-egress-gate.ps1`, RFC 23-2): merged (#38) and passed 3 consecutive `release-desktop.yml` dry runs (#46). Scope and residuals below. |

### SEC-14: what the Windows no-egress gate checks, and what it does not

Measured on `windows-latest` (Server 2025) in runs 43802298765, 43804844070, 43805710270 and 43806349805;
details in [RFC 23-2 §10](rfc-23-2-windows-egress-gate.md#10-runner-evidence-phase-0-2026-11-16).

- **Checked.** Any TCP or UDP connection attempt, allowed or blocked, by any process in the app's
  tree, to a unicast non-loopback address, however short-lived: 20 of 20 deliberate attempts per
  protocol were recorded in each run. The socket sampler it replaces saw 0 of 20 connections to a
  peer that closes at once. Also checked: name lookups by a tree process through the system
  resolver, a foreign image in the tree, and an SMB connection from the system redirector during a
  window. Every app process must have exited before a window is read, and none may be running when
  the block rules are removed; before that the gate re-checks that auditing and the rules are still
  in place. These last checks were added after review; they ran armed once (run 43814441249, gate
  passed), and each is shown to fire only by the self-test.
- **WebDAV: coded, never exercised.** The gate also fails on a connection from the WebClient service
  to port 80 or 443, reading that service's pid again for every window. Whether the WebClient service
  exists on `windows-latest` is not shown by any run's artifacts; it is inferred to be absent on
  Windows Server, in which case this half of the check can never fire there.
- **Subject.** The controls and the sign flow run on the gate-only probe build, which differs from
  the release by one fuse byte (`check-fuses.mjs`). The release exe itself is measured undriven:
  launch, 15 s idle, quit; a quit that needs a kill fails the gate. In the release workflow that exe
  is the one unpacked from the shipped portable (`release/portable-extract`), the same tree
  `check-fuses.mjs` compares with the probe. The four runs above used `release/win-unpacked`;
  run 43814441249 used the unpacked portable and passed. Signing on the release binary is
  inferred from the probe. The positive controls are IPv4 only.
- **Evidence.** The uploaded artifact holds only the events the judge used (tree members, their
  connection and lookup events, share-client events), without local addresses, accounts, machine
  names or SIDs, and without the audit-policy backup.
- **Finding F1, fixed.** The gate showed the app's network service looking up `wpad` on every
  launch, with the resolver sending that query to the DNS server. `electron/main.js` now sets
  `no-proxy-server`; the committed line passed the strict gate on the runner (run 43814441249).
  Windows builds up to v0.2.0 are expected to make the lookup: they have the same `main.js`
  switches and Electron line, but this is inferred from the code, not measured on those binaries,
  and nothing was measured on Linux. The fix ships from the next release. The gate keeps no
  allow-list, so a regression fails it.
- **Not checked, recorded.** Multicast and broadcast from the app are logged, not failed, the same
  rule as the Linux gate. The portable wrapper's self-extraction to `%TEMP%` is not monitored; the
  gate runs the unpacked build. A browser opened through the "View source" link is not a child
  process and is not followed. Certificate revocation or SmartScreen checks the OS makes on its
  own are not attributed to the app. Host-level WPAD by the WinHTTP service is not attributed.
- **Not tested.** Whether any of this works unelevated: the hosted runner is an administrator.

`audit:gate` fails on any high or critical production advisory, with no exceptions. The `crypto-js`
chain left production dependencies when `@signpdf/placeholder-plain`, used only by the original spike,
moved to `devDependencies`.

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
