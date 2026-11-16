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
#     before a clean result means anything.
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
  [string]$Release = 'release\win-unpacked\PDF Signer.exe',
  [string]$EvidenceDir = 'egress-gate-out',
  # Attempts per Node TCP/UDP control. 3 on every release; 20 for the evidence run (RFC section 6.1).
  [int]$Repeat = 3,
  [int]$IdleSeconds = 15,
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
    [int[]]$ShareClientPids = @()
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
          if (-not $in -and [int]$port -in 445, 139, 80 -and -not (Get-AddressExemption $remote $Broadcast)) {
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
  [pscustomobject]@{ Members = $members; Failures = $failures; Logged = $logged }
}

# The controls: every positive attempt must have been blocked AND recorded with the right pid, and
# the negative ones must have left no trace. Returns the list of problems (empty = controls hold).
function Test-EgressControls {
  param($Verdict, $Report)
  $problems = [Collections.Generic.List[string]]::new()
  if ($Report.error) { $problems.Add("control failed: the driver errored: $($Report.error)") ; return $problems }
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

function Format-Failure($f) { "pid $($f.Pid) at $($f.Time): $($f.Detail)" }

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
  $v = Get-EgressVerdict -Sec @($smb, (& $conn 5156 2 4 'System' '203.0.113.9')) -PackageDirs $dirs -ShareClientPids 4
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
$disabled = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled })
if ($disabled) { throw "control failed (precondition): firewall profile(s) $($disabled.Name -join ', ') are disabled, so the block rules would not apply." }

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
$auditGuids = @(
  '{0CCE9225-69AE-11D9-BED3-505054503030}' # Filtering Platform Packet Drop  (5152)
  '{0CCE9226-69AE-11D9-BED3-505054503030}' # Filtering Platform Connection   (5156, 5157)
  '{0CCE922B-69AE-11D9-BED3-505054503030}' # Process Creation                (4688)
  '{0CCE922C-69AE-11D9-BED3-505054503030}' # Process Termination             (4689)
)
function Remove-GateRules { Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
function Get-LogSetting([string]$Log, [string]$Name) { ((wevtutil gl $Log) -match "^\s*$Name\s*:") -replace '^.*:\s*', '' | Select-Object -First 1 }
function Invoke-Native([string]$What, [scriptblock]$Command) {
  & $Command | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}
function Read-Events([string]$Log, [int[]]$Ids, [datetime]$From, [datetime]$To) {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = $Log; Id = $Ids; StartTime = $From; EndTime = $To } -ErrorAction SilentlyContinue)
  foreach ($e in $events) {
    $row = [ordered]@{ Id = $e.Id; Time = $e.TimeCreated.ToUniversalTime().ToString('o'); Rec = $e.RecordId; Pid = $e.ProcessId }
    foreach ($d in ([xml]$e.ToXml()).Event.EventData.Data) { $row[$d.Name] = $d.'#text' }
    [pscustomobject]$row
  }
}

$problems = [Collections.Generic.List[string]]::new()
$summary = [ordered]@{ started = (Get-Date).ToUniversalTime().ToString('o'); probe = $probeExe; release = $releaseExe; windows = [ordered]@{} }
$marker = "egress-gate-marker-$PID.invalid"
$webClient = [int](Get-CimInstance Win32_Service -Filter "Name='WebClient'" -ErrorAction SilentlyContinue).ProcessId
$shareClientPids = @(4) + @($webClient | Where-Object { $_ })
$state = @{}

# Judge one window. Both logs must still hold the markers written at arm time: if either rolled over,
# a clean result would mean nothing.
function Get-WindowVerdict([string]$Name, [datetime]$From) {
  Start-Sleep -Seconds 3 # let the last events reach the logs
  $to = Get-Date
  $sec = @(Read-Events 'Security' (4688, 4689, 5152, 5156, 5157) $From $to)
  $dns = @(Read-Events $dnsLog (3006, 3009, 3010) $From $to)
  $sec | ConvertTo-Json -Depth 3 -Compress | Set-Content (Join-Path $EvidenceDir "events-$Name-security.json")
  $dns | ConvertTo-Json -Depth 3 -Compress | Set-Content (Join-Path $EvidenceDir "events-$Name-dns.json")
  # Get-WinEvent compares these bounds at whole-second resolution (seen on the runner: an EndTime of
  # hh:mm:30.37 excluded an event at hh:mm:30.24), so the marker is read up to now, not up to $From.
  $armSec = @(Read-Events 'Security' (4688) $state.armed $to | Where-Object { [Convert]::ToInt32($_.NewProcessId, 16) -eq $state.markerPid })
  $armDns = @(Read-Events $dnsLog (3006) $state.armed $to | Where-Object QueryName -eq $marker)
  if (-not $armSec) { $script:problems.Add("${Name}: the Security log no longer holds the arm marker (rolled over, or process auditing is off).") }
  if (-not $armDns) { $script:problems.Add("${Name}: the DNS-Client log no longer holds the arm marker (rolled over, or the channel is off).") }
  $v = Get-EgressVerdict -Sec $sec -Dns $dns -PackageDirs $packageDirs -AllowImage $AllowImage -AllowDnsName $AllowDnsName -Broadcast $broadcast -ShareClientPids $shareClientPids
  $script:summary.windows[$Name] = [ordered]@{
    from = $From.ToUniversalTime().ToString('o'); to = $to.ToUniversalTime().ToString('o')
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

try {
  # ---- arm ----
  Remove-GateRules # leftovers from a killed run
  $state.auditBackup = Join-Path $EvidenceDir 'auditpol-backup.csv'
  Invoke-Native 'auditpol /backup' { auditpol /backup "/file:$($state.auditBackup)" }
  $state.auditBefore = (auditpol /get /category:* /r) -join "`n"
  $state.secLogSize = Get-LogSetting 'Security' 'maxSize'
  $state.dnsLogEnabled = Get-LogSetting $dnsLog 'enabled'
  Invoke-Native 'Security log resize' { wevtutil sl Security /ms:268435456 }
  foreach ($g in $auditGuids) { Invoke-Native "auditpol /set $g" { auditpol /set "/subcategory:$g" /success:enable /failure:enable } }
  $images = @(Get-ChildItem $packageDirs -Recurse -Filter *.exe | ForEach-Object FullName)
  $i = 0
  foreach ($image in $images) { $i++; New-NetFirewallRule -DisplayName "$RulePrefix $i" -Direction Outbound -Action Block -Program $image -Profile Any | Out-Null }
  Invoke-Native 'DNS-Client channel enable' { wevtutil sl $dnsLog /e:true }
  $summary.rules = $images
  $state.armed = Get-Date
  Start-Sleep -Milliseconds 500
  $m = Start-Process cmd.exe -ArgumentList '/c', 'exit' -PassThru -WindowStyle Hidden; $state.markerPid = $m.Id; $m.WaitForExit()
  try { $null = [Net.Dns]::GetHostAddresses($marker) } catch { $null = $_ } # a .invalid name: the lookup itself is the marker
  Write-Host "armed: $($images.Count) block rule(s), Filtering Platform + process auditing, DNS-Client log"

  # ---- window 1: controls on the probe ----
  $from = Get-Date
  $controlFile = Join-Path $EvidenceDir 'control.json'
  $env:PKG_EXE = $probeExe
  node scripts/egress-control.mjs $controlFile $Repeat | Out-Host
  $controlExit = $LASTEXITCODE
  $v = Get-WindowVerdict 'control' $from
  if ($controlExit -ne 0 -or -not (Test-Path $controlFile)) { $problems.Add("control failed: the control driver exited $controlExit.") }
  else {
    $report = Get-Content $controlFile -Raw | ConvertFrom-Json
    $controlProblems = @(Test-EgressControls $v $report)
    $controlProblems | ForEach-Object { $problems.Add($_) }
    @($v.Failures | Where-Object Kind -eq 'image') | ForEach-Object { $problems.Add("control: $(Format-Failure $_)") }
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
  try {
    $p = Start-Process $releaseExe -PassThru
    $null = $p.Handle
    Start-Sleep -Seconds $IdleSeconds
    if ($p.HasExited) { $problems.Add("release-idle: the release exe exited on its own (exit $($p.ExitCode)) before the idle period ended.") }
    else {
      $null = $p.CloseMainWindow()
      if (-not $p.WaitForExit(10000)) { taskkill /PID $p.Id /T /F | Out-Null; Write-Host 'release-idle: the app did not quit on window close; killed (quit path not measured).' }
    }
  } finally {
    Remove-Item Env:PORTABLE_EXECUTABLE_DIR -ErrorAction SilentlyContinue
    Remove-Item $idleData.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
  Assert-Clean 'release-idle' (Get-WindowVerdict 'release-idle' $from)
} finally {
  # ---- disarm: always, and verify ----
  Remove-GateRules
  if ($state.auditBackup -and (Test-Path $state.auditBackup)) {
    auditpol /restore "/file:$($state.auditBackup)" | Out-Null
    # Compared as `auditpol /get /r` text: a restored backup re-exports with two extra GlobalSacl rows.
    if (((auditpol /get /category:* /r) -join "`n") -ne $state.auditBefore) { $problems.Add('cleanup: audit policy differs from its state before the gate.') }
  }
  if ($state.secLogSize) { wevtutil sl Security "/ms:$($state.secLogSize)" | Out-Null }
  if ($state.dnsLogEnabled -eq 'false') { wevtutil sl $dnsLog /e:false | Out-Null }
  if (Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue) { $problems.Add('cleanup: a gate firewall rule is still present.') }
  $summary.problems = @($problems)
  $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $EvidenceDir 'verdict.json')
}

if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Host "::error::$_" }
  throw "Windows egress gate FAILED with $($problems.Count) problem(s); evidence in $EvidenceDir."
}
Write-Host 'Windows egress gate passed: controls seen, no egress from the app process tree.'
