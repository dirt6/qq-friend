# Start NapCat with admin rights (ASCII only: PS 5.1 parses UTF-8 without BOM as GBK).
# Why this file exists: the project's launcher (napcat\start...bat) is Chinese-named,
# and killing QQ needs admin (a low-integrity shell gets "Access denied").
$ErrorActionPreference = 'Continue'

$dir = 'E:\dsh\QQ-agent\napcat\shell\napcat'
$qq  = 'D:\NTQQ\QQ.exe'

Write-Host '[napcat-launcher] stopping QQ...'
for ($i = 0; $i -lt 6; $i++) {
    taskkill /F /IM QQ.exe /T 2>$null | Out-Null
    Start-Sleep -Seconds 2
    $left = Get-Process -Name QQ -ErrorAction SilentlyContinue
    if (-not $left) { break }
    Write-Host ('[napcat-launcher] QQ still alive, retry ' + ($i + 2))
}
$left = Get-Process -Name QQ -ErrorAction SilentlyContinue
if ($left) {
    Write-Host '[napcat-launcher] WARNING: QQ could not be stopped:'
    $left | ForEach-Object { Write-Host ('  pid=' + $_.Id) }
    Write-Host '[napcat-launcher] injection will probably fail.'
} else {
    Write-Host '[napcat-launcher] QQ stopped.'
}

if (-not (Test-Path $qq)) { Write-Host ('[napcat-launcher] QQ not found: ' + $qq); Read-Host 'press enter'; exit 1 }

$env:NAPCAT_PATCH_PACKAGE = Join-Path $dir 'qqnt.json'
$env:NAPCAT_LOAD_PATH     = Join-Path $dir 'loadNapCat.js'
$env:NAPCAT_INJECT_PATH   = Join-Path $dir 'NapCatWinBootHook.dll'
$env:NAPCAT_LAUNCHER_PATH = Join-Path $dir 'NapCatWinBootMain.exe'
$env:NAPCAT_MAIN_PATH     = Join-Path $dir 'napcat.mjs'

$m = ($env:NAPCAT_MAIN_PATH -replace '\\', '/')
$content = '(async () => {await import("file:///' + $m + '")})()'
Set-Content -Path $env:NAPCAT_LOAD_PATH -Value $content -Encoding ASCII

Set-Location $dir
Write-Host '[napcat-launcher] injecting NapCat into QQ...'
& $env:NAPCAT_LAUNCHER_PATH $qq $env:NAPCAT_INJECT_PATH
Write-Host '[napcat-launcher] launcher exited (QQ closed).'
