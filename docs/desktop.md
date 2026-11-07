# PDF Signer — Desktop builds

The desktop builds are the **exact same app** as the web PWA, wrapped in a minimal Electron shell so
it runs as a single portable file with **no install and no network** (FR-009/FR-019). The signing
engine is unchanged and shared — a desktop signature is produced by the same code the web build's
83 unit tests and pyHanko gate already validate.

- **Windows**: `PDF Signer <version>.exe` — a portable single file, no installer, no registry.
- **Linux**: `PDF Signer-<version>.AppImage` — a single file; `chmod +x` then run.

## First run

### Windows — SmartScreen warning (expected, disclosed)

The binary is **not code-signed** in this feature, so Windows SmartScreen shows *“Windows protected
your PC.”* This is expected, not a malfunction:

> **More info → Run anyway**

An attestation (below) is **not** a code-signing certificate and does **not** remove this warning —
it proves *what built the binary*, not *who vouches for it*.

### Linux — FUSE

AppImages self-mount via FUSE. On hosts without `libfuse2` (many modern distros), a plain
double-click fails **before any app code runs** — that error is the AppImage runtime's, not ours.
Run it extracted instead:

```bash
./PDF-Signer-<version>.AppImage --appimage-extract-and-run
```

## What it leaves behind (honest scope)

Everything the app writes in normal operation lives in **one folder beside the artifact**
(`pdf-signer-data/`). Delete the artifact **and that folder**, and **no user content remains** — no
document, certificate, or signature.

It is **not** an anti-forensics tool, and “leaves absolutely nothing, ever” is not an accurate claim.
Bounded **non-user-content** residue can remain *outside* that folder:

- the Windows portable `.exe` extracts its own program files to a temp dir while running (a crash can
  leave them);
- on **read-only media** the app runs in memory-only mode using a throwaway temp cache for the engine
  (a crash can leave that cache) — your certificate is **not remembered** in this mode, by design;
- the Linux AppImage under `--appimage-extract-and-run` extracts program files to a temp dir;
- the OS itself records that an executable ran (prefetch, execution history, antivirus) in places no
  application can reach.

None of these are your documents, certificates, or signatures.

## No self-update

This build **does not update itself**. These builds **never contact a network**. There is no update
feed to misconfigure — the guarantee is the *absence* of one. A build past ~180 days shows a passive,
offline notice that its bundled browser engine is ageing and a newer build should be fetched
manually; it makes **zero** network requests to do so.

## Security updates

Web and desktop share one release train: every release is cut from one commit. Rebuilds of the
desktop builds are **best-effort**; there is no promised turnaround after a security fix, and because
the app never updates itself, a fix reaches you only when you download a newer build. The ~180-day
notice tracks the age of the bundled engine, not whether a known vulnerability affects it, so a build
can need replacing well before the notice appears. Check the releases page if that matters to you.

## Hardening

The binary has Electron fuses burned in: it will not run as plain Node, ignores `NODE_OPTIONS`, loads
the app only from its archive, and gives `file:` no extra privileges. On Windows that archive's
integrity is also checked at startup; Electron has no such check on Linux. The renderer sandbox can
still be turned off by whoever launches the app (`--no-sandbox`); Electron has no fuse for that, and
that person already controls your session.

## Verifying a download

Do not trust the release page's contents — verify independently:

```bash
# 1. Checksum
sha256sum -c SHA256SUMS

# 2. Build provenance (proves the exact source commit + that this repo's workflow built it)
gh attestation verify "PDF Signer <version>.exe" \
  --repo kurtvalcorza/pdf-signer-pwa \
  --signer-workflow kurtvalcorza/pdf-signer-pwa/.github/workflows/release-desktop.yml \
  --source-digest <expected-commit-sha>
```

The attestation is a record in GitHub's attestations API (not a release asset). `--repo` alone is not
enough — it only proves *some* workflow in this repo built it. Pin **`--signer-workflow`** (which
workflow) **and `--source-digest`** (which commit), or a build from an unexpected ref/commit would
still satisfy the check.
