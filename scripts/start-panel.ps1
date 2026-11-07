# Start the control panel headlessly and log every step.
# Used when the panel is down and we need it back with admin rights:
#   Start-Process powershell -Verb RunAs -File scripts\start-panel.ps1
# Also usable un-elevated for a smoke test (the panel then reports 管理员=否).
$ErrorActionPreference = 'Continue'
$root = 'E:\dsh\QQ-agent'
$port = 8899
$log = Join-Path $root 'data\panel-start.log'

function L($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 }

L '==== start-panel begin ===='
L ("elevated = " + (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)))

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
L ("node = " + $node)
if (-not $node) { L 'FATAL: node not found'; exit 1 }

$env:QQ_PANEL_PORT = [string]$port
# 不要自动开浏览器：反复重启会把标签页越开越多（2026-10-28 机主就看到三个）。
# 需要看页面时自己访问 http://127.0.0.1:8899 即可。
$env:QQ_PANEL_NO_BROWSER = '1'
$out = Join-Path $root 'data\web-panel.console.log'
$err = Join-Path $root 'data\web-panel.console.err.log'

try {
  Start-Process -FilePath $node -ArgumentList (Join-Path $root 'scripts\web-panel-server.mjs') `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
  L 'Start-Process ok'
} catch {
  L ('Start-Process FAILED: ' + $_.Exception.Message)
  exit 1
}

Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest ("http://127.0.0.1:{0}/api/state" -f $port) -UseBasicParsing -TimeoutSec 5
  L ("state ok: " + $r.StatusCode)
} catch {
  L ("state FAILED: " + $_.Exception.Message)
}
L '==== start-panel end ===='
