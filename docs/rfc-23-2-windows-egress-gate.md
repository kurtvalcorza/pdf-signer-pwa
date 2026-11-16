# RFC 23-2: Packet-level no-egress gate on Windows, scoped to the app's process tree

Status: **accepted 2026-11-15; gate drafted and measured on the runner 2026-11-16, not yet merged**
(evidence in [§10](#10-runner-evidence-phase-0-2026-11-16); its one finding, F1, is fixed in
`electron/main.js` by owner decision of 2026-11-16, [§8](#8-open-questions-for-kurt) question 3). Issue #23, item 2; it came from #12 and SEC-14
([audit.md](audit.md)). Owner decisions recorded in [§7](#7-owner-decisions): B1 (a), B2 (a),
B3 (b) gate-only probe build, B4–B7 (a).

## Summary

SC-004 requires a monitored run of the packaged app: launch, sign, idle and quit, with a **fail
on any egress, by any protocol, over the whole process tree**
(`specs/002-desktop-packaging/contracts/release-artifacts.md`). Linux meets that with a network
namespace and `tcpdump` (`release-desktop.yml`). Windows does not.
`scripts/windows-egress-check.ps1` polls `Get-NetTCPConnection` and `Get-NetUDPEndpoint` in a
loop, which has two gaps:

1. A connection opened and closed between two polls is missed.
2. DNS goes through the DNS Client service (`svchost`, Dnscache), so a lookup is never seen as
   the app's socket.

This RFC recommends making the decision **at connect time instead of sampling**:

- Put an outbound **block** filter on the app's own executable.
- Turn on WFP connection auditing.
- Fail the gate on any blocked or permitted non-loopback connection event whose process is in the
  app's process tree.
- Add DNS-Client ETW for name-resolution attribution.
- Run a **deliberate short-lived probe** through the same packaged binary as a positive control,
  so that a pass means something.

Evidence labels: **[MS]** is a Microsoft Learn page (see Sources). **[GH]** is GitHub Docs.
**[repo]** is this repository at `origin/main` `02ef745`. **[inferred]** is reasoning not yet
run on a runner; the test plan (§6) confirms or refutes each one. §10 records what the runner
showed on 2026-11-16 and takes precedence over an **[inferred]** label wherever they differ.

## 1. Requirements the gate must meet

| ID  | Requirement                                                                                                                               |
| :-- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Fails on a deliberate outbound attempt **however short-lived**: TCP connect, UDP send, and a name lookup.                                 |
| G2  | Passes on the packaged build (`release\win-unpacked\PDF Signer.exe`, driven by `electron/verify-packaged.mjs`) through a real sign.       |
| G3  | Scoped to the app's **process tree**. The runner agent, Defender and Windows Update keep their network, so the job can still report back. |
| G4  | Runs on a GitHub-hosted `windows-latest` runner, with no third-party driver and no new npm or pip dependency.                             |
| G5  | Proves its own sensitivity on every run (a positive control), like the current script's TCP and UDP controls.                             |

## 2. Options evaluated

### A. WFP: filter with logging, net events, or a callout

- **What it gives [MS].** With the auditpol subcategory **Filtering Platform Connection**
  (`{0CCE9226-69AE-11D9-BED3-505054503030}`) enabled, WFP writes Security-log events. These
  include **5156** (connection permitted), **5157** (connection blocked), **5158** and **5159**
  (bind permitted or blocked), and **5154** and **5155** (listen). **Filtering Platform Packet
  Drop** (`{0CCE9225-69AE-11D9-BED3-505054503030}`) adds **5152** (packet dropped) and **5153** (vetoed). WFP auditing is
  off by default, and only `auditpol.exe` can enable a single subcategory. Event 5157 carries
  `ProcessID`, `Application` (the full `\device\harddiskvolumeN\…` path), `Direction`, the source
  and destination address and port, `Protocol`, `FilterRTID` and `LayerName`, which is an ALE
  layer.
- **Why it meets G1 [MS; inferred for the timing].** ALE (Application Layer Enforcement)
  classifies at **connection authorisation**: `connect()` for TCP and the first send to a new
  remote for UDP. That happens **before any packet leaves**. So an attempt is recorded as an
  event however briefly the socket lives, and a sampler cannot miss it the same way. That this
  happens for an attempt closed within microseconds is the claim the probe (§6) must confirm.
- **Net events** (`FwpmNetEventEnum`, `netsh wfp show netevents`) are a second, non-Security-log
  record. **[inferred]** Collection is on by default, and all outbound events are collected. The
  `FwpmEngineSetOption0` remarks say so, but the review did not re-check that page, and nothing
  has been observed on a runner. They are useful as a cross-check, but they need P/Invoke or `netsh` XML
  parsing to read.
- **A callout** needs a signed kernel driver. That fails G4. Rejected.
- **A custom user-mode filter** (`FwpmFilterAdd0` in a dynamic session, conditioned on
  `FWPM_CONDITION_ALE_APP_ID`, at `FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6`) is possible from
  PowerShell through `Add-Type` with no new dependency. It is more code to own than option E,
  which reaches the same WFP layers through the firewall service.
- **Dual-stack caveat [MS, ALE page].** For a true dual-IP socket, classification at the IPv4 ALE
  layer may not occur; its IPv4 traffic is classified at the IPv6 layer under an IPv4-mapped
  address. So any filter, and the judging step, must cover the V6 layers and treat
  `::ffff:a.b.c.d` as IPv4. Firewall rules apply to both stacks.

### B. ETW Microsoft-Windows-Kernel-Network and TCPIP providers

- **[inferred]** Microsoft-Windows-Kernel-Network emits per-process TCP connect and UDP send
  events with a PID. Process-tree attribution needs a parallel Microsoft-Windows-Kernel-Process
  session for process start events. `logman` can record both to an `.etl`, and
  `Get-WinEvent -Path *.etl -Oldest` can read it, with no new tools.
- Weaknesses: Microsoft does not publish these providers' event schemas as a supported contract,
  so field names can change between builds. Kernel sessions also drop events under load, and a
  dropped event fails G1 silently unless the session's lost-event count is checked.
- Verdict: a good **secondary witness**, not the primary gate.

### C. pktmon with filters

- **[MS]** `pktmon filter add` matches by MAC, VLAN, ethertype, transport protocol, IP, port,
  heartbeat and encapsulation. **There is no process or application filter.** A capture is
  host-wide, so the runner agent's own HTTPS traffic would be in it.
- Verdict: fails G3. Rejected as a gate. It is still useful for diagnosis when the gate fails,
  for example `pktmon start --capture` followed by `pktmon etl2pcap`.

### D. Windows Sandbox, or isolation with no route

- Windows Sandbox needs Hyper-V or virtualisation support. **[inferred]** Standard GitHub-hosted
  Windows runners do not offer nested virtualisation, so it is unavailable on `windows-latest`.
- Windows has no unprivileged network namespace. AppContainer or LPAC with no network
  capabilities would block network access, but Electron is not built to launch as an
  AppContainer, and doing so would change the product under test.
- Verdict: fails G4 or changes the binary's environment. Rejected.

### E. Deny-all outbound firewall rule for the app's binaries, plus the WFP audit log (recommended)

- `New-NetFirewallRule -Direction Outbound -Program <exe> -Action Block` installs WFP filters at
  the ALE connect layers for that application [MS: Windows Firewall is built on WFP]. With
  Filtering Platform Connection auditing on, every attempt by that image appears as **5157**,
  with its PID.
- **Process-tree scope.** Electron's renderer, GPU, utility (network service) and crashpad
  processes are the **same executable** launched with `--type=…`, so a rule on one program path
  covers the whole tree **[inferred; confirmed in §6 step 4]**. Any child running a _different_
  image is not covered by the rule. The gate must detect that case and fail on it (§4).
- **Fails closed both ways.** A blocked attempt yields 5157. An attempt that somehow got
  through yields 5156. The gate fails on either one.
- **Risk.** If the runner's firewall profiles are disabled, `-Program` rules are not enforced
  **[inferred]**. The gate must either enable the profile (`Set-NetFirewallProfile -Enabled True -DefaultOutboundAction Allow`)
  or prove enforcement through the positive control. It does both.

## 3. DNS attribution

- If Chromium resolves names itself (its built-in async DNS client), the queries are UDP/TCP 53
  from the app's own image. Option E then catches them as 5157 **[inferred]**.
- If resolution goes through the system resolver, the query is sent by Dnscache inside `svchost`.
  The app's firewall rule does not cover it, and 5156 for that query names `svchost.exe`. This is
  the gap the current script documents.
- Proposal: run a **Microsoft-Windows-DNS-Client** ETW session for the gate's duration, with
  `logman start … -p Microsoft-Windows-DNS-Client`, or by enabling the
  `Microsoft-Windows-DNS-Client/Operational` channel. Fail on any query event whose header
  `ProcessId` is in the app's tree.
  - **[inferred]** The client-side query events (for example 3006 "query called" and 3008
    "query completed") are logged in the **calling** process's context, so the header PID is the
    app's. Secondary write-ups say so; no Microsoft page seen in this pass does.
- **There are two resolver paths, and the probe must cover both.** Node's `dns.lookup` in the
  main process uses getaddrinfo, the system resolver. Chromium's host resolver runs in the
  **network-service utility process**. Depending on its configuration, it either calls the system
  resolver from that process or uses its built-in DNS client **[inferred]**. A renderer or session
  request takes the Chromium path, which is the one most likely to leak. So decision B2 rests on
  the results for **both** probes (§4 step 3), not on the Node one alone. If attribution works
  for one path and not the other, the check gates on the path that works, and the other is
  recorded as a gap.
- A name lookup with no connection afterwards still discloses the name to the resolver. So the
  DNS check is part of SC-004, not a nicety.

## 4. Design (recommended)

A new `scripts/windows-egress-gate.ps1`, run in place of today's step in `release-desktop.yml`.
The shape is **[inferred]**; no script is written by this RFC.

1. **Preconditions.**
   - Running elevated: `[Security.Principal.WindowsPrincipal]` is Administrator. [GH] says
     Windows runners run as administrators with UAC disabled.
   - Firewall profiles enabled, outbound default Allow.
   - Raise the Security log size (`wevtutil sl Security /ms:<bytes>`) so the audit volume
     cannot roll over the window.
   - Record `StartTime`.
2. **Arm.**
   - Enable auditing by GUID, because the subcategory names are localised [MS]:
     - Filtering Platform Connection:
       `auditpol /set /subcategory:"{0CCE9226-69AE-11D9-BED3-505054503030}" /success:enable /failure:enable`
     - Filtering Platform Packet Drop: the same command with
       `{0CCE9225-69AE-11D9-BED3-505054503030}`
     - Process Creation (event 4688): `{0CCE922B-69AE-11D9-BED3-505054503030}`. This GUID is from
       memory **[inferred]**; confirm it with `auditpol /list /subcategory:* /v` before use. Also
       enable "Include command line in process creation events" so the `--type=` of each child is
       recorded.
   - `New-NetFirewallRule -Direction Outbound -Action Block -Program <abs path of PDF Signer.exe>`,
     plus one for every other image in the package's `win-unpacked` directory (any `*.exe`).
   - Start the DNS-Client ETW session.
   - Take a **baseline** of out-of-tree 5156 events to ports 80, 443 and 445 (System PID 4,
     `svchost`), for the false-negative checks in §5a.
3. **Positive control (G5).** Launch the packaged app through Playwright, as
   `verify-packaged.mjs` does. The probe mechanism is decision B3. Make the app attempt the
   following, through **both** network stacks it contains:
   - **Node, main process:** a TCP connect to `192.0.2.1:443` (TEST-NET-1), closed immediately;
     a UDP send to `198.51.100.1:53` (TEST-NET-2); and `dns.lookup('egress-probe-node.invalid')`.
   - **Chromium, network service:**
     - `session.defaultSession.resolveHost('egress-probe-chromium.invalid')`;
     - `net.request('http://192.0.2.2/')` from the main process;
     - a renderer `fetch('http://192.0.2.3/')`. This one is expected to be stopped by CSP and the
       layer-2 `webRequest` block before any socket is opened, so it is a **negative control**:
       it must produce **no** WFP event. If it does produce one, a layer above WFP has failed.
       That is a finding, and the gate fails.

   The gate requires **5157** events for every TEST-NET attempt except the renderer fetch. Each
   must be attributed to a tree PID, and the Chromium ones must carry the **network-service
   child's** PID (identified by `--type=utility` in its 4688 command line). If B2 is (a), the gate
   also requires DNS-Client events for whichever lookups §6 step 3 proved attributable. Any
   missing event fails the gate with "control failed".

4. **Real run.** Start a fresh launch with `PDFSIGNER_SKIP_VALIDATE=1`, and run the full
   `verify-packaged.mjs` flow: launch, sign, idle, quit.
5. **Collect and judge** over `[StartTime, now]`:
   - **Tree** comes from Security event **4688** (New Process ID, Creator Process ID, New Process
     Name), which is in the same log the gate already reads. The 5152 page points to 4688 for PID
     correlation [MS]. This replaces the undocumented Kernel-Process ETW used in the first draft.
     Tree members are keyed on **(PID, 4688 time)** and closed by 4689 (process exit), so a PID
     reused by an unrelated process later in the window is not counted as the app's. A network
     event belongs to the tree only if its PID was a live tree member at the event's time. A
     child whose image is not in the package directory fails the gate (G3), unless it is on an
     explicit allow-list kept in the script. The allow-list starts empty.
   - **Fail** on any 5156, 5157 or 5152 whose `ProcessID` is in the tree and whose destination
     is unicast and not `127.0.0.0/8`, `::1` or `::ffff:127.0.0.0/104`.
   - **Multicast and broadcast are excluded, matching the Linux gate.** The Linux leg drops them
     with `'not multicast and not broadcast'` (`release-desktop.yml:126-130`), on the reasoning
     that ND, mDNS and IGMP are stack noise. Windows uses the same rule: destinations in
     `224.0.0.0/4`, `ff00::/8`, `255.255.255.255` or the subnet broadcast are **logged, not
     failed**. An app-originated mDNS or SSDP packet is therefore a residual on both platforms,
     recorded the same way in audit.md.
   - **Fail** on any DNS-Client query from a tree PID (if B2 is (a)).
   - **Log, do not fail**, on 5158 binds. A wildcard UDP bind is not traffic. The 5157 on the
     first send is what counts.
   - **Out-of-tree checks (§5a), per decision B7.**
6. **Disarm** in a `finally` block: remove the rules, restore auditpol, stop the ETW session,
   and upload the filtered events as an artifact on failure. The runner is ephemeral, but the
   cleanup keeps the step safe to run locally.

The portable wrapper `.exe` extracts and relaunches from `%TEMP%`. The gate stays on
`win-unpacked`, as today. Covering the wrapper would need a rule on the extracted path, which is
only known after launch (open question 2).

## 5. False-positive sources

| Source                                                | Expected behaviour                                                                                                                              | Handling                                                                                   |
| :---------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| Electron, Chromium network service                    | Same image, so it is under the rule. No traffic expected: CSP `connect-src 'none'` and the layer-2 `webRequest` block **[repo]**.               | Anything seen is a real finding.                                                           |
| Chromium component updater, variations, Safe Browsing | Electron does not ship Google's updater or field-trial services **[inferred]**.                                                                 | Any attempt is a real finding. That is the point of SC-004.                                |
| Crash reporter (crashpad)                             | Same image with `--type=crashpad-handler`. `crashReporter.start()` is absent (release-artifacts layer-5) **[repo]**.                            | Upload attempts would fail the gate, correctly.                                            |
| Certificate revocation (CRL/OCSP, AIA fetch)          | The app does no TLS. Authenticode checks of the unsigned binary are made by the OS (Defender, SmartScreen), not by the app tree **[inferred]**. | Outside the tree by PID. A revocation fetch attributed to the app would be a finding.      |
| SmartScreen and Defender scanning the new `.exe`      | Different processes (`smartscreen.exe`, `MsMpEng.exe`)                                                                                          | Out of tree, so ignored. Logged for evidence.                                              |
| Dnscache resolving for others                         | `svchost`                                                                                                                                       | Ignored, unless a DNS-Client event attributes the query to a tree PID.                     |
| Loopback (Playwright CDP/inspector)                   | `127.0.0.1`                                                                                                                                     | Excluded by address. The inspector is how `verify-packaged.mjs` drives the app **[repo]**. |
| IPv6 router or neighbour discovery, multicast         | Kernel, not the app                                                                                                                             | Out of tree.                                                                               |
| Runner agent and telemetry                            | `Runner.Worker.exe`, and so on                                                                                                                  | Out of tree. Not blocked, so G3 holds.                                                     |

`electron/main.js:24-27` also sets `disable-background-networking`, `disable-component-update`,
`disable-domain-reliability` and `disable-breakpad` **[repo]**. So the updater and crash-upload
rows above are expected to stay silent, and the different-image check should not be tripped by
crashpad.

## 5a. Known false negatives: egress the app causes but does not send

The per-image block rule and the PID-tree judgement only see traffic **sent by the app's own
processes**. SC-004 says "any egress", so each case below is either checked or written down as
out of scope. None of them is stopped by the block rule, so if it happens, the name or request
still leaves the runner.

| Case                                                                                                                | Who sends it                                                        | Status under B7 (a)                                                                                                                                                                                                                                                                                                  |
| :------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS through the system resolver                                                                                     | Dnscache (`svchost`)                                                | **Checked** through DNS-Client ETW attribution (§3, B2).                                                                                                                                                                                                                                                             |
| UNC or WebDAV path open (for example `\\host\share\x.pdf` through the file dialog, or a link)                       | SMB redirector (System, PID 4) or the WebClient service (`svchost`) | **Checked**: fail on any new out-of-tree 5156 to port 445, 139 or 80 from PID 4 or the WebClient `svchost` during the window, compared with the baseline from step 2. The gate's own flow opens only local paths, so any such event is a finding **[inferred: the runner may have background SMB; baseline first]**. |
| Proxy auto-detection (WPAD): the WinHTTP Auto-Proxy service resolving `wpad` or fetching a PAC file                 | `svchost` (WinHttpAutoProxySvc)                                     | **Out of scope, recorded.** It is host behaviour, not attributable to one request. Chromium's own proxy resolution would show up in the tree (same image) and is covered.                                                                                                                                            |
| A process launched through the shell, `shell.openExternal(REPO_URL)` (`electron/network.js:47`)                     | The default browser, which is not parented to the app               | **Out of scope by design**: it is a disclosed, user-initiated, exact-URL hand-off (FR-020). The gate's flow never clicks the link. The tree check still catches a _child_ process with another image. A shell-brokered launch is not a child, so it is listed here.                                                  |
| Certificate revocation (CRL, OCSP or AIA) done by the OS for the app's binary or for any certificate the app parses | CryptSvc, `svchost`, or SmartScreen                                 | **Out of scope, recorded.** The app does no TLS. The OS may revoke-check the unsigned binary's environment on its own schedule. A revocation fetch _from a tree PID_ would be caught as a 5157.                                                                                                                      |

Every "out of scope, recorded" row goes into audit.md next to SEC-14, so the Windows claim says
exactly what it covers. This is the "a claim must not outrun its mechanism" lesson from the 002
review (CLAUDE.md).

## 6. Test plan

1. **Probe-detects-short-lived (G1).** On the runner, the positive control (§4 step 3) produces
   two 5157 events with the app's PID and image path. The TCP socket is closed in under 1 ms.
   Repeat 20 times in one job; the evidence bar is 20 detections out of 20. Record whether 5156
   or 5157 appears for a connection the rule did _not_ cover (a control run with the rule
   removed). This is what shows auditing alone sees a permitted short connection.
2. **Old sampler misses it.** Run the same probe under `windows-egress-check.ps1` and record
   how many of the 20 it misses. This is the before and after number for audit.md SEC-14. A miss
   rate of 0 would mean the sampler's gap is theoretical on this runner; record it either way.
3. **DNS attribution (B2).** Record, separately for each, whether the Node lookup
   (`egress-probe-node.invalid`) and the Chromium `resolveHost` lookup
   (`egress-probe-chromium.invalid`) appear in the DNS-Client session with a tree PID, and which
   PID: main or network service. Also record whether the Chromium lookup instead shows up as UDP
   53 from the network-service PID, as a 5157. These results decide B2, per path.
   - **3a.** **Chromium paths reach WFP.** `net.request` to `192.0.2.2` produces a 5157 from the
     network-service PID. The renderer `fetch` produces none, because CSP and layer 2 stop it first.
4. **Tree coverage.** The 4688 events show every child of the root running the same image. A
   synthetic PID-reuse case is checked: an unrelated process started after a tree member exits,
   reusing its PID, must not be counted. Then a test-only probe spawns `cmd.exe /c exit`, a different image, and the gate must
   fail with "unexpected image in process tree".
5. **Pass on the real build (G2).** The full launch, sign, idle and quit run yields zero failing
   events, and the job passes. Do this on 3 consecutive release-workflow runs (a
   `workflow_dispatch` dry run) before the old step is removed.
6. **Negative control on the gate itself.** With the firewall profile deliberately disabled, the
   positive control must fail as "control failed", not pass silently.
7. **Cleanup.** After the step, `Get-NetFirewallRule` shows none of the gate's rules, and auditpol
   is restored.

Done-when, from issue #23: steps 1 and 5 pass, with step 6 shown to fail closed.

## 7. Owner decisions

**Decided 2026-11-15 by the owner:** B1 (a), B2 (a), B3 (b), B4 (a), B5 (a), B6 (a), B7 (a). Turning
the inspector fuse off in release builds, and asserting the fuse state in `verify-packaged.mjs`, is
tracked as a separate security follow-up (issue #33: the release now has the fuse off, the packaged
gates drive a gate-only probe build, and `scripts/check-fuses.mjs` asserts both fuse sets). The options below are kept as the record of what was
weighed.

**B1. Mechanism**

- **(a) Option E: a firewall block rule per packaged image, WFP connection and packet-drop
  auditing, the PID tree from Security event 4688, and a positive probe through both network
  stacks. Recommended.**
- (b) Option A: our own WFP dynamic-session filter through `Add-Type`. It does not depend on the
  firewall profile state, but it is about 200 more lines to own.
- (c) Option B: ETW Kernel-Network alone. No blocking, and an undocumented schema.
- (d) Keep socket sampling and document the gap permanently.

**B2. DNS**

- **(a) DNS-Client ETW is a gating check for each resolver path (Node getaddrinfo, Chromium host
  resolver) that §6 step 3 shows it attributes to a tree PID. Any path it cannot attribute is
  informational, with the residual gap written in audit.md. Recommended.**
- (b) Always informational.
- (c) Leave DNS out of scope for Windows.

**B3. The inspector fuse, and how the probe reaches the packaged binary**

Today the release binary keeps `enableNodeCliInspectArguments` on (`electron-builder.yml:13-20`
**[repo]**), because `verify-packaged.mjs` drives the app through the inspector. That means anyone
who launches the shipped `.exe` with `--inspect` gets code execution in the main process. This
partly undercuts the burned `runAsNode` and `NODE_OPTIONS` fuses. The exposure **already exists**;
this RFC does not add it. But option (a) would make a second release gate depend on it.

- (a) **Keep the inspector fuse on, and probe through it** with `electronApp.evaluate` in the
  main process. The tested binary is byte-for-byte the shipped one, and no probe code enters
  `electron/`. Cost: the `--inspect` exposure stays for as long as the gates need it.
  **[inferred]** Whether the evaluate context can reach `net` and `dgram` in an ESM main is
  unknown.
- (b) **A separate gate-only probe build, or an environment-gated hook.** The same commit is
  built a second time with a probe module (outside `electron/`), or with the hook compiled in
  only when a build flag is set. Both the egress gate and `verify-packaged` can then run against
  it. Cost: the gated binary differs from the shipped one by the probe (and by a fuse, if (c) is
  also chosen). An environment-gated hook compiled into the _shipped_ binary is not acceptable,
  because it is a dormant network path.
- (c) **Turn the inspector fuse off in release for security, and probe another way**: (b)'s gate
  build, or a standalone probe `.exe` in the package directory, which is covered by the per-image
  rules but proves less about the real binary. Cost: `verify-packaged.mjs` must also move to the
  gate build, or to a driver that does not need the inspector.
- **Recommended: (b) now, with (c) as a follow-up SEC-03 item.** The probe does not come to
  depend on the inspector, and turning the fuse off later changes no gate.

Whichever is chosen, a **follow-up**: assert the fuse state the team chose in
`verify-packaged.mjs` (`@electron/fuses` read on the packaged binary). It is not asserted
today (`verify-packaged.mjs:37-43`).

**B4. The existing socket sampler**

- **(a) Keep it as a secondary witness for one release, then delete it. Recommended.**
- (b) Delete it when the new gate lands.

**B5. Where the gate runs**

- **(a) `release-desktop.yml` only, as today. Recommended**: it needs the packaged build and
  changes runner security settings.
- (b) Also on `ci.yml` PRs, which adds an electron-builder packaging step to every PR.

**B6. Multicast and broadcast**

- **(a) Log but do not fail, the same rule as the Linux gate (§4 step 5). Recommended**: one
  rule on both platforms.
- (b) Fail on them on both platforms. That needs a Linux change too, and it accepts stack noise
  as a failure risk.

**B7. Egress the app causes but does not send (§5a)**

- **(a) Check DNS and UNC/WebDAV (out-of-tree 5156 to ports 445, 139 and 80 from System or
  WebClient, compared with a baseline). Record WPAD, shell-launched processes and OS revocation
  checks as out of scope in audit.md. Recommended.**
- (b) Only the in-tree checks plus DNS, with every out-of-tree case recorded as a gap.
- (c) Treat any out-of-tree egress during the window as a failure. Not recommended: the runner's
  own background traffic would make the gate flaky.

## 8. Open questions for Kurt

1. ~~Is a 20/20 detection run on one runner image enough evidence?~~ **Decided 2026-11-16:**
   the positive control runs on every release (3 attempts per protocol); the 20/20 run is
   repeated only when `windows-latest` moves to a new Server release. Evidence so far:
   20/20 TCP and 20/20 UDP in each of runs 43802298765, 43804844070, 43805710270 and
   43806349805, all on
   Server 2025 (10.0.26100).
2. ~~Should the portable wrapper `.exe` be monitored?~~ **Decided 2026-11-16:** stay on
   `win-unpacked`. The wrapper's `%TEMP%` extraction is a named residual in audit.md.
3. ~~Finding F1 (§10): the app looks up `wpad` on every launch.~~ **Decided 2026-11-16: (a).**
   `electron/main.js` now sets `no-proxy-server` before `ready`, and the desktop E2E asserts the
   switch. The gate stays strict, with no allow-list. The options are kept as the record.
   - **(a) Chosen:** add `app.commandLine.appendSwitch('no-proxy-server')` to
     `electron/main.js` in its own change. The app makes no requests, so it needs no proxy.
     Measured: the lookup disappears (run 43804844070) and the strict gate passes
     (runs 43805710270 and 43806349805). Checked locally on Windows after the change: lint,
     type-check, 160 unit tests, 8 desktop E2E tests, `check-fuses` (probe and release still
     differ by one byte). Linux: the switch is platform-independent Chromium and nothing in the
     repository configures or reads a proxy, so no effect is expected; the Linux desktop E2E and
     the namespace gate in CI are what will confirm it.
   - (b) Allow-list `wpad` in the workflow (`-AllowDnsName 'wpad','wpad.*'`) and record it
     as a residual in audit.md. The lookup keeps leaving the user's machine, and
     `docs/desktop.md` must stop saying the build never contacts a network.
   - (c) Land the gate report-only until (a) ships.
4. **Open, cannot be answered on a hosted runner.** The runner is elevated, so every result
   in §10 was obtained as an administrator. Whether the DNS-Client channel can be enabled and
   read, or the Security log read, from an unelevated session was **not tested**. The gate
   requires elevation anyway (audit policy and firewall rules), so this only matters if a
   reduced, unelevated variant is ever wanted, for example on a developer machine.
5. **Open, minor.** The three-consecutive-dry-run bar of §6 step 5 is not met yet: two strict
   passes exist (runs 43805710270 and 43806349805, both with the F1 fix applied on a throwaway
   branch). The rest belong on `release-desktop.yml` dry runs of the branch that carries the fix.
   The committed `electron/main.js` line passed the armed gate once, in run 43814441249, in a
   temporary workflow that invokes the gate as the release workflow does.

## 9. Effort

About **4–6 working days [inferred]** (raised from 3–4 after review). Alternatively, split it:
spend one day on runner experiments (§6 steps 1–4 and 6) first, then re-estimate the script.

| Part                                                                                                   | Estimate   |
| :----------------------------------------------------------------------------------------------------- | :--------- |
| `windows-egress-gate.ps1`: arm, judge with the 4688 tree and PID reuse, disarm, event parsing          | 1.5–2 days |
| Probes through both stacks (B3 mechanism), the tree check, §5a baseline checks                         | 1–1.5 days |
| Runner experiments §6 steps 1–4 and 6, with evidence in audit.md                                       | 1–1.5 days |
| Workflow wiring, 3 dry runs, docs (`desktop.md`, release-artifacts SC-004 wording, audit.md residuals) | 0.5–1 day  |

## 10. Runner evidence (Phase 0, 2026-11-16)

Everything in this section was **measured** on GitHub-hosted `windows-latest`
(Windows Server 2025, 10.0.26100, image `win25-vs2026` 20261103.298.1), on a throwaway branch
that has since been deleted. The raw events of run 1 are kept, trimmed, in
`scripts/fixtures/egress-gate/run-43802298765.json` and replayed by
`scripts/windows-egress-gate.ps1 -SelfTest`. It replaces the matching **[inferred]** labels above.

| Run | What it ran | Result |
| :-- | :-- | :-- |
| [43802298765](https://github.com/kurtvalcorza/pdf-signer-pwa/actions/runs/43802298765) | Experiment script: baseline, armed controls, real sign flow, release idle, firewall off, rules removed | All phases completed |
| [43804844070](https://github.com/kurtvalcorza/pdf-signer-pwa/actions/runs/43804844070) | The drafted gate, strict with 20 repeats, then with `wpad` allow-listed, then with firewall profiles off; `--no-proxy-server`; old sampler against a closing peer | Controls 20/20; strict failed on `wpad` only (plus a marker bug, fixed); firewall off failed closed |
| [43805710270](https://github.com/kurtvalcorza/pdf-signer-pwa/actions/runs/43805710270) | The gate, strict with 20 repeats, against a build with `no-proxy-server` added in `electron/main.js` (throwaway branch only) | **Passed**, 0 problems; firewall off failed closed |
| [43806349805](https://github.com/kurtvalcorza/pdf-signer-pwa/actions/runs/43806349805) | The same, with the gate as committed (SMB/WebDAV check added) | **Passed**, 0 problems; firewall off failed closed; 0 rules left |
| [43812388020](https://github.com/kurtvalcorza/pdf-signer-pwa/actions/runs/43812388020) | The final gate, invoked as `release-desktop.yml` invokes it, on the committed `no-proxy-server` line | Stopped **before the gate**: the fuse step, copied from `release-desktop.yml`, found no exe in the unpacked portable (the app is in a nested `app-64.7z`). Fixed by extracting twice |
| [43814441249](https://github.com/kurtvalcorza/pdf-signer-pwa/actions/runs/43814441249) | The same, with the two-stage extraction | **Passed**, 0 problems: controls 3/3 TCP and 3/3 UDP; sign flow clean; release exe from `release/portable-extract` clean; 0 rules and 0 app processes left |

### What was confirmed

- **Connect-time decision (G1, §6 step 1).** With the per-image outbound block rule, 20 of 20
  Node TCP connects to `192.0.2.1` and 20 of 20 UDP sends to `198.51.100.1` each produced a
  **5157** (and a 5152) carrying the main process's pid and the probe's image path. The connects
  failed with `EACCES` in 0.3–2.7 ms. Repeated in runs 2, 3 and 4: 80 of 80 for each protocol.
  A blocked UDP `send` reports success to the caller; only the audit event shows it.
- **Auditing alone sees permitted short connections.** With the rules removed, 5 of 5 two-millisecond
  connect attempts and 20 of 20 connect-then-close connections produced a **5156**.
- **The old sampler misses them (§6 step 2).** Against the same attempts it saw 1 of the 5
  two-millisecond attempts, and **0 of 20** connections to a peer that closes at once (run 2).
  In run 1 it saw 20 of 20 only because that peer never closed, which left the sockets lingering.
- **Children are covered.** The rule is per image, and the GPU, network-service and renderer
  processes run the same exe. Chromium's attempts were blocked in the network-service child.
- **Process tree (§6 step 4).** 4688/4689 gave the whole tree: root, GPU, network service,
  renderer. A `cmd.exe` spawned from the main process appeared with its `conhost.exe` child, so a
  foreign image is detected. The network service is identified from `app.getAppMetrics()`, so
  the "include command line" audit policy is **not** needed and the gate does not set it.
- **Chromium controls (§6 step 3a, the claim this RFC expected to be wrong).**
  `net.request` on `defaultSession` to `192.0.2.2` ended in `net::ERR_BLOCKED_BY_CLIENT` within
  2 ms and left **no** WFP event: layer 2 cancels it before a socket exists, so it cannot be a
  positive control. The same request through `session.fromPartition('egress-gate-control')` ended
  in `net::ERR_NETWORK_ACCESS_DENIED` and produced a 5157 from the network-service pid. The
  renderer `fetch` was rejected and left no event. Design as built: partition request positive,
  `defaultSession` request and renderer `fetch` negative.
- **Reaching Node from the inspector (B3).** `process.mainModule.require('node:net')` works in
  `electronApp.evaluate` on the fuse-on probe (Electron 43.8.7, Node 24.22.1), and so does
  `process.getBuiltinModule`. No probe code is in any binary.
- **DNS attribution (§3, §6 step 3, B2).** The `Microsoft-Windows-DNS-Client/Operational` channel
  and a `logman` ETW session both recorded the lookups. Event 3006 is logged in the calling
  process: the Node `dns.lookup` carried the main pid, the Chromium `resolveHost` the
  network-service pid. The resolver service's own events (3009, 3010) carry a `ClientPID` field
  with the same pid, and 3010 names the DNS server the query went to. Chromium **also** tried
  its built-in client first: 4 UDP 53 attempts from the network service, each a 5157. Both paths
  are attributable, so B2 (a) gates on both. The gate uses the channel, not `logman`.
- **Noise.** About one event per second host-wide, all outside the tree: the Azure guest agent,
  the runner's own agents, Dnscache, Defender, and inbound drops with pid 0. Inside the tree a
  clean run has only the loopback inspector connection and socket binds. No multicast or
  broadcast packet came from the app. No SMB or WebDAV client connection appeared in any window.
- **Fail closed (§6 step 6).** With the firewall profiles disabled the same attempts were
  **allowed** (5156, filter id 0), so no 5157 exists and the controls fail. The gate stops
  earlier, at a precondition that names the disabled profiles.
- **Cleanup (§6 step 7).** No gate rule was left after any run. `auditpol /get /category:* /r`
  was identical before and after. A restored `auditpol /backup` file is **not** byte-identical
  when backed up again (two `GlobalSacl` rows are added), so the gate compares the `/get` text.
- **Preconditions.** The runner is elevated, all three firewall profiles are
  enabled, and the Security log is 20 MB by default (the gate raises it and restores it).

### Things that differ from the design text

- 4688 names the image as `\Device\HarddiskVolume4\…` and 5156/5157 use the same form in lower
  case, while 4689 and the file system use `D:\…`. The judge compares the path after the volume.
- `Get-WinEvent` applies `StartTime` and `EndTime` at whole-second resolution. Windows are
  therefore read with a settle delay, and the arm markers are read up to "now".
- The §4 baseline of out-of-tree traffic to ports 80, 443 and 445 is not needed as a
  subtraction: the judge fails only on ports 445, 139 and 80 from System (pid 4) or the
  WebClient service, and none occurred. The Azure guest agent's constant port-80 traffic is a
  different process and is ignored.

### Finding F1: the app looks up `wpad` on every launch

On every launch, of the probe **and of the release exe run undriven**, the network-service
process calls the system resolver for `wpad` (event 3006, twice at start and again about 8 s
later). The resolver service then sends a query for `wpad.<connection DNS suffix>` to the
configured DNS server (event 3010 with the app's `ClientPID`; answer NXDOMAIN). This is Chromium's
proxy auto-detection, and it is egress attributable to the app's own process, not the
host-level WinHTTP service that §5a records as out of scope. The old sampler cannot see it.
`docs/desktop.md` says these builds never contact a network; on Windows that was not true for
this one lookup.

Launching the release exe with `--no-proxy-server` removed the lookup (run 2), and a build with
`app.commandLine.appendSwitch('no-proxy-server')` in `electron/main.js` passed the strict gate
(run 3). The owner chose that fix on 2026-11-16 (§8, question 3). It is committed with this work as its
own change, so `docs/desktop.md`'s statement holds again from the next release. Windows builds up
to v0.2.0 are **expected** to make the lookup: `git diff v0.2.0..a6f4eef` leaves `electron/main.js`
untouched, so they carry the same switches. That is inferred from the code. It was not measured
on a v0.2.0 binary, and nothing about `wpad` was measured on Linux.

### Changes after review (2026-11-16)

A review of the drafted gate found no escape in the recorded runs but several places where a
clean result could have meant less than it said. These are fixed in the script and covered by
`-SelfTest` (38 checks, each new one shown to fail under mutation). They ran armed once, in run
43814441249, and the gate passed with them. That run shows they do not fail a clean build; it
does not show each one firing, which only the self-test does. The same run is the first time the
committed `no-proxy-server` line went through the armed gate, and its uploaded evidence held no
account, machine name, SID, DNS suffix or private address. The gate has still not run inside
`release-desktop.yml` itself.

- A window fails if any tree member has no exit event, or if a package image is still running
  when the window is read. A release exe that has to be killed fails the gate. The control
  driver reports a failed `app.close()` instead of swallowing it.
- Windows are read with no upper time bound, and window 3 is read a second time just before the
  rules are removed, after confirming that no package process is left.
- Before disarm the gate asserts that the four audit subcategories are still set to success and
  failure, that every block rule is still in place, that no firewall profile was disabled (read
  from the active store) and that the DNS-Client log is still on.
- Window 3 runs the exe unpacked from the shipped portable (`release/portable-extract`), the
  tree `check-fuses.mjs` compares with the probe, not `release/win-unpacked`.
- The share-client check reads the WebClient pid for every window and includes port 443.
  Whether WebClient exists on `windows-latest` is **[inferred]** absent: no run artifact shows it.
- The evidence artifact holds only the events the judge used, reduced to the fields it used;
  the audit-policy backup is kept out of it. The committed fixture has the runner's DNS suffix,
  account name and internal addresses replaced. An earlier local commit still holds the original
  values, so the branch should be squashed when it is merged.
- Each cleanup step runs on its own; a log that cannot be read stops the gate with that message;
  the number of attempts the driver reports must equal `-Repeat`.
- Not done: an IPv6 positive control. An IPv6 attempt by the app is judged like any other, but
  no control proves the block and audit path for IPv6 on the runner.

## Sources

- Microsoft Learn, _WFP auditing_: subcategory GUIDs and event IDs 5152–5159.
  <https://learn.microsoft.com/en-us/windows/win32/fwp/auditing-and-logging>
- Microsoft Learn, _5157(F) The Windows Filtering Platform has blocked a connection_: event
  fields, including ProcessID, Application and LayerName.
  <https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-5157>
- Microsoft Learn, _Application Layer Enforcement (ALE)_.
  <https://learn.microsoft.com/en-us/windows/win32/fwp/application-layer-enforcement--ale->
- Microsoft Learn, _FwpmEngineSetOption0_: net-event collection defaults.
  <https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmengineSetOption0>
- Microsoft Learn, _pktmon filter add_: the filter parameters, with no process filter.
  <https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/pktmon-filter-add>
- GitHub Docs, _GitHub-hosted runners reference_: Windows runs as administrator with UAC
  disabled. <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- Repository: `scripts/windows-egress-check.ps1`, `.github/workflows/release-desktop.yml`,
  `electron/verify-packaged.mjs`, `electron-builder.yml`,
  `specs/002-desktop-packaging/contracts/release-artifacts.md`, issues #12 and #16.
