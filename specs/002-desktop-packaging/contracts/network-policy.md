# Contract: Desktop Runtime Network Policy

**Feature**: `002-desktop-packaging` | **Enforces**: FR-005, FR-006, FR-007 | **Principle**: I
(NON-NEGOTIABLE), as amended in constitution v1.1.0

Constitution v1.1.0 requires each distribution to enforce the **strongest network prohibition
available to it**, and forbids relying on a single mechanism where more than one exists. For a
packaged distribution that means CSP **and** runtime denial — the CSP is not replaced, it is joined.

## Layers (all four are required; none is sufficient alone)

| # | Layer | Mechanism | What it catches that the others don't |
|---|---|---|---|
| 1 | **Content Security Policy** | Existing `connect-src 'none'` meta tag in `index.html`, shipped unmodified | Renderer-originated requests, declaratively, identically to web |
| 2 | **Chromium session denial** | `session.defaultSession.webRequest.onBeforeRequest` → cancel unless scheme is allow-listed | Chromium-session requests CSP doesn't govern (e.g. non-renderer session traffic) |
| 3 | **Node-side prohibition** | No Node network API may be imported or called in `electron/**`; enforced by lint (below) | **Main-process traffic — which layer 2 CANNOT see** |
| 4 | **No updater** | `electron-updater` is **not a dependency** | Removes the mechanism entirely — there is no flag to misconfigure |
| 5 | **No crash/metrics reporting** | Never call `crashReporter.start()`; disable Chromium metrics via switches | Framework phone-home that ships enabled-by-default elsewhere |
| 6 | **External observation** | Release gate watches from outside the process (see Verification) | Attempts that fail silently and leave no in-app trace |

### ⚠ Layer 2 does NOT cover the main process

`session.webRequest` only intercepts **Chromium session** requests. Node's `fetch`, `http`, `https`,
`net`, `dgram`, and `tls` in the main process **bypass it entirely**. An earlier draft of this
contract claimed layer 2 "catches main-process requests" — that was **false**, and it mattered: an
implementation could have added a Node-side update check or exfiltration path and passed every gate
specified here. *(Codex, PR #7.)*

Layer 3 is therefore not decoration — it is the **only** thing standing between the main process and
the network:

- `electron/**` MUST NOT import `node:http`, `node:https`, `node:net`, `node:dgram`, `node:tls`, or
  any transitive HTTP client.
- `electron/**` MUST NOT call global `fetch`.
- **An import allow-list** governs `electron/**`: only explicitly-approved, non-network modules may be
  imported. A deny-list is insufficient — `import got from 'got'` (or `axios`, `undici`) walks past a
  builtins-only rule while using Node networking layer 2 cannot see.
- **⚠ `net` from the `electron` module is BANNED outside `electron/protocol.ts`.** Allow-listing the
  `electron` module as a whole is **not** enough: Electron's `net` is a full HTTP(S) client, so
  `import { net } from 'electron'` satisfies a module-level allow-list while handing the main process
  an outbound request primitive that bypasses every layer above. The lint rule MUST ban the `net`
  import *and* property access everywhere except the protocol handler. *(Codex, PR #7 — a bypass in
  the fix for the original bypass.)*
- `net.fetch` is permitted **only** inside `electron/protocol.ts`, solely to read `app:` assets from
  disk (it never touches a remote host).
- A **packaged-build dependency audit** additionally fails the build if any module reachable from
  `electron/**` in the shipped output pulls a network-capable dependency. Lint covers source; the
  audit covers what ships.

## Scheme registration — privileges and timing

`protocol.registerSchemesAsPrivileged` MUST be called **synchronously at main-process startup, before
the `ready` event**, and exactly once. Only `protocol.handle` waits for `app.whenReady()`.

**Why this is a correctness rule, not a style note**: if the privileged registration is wired inside
`app.whenReady()` — the natural place to put protocol setup — the `app:` scheme silently never
receives `standard`/`secure`/`supportFetchAPI`. The app may still appear to load while relative
assets, the Fetch API, and **IndexedDB** (i.e. all opt-in persistence) break **in the packaged
artifact only**. *(Codex, PR #7.)*

Privileges: `{ standard: true, secure: true, supportFetchAPI: true }`. **`bypassCSP` MUST be absent or
false** (see below). `allowServiceWorkers` is not needed — desktop builds do not register a service
worker.

### The handler must not be blocked by our own filter

The layer-2 allow-list cancels every scheme outside `app:`/`blob:`/`data:`. The `app:` handler itself
reads from disk (`net.fetch` over a `file:` URL). The filter MUST NOT cancel the handler's own asset
reads — **the app would fail to load at all**. Scope the filter to renderer/session-originated
requests, and verify the packaged app actually opens (T005 spike). *(Codex, PR #7.)*

## Allow-list (layer 2)

A request proceeds **only** if its scheme is one of:

| Scheme | Why | If wrongly blocked |
|---|---|---|
| `app:` | The application's own assets, served by our handler from `dist/` | App does not load at all — fails loudly |
| `blob:` | **The signed-PDF download** and in-memory previews | **Signing silently appears to work but no file is saved** — the highest-consequence mistake in this contract (R10) |
| `data:` | Inline images/fonts already used by the app | Appearance/preview breakage |

Every other scheme — `http:`, `https:`, `ws:`, `wss:`, `ftp:`, and any custom scheme — is **cancelled
unconditionally**. There is no allow-list entry for a remote host, and none may be added: a change
adding one is blocked by the constitution's privacy gate, not by review discretion.

## Additional locks

- `will-navigate` → **prevented** for any target outside `app:`. A stray link cannot navigate the
  window to a remote origin.
- `setWindowOpenHandler` → **deny by default**, with exactly one carve-out (below). No popups, no
  in-app window may ever reach a remote origin.

### Carve-out: the source-repository link (`shell.openExternal`)

The shipped app has a floating "View source on GitHub" link (`src/components/GitHubLink.tsx`,
`target="_blank"` → `https://github.com/kurtvalcorza/pdf-signer-pwa`). A blanket
`setWindowOpenHandler: 'deny'` would leave that control **visibly present and silently dead** on
desktop — a UI defect, and a breach of FR-020 (all 001 capability holds on desktop).

**Rule**: `setWindowOpenHandler` denies the in-app window in **all** cases, and for this **one exact
URL** additionally calls `shell.openExternal(url)` before returning `{ action: 'deny' }`.

Why this is not a loophole:

- **The application still makes zero requests.** It hands a URL to the operating system; the user's
  own browser — a separate process, outside this app's session and policy — does the fetching. No
  Electron window, session, or request is involved, so layers 1–2 are untouched and FR-006 ("MUST NOT
  contact any host") remains literally true of *this app*.
- **No user content moves.** The URL is a compile-time constant pointing at a public repository. It
  is not derived from the document, the signature, the certificate, or any user input.
- **It is user-initiated**, never automatic — nothing happens unless the user clicks.
- **It is allow-listed by exact string**, not by pattern or origin. A URL assembled at runtime, or
  any other URL, MUST NOT be passed to `shell.openExternal`. Widening this to "any https URL" would
  hand the app a general-purpose exfiltration primitive that bypasses every layer above — the exact
  failure this contract exists to prevent.

**It is also more valuable on desktop than on web**: an unsigned binary (FR-014) that points at its
own source is precisely where a cautious user goes to check what they are running and how to verify
it (FR-018a).

**Honest note**: clicking it while offline fails in the user's browser, as expected. That is the
browser's behaviour, not a degradation of this app — the signing tool itself never needed the
network.
- **`bypassCSP` MUST be `false`** on the `app:` scheme registration (R2). Setting it `true` — a
  common tutorial copy-paste — silently disables layer 1 while every existing test still passes. This
  is the single highest-risk line in the feature and is asserted from **inside** the packaged app by
  the gate, not left to code review.

## Verification (SC-004 — "observed from outside the app, not merely asserted internally")

| Check | Method | Gate |
|---|---|---|
| **Zero outbound ATTEMPTS** (SC-004) | Run the packaged binary with networking **available but monitored** — a firewall/proxy/packet capture that logs and blocks — through the full lifecycle: launch, sign, idle, quit. **Fail on any DNS query or TCP/HTTP attempt**, successful or not | **Primary gate** (FR-006) |
| Works with no network at all | Run with **no network interface**; complete a full signing flow | Must succeed identically to a networked run |
| CSP (layer 1) alive in the shipped artifact | Assert a `securitypolicyviolation` event fires for a `connect-src` violation; assert `bypassCSP` absent from the registered privileges | Desktop E2E (`desktop-privacy.spec.ts`) |
| Layer 2 + allow-list | A synthetic `https:` request is cancelled; a real signed-PDF download completes (proves `blob:` allowed) | Desktop E2E |
| Layer 3 (Node-side) | Lint rule passes; assert no HTTP client in the packaged `electron/**` | Build-time check |

> **Why "runs offline" is not the primary gate**: with no interface present, a stray telemetry or
> update call fails instantly, records nothing, and the app still signs — so the run passes while the
> attempt happened. The spec demands SC-004 be "observed from outside the app, not merely asserted
> internally", and only a monitored-but-live network can distinguish *made no request* from *made a
> request that failed*. The offline run is retained as a **separate** check, because it proves a
> different thing (the app doesn't degrade). *(Codex, PR #7.)*
| No updater present | Assert `electron-updater` absent from the dependency tree and the packaged app | Build-time check |
| Repo link works, and only it | Clicking "View source on GitHub" invokes `shell.openExternal` (not an in-app window); assert **no other** URL can reach `openExternal` | Desktop E2E |

## Honest limits (Principle IV — state these, do not imply otherwise)

- This policy makes the app **structurally incapable of outbound requests**; it is an enforced
  control, not a mathematical proof. It is described as such wherever it is surfaced.
- It governs **this application's** behaviour only. It says nothing about the host OS, and it is not
  a sandbox against a compromised machine.
- The four layers are defence-in-depth against *our own* future mistakes as much as against attack —
  that is why no single one is treated as sufficient.
