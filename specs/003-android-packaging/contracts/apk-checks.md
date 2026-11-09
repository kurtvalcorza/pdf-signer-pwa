# Contract: Release checks on the signed APK

Run by `scripts/android-check-apk.mjs` (C1–C7, C9: static checks on the APK and the repository) and
`scripts/android-gate.mjs` (C8, C10–C12: on an emulator running that exact APK). The release
`publish` job `needs:` the Android job, so a failure blocks the whole release (FR-020). Every check
runs on the **signed release APK** that is published, never on a debug or variant build
(Principle V). See [research.md](../research.md) R5, R9, R10, R12, R13.

| ID | Check | Mechanism | Fails when |
|---|---|---|---|
| C1 | No permissions | `aapt2 dump permissions <apk>` | any `uses-permission` other than the one allowed entry: `<applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which `androidx.core` declares at signature protection and the app grants itself; it must also appear as a `permission` with `protectionLevel=signature` (FR-004, FR-010; spike S3) |
| C2 | Dependency allow-list | resolved `releaseRuntimeClasspath` vs `android/dependency-allowlist.txt`; Gradle dependency verification | any coordinate not listed, or a checksum mismatch (FR-006) |
| C3 | Signing identity | `apksigner verify --verbose --print-certs <apk>` | not verified, v2 or v3 scheme missing, or SHA-256 ≠ `android/SIGNING_FINGERPRINT` (FR-018, FR-021) |
| C4 | Exported surface | `aapt2 dump xmltree --file AndroidManifest.xml <apk>` | any exported component other than the launcher activity; an exported provider; any intent filter other than MAIN/LAUNCHER (FR-014). `androidx.profileinstaller`'s `ProfileInstallReceiver` (exported, guarded by `DUMP`) is removed in the manifest with `tools:node="remove"` (spike S3) |
| C5 | Backup and transfer exclusion | same xmltree, plus the packaged `res/xml` rules | `allowBackup` ≠ false; `dataExtractionRules` absent; `cloud-backup` or `device-transfer` lacks an exclude for any domain (FR-013) |
| C6 | Release hardening | same xmltree | `debuggable` true; WebView `MetricsOptOut` ≠ true; `EnableSafeBrowsing` ≠ false |
| C7 | Same web build | hash of APK `assets/www/**` vs the release's `dist/` | any file differs, is missing or is extra (FR-001, FR-019) |
| C8 | Content hidden | `adb exec-out screencap -p` while the app shows a document | any non-black pixel in the app window (FR-023) |
| C9 | No shell code in shared paths | `git diff <base>..HEAD -- src/ index.html vite.config.ts` in the 003 branch | the diff mentions the shell (`pdfSignerShell`, `appassets`, `androidplatform`, `android`, case-insensitive), or contains a change not listed in the PR as distribution-neutral (SC-006). Neutral fixes, such as spike S11's wording, land as separate commits so they can be reviewed apart. Run in CI on PRs, not only on release |
| C10 | Sign + counter-sign validate | gate run (R13) → `scripts/validate_pdf.py` | either file fails integrity or modification policy (FR-020, SC-002) |
| C11 | Certified refusal | gate opens a certified fixture | the app offers certificate signing (US1 AS3) |
| C12 | No traffic | `dumpsys netstats detail` for the app UID after the gate | any bytes sent or received (SC-003) |

C7 also asserts that the path handler adds no `Content-Security-Policy` header: a JVM unit test on
the handler, run in the same job.

Every check prints the evidence it judged (the permission list, the fingerprint, the diff, the
netstats line), so a failed release shows why in its log. No check prints a secret: C3 reads the
public certificate only.
