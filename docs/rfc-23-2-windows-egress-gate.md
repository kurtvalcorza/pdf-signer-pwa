# RFC 23-2: Packet-level no-egress gate on Windows, scoped to the app's process tree

Status: **proposal, not implemented**. Issue #23, item 2; it came from #12 and SEC-14
([audit.md](audit.md)).

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
run on a runner; the test plan (§6) confirms or refutes each one.

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
  Drop** (`{0CCE9225-…}`) adds **5152** (packet dropped) and **5153** (vetoed). WFP auditing is
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
  record. Collection is **on by default**, and all outbound events are collected [MS,
  FwpmEngineSetOption0]. They are useful as a cross-check, but they need P/Invoke or `netsh` XML
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
  **[inferred]**. The gate must either enable the profile (`Set-NetFirewallProfile -Enabled True
-DefaultOutboundAction Allow`) or prove enforcement through the positive control. It does both.

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
    app's. Secondary write-ups say so; no Microsoft page seen in this pass does. The probe's
    deliberate `.invalid` lookup (§6) decides whether this check can gate or must stay
    informational (decision B2).
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
   - `auditpol /set /subcategory:"{0CCE9226-69AE-11D9-BED3-505054503030}" /success:enable
/failure:enable`, and the same for `{0CCE9225-…}`. Use the GUIDs, because the names are
     localised [MS].
   - `New-NetFirewallRule -Direction Outbound -Action Block -Program <abs path of PDF Signer.exe>`,
     plus one for every other image in the package's `win-unpacked` directory (any `*.exe`).
   - Start the DNS-Client and Kernel-Process ETW sessions.
3. **Positive control (G5).** Launch the packaged app through Playwright, as
   `verify-packaged.mjs` does. Then make it attempt, from its **main process**:
   - a TCP connect to `192.0.2.1:443` (TEST-NET-1), closed immediately;
   - a UDP send to `198.51.100.1:53` (TEST-NET-2);
   - `dns.lookup('egress-probe.invalid')`.

   The gate requires **5157** events for the first two, attributed to the app's PID and image. If
   B2 is (a), it also requires a DNS-Client event for the third. Missing any of them fails the
   gate with "control failed". The probe mechanism is decision B3.

4. **Real run.** Start a fresh launch with `PDFSIGNER_SKIP_VALIDATE=1`, and run the full
   `verify-packaged.mjs` flow: launch, sign, idle, quit.
5. **Collect and judge** over `[StartTime, now]`:
   - **Tree** = the PIDs in Kernel-Process start events descending from the launched root. A
     child whose image is not in the package directory fails the gate (G3), unless it is on an
     explicit allow-list kept in the script. The allow-list starts empty.
   - **Fail** on any 5156, 5157 or 5152 whose `ProcessID` is in the tree and whose destination
     is not `127.0.0.0/8` or `::1`.
   - **Fail** on any DNS-Client query from a tree PID (if B2 is (a)).
   - **Log, do not fail**, on 5158 binds. A wildcard UDP bind is not traffic. The 5157 on the
     first send is what counts.
6. **Disarm** in a `finally` block: remove the rules, restore auditpol, stop the ETW sessions,
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
| Certificate revision (CRL/OCSP, AIA fetch)            | The app does no TLS. Authenticode checks of the unsigned binary are made by the OS (Defender, SmartScreen), not by the app tree **[inferred]**. | Outside the tree by PID. A revocation fetch attributed to the app would be a finding.      |
| SmartScreen and Defender scanning the new `.exe`      | Different processes (`smartscreen.exe`, `MsMpEng.exe`)                                                                                          | Out of tree, so ignored. Logged for evidence.                                              |
| Dnscache resolving for others                         | `svchost`                                                                                                                                       | Ignored, unless a DNS-Client event attributes the query to a tree PID.                     |
| Loopback (Playwright CDP/inspector)                   | `127.0.0.1`                                                                                                                                     | Excluded by address. The inspector is how `verify-packaged.mjs` drives the app **[repo]**. |
| IPv6 router or neighbour discovery, multicast         | Kernel, not the app                                                                                                                             | Out of tree.                                                                               |
| Runner agent and telemetry                            | `Runner.Worker.exe`, and so on                                                                                                                  | Out of tree. Not blocked, so G3 holds.                                                     |

## 6. Test plan

1. **Probe-detects-short-lived (G1).** On the runner, the positive control (§4 step 3) produces
   two 5157 events with the app's PID and image path. The TCP socket is closed in under 1 ms.
   Repeat 20 times in one job; the evidence bar is 20 detections out of 20. Record whether 5156
   or 5157 appears for a connection the rule did _not_ cover (a control run with the rule
   removed). This is what shows auditing alone sees a permitted short connection.
2. **Old sampler misses it.** Run the same probe under `windows-egress-check.ps1` and record
   how many of the 20 it misses. This is the before and after number for audit.md SEC-14. A miss
   rate of 0 would mean the sampler's gap is theoretical on this runner; record it either way.
3. **DNS attribution (B2).** The probe's `egress-probe.invalid` lookup appears in the DNS-Client
   session with a tree PID: yes or no. This decides whether the DNS check gates or only logs.
4. **Tree coverage.** The Kernel-Process session shows every child of the root running the same
   image. Then a test-only probe spawns `cmd.exe /c exit`, a different image, and the gate must
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

**B1. Mechanism**

- **(a) Option E: a firewall block rule per packaged image, WFP connection and packet-drop
  auditing, the PID tree from Kernel-Process ETW, and a positive probe. Recommended.**
- (b) Option A: our own WFP dynamic-session filter through `Add-Type`. It does not depend on the
  firewall profile state, but it is about 200 more lines to own.
- (c) Option B: ETW Kernel-Network alone. No blocking, and an undocumented schema.
- (d) Keep socket sampling and document the gap permanently.

**B2. DNS**

- **(a) DNS-Client ETW as a gating check, if §6 step 3 shows it attributes the probe's lookup;
  otherwise informational, with the residual gap written in audit.md. Recommended.**
- (b) Always informational.
- (c) Leave DNS out of scope for Windows.

**B3. How the probe reaches the packaged binary**

- **(a) Through the inspector Playwright already attaches.** `enableNodeCliInspectArguments`
  stays on for `verify-packaged.mjs` **[repo]** `electron-builder.yml`, and the probe is
  `electronApp.evaluate` in the main process. **Recommended**: it uses the shipped binary itself,
  and no probe code enters `electron/` (the eslint import allow-list stays intact). **[inferred]**
  Whether the main-process evaluate context can reach `net` and `dgram` in an ESM main is
  unknown; if it cannot, fall back to (b).
- (b) A separate unreleased "probe" package variant, built in the same job, with a probe module
  outside `electron/`.
- (c) A standalone probe executable in the package directory. It is covered by the per-image
  rules, but it proves less about the real binary.

**B4. The existing socket sampler**

- **(a) Keep it as a secondary witness for one release, then delete it. Recommended.**
- (b) Delete it when the new gate lands.

**B5. Where the gate runs**

- **(a) `release-desktop.yml` only, as today. Recommended**: it needs the packaged build and
  changes runner security settings.
- (b) Also on `ci.yml` PRs, which adds an electron-builder packaging step to every PR.

## 8. Open questions for Kurt

1. Is a 20/20 detection run on one runner image enough evidence, or should it be repeated after
   each `windows-latest` image bump? `windows-latest` moves between Server releases.
2. Should the portable wrapper `.exe` (not only `win-unpacked`) be monitored? That needs a rule
   on its `%TEMP%` extraction path, discovered after launch.
3. If B3 (a) works, should the inspector-enabling fuse stay on in release binaries? It is on
   today for the packaged gate. That is a separate SEC-03 question, but this gate would come to
   depend on it.

## 9. Effort

About **3–4 working days [inferred]**:

| Part                                                                               | Estimate  |
| :--------------------------------------------------------------------------------- | :-------- |
| `windows-egress-gate.ps1`: arm, judge, disarm, and the event parsing               | 1.5 days  |
| Probe via Playwright evaluate (or the B3 fallback) and the tree check              | 0.5–1 day |
| Runner experiments §6 steps 1–4 and 6, with evidence in audit.md                   | 1 day     |
| Workflow wiring, 3 dry runs, docs (`desktop.md`, release-artifacts SC-004 wording) | 0.5 day   |

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
