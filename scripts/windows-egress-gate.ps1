# Windows no-egress gate (SC-004), connection-level: issue #23 item 2, RFC docs/rfc-23-2-windows-egress-gate.md
# (option E). Replaces socket sampling with a decision taken at connect time:
#
#   - an outbound firewall BLOCK rule per image in the package directories, so nothing leaves;
#   - Filtering Platform auditing (Security 5156 allowed / 5157 blocked / 5152 dropped), which records
#     every connection attempt with its process id, however short-lived;
#   - the process tree from Security 4688/4689, keyed on (pid, start time) so a reused pid is not counted;
#   - the DNS-Client Operational log, which attributes system-resolver lookups to the calling pid;
#   - out-of-tree SMB/WebDAV client connections during a window (a UNC or WebDAV path the app opened);
#   - in-app positive and negative controls (scripts/egress-control.mjs) that must be seen, or not seen,
#     before a clean result means anything. The controls are IPv4 only: there is no IPv6 positive
#     control, although an IPv6 attempt by the app is judged like any other.
#
# Every app process must have exited before a window is read, and nothing of the app may be running
# when the block rules come off. The evidence directory holds only the events the judge used.
#
# Three windows are judged: the controls and the real sign flow on the GATE-ONLY PROBE build, and an
# undriven launch/idle/quit of the RELEASE build (the probe differs from it by one fuse byte,
# scripts/check-fuses.mjs). Measured behaviour on windows-latest is recorded in the RFC, section 10.
#
# NEEDS ELEVATION and changes host state while it runs: firewall rules (DisplayName prefix
# "pdfsigner-egress-gate"), audit policy, Security log size, the DNS-Client Operational channel. All
# are restored in `finally`; leftovers from a killed run are removed at start. Outside GitHub Actions
# it refuses to arm without -Arm. `-SelfTest` runs the judge over recorded events and touches nothing.
[CmdletBinding()]
param(
  [string]$Probe = 'release-probe\win-unpacked\PDF Signer.exe',
  # The release workflow passes release\portable-extract\PDF Signer.exe: the unpacked SHIPPED portable,
  # the tree check-fuses.mjs compares with the probe. The default is for a local --dir pack.
  [string]$Release = 'release\win-unpacked\PDF Signer.exe',
  [string]$EvidenceDir = 'egress-gate-out',
  # Attempts per Node TCP/UDP control. 3 on every release; 20 for the evidence run (RFC section 6.1).
  [int]$Repeat = 3,
  [int]$IdleSeconds = 15,
  # How long window 3 waits for the release exe to exit after its window is closed. Was 10 s. In run
  # 44760981065 (image win25-vs2026 20261116.315) every armed quit was slow, with no code change since
  # the passing run: the probe's quits, which Playwright waits for without a timeout, took 22.1 s and
  # 24.3 s from the renderer's exit to the browser process's exit, and the killed release tree's root
  # was gone only 29.6 s after the close (19.5 s after taskkill /F), so teardown itself was slow on that
  # host. 60 s is about 2 times the slowest exit seen; a kill still fails the gate. Each quit's timing
  # goes in verdict.json.
  [ValidateRange(1, 600)][int]$QuitSeconds = 60,
  # DNS names (wildcards allowed) an in-tree process may look up without failing the gate. Empty by
  # default: every entry is a recorded residual and an owner decision, never a convenience.
  [string[]]$AllowDnsName = @(),
  # Image file names allowed in the tree although they are not in a package directory. Starts empty.
  [string[]]$AllowImage = @(),
  [switch]$Arm,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
$RulePrefix = 'pdfsigner-egress-gate'
$Inbound = '%%14592'
$AuditGuids = @(
  '{0CCE9225-69AE-11D9-BED3-505054503030}' # Filtering Platform Packet Drop  (5152)
  '{0CCE9226-69AE-11D9-BED3-505054503030}' # Filtering Platform Connection   (5156, 5157)
  '{0CCE922B-69AE-11D9-BED3-505054503030}' # Process Creation                (4688)
  '{0CCE922C-69AE-11D9-BED3-505054503030}' # Process Termination             (4689)
)

# ----------------------------------------------------------------------------------------------------
# Judge: pure functions over plain event records, so -SelfTest can replay recorded runner events.
# A record is the event's EventData fields plus Id, Time (ISO 8601 UTC) and Rec (record id).
# ----------------------------------------------------------------------------------------------------

# 4688 and 5156/5157 name images as \Device\HarddiskVolumeN\..., 4689 and the file system as X:\...
# Compare the part after the volume, lower-cased.
function Get-PathTail([string]$Path) {
  (($Path -replace '^\\device\\harddiskvolume\d+', '') -replace '^[a-z]:', '').ToLowerInvariant()
}

# Same rule as the Linux leg ('not multicast and not broadcast'): loopback is not egress; multicast
# and broadcast are stack noise, logged and not failed.
function Get-AddressExemption([string]$Address, [string[]]$Broadcast = @()) {
  if ($Address -match '^127\.' -or $Address -eq '::1' -or $Address -match '^::ffff:127\.') { return 'loopback' }
  if ($Address -match '^(22[4-9]|23\d)\.' -or $Address -match '^ff[0-9a-f]{2}:' -or
    $Address -eq '255.255.255.255' -or $Broadcast -contains $Address) { return 'multicast-or-broadcast' }
  return $null
}

function Get-EgressVerdict {
  param(
    [object[]]$Sec = @(), [object[]]$Dns = @(), [string[]]$PackageDirs,
    [string[]]$AllowImage = @(), [string[]]$AllowDnsName = @(), [string[]]$Broadcast = @(),
    # Out-of-tree senders of egress the app can CAUSE without sending (RFC section 5a, B7 (a)): the SMB
    # redirector (System, pid 4) and the WebClient service, for a UNC or WebDAV path.
    [int[]]$ShareClientPids = @(),
    # Fail on a tree member with no exit event: a process still running when the window is read can
    # act after it, in no window. The gate always sets this; synthetic tests may leave it off.
    [switch]$RequireExit
  )
  $dirTails = @($PackageDirs | ForEach-Object { (Get-PathTail $_).TrimEnd('\') + '\' })
  $inPackage = { param($image) $t = Get-PathTail "$image"; [bool]($dirTails | Where-Object { $t.StartsWith($_) }) }
  $members = [Collections.Generic.List[object]]::new()
  $failures = [Collections.Generic.List[object]]::new()
  $logged = [Collections.Generic.List[object]]::new()
  $live = @{}

  foreach ($e in ($Sec | Sort-Object @{ e = { $_.Time } }, @{ e = { [long]$_.Rec } })) {
    switch ([int]$e.Id) {
      4688 {
        $procId = [Convert]::ToInt32($e.NewProcessId, 16)
        $parent = [Convert]::ToInt32($e.ProcessId, 16)
        $packaged = & $inPackage $e.NewProcessName
        if ($live.ContainsKey($parent) -or $packaged) {
          $m = [pscustomobject]@{ Pid = $procId; Parent = $parent; Image = $e.NewProcessName; Start = $e.Time; End = $null; Root = -not $live.ContainsKey($parent) }
          $live[$procId] = $m
          $members.Add($m)
          if (-not $packaged -and $AllowImage -notcontains (Split-Path (Get-PathTail $e.NewProcessName) -Leaf)) {
            $failures.Add([pscustomobject]@{ Kind = 'image'; Time = $e.Time; Pid = $procId; Detail = "unexpected image in process tree: $($e.NewProcessName)" })
          }
        } elseif ($live.ContainsKey($procId)) {
          # an unrelated process took a pid whose exit event we did not see: it is not the app's
          $live.Remove($procId)
        }
      }
      4689 {
        $procId = [Convert]::ToInt32($e.ProcessId, 16)
        if ($live.ContainsKey($procId)) { $live[$procId].End = $e.Time; $live.Remove($procId) }
      }
      { $_ -in 5152, 5156, 5157 } {
        $procId = [int]($e.ProcessID ?? $e.ProcessId)
        $inTree = $live.ContainsKey($procId)
        $in = $e.Direction -eq $Inbound
        $remote = $in ? $e.SourceAddress : $e.DestAddress
        $port = $in ? $e.SourcePort : $e.DestPort
        if (-not $inTree -and $ShareClientPids -contains $procId) {
          if (-not $in -and [int]$port -in 445, 139, 80, 443 -and -not (Get-AddressExemption $remote $Broadcast)) {
            $failures.Add([pscustomobject]@{ Kind = 'share'; Time = $e.Time; Pid = $procId; Id = [int]$e.Id; Remote = $remote; Port = [int]$port
                Detail = "event $($e.Id) from the SMB/WebDAV client to $remote`:$port during the window (a UNC or WebDAV path was opened)" })
          }
          continue
        }
        if (-not $inTree -and -not (& $inPackage $e.Application)) { continue }
        $row = [pscustomobject]@{
          Kind = 'network'; Time = $e.Time; Pid = $procId; Id = [int]$e.Id; Protocol = [int]$e.Protocol
          Remote = $remote; Port = [int]$port; Inbound = $in; Detail = $null
        }
        $exempt = Get-AddressExemption $remote $Broadcast
        if ($exempt) { $row.Detail = $exempt; $logged.Add($row); continue }
        # A package image whose pid is not a live tree member means the tree is incomplete: fail closed.
        $row.Detail = $inTree ? "event $($e.Id) to $remote`:$port" : "event $($e.Id) to $remote`:$port from a package image outside the observed tree"
        $failures.Add($row)
      }
    }
  }

  if ($RequireExit) {
    foreach ($m in @($members | Where-Object { -not $_.End })) {
      $failures.Add([pscustomobject]@{ Kind = 'alive'; Time = $m.Start; Pid = $m.Pid; Detail = "no exit event (4689) for $(Split-Path (Get-PathTail $m.Image) -Leaf) started at $($m.Start): still running when the window was read" })
    }
  }

  $inTreeAt = {
    param($procId, $time)
    [bool]($members | Where-Object { $_.Pid -eq $procId -and $_.Start -le $time -and (-not $_.End -or $time -le $_.End) })
  }
  $seen = @{}
  foreach ($e in ($Dns | Sort-Object @{ e = { $_.Time } })) {
    # 3006: the lookup, logged in the calling process. 3009/3010: the resolver service acting for
    # ClientPID; 3010 means a query was sent to a DNS server.
    $procId = ([int]$e.Id -eq 3006) ? [int]$e.Pid : [int]$e.ClientPID
    if (-not $procId -or -not (& $inTreeAt $procId $e.Time)) { continue }
    $name = "$($e.QueryName)"
    $key = "$procId $name"
    if ($seen.ContainsKey($key)) { if ([int]$e.Id -eq 3010) { $seen[$key].Sent = $true }; continue }
    $row = [pscustomobject]@{ Kind = 'dns'; Time = $e.Time; Pid = $procId; Name = $name; Sent = ([int]$e.Id -eq 3010); Detail = "DNS lookup of '$name'" }
    $seen[$key] = $row
    if ($AllowDnsName | Where-Object { $name -like $_ }) { $logged.Add($row) } else { $failures.Add($row) }
  }
  # Evidence: only what the judge used, already reduced (no local address, account, machine or SID).
  [pscustomobject]@{ Members = $members; Failures = $failures; Logged = $logged; Evidence = [ordered]@{ members = @($members); failures = @($failures); logged = @($logged) } }
}

# The controls: every positive attempt must have been blocked AND recorded with the right pid, and
# the negative ones must have left no trace. Returns the list of problems (empty = controls hold).
function Test-EgressControls {
  param($Verdict, $Report, [int]$Repeat = 0)
  $problems = [Collections.Generic.List[string]]::new()
  if ($Report.error) { $problems.Add("control failed: the driver errored: $($Report.error)") ; return $problems }
  if ($Report.closeError) { $problems.Add("control failed: the app did not close cleanly after the controls: $($Report.closeError)") }
  if ($Repeat -gt 0) {
    foreach ($kind in 'nodeTcp', 'nodeUdp') {
      $made = @($Report.attempts.$kind).Count
      if ($made -ne $Repeat) { $problems.Add("control failed: the driver reports $made $kind attempt(s), expected $Repeat") }
    }
  }
  $net = @($Verdict.Failures | Where-Object Kind -eq 'network')
  $dns = @($Verdict.Failures | Where-Object Kind -eq 'dns')
  $blocked = { param($procId, $proto, $hostAddr, $port)
    [bool]($net | Where-Object { $_.Id -eq 5157 -and $_.Pid -eq $procId -and $_.Protocol -eq $proto -and $_.Remote -eq $hostAddr -and $_.Port -eq $port }) }
  $main = [int]$Report.mainPid
  $ns = [int]$Report.networkServicePid
  if (-not $ns) { $problems.Add('control failed: the app reported no network-service process') }
  if (-not ($Verdict.Members | Where-Object { $_.Pid -eq $main -and $_.Root })) { $problems.Add("control failed: main pid $main is not the root of the observed tree") }
  if ($ns -and -not ($Verdict.Members | Where-Object { $_.Pid -eq $ns -and $_.Parent -eq $main })) { $problems.Add("control failed: network-service pid $ns is not a child of the root") }

  foreach ($a in $Report.attempts.nodeTcp) {
    if (-not (& $blocked $main 6 $a.host ([int]$a.port))) { $problems.Add("control failed: no 5157 for the Node TCP attempt to $($a.host):$($a.port)") }
  }
  foreach ($a in $Report.attempts.nodeUdp) {
    if (-not (& $blocked $main 17 $a.host ([int]$a.port))) { $problems.Add("control failed: no 5157 for the Node UDP attempt to $($a.host):$($a.port)") }
  }
  $p = [uri]$Report.attempts.partition.url
  if (-not (& $blocked $ns 6 $p.Host $p.Port)) { $problems.Add("control failed: no 5157 from the network service for the unlocked-partition request to $($p.Host):$($p.Port)") }

  foreach ($negative in $Report.attempts.defaultSession.url, $Report.attempts.renderer.url) {
    $h = ([uri]$negative).Host
    if ($net | Where-Object Remote -eq $h) { $problems.Add("LAYER FAILURE: the request to $negative reached the network stack; the layer-2 block or CSP did not stop it") }
  }
  if ($Report.attempts.defaultSession.message -ne 'net::ERR_BLOCKED_BY_CLIENT') { $problems.Add("control failed: defaultSession request was not cancelled by layer 2 ($($Report.attempts.defaultSession | ConvertTo-Json -Compress))") }
  if ("$($Report.attempts.renderer.result)" -notlike 'rejected*') { $problems.Add("control failed: renderer fetch was not rejected ($($Report.attempts.renderer.result))") }

  if (-not ($dns | Where-Object { $_.Pid -eq $main -and $_.Name -eq $Report.attempts.nodeDns.name })) { $problems.Add("control failed: the Node lookup of $($Report.attempts.nodeDns.name) was not attributed to the main process") }
  if (-not ($dns | Where-Object { $_.Pid -eq $ns -and $_.Name -eq $Report.attempts.chromiumDns.name })) { $problems.Add("control failed: the Chromium lookup of $($Report.attempts.chromiumDns.name) was not attributed to the network service") }
  $problems
}

# Processes whose image lies under a package directory. Pure: the caller supplies the process list.
# Win32_Process can report a null ExecutablePath for a process that is being torn down (issue #48), so
# a process with no path still counts when it is a tree member with no exit event yet: same pid, and a
# CreationDate within a second of the member's 4688, so an unrelated process that reused the pid is not
# counted. Members are Get-EgressVerdict members (Pid, Start, End).
function Get-RunningPackageProcesses {
  param([object[]]$Processes = @(), [string[]]$PackageDirs, [object[]]$Members = @())
  $dirTails = @($PackageDirs | ForEach-Object { (Get-PathTail $_).TrimEnd('\') + '\' })
  $open = @($Members | Where-Object { -not $_.End })
  @($Processes | Where-Object {
      if ($_.ExecutablePath) { $t = Get-PathTail $_.ExecutablePath; [bool]($dirTails | Where-Object { $t.StartsWith($_) }) }
      elseif ($_.CreationDate) {
        $created = ([datetimeoffset]$_.CreationDate).UtcDateTime
        $procId = $_.ProcessId
        [bool]($open | Where-Object { $_.Pid -eq $procId -and [Math]::Abs(($created - ([datetimeoffset]$_.Start).UtcDateTime).TotalSeconds) -le 1 })
      } else { $false }
    })
}

# The four audit subcategories must be set to success AND failure (value 3 in an `auditpol /backup`
# file, which is locale-independent). Returns the list of problems.
function Test-AuditArmed {
  param([object[]]$Rows = @(), [string[]]$Guids)
  foreach ($g in $Guids) {
    $row = $Rows | Where-Object { $_.'Subcategory GUID' -eq $g } | Select-Object -First 1
    if (-not $row -or "$($row.'Setting Value')" -ne '3') { "audit subcategory $g is not set to success and failure (value '$($row.'Setting Value')'); the gate was not observing." }
  }
}

function Format-Failure($f) { "pid $($f.Pid) at $($f.Time): $($f.Detail)" }

# How window 3's quit went, from what the caller measured. Pure, so -SelfTest covers it. Exits holds
# one record per process of the tree, captured before the close: Pid, Root, and ExitedAfter (seconds
# from the close to the exit; $null if it was still running when measured). KilledAfter is when the
# kill was sent, $null if none was needed. Returns the detail line and the problem ($null if none).
function Get-QuitReport {
  param([int]$ClosedPid, [bool]$CloseSent, [object[]]$Exits = @(), $KilledAfter = $null, [int]$BudgetSeconds)
  $killed = $null -ne $KilledAfter
  $parts = @($Exits | Sort-Object @{ Expression = { -not $_.Root } }, Pid | ForEach-Object {
      $who = if ($_.Root) { "root pid $($_.Pid)" } else { "child pid $($_.Pid)" }
      if ($null -eq $_.ExitedAfter) { "$who still running" }
      else {
        $when = [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:F1} s', [double]$_.ExitedAfter)
        if ($killed -and $_.ExitedAfter -ge $KilledAfter) { "$who exited at $when, after the kill" } else { "$who exited at $when" }
      }
    })
  $detail = "CloseMainWindow on pid $ClosedPid returned $CloseSent; " + $(if ($parts) { $parts -join ', ' } else { 'no process measured' }) +
    '; ' + $(if ($killed) { [string]::Format([Globalization.CultureInfo]::InvariantCulture, 'kill needed at {0:F1} s', [double]$KilledAfter) } else { 'no kill needed' })
  $problem = if (-not $CloseSent) {
    "release-idle: CloseMainWindow found no main window to close, so the quit was never requested and the exe was killed ($detail)."
  } elseif ($killed) {
    "release-idle: the release exe did not quit within $BudgetSeconds s of its window being closed and had to be killed, so the quit path was not measured ($detail)."
  } else { $null }
  [pscustomobject]@{ Detail = $detail; Problem = $problem }
}

# ----------------------------------------------------------------------------------------------------
# -SelfTest: replay events recorded on the runner, plus synthetic edge cases. No elevation, no changes.
# ----------------------------------------------------------------------------------------------------
if ($SelfTest) {
  $fx = Get-Content (Join-Path $PSScriptRoot 'fixtures\egress-gate\run-43802298765.json') -Raw | ConvertFrom-Json
  $dirs = 'D:\a\pdf-signer-pwa\pdf-signer-pwa\release-probe\win-unpacked', 'D:\a\pdf-signer-pwa\pdf-signer-pwa\release\win-unpacked'
  $wpad = 'wpad', 'wpad.*'
  $failed = 0
  function Check([string]$Name, [bool]$Ok) { if ($Ok) { Write-Host "  ok    $Name" } else { Write-Host "  FAIL  $Name"; $script:failed++ } }

  # 1. Recorded controls: 20 TCP + 20 UDP short-lived attempts, both resolver paths, partition request.
  $v = Get-EgressVerdict -Sec $fx.control.sec -Dns $fx.control.dns -PackageDirs $dirs -AllowImage 'cmd.exe', 'conhost.exe'
  $problems = @(Test-EgressControls $v $fx.control.report)
  Check 'recorded controls hold (20/20 TCP, 20/20 UDP, partition, both DNS paths, negatives silent)' ($problems.Count -eq 0)
  $problems | ForEach-Object { Write-Host "        $_" }
  Check 'tree is the root plus gpu, network service, renderer, cmd, conhost' ($v.Members.Count -eq 6 -and @($v.Members | Where-Object Root).Count -eq 1)
  Check 'loopback inspector traffic is logged, not failed' (@($v.Logged | Where-Object Detail -eq 'loopback').Count -gt 0 -and -not ($v.Failures | Where-Object { $_.Kind -eq 'network' -and $_.Remote -like '127.*' }))

  # 2. A foreign image in the tree fails (the recorded run spawned cmd.exe from the main process).
  $v = Get-EgressVerdict -Sec $fx.control.sec -PackageDirs $dirs
  Check 'foreign image in the tree fails' (@($v.Failures | Where-Object Kind -eq 'image').Count -eq 2)

  # 3. Recorded real sign flow and release idle: nothing at the connection level; the only finding is
  #    the WPAD lookup the network service makes on every launch (RFC section 10, finding F1).
  foreach ($window in 'realRun', 'releaseIdle') {
    $v = Get-EgressVerdict -Sec $fx.$window.sec -Dns $fx.$window.dns -PackageDirs $dirs
    Check "$window`: no connection-level failure" (@($v.Failures | Where-Object Kind -ne 'dns').Count -eq 0)
    Check "$window`: the WPAD lookup is attributed to the tree and fails by default" (@($v.Failures | Where-Object { $_.Kind -eq 'dns' -and $_.Name -like 'wpad*' }).Count -ge 1)
    $v = Get-EgressVerdict -Sec $fx.$window.sec -Dns $fx.$window.dns -PackageDirs $dirs -AllowDnsName $wpad
    Check "$window`: clean once wpad is allow-listed" ($v.Failures.Count -eq 0)
  }

  # 4. Firewall profiles off: attempts are ALLOWED (5156), so the controls must fail closed.
  $report = $fx.control.report | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $off = @($fx.firewallOff.sec | Where-Object { $_.Id -eq 4688 -and $_.NewProcessName -like '*PDF Signer.exe' })
  $report.mainPid = [Convert]::ToInt32($off[0].NewProcessId, 16)
  $report.attempts.nodeTcp = @(23000, 23001, 23002 | ForEach-Object { [pscustomobject]@{ host = '192.0.2.1'; port = $_ } })
  $report.attempts.nodeUdp = @([pscustomobject]@{ host = '198.51.100.1'; port = 23053 })
  $v = Get-EgressVerdict -Sec $fx.firewallOff.sec -PackageDirs $dirs
  Check 'firewall off: the attempts still fail the judge (5156 in tree)' (@($v.Failures | Where-Object { $_.Id -eq 5156 -and $_.Remote -eq '192.0.2.1' }).Count -eq 3)
  Check 'firewall off: controls report "control failed"' (@(Test-EgressControls $v $report | Where-Object { $_ -like 'control failed: no 5157*' }).Count -ge 4)

  # 5. Synthetic edge cases.
  $t = { param($s) "2026-01-01T00:00:$($s.ToString('00')).0000000Z" }
  $app = '\Device\HarddiskVolume4\a\pdf-signer-pwa\pdf-signer-pwa\release\win-unpacked\PDF Signer.exe'
  $appLower = $app.ToLowerInvariant()
  $other = '\Device\HarddiskVolume3\Windows\System32\svchost.exe'
  $n = 0
  $ev = { param($id, $s, $h) $script:n++; [pscustomobject](@{ Id = $id; Time = (& $t $s); Rec = $script:n } + $h) }
  $conn = { param($id, $s, $procId, $image, $dest, $dir = '%%14593') & $ev $id $s @{ ProcessID = "$procId"; Application = $image; Direction = $dir; SourceAddress = '10.0.0.5'; SourcePort = '50000'; DestAddress = $dest; DestPort = '443'; Protocol = '6' } }
  $script:n = 0
  $sec = @(
    (& $ev 4688 1 @{ NewProcessId = '0x64'; ProcessId = '0x10'; NewProcessName = $app }),
    (& $conn 5156 2 100 $appLower '127.0.0.1'),
    (& $conn 5156 2 100 $appLower '224.0.0.251'),
    (& $conn 5156 2 100 $appLower 'ff02::fb'),
    (& $conn 5156 2 100 $appLower '10.0.0.255'),
    (& $ev 4689 3 @{ ProcessId = '0x64'; ProcessName = 'D:\a\pdf-signer-pwa\pdf-signer-pwa\release\win-unpacked\PDF Signer.exe' }),
    (& $ev 4688 4 @{ NewProcessId = '0x64'; ProcessId = '0x20'; NewProcessName = $other }),
    (& $conn 5156 5 100 $other.ToLowerInvariant() '203.0.113.9')
  )
  $v = Get-EgressVerdict -Sec $sec -PackageDirs $dirs -Broadcast '10.0.0.255'
  Check 'loopback, multicast and subnet broadcast are exempt' ($v.Failures.Count -eq 0 -and $v.Logged.Count -eq 4)
  Check 'a pid reused by an unrelated process after exit is not counted' (-not ($v.Failures | Where-Object Remote -eq '203.0.113.9'))
  $v = Get-EgressVerdict -Sec ($sec[0], (& $conn 5157 2 100 $appLower '203.0.113.9')) -PackageDirs $dirs
  Check 'an in-tree unicast attempt fails' ($v.Failures.Count -eq 1 -and $v.Failures[0].Remote -eq '203.0.113.9')
  $v = Get-EgressVerdict -Sec ($sec[0], (& $ev 5156 2 @{ ProcessID = '100'; Application = $appLower; Direction = $Inbound; SourceAddress = '127.0.0.1'; SourcePort = '5555'; DestAddress = '127.0.0.1'; DestPort = '9229'; Protocol = '6' }), (& $ev 5156 2 @{ ProcessID = '100'; Application = $appLower; Direction = $Inbound; SourceAddress = '203.0.113.9'; SourcePort = '4444'; DestAddress = '10.0.0.5'; DestPort = '8080'; Protocol = '6' })) -PackageDirs $dirs
  Check 'an inbound connection from a remote host fails; inbound loopback does not' ($v.Failures.Count -eq 1 -and $v.Failures[0].Inbound)
  $v = Get-EgressVerdict -Sec @(& $conn 5157 2 777 $appLower '203.0.113.9') -PackageDirs $dirs
  Check 'a package image outside the observed tree fails closed' ($v.Failures.Count -eq 1)
  $v = Get-EgressVerdict -Sec @(& $conn 5156 2 778 $other.ToLowerInvariant() '203.0.113.9') -PackageDirs $dirs
  Check 'an out-of-tree, non-package process is ignored' ($v.Failures.Count -eq 0)
  $smb = & $ev 5156 2 @{ ProcessID = '4'; Application = 'System'; Direction = '%%14593'; SourceAddress = '10.0.0.5'; SourcePort = '50001'; DestAddress = '203.0.113.9'; DestPort = '445'; Protocol = '6' }
  $smbOther = & $ev 5156 2 @{ ProcessID = '4'; Application = 'System'; Direction = '%%14593'; SourceAddress = '10.0.0.5'; SourcePort = '50003'; DestAddress = '203.0.113.9'; DestPort = '8080'; Protocol = '6' }
  $v = Get-EgressVerdict -Sec @($smb, $smbOther) -PackageDirs $dirs -ShareClientPids 4
  Check 'an SMB connection from System during the window fails; its other traffic does not' ($v.Failures.Count -eq 1 -and $v.Failures[0].Kind -eq 'share')
  foreach ($window in 'control', 'realRun', 'releaseIdle') {
    $v = Get-EgressVerdict -Sec $fx.$window.sec -PackageDirs $dirs -AllowImage 'cmd.exe', 'conhost.exe' -ShareClientPids 4
    Check "$window`: no SMB/WebDAV client traffic was recorded on the runner" (@($v.Failures | Where-Object Kind -eq 'share').Count -eq 0)
  }
  $dnsEvents = @(
    [pscustomobject]@{ Id = 3006; Time = (& $t 2); Pid = 100; QueryName = 'example.org' },
    [pscustomobject]@{ Id = 3010; Time = (& $t 2); Pid = 2032; ClientPID = '100'; QueryName = 'example.org' },
    [pscustomobject]@{ Id = 3006; Time = (& $t 2); Pid = 555; QueryName = 'not-ours.example' },
    [pscustomobject]@{ Id = 3006; Time = (& $t 5); Pid = 100; QueryName = 'after-exit.example' }
  )
  $v = Get-EgressVerdict -Sec $sec -Dns $dnsEvents -PackageDirs $dirs -Broadcast '10.0.0.255'
  Check 'an in-tree DNS lookup fails once, marked as sent; others are ignored' ($v.Failures.Count -eq 1 -and $v.Failures[0].Name -eq 'example.org' -and $v.Failures[0].Sent)

  # 6. Review round: exits, leftovers, counts, share client on 443, armed state, evidence content.
  $v = Get-EgressVerdict -Sec @($sec[0]) -PackageDirs $dirs -RequireExit
  Check 'a tree member with no exit event fails when exits are required' ($v.Failures.Count -eq 1 -and $v.Failures[0].Kind -eq 'alive')
  $v = Get-EgressVerdict -Sec @($sec[0], $sec[5]) -PackageDirs $dirs -RequireExit
  Check 'a tree member with its exit event does not' ($v.Failures.Count -eq 0)
  foreach ($window in 'control', 'realRun', 'releaseIdle', 'firewallOff') {
    $v = Get-EgressVerdict -Sec $fx.$window.sec -PackageDirs $dirs -RequireExit
    Check "$window`: every recorded tree member has its exit event" (@($v.Failures | Where-Object Kind -eq 'alive').Count -eq 0)
  }
  $running = @(
    [pscustomobject]@{ ProcessId = 11; ExecutablePath = 'D:\a\pdf-signer-pwa\pdf-signer-pwa\release\win-unpacked\PDF Signer.exe' },
    [pscustomobject]@{ ProcessId = 12; ExecutablePath = 'C:\Windows\System32\svchost.exe' },
    [pscustomobject]@{ ProcessId = 13; ExecutablePath = $null }
  )
  $left = @(Get-RunningPackageProcesses -Processes $running -PackageDirs $dirs)
  Check 'a package image still running is found; other processes are not' ($left.Count -eq 1 -and $left[0].ProcessId -eq 11)
  # Issue #48: a tree member being torn down can have no ExecutablePath. CreationDate is local time,
  # as Get-CimInstance returns it; member pid 100 started at 00:00:01 ($sec[0]).
  $at = { param($s) ([datetimeoffset]"2026-01-01T00:00:$s`Z").LocalDateTime }
  $open = @((Get-EgressVerdict -Sec @($sec[0]) -PackageDirs $dirs).Members)
  $exited = @((Get-EgressVerdict -Sec @($sec[0], $sec[5]) -PackageDirs $dirs).Members)
  $tearing = @(
    [pscustomobject]@{ ProcessId = 100; ExecutablePath = $null; CreationDate = (& $at '01.2') },
    [pscustomobject]@{ ProcessId = 13; ExecutablePath = $null; CreationDate = (& $at '01.2') },
    [pscustomobject]@{ ProcessId = 12; ExecutablePath = 'C:\Windows\System32\svchost.exe'; CreationDate = (& $at '01.2') }
  )
  $left = @(Get-RunningPackageProcesses -Processes $tearing -PackageDirs $dirs -Members $open)
  Check 'a tree member with no ExecutablePath is still running; an unrelated pid with none is not' ($left.Count -eq 1 -and $left[0].ProcessId -eq 100)
  $reused = @([pscustomobject]@{ ProcessId = 100; ExecutablePath = $null; CreationDate = (& $at '04.0') })
  Check 'a pathless process that reused a tree pid later is not counted' (@(Get-RunningPackageProcesses -Processes $reused -PackageDirs $dirs -Members $open).Count -eq 0)
  Check 'a pathless process on the pid of a member that already exited is not counted' (@(Get-RunningPackageProcesses -Processes @($tearing[0]) -PackageDirs $dirs -Members $exited).Count -eq 0)
  $undated = @([pscustomobject]@{ ProcessId = 100; ExecutablePath = $null; CreationDate = $null })
  Check 'a pathless process with no creation date is not counted (the RequireExit read still catches a member)' (@(Get-RunningPackageProcesses -Processes $undated -PackageDirs $dirs -Members $open).Count -eq 0)
  $report = $fx.control.report | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $v = Get-EgressVerdict -Sec $fx.control.sec -Dns $fx.control.dns -PackageDirs $dirs -AllowImage 'cmd.exe', 'conhost.exe' -RequireExit
  Check 'recorded controls hold with the attempt count checked' (@(Test-EgressControls $v $report -Repeat 20).Count -eq 0)
  Check 'a driver that made fewer attempts than asked fails the controls' (@(Test-EgressControls $v $report -Repeat 21 | Where-Object { $_ -like '*expected 21' }).Count -eq 2)
  $report | Add-Member closeError 'Error: electronApplication.close: timeout'
  Check 'an app that did not close after the controls fails them' (@(Test-EgressControls $v $report -Repeat 20 | Where-Object { $_ -like '*did not close cleanly*' }).Count -eq 1)
  $dav = & $ev 5156 2 @{ ProcessID = '900'; Application = $other.ToLowerInvariant(); Direction = '%%14593'; SourceAddress = '10.0.0.5'; SourcePort = '50002'; DestAddress = '203.0.113.9'; DestPort = '443'; Protocol = '6' }
  $v = Get-EgressVerdict -Sec @($dav) -PackageDirs $dirs -ShareClientPids 4, 900
  Check 'a WebDAV-over-HTTPS connection from the WebClient service fails' ($v.Failures.Count -eq 1 -and $v.Failures[0].Kind -eq 'share' -and $v.Failures[0].Port -eq 443)
  $rows = $AuditGuids | ForEach-Object { [pscustomobject]@{ 'Subcategory GUID' = $_; 'Setting Value' = '3' } }
  Check 'all four audit subcategories on: armed' (@(Test-AuditArmed -Rows $rows -Guids $AuditGuids).Count -eq 0)
  $rows[1].'Setting Value' = '1'
  Check 'connection auditing reduced to success only: not armed' (@(Test-AuditArmed -Rows $rows -Guids $AuditGuids).Count -eq 1)
  Check 'a missing subcategory row: not armed' (@(Test-AuditArmed -Rows $rows[0..2] -Guids $AuditGuids).Count -eq 2)
  $v = Get-EgressVerdict -Sec $fx.control.sec -Dns $fx.control.dns -PackageDirs $dirs
  $text = $v.Evidence | ConvertTo-Json -Depth 4 -Compress
  Check 'evidence holds no out-of-tree process, account, SID or local address' ($text -notmatch 'guestagent|svchost|runner|SubjectUser|S-1-5-|SourceAddress|10\.0\.0\.4' -and $text -match '192\.0\.2\.1')

  # Window 3's quit report. Timings are those of run 44760981065's release-idle tree.
  $exits = @(
    [pscustomobject]@{ Pid = 8944; Root = $true; ExitedAfter = 29.56 }
    [pscustomobject]@{ Pid = 8236; Root = $false; ExitedAfter = 0.02 }
    [pscustomobject]@{ Pid = 8000; Root = $false; ExitedAfter = 10.02 }
  )
  $q = Get-QuitReport -ClosedPid 8944 -CloseSent $true -Exits $exits -BudgetSeconds 60
  Check 'a natural quit within the budget is no problem, and its timings are reported' ($null -eq $q.Problem -and $q.Detail -match 'returned True' -and $q.Detail -match 'root pid 8944 exited at 29\.6 s' -and $q.Detail -match 'no kill needed')
  $q = Get-QuitReport -ClosedPid 8944 -CloseSent $true -Exits $exits -KilledAfter 10.0 -BudgetSeconds 10
  Check 'a killed quit fails and says which exits came after the kill' ($q.Problem -like 'release-idle: *did not quit within 10 s*had to be killed*' -and $q.Problem -match 'root pid 8944 exited at 29\.6 s, after the kill' -and $q.Problem -match 'child pid 8236 exited at 0\.0 s[,;]' -and $q.Problem -match 'kill needed at 10\.0 s')
  $q = Get-QuitReport -ClosedPid 8944 -CloseSent $false -Exits @([pscustomobject]@{ Pid = 8944; Root = $true; ExitedAfter = $null }) -KilledAfter 0.0 -BudgetSeconds 60
  Check 'no main window to close fails as a quit never requested' ($q.Problem -like '*found no main window*never requested*' -and $q.Problem -match 'returned False' -and $q.Problem -match 'root pid 8944 still running' -and $q.Problem -match 'kill needed at 0\.0 s')

  if ($failed) { throw "windows-egress-gate self-test: $failed check(s) failed" }
  Write-Host 'windows-egress-gate self-test: all checks passed'
  return
}

# ----------------------------------------------------------------------------------------------------
# The gate.
# ----------------------------------------------------------------------------------------------------
if (-not $IsWindows) { throw 'This gate runs on Windows only.' }
if (-not $Arm -and $env:GITHUB_ACTIONS -ne 'true') {
  throw 'Refusing to arm outside CI: this changes firewall rules and audit policy on this machine. Pass -Arm to do it anyway.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'The egress gate needs an elevated session (audit policy, firewall rules, the Security log).'
}
foreach ($svc in 'mpssvc', 'BFE', 'Dnscache') {
  if ((Get-Service $svc).Status -ne 'Running') { throw "Precondition: service $svc is not running; the gate cannot observe anything." }
}
# ActiveStore is what the firewall enforces (local settings merged with group policy), not what is saved.
function Get-DisabledProfiles { @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { -not $_.Enabled } | ForEach-Object Name) }
$disabled = Get-DisabledProfiles
if ($disabled) { throw "control failed (precondition): firewall profile(s) $($disabled -join ', ') are disabled, so the block rules would not apply." }

$probeExe = (Resolve-Path $Probe).Path
$releaseExe = (Resolve-Path $Release).Path
$packageDirs = @((Split-Path $probeExe), (Split-Path $releaseExe))
New-Item -ItemType Directory -Force $EvidenceDir | Out-Null
$EvidenceDir = (Resolve-Path $EvidenceDir).Path
$broadcast = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object {
    $ip = [Net.IPAddress]::Parse($_.IPAddress).GetAddressBytes()
    $bits = $_.PrefixLength
    $b = for ($i = 0; $i -lt 4; $i++) { $hostBits = [Math]::Min(8, [Math]::Max(0, 32 - $bits - 8 * (3 - $i))); $ip[$i] -bor ((1 -shl $hostBits) - 1) }
    $b -join '.'
  })

$dnsLog = 'Microsoft-Windows-DNS-Client/Operational'
function Remove-GateRules { Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
function Get-LogSetting([string]$Log, [string]$Name) { ((wevtutil gl $Log) -match "^\s*$Name\s*:") -replace '^.*:\s*', '' | Select-Object -First 1 }
function Invoke-Native([string]$What, [scriptblock]$Command) {
  & $Command | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}
# Reads from $From to the newest event. There is deliberately no upper bound: Get-WinEvent applies its
# time bounds at whole-second resolution (seen on the runner: an EndTime of hh:mm:30.37 excluded an event
# at hh:mm:30.24), so an EndTime of "now" would leave up to a second unread. "No events" is a result;
# any other failure to read is an error and stops the gate, because silence would then mean nothing.
function Read-Events([string]$Log, [int[]]$Ids, [datetime]$From) {
  try {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = $Log; Id = $Ids; StartTime = $From } -ErrorAction Stop)
  } catch {
    if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return }
    throw "could not read the $Log log, so the gate cannot judge anything: $($_.Exception.Message)"
  }
  foreach ($e in $events) {
    $row = [ordered]@{ Id = $e.Id; Time = $e.TimeCreated.ToUniversalTime().ToString('o'); Rec = $e.RecordId; Pid = $e.ProcessId }
    foreach ($d in ([xml]$e.ToXml()).Event.EventData.Data) { $row[$d.Name] = $d.'#text' }
    [pscustomobject]$row
  }
}
# The window's tree is read from the Security log first, so a member Win32_Process reports without a
# path is still found (see Get-RunningPackageProcesses).
function Get-PackageProcesses([datetime]$From) {
  $tree = (Get-EgressVerdict -Sec @(Read-Events 'Security' (4688, 4689) $From) -PackageDirs $packageDirs -AllowImage $AllowImage).Members
  Get-RunningPackageProcesses -Processes @(Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath, CreationDate) -PackageDirs $packageDirs -Members @($tree)
}
# Pid 4 is the SMB redirector. WebClient (WebDAV) is trigger-started, so its pid is read again for
# every window rather than once at arm time.
function Get-ShareClientPids {
  $webClient = [int](Get-CimInstance Win32_Service -Filter "Name='WebClient'" -ErrorAction SilentlyContinue).ProcessId
  if ($webClient) { [void]$state.webClientPids.Add($webClient) }
  @(4) + @($state.webClientPids)
}

$problems = [Collections.Generic.List[string]]::new()
$summary = [ordered]@{ started = (Get-Date).ToUniversalTime().ToString('o'); probe = $probeExe; release = $releaseExe; windows = [ordered]@{} }
$marker = "egress-gate-marker-$PID.invalid"
$state = @{ webClientPids = [Collections.Generic.HashSet[int]]::new() }

# Judge one window. Both logs must still hold the markers written at arm time: if either rolled over,
# a clean result would mean nothing. Every app process must be gone when the window is read.
function Get-WindowVerdict([string]$Name, [datetime]$From) {
  Start-Sleep -Seconds 3 # let the last events reach the logs
  $alive = @(Get-PackageProcesses $From)
  if ($alive) {
    $script:problems.Add("${Name}: $($alive.Count) package process(es) still running when the window closed (pid $($alive.ProcessId -join ', ')); what they do next would be in no window.")
    $alive | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
    Start-Sleep -Seconds 2
  }
  $sec = @(Read-Events 'Security' (4688, 4689, 5152, 5156, 5157) $From)
  $dns = @(Read-Events $dnsLog (3006, 3009, 3010) $From)
  $armSec = @(Read-Events 'Security' (4688) $state.armed | Where-Object { [Convert]::ToInt32($_.NewProcessId, 16) -eq $state.markerPid })
  $armDns = @(Read-Events $dnsLog (3006) $state.armed | Where-Object QueryName -eq $marker)
  if (-not $armSec) { $script:problems.Add("${Name}: the Security log no longer holds the arm marker (rolled over, or process auditing is off).") }
  if (-not $armDns) { $script:problems.Add("${Name}: the DNS-Client log no longer holds the arm marker (rolled over, or the channel is off).") }
  $v = Get-EgressVerdict -Sec $sec -Dns $dns -PackageDirs $packageDirs -AllowImage $AllowImage -AllowDnsName $AllowDnsName -Broadcast $broadcast -ShareClientPids (Get-ShareClientPids) -RequireExit
  # Evidence is uploaded from a public repository: only the events the judge used, reduced to the
  # fields it used. No other process on the host, no account, machine, SID or local address.
  $v.Evidence | ConvertTo-Json -Depth 3 -Compress | Set-Content (Join-Path $EvidenceDir "events-$Name.json")
  $script:summary.windows[$Name] = [ordered]@{
    from = $From.ToUniversalTime().ToString('o'); read = (Get-Date).ToUniversalTime().ToString('o')
    securityEvents = $sec.Count; dnsEvents = $dns.Count
    tree = @($v.Members | ForEach-Object { "$($_.Pid) <- $($_.Parent) $(Split-Path (Get-PathTail $_.Image) -Leaf)" })
    failures = @($v.Failures); logged = @($v.Logged | Group-Object Kind, Detail | ForEach-Object { "$($_.Count) x $($_.Name)" })
  }
  Write-Host "[$Name] $($sec.Count) security events, $($dns.Count) DNS events, tree of $($v.Members.Count), $($v.Failures.Count) failing, $($v.Logged.Count) logged"
  $v
}
function Assert-Clean([string]$Name, $Verdict) {
  if (-not ($Verdict.Members | Where-Object Root)) { $script:problems.Add("${Name}: no app process was observed, so the window proves nothing.") }
  foreach ($f in $Verdict.Failures) { $script:problems.Add("${Name}: EGRESS: $(Format-Failure $f)") }
}
# Windows 2 and 3 pass on the ABSENCE of events, so the instruments must still be on when they end.
function Assert-StillArmed([string]$When) {
  $probeFile = Join-Path ([IO.Path]::GetTempPath()) "pdfsigner-egress-auditpol-$PID-check.csv"
  try {
    Invoke-Native 'auditpol /backup (armed check)' { auditpol /backup "/file:$probeFile" }
    Test-AuditArmed -Rows @(Import-Csv $probeFile) -Guids $AuditGuids | ForEach-Object { $script:problems.Add("${When}: $_") }
  } finally { Remove-Item $probeFile -Force -ErrorAction SilentlyContinue }
  $rules = @(Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Block' -and $_.Direction -eq 'Outbound' })
  if ($rules.Count -ne $state.imageCount) { $script:problems.Add("${When}: $($rules.Count) of $($state.imageCount) block rules are in place; the windows were not fully blocked.") }
  $off = Get-DisabledProfiles
  if ($off) { $script:problems.Add("${When}: firewall profile(s) $($off -join ', ') were disabled during the gate.") }
  if ((Get-LogSetting $dnsLog 'enabled') -ne 'true') { $script:problems.Add("${When}: the DNS-Client log was switched off during the gate.") }
}
# Each cleanup step runs on its own, so one failure cannot skip the restores after it.
function Invoke-Cleanup([string]$What, [scriptblock]$Step) {
  try { & $Step } catch { $script:problems.Add("cleanup: $What failed: $($_.Exception.Message)") }
}

try {
  # ---- arm ----
  Remove-GateRules # leftovers from a killed run
  # The backup holds the machine name, so it stays out of the evidence directory and is deleted.
  $state.auditBackup = Join-Path ([IO.Path]::GetTempPath()) "pdfsigner-egress-auditpol-$PID.csv"
  Invoke-Native 'auditpol /backup' { auditpol /backup "/file:$($state.auditBackup)" }
  $state.auditBefore = (auditpol /get /category:* /r) -join "`n"
  $state.secLogSize = Get-LogSetting 'Security' 'maxSize'
  $state.dnsLogEnabled = Get-LogSetting $dnsLog 'enabled'
  Invoke-Native 'Security log resize' { wevtutil sl Security /ms:268435456 }
  foreach ($g in $AuditGuids) { Invoke-Native "auditpol /set $g" { auditpol /set "/subcategory:$g" /success:enable /failure:enable } }
  $images = @(Get-ChildItem $packageDirs -Recurse -Filter *.exe | ForEach-Object FullName)
  $i = 0
  foreach ($image in $images) { $i++; New-NetFirewallRule -DisplayName "$RulePrefix $i" -Direction Outbound -Action Block -Program $image -Profile Any | Out-Null }
  $state.imageCount = $images.Count
  Invoke-Native 'DNS-Client channel enable' { wevtutil sl $dnsLog /e:true }
  $summary.rules = $images
  $state.armed = Get-Date
  Start-Sleep -Milliseconds 500
  $m = Start-Process cmd.exe -ArgumentList '/c', 'exit' -PassThru -WindowStyle Hidden; $state.markerPid = $m.Id; $m.WaitForExit()
  try { $null = [Net.Dns]::GetHostAddresses($marker) } catch { $null = $_ } # a .invalid name: the lookup itself is the marker
  Assert-StillArmed 'arm'
  Write-Host "armed: $($images.Count) block rule(s), Filtering Platform + process auditing, DNS-Client log"

  # ---- window 1: controls on the probe ----
  $from = Get-Date
  $controlFile = Join-Path $EvidenceDir 'control.json'
  $env:PKG_EXE = $probeExe
  node scripts/egress-control.mjs $controlFile $Repeat | Out-Host
  $controlExit = $LASTEXITCODE
  $v = Get-WindowVerdict 'control' $from
  if (-not (Test-Path $controlFile)) { $problems.Add("control failed: the control driver exited $controlExit and wrote no report.") }
  else {
    $report = Get-Content $controlFile -Raw | ConvertFrom-Json
    if ($controlExit -ne 0) { $problems.Add("control failed: the control driver exited $controlExit.") }
    $controlProblems = @(Test-EgressControls $v $report -Repeat $Repeat)
    $controlProblems | ForEach-Object { $problems.Add($_) }
    @($v.Failures | Where-Object { $_.Kind -in 'image', 'alive', 'share' }) | ForEach-Object { $problems.Add("control: $(Format-Failure $_)") }
    $summary.controls = [ordered]@{ repeat = $Repeat; problems = $controlProblems; report = $report }
    if (-not $controlProblems) { Write-Host "controls hold: $Repeat/$Repeat TCP and $Repeat/$Repeat UDP attempts blocked and attributed; Chromium partition request blocked in the network service; both lookups attributed; negatives silent" }
  }

  # ---- window 2: the real launch, sign, quit flow on the probe ----
  $from = Get-Date
  $env:PDFSIGNER_SKIP_VALIDATE = '1'
  node electron/verify-packaged.mjs | Out-Host
  if ($LASTEXITCODE -ne 0) { $problems.Add("real-run: the packaged sign failed (exit $LASTEXITCODE).") }
  Assert-Clean 'real-run' (Get-WindowVerdict 'real-run' $from)

  # ---- window 3: the shipped binary, undriven: launch, idle, quit ----
  $from = Get-Date
  $idleData = New-Item -ItemType Directory -Force (Join-Path ([IO.Path]::GetTempPath()) "pdfsigner-egress-idle-$PID")
  $env:PORTABLE_EXECUTABLE_DIR = $idleData.FullName
  $p = $null
  try {
    $p = Start-Process $releaseExe -PassThru
    $null = $p.Handle
    Start-Sleep -Seconds $IdleSeconds
    if ($p.HasExited) { $problems.Add("release-idle: the release exe exited on its own (exit $($p.ExitCode)) before the idle period ended.") }
    else {
      # The tree as it stands before the close, each with a handle held so its exit time can still be
      # read once it is gone: a failed quit then says which process held it up, and for how long.
      # Diagnostics only: if listing the children fails, measure the root alone rather than leave the
      # exe running while the block rules come down.
      $tree = @($p)
      try {
        $tree += @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | ForEach-Object {
            try { $c = [Diagnostics.Process]::GetProcessById([int]$_.ProcessId); $null = $c.Handle; $c } catch { $null = $_ }
          })
      } catch { Write-Host "[release-idle] could not list the tree before the close: $($_.Exception.Message)" }
      $closedAt = Get-Date
      $sent = $p.CloseMainWindow()
      $killedAfter = $null
      if (-not $sent -or -not $p.WaitForExit($QuitSeconds * 1000)) {
        $killedAfter = ((Get-Date) - $closedAt).TotalSeconds
        taskkill /PID $p.Id /T /F 2>$null | Out-Null
      }
      foreach ($c in $tree) { $null = $c.WaitForExit(5000) }
      $exits = @($tree | ForEach-Object {
          [pscustomobject]@{ Pid = $_.Id; Root = ($_.Id -eq $p.Id); ExitedAfter = if ($_.HasExited) { [Math]::Round(($_.ExitTime - $closedAt).TotalSeconds, 3) } else { $null } }
        })
      $quit = Get-QuitReport -ClosedPid $p.Id -CloseSent $sent -Exits $exits -KilledAfter $killedAfter -BudgetSeconds $QuitSeconds
      Write-Host "[release-idle] quit: $($quit.Detail)"
      $summary.releaseIdleQuit = [ordered]@{
        closedPid = $p.Id; closeMainWindow = $sent; budgetSeconds = $QuitSeconds
        killedAfter = if ($null -ne $killedAfter) { [Math]::Round($killedAfter, 3) } else { $null }
        exits = $exits; detail = $quit.Detail
      }
      if ($quit.Problem) { $problems.Add($quit.Problem) }
    }
  } finally {
    # Never leave the release exe running past this window, whatever threw above: the block rules
    # are removed during cleanup.
    if ($p -and -not $p.HasExited) { taskkill /PID $p.Id /T /F 2>$null | Out-Null }
    Remove-Item Env:PORTABLE_EXECUTABLE_DIR -ErrorAction SilentlyContinue
    Remove-Item $idleData.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
  $null = Get-WindowVerdict 'release-idle' $from

  # ---- last look, then disarm ----
  # The block rules are about to go. Confirm nothing of the app is left to use the network once they
  # do, check the instruments stayed on, and read window 3 once more so its final second is covered.
  Start-Sleep -Seconds 1
  $left = @(Get-PackageProcesses $state.armed)
  if ($left) { $problems.Add("before disarm: $($left.Count) package process(es) still running (pid $($left.ProcessId -join ', ')); refusing to call the run clean.") }
  Assert-StillArmed 'before disarm'
  Assert-Clean 'release-idle' (Get-WindowVerdict 'release-idle' $from)
} finally {
  # ---- disarm: always, each step on its own, and verify ----
  Invoke-Cleanup 'removing the firewall rules' { Remove-GateRules }
  Invoke-Cleanup 'restoring the audit policy' {
    if ($state.auditBackup -and (Test-Path $state.auditBackup)) {
      Invoke-Native 'auditpol /restore' { auditpol /restore "/file:$($state.auditBackup)" }
      # Compared as `auditpol /get /r` text: a restored backup re-exports with two extra GlobalSacl rows.
      if (((auditpol /get /category:* /r) -join "`n") -ne $state.auditBefore) { throw 'audit policy differs from its state before the gate' }
    }
  }
  Invoke-Cleanup 'deleting the audit policy backup' { if ($state.auditBackup) { Remove-Item $state.auditBackup -Force -ErrorAction SilentlyContinue } }
  Invoke-Cleanup 'restoring the Security log size' { if ($state.secLogSize) { Invoke-Native 'wevtutil sl Security' { wevtutil sl Security "/ms:$($state.secLogSize)" } } }
  Invoke-Cleanup 'restoring the DNS-Client channel' { if ($state.dnsLogEnabled -eq 'false') { Invoke-Native 'wevtutil sl DNS-Client' { wevtutil sl $dnsLog /e:false } } }
  Invoke-Cleanup 'checking that no gate rule is left' { if (Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue) { throw 'a gate firewall rule is still present' } }
  $problems = [Collections.Generic.List[string]]@($problems | Select-Object -Unique)
  $summary.problems = @($problems)
  Invoke-Cleanup 'writing verdict.json' { $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $EvidenceDir 'verdict.json') }
}

if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Host "::error::$_" }
  throw "Windows egress gate FAILED with $($problems.Count) problem(s); evidence in $EvidenceDir."
}
Write-Host 'Windows egress gate passed: controls seen, no egress from the app process tree.'
