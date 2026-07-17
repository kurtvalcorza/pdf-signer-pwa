# Contract: Portable State Location

**Feature**: `002-desktop-packaging` | **Enforces**: FR-011, FR-011a, FR-011b, FR-012, FR-013
**Principle**: VI (as amended in constitution v1.1.0 — persistence scope now covers *any* on-device
store, including a desktop application data directory)

## The promise this contract keeps

> *"Delete the binary and nothing remains."*

That sentence is only true if every write the application makes lands next to the artifact. This
contract exists because Electron's **defaults break that promise silently** — the default `userData`
is `%APPDATA%` / `~/.config`, which survives deletion of the artifact and would leave a remembered
certificate on a machine the user believed they had cleaned.

## Resolution (applied before `app.whenReady()`)

`app.setPath('userData', <resolved>)` — one call, zero application-code change: `idb-keyval` →
IndexedDB lives under `userData`, so `src/features/persistence/certStore.ts` follows automatically
and FR-009 stays clean.

| Platform | Source of truth | Resolved `userData` |
|---|---|---|
| Windows portable `.exe` | `process.env.PORTABLE_EXECUTABLE_DIR` | `<that dir>/pdf-signer-data` |
| Linux AppImage | `dirname(process.env.APPIMAGE)` | `<that dir>/pdf-signer-data` |
| Dev / unpackaged | *(neither set)* | Electron default — dev only, never shipped |

### ⚠ Forbidden derivations

These **MUST NOT** be used to locate the data directory. Each looks correct and is wrong:

| Expression | Why it's wrong |
|---|---|
| `process.execPath` | Windows portable **extracts to a temp dir** (`%LOCALAPPDATA%\Temp\<guid>.tmp\app`) and runs from there; on Linux the AppImage runs from a read-only squashfs mount (`/tmp/.mount_XXXX`). Points at temp, not at the user's file. |
| `__dirname` / `app.getAppPath()` | Same — inside the extraction/mount, and inside `asar`. |
| `process.env.ARGV0` (Linux) | Reports *how the AppImage was invoked*; returns the symlink path when launched via one. `APPIMAGE` is the absolute path of the actual file. |

The failure mode is nasty precisely because it is quiet: state writes succeed, tests pass, and the
user's remembered certificate vanishes on next launch (fresh temp GUID) — or worse, persists in temp
after they deleted the "portable" binary.

**Test that catches it**: run the same binary from **two different directories** and confirm each
keeps its own state beside itself. A single-location test passes even when the resolution is wrong.

## Read-only media (FR-011b)

```text
adjacent dir writable?
  ├─ yes ──> mode: adjacent   — opt-in persistence available
  └─ no  ──> mode: ephemeral  — throwaway temp userData for Electron's OWN cache only
                                opt-in persistence DISABLED (never offered, never written)
                                temp dir deleted on quit
                                signing FULLY functional; user is TOLD (visibly)
```

### ⚠ Ephemeral mode MUST disable opt-in persistence — not merely relocate it

Electron requires *some* writable `userData` for its own cache/GPU/profile files, so ephemeral mode
still points it at a temp directory. **That makes IndexedDB work.** If the app merely relocates
`userData` and changes nothing else, `idb-keyval` writes succeed — and the user's remembered
**certificate** lands on the host disk, in temp, on a machine where they deliberately chose read-only
media. A crash or missed cleanup then leaves exactly the residue FR-011b exists to prevent.

So in `ephemeral` mode the shell MUST:

1. **Disable opt-in persistence outright** — the "remember" affordances are not offered, and
   `saveCertificate`/`saveSignature` are never reached. Memory-only is enforced by *not writing*, not
   by hoping the write fails.
2. **Delete the temp `userData` on quit**, and treat leftovers as a bug.
3. **Tell the user** persistence is unavailable this session (FR-011b's visibility requirement).

*(Codex, PR #7 — a correct catch: "degrade to memory-only" was written into FR-011b but the design's
ephemeral fallback quietly re-enabled disk writes. The requirement said one thing; the mechanism did
another.)*

**MUST NOT** fall back to the OS per-user application-data directory. Not as a convenience, not as a
last resort. That fallback is exactly the residue this feature exists to avoid (SC-005, SC-011), and
it would be invisible to the user who chose a portable build *because* they wanted no trace.

**Note on existing behaviour**: `certStore.ts:16–24` already catches storage failures and degrades to
memory-only **silently** — deliberate for the web (where storage denial is routine and unremarkable).
FR-011b requires the desktop degradation to be **visible**, because here it means "your USB stick is
read-only and your cert will not be remembered", which the user can act on. The change is in the
shell/UI, not in the persistence layer.

## Absolute carve-outs (FR-012 — no opt-in, no exceptions)

Never written to **any** location, including anything under `userData`:

- The `.p12` / certificate **password**
- **Decrypted private-key material**

Extends to indirect persistence — temp files, logs, crash dumps (constitution VI, v1.1.0). The
desktop shell therefore:

- **MUST NOT** call `crashReporter.start()` (a dump could contain in-memory key material)
- **MUST NOT** add any logging of application state to disk
- **MUST NOT** introduce a new store of any kind (see `data-model.md` § Entities explicitly NOT
  introduced)

## Disclosure (FR-013)

The user MUST be able to learn where state lives and remove it. Both are satisfied by:

1. Surfacing the resolved path and current mode (`adjacent` / `ephemeral`) in the app's info surface.
2. The existing "clear" affordance from 001, unchanged.
3. Documenting that deleting the artifact's folder removes everything.

## Honest caveat (Principle IV)

The Windows portable target extracts **its own program files** to temp while running and cleans them
on exit; a hard crash can leave them behind. This is application code, never user content — user
content lives in the relocated `userData` — so FR-012 is unaffected. But it means "leaves absolutely
nothing on the machine, ever" is **not** an accurate claim, and MUST NOT be made. SC-005 is assessed
against *user data*, and the temp-extraction behaviour is stated plainly rather than glossed.
