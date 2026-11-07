# Windows no-egress gate (SC-004): run the packaged app through a real sign while sampling the sockets
# of its whole process tree, and fail on anything reaching beyond loopback.
#
# This is socket sampling, not packet capture: a connection opened and closed between two samples can
# be missed, and DNS lookups go through the system resolver service, so they are not attributed to the
# app. Windows packet capture is host-wide and cannot be scoped to one process tree, so a packet-level
# gate (WFP) remains open in issue #23. Needs no elevation.
param([string]$Exe = 'release\win-unpacked\PDF Signer.exe')

$ErrorActionPreference = 'Stop'
$minimumSamples = 5
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)

function Get-ExternalSockets([int[]]$Ids) {
  $loopback = '^(127\.|::1$)'
  # A TCP socket with a wildcard remote is listening, not connected. A UDP socket has no remote, so a
  # wildcard local bind counts: it can send anywhere.
  @(Get-NetTCPConnection |
    Where-Object { $Ids -contains $_.OwningProcess -and $_.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0$|::$)' } |
    ForEach-Object { "TCP $($_.RemoteAddress):$($_.RemotePort)" }) +
  @(Get-NetUDPEndpoint |
    Where-Object { $Ids -contains $_.OwningProcess -and $_.LocalAddress -notmatch $loopback } |
    ForEach-Object { "UDP bound $($_.LocalAddress):$($_.LocalPort)" })
}

# Positive control: the sampler must see a real TCP connection and a real UDP socket, or a pass would
# mean nothing for that half.
$localIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | Select-Object -First 1).IPAddress
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($localIp), 0)
$listener.Start()
$client = [Net.Sockets.TcpClient]::new($localIp, $listener.LocalEndpoint.Port)
$udp = [Net.Sockets.UdpClient]::new(0)
$control = Get-ExternalSockets @($PID)
$udp.Dispose()
$client.Dispose()
$listener.Stop()
if (-not ($control -match '^TCP')) { throw 'Control failed: the sampler did not see a TCP connection.' }
if (-not ($control -match '^UDP')) { throw 'Control failed: the sampler did not see a UDP socket.' }

$env:PDFSIGNER_SKIP_VALIDATE = '1'
$run = Start-Process node -ArgumentList 'electron/verify-packaged.mjs' -PassThru -NoNewWindow
$null = $run.Handle # keeps ExitCode readable after the process ends

$samples = 0
$found = [Collections.Generic.HashSet[string]]::new()
while (-not $run.HasExited) {
  $ids = @(Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object Id)
  if ($ids.Count -gt 0) {
    $samples++
    foreach ($socket in (Get-ExternalSockets $ids)) { [void]$found.Add($socket) }
  }
}
$run.WaitForExit()

Write-Host "samples with the app running: $samples"
if ($run.ExitCode -ne 0) { throw "The packaged sign failed (exit $($run.ExitCode))." }
if ($samples -lt $minimumSamples) { throw "Only $samples samples: too few to mean anything." }
if ($found.Count -gt 0) {
  $found | ForEach-Object { Write-Host "::error::$_" }
  throw 'EGRESS DETECTED: the app opened a non-loopback socket.'
}
Write-Host 'no non-loopback sockets seen'
