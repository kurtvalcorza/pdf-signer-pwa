# Contract: Release Artifacts, Provenance & Disclosure

**Feature**: `002-desktop-packaging` | **Enforces**: FR-004, FR-010, FR-014, FR-015, FR-017, FR-018,
FR-018a | **Principles**: IV (honest posture), V (per-distribution evidence)

## What a release publishes

| Artifact | Platform | Target | Notes |
|---|---|---|---|
| `PDF-Signer-<version>-portable.exe` | Windows x64 | `portable` | Single file; no installer, no registry (FR-001) |
| `PDF-Signer-<version>.AppImage` | Linux x86_64 | `AppImage` | Single file; no root, no package manager (FR-002) |
| `SHA256SUMS` | — | — | Checksum per artifact (FR-017) |
| Provenance attestation | both | Sigstore / in-toto | Attached per artifact (FR-018a) |

**No macOS artifact** (FR-004) — the "accept the warning" mitigation that makes an unsigned build
usable on Windows and Linux does not exist there; an un-notarized app is commonly refused outright.

## Build pipeline

- **Matrix**: `windows-latest` → portable `.exe`; `ubuntu-latest` → AppImage. **No cross-compiling** —
  native runners remove a whole class of toolchain failure for zero cost (R8).
- **One commit for all artifacts.** A release MUST NOT mix builds from different sources
  (`data-model.md` § Release).
- **Built by CI, never from a developer machine** (FR-018a). A locally-built binary cannot carry a
  meaningful attestation — the attestation's whole value is that a *workflow*, not a person, produced
  it.

### Required workflow permissions (R8)

```yaml
permissions:
  id-token: write      # mint the OIDC token for the Sigstore signing certificate
  attestations: write  # persist the attestation
  contents: write      # upload release assets
```

**Availability**: artifact attestations are free for **public repositories on all current GitHub
plans**. `pdf-signer-pwa` is public → no blocker, no cost. (Private/internal repos would require
Enterprise Cloud.)

## Release gate (FR-010, Principle V — **blocking**)

**This diagram is the AUTHORITATIVE gate list.** `tasks.md` T031/T032a map each gate to its
implementing task and MUST match this list; where they diverge, **this contract wins**. A gate absent
*here* is not enforced (Codex, PR #7/#11) — so new blocking gates are added here first, then mirrored
into the task mapping.

```text
build (per platform)
   ├─> launch the PACKAGED artifact via Playwright (_electron.launch)
   │     └─> complete a real signing flow → signed PDF
   │           └─> scripts/validate_pdf.py  (pyHanko)                    [FR-010]
   ├─> layer E2E: CSP alive + bypassCSP absent + layer 2 + blob: allowed +
   │     app:// path-traversal REFUSED (T015 step 5) + openExternal reachable
   │     ONLY by the exact repo URL                                       [Principle I, FR-020]
   ├─> MONITORED-NETWORK run: launch→sign→idle→quit under PACKET-LEVEL
   │     monitoring (firewall / packet capture / network namespace over the
   │     WHOLE process tree — NOT a proxy, which sees only configured HTTP(S));
   │     FAIL on ANY egress — any packet/socket, any protocol (TCP/UDP/ICMP/
   │     DNS/QUIC), by name or numeric IP. NOT a protocol list            [SC-004, primary]
   ├─> layer-3 lint + packaged dependency audit                          [no Node HTTP client]
   ├─> layer-5: crashReporter.start() absent + metrics switches set      [no phone-home; build-time —
   │                                                                      a crash-free monitored run
   │                                                                      cannot observe an armed reporter]
   ├─> portable-state: two folders + read-only degradation +
   │     same-folder single-instance lock (defer + stale-lock recovery)  [FR-011a/b, concurrency]
   ├─> packaged US3 surfaces in the RUNNING app: about/no-self-update
   │     surface UNCONDITIONALLY; staleness notice under a STALE-metadata
   │     fixture/override (a fresh build must NOT show it — do not gate on
   │     it unconditionally, or a valid release fails / is pressured to lie) [FR-015/015a — not a doc scan]
   └─> [Linux] FUSE-less host: launch+sign AND the two-folder portability
         spec, BOTH under --appimage-extract-and-run                     [FR-002a, R3]
         │
         ├─ ALL pass on BOTH platforms ──> publish/aggregation job, which ALSO requires:
         │     • SHA256SUMS + provenance attestation ASSETS produced      [FR-017/018a — not just docs]
         │     • docs/release notes carry the unsigned-binary, no-self-update,
         │       pinned verification command, AND --appimage-extract-and-run
         │       fallback text                                            [FR-014/015/018a/002a]
         └─ ANY fail ──────────────────> NOTHING publishes (neither platform)
```

*(Corrected 2026-07-17: this diagram previously made an artifact "eligible to publish" the moment
pyHanko passed — the monitored-network and layer-3 gates existed only in the task list, and **a gate
that isn't in the release contract is a suggestion**. Extended 2026-07-18 (Codex, PR #11) to the full
blocking set — layer-5, concurrency lock, packet-level monitoring, packaged US3 surfaces, produced
verification assets, and the extract-and-run portability variant + fallback docs — so the contract, as
the publishing authority, no longer trails the task list.)*

Non-negotiable rules:

- The gate runs against output from **the artifact being shipped** — not the web build, not the other
  platform, not Electron-from-`node_modules` against source. Constitution v1.1.0: *"Sharing an
  implementation makes a passing result likely; it does not make it demonstrated."*
- **No partial releases.** If either platform's gate is red, neither publishes (SC-002). Shipping one
  while the other is broken would imply an equivalence never demonstrated. The user stories'
  "independently shippable" framing means independently **buildable and testable** — never
  independently **publishable**.
- **No release without its verification path.** Checksums *and* attestation (FR-017/FR-018a) ship
  with the **first** public release, not after it. FR-014's disclosure tells users to verify instead
  of trusting an unsigned binary; publishing before that path exists would make the honesty feature
  itself the overclaim.
- **The Linux artifact must be verified on a FUSE-less host** (FR-002a) before publishing, or the
  "no root, no package manager" promise is false for a large share of real Linux systems.
- The existing web gates must also be green (SC-008) — desktop packaging must not regress the web
  distribution (FR-019).

## Verification available to users

| Question the user has | What answers it | Command |
|---|---|---|
| "Is this the published file?" | `SHA256SUMS` (FR-017) | standard checksum tools |
| "Where did it actually come from?" | Provenance attestation (FR-018a) | `gh attestation verify <file> --repo … --signer-workflow …/release-desktop.yml --source-digest <sha>` |
| "Which source built it?" | Attestation predicate + release notes (FR-018) | as above — **`--source-digest` pins the commit** |

> **The verification command MUST pin the workflow and commit, not just the repo.** `--repo` alone
> proves only that *some* attesting workflow in this repository produced the artifact — any other
> workflow, ref, or commit satisfies it. FR-018a exists to prove *what* built it and *from which
> commit*; a check that can't distinguish those is a checkbox. *(Codex, PR #7.)*

## Disclosure (FR-014 — ships **with** the release, not after)

Constitution v1.1.0's honesty gate: a distribution-specific weakness MUST ship its disclosure **in
the same change**. Every release page states, plainly:

1. **These binaries are not signed by a recognised code-signing authority.**
2. **What you will see because of that** — Windows SmartScreen's *"Windows protected your PC"*,
   requiring **More info → Run anyway**; Linux requires `chmod +x`.
3. **What to do instead** — verify the checksum and the provenance attestation.
4. **The app does not self-update** (FR-015). Security fixes require downloading a new build.

### ⚠ The distinction that must never blur

**An attestation is not a code-signing certificate.**

| | Proves | Removes SmartScreen warning? |
|---|---|---|
| Authenticode certificate | *who* built it (a vetted identity) | **Yes** |
| Provenance attestation | *what* built it, *from which commit* | **No** |

Attestation is the honest substitute for a certificate we do not have — it is genuinely useful and
genuinely free, and it does **nothing** about the warning. Implying otherwise ("verified builds!"
next to a scary dialog) would be exactly the overclaiming Principle IV forbids. Say both facts, plainly, together.

## In-app disclosures (FR-015, FR-015a/b)

| Surface | Content | Constraint |
|---|---|---|
| Info/about | Version, build date, source commit, distribution | Read from `BuildMetadata` |
| Info/about | "This build does not update itself." | Data-driven (`selfUpdates: false`) |
| Passive notice, once stale | Build age + "the bundled browser engine no longer receives security updates" | **Local clock only, zero network** (FR-015a); non-blocking; MUST NOT name a specific CVE it cannot know about (FR-015b) |
| Info/about | Where state lives + current mode | FR-013, see `portable-paths.md` |

The staleness notice **MUST NOT** offer a "don't show again" option — that would create a new
on-device store whose only purpose is suppressing a disclosure the constitution requires
(`data-model.md` § Entities explicitly NOT introduced).
