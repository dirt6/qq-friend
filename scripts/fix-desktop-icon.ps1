# ============================================================================
#  应急修复：桌面图标还是旧的那个
# ============================================================================
#  用法 A（推荐）：右键本文件 →「使用 PowerShell 运行」
#  用法 B：双击 修复桌面图标.bat
#
#  做两件事（都会先打印再做，可核对）：
#    1. 重建桌面快捷方式「QQ Agent 控制面板」：目标/参数/工作目录/图标 全部重新写一遍
#    2. 清理 Windows 图标缓存（explorer 进程内缓存 + iconcache 数据库）
#
#  只碰这一个快捷方式和图标缓存，不动任何其它文件，不碰 E:\dsh 之外的东西。
# ============================================================================
[CmdletBinding()]
param(
  [switch]$Check,              # 只看当前状态，不改任何东西（你可以在受限会话里先跑这个）
  [switch]$NoExplorerRestart   # 清完缓存不重启 explorer（默认会问一次）
)

$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
# ══ 2026-11-03：桌面图标改指 Electron 桌面应用（3210）═════════════════
#
# 原来指向「启动控制面板.bat」—— 那是 **8899 的 web 面板**（提权运行）。
# 现在功能都搬到 3210 的 Electron 界面里了，图标应该直接开那个。
#
# 两个 launcher 的分工（别搞混）：
#   · 启动控制面板.bat  → 8899 web 面板（自动提权，连带启动 NapCat）
#   · 启动QQ机器人.bat  → Electron 桌面应用（3210，带 --no-sandbox）
#
# ⚠️ 用后者之后 NapCat 不会自动起 —— 从应用「运维」页点「启动 NapCat」，
#    那条路由自己会请求 UAC。这是有意的：提权只在你主动点的时候发生。
$target  = Join-Path $root '启动QQ机器人.bat'
$workdir = $root
$icon    = Join-Path $root 'assets\icon-app.ico'   # 2026-11-03: 用新文件名绕过 Windows 图标缓存
#        （icon.ico 是给 Electron 打包用的，别动它）
$lnk     = Join-Path $env:USERPROFILE 'Desktop\QQ Agent.lnk'
# 旧名字留着：第一次跑会把它删掉，避免桌面上出现两个图标
$oldLnk  = Join-Path $env:USERPROFILE 'Desktop\QQ Agent 控制面板.lnk'

function Info($m) { Write-Host "[QQ Agent] $m" }
function Warn($m) { Write-Host "[QQ Agent] $m" -ForegroundColor Yellow }

function New-ShortcutObject($path) {
  $sh = New-Object -ComObject WScript.Shell
  return $sh.CreateShortcut($path)
}

# ── 只读检查 ────────────────────────────────────────────────────────────────
if ($Check) {
  Info '检查模式：只读，不修改任何东西'
  foreach ($f in @($target, $icon)) {
    if (Test-Path -LiteralPath $f) { Info "OK   $f ($((Get-Item -LiteralPath $f).Length) 字节)" }
    else { Warn "缺失 $f" }
  }
  $s = New-ShortcutObject $lnk
  Info "快捷方式 目标       = $($s.TargetPath)"
  Info "快捷方式 图标       = $($s.IconLocation)"
  Info "期望     图标       = $icon,0"
  $icoItem = Get-Item -LiteralPath $icon -ErrorAction SilentlyContinue
  if ($icoItem) { Info "图标文件修改时间     = $($icoItem.LastWriteTime)" }
  $lnkItem = Get-Item -LiteralPath $lnk -ErrorAction SilentlyContinue
  if ($lnkItem) { Info "快捷方式修改时间     = $($lnkItem.LastWriteTime)" }
  $icdb = Join-Path $env:LOCALAPPDATA 'IconCache.db'
  $icdbItem = Get-Item -LiteralPath $icdb -Force -ErrorAction SilentlyContinue
  if ($icdbItem) { Info "图标缓存文件         = $icdb ($($icdbItem.Length) 字节)" }
  else { Info '图标缓存文件         = 不存在（%LocalAppData%\IconCache.db）' }
  exit 0
}

# ── 需要管理员 ──────────────────────────────────────────────────────────────
$isAdmin = $false
try {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}
if (-not $isAdmin) {
  Info '需要管理员权限（要重建桌面快捷方式并清理图标缓存），正在请求提权…'
  try {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"' + $PSCommandPath + '"'))
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs | Out-Null
  } catch {
    Warn ('提权失败：' + $_.Exception.Message)
    Warn '也可以右键本文件选「使用 PowerShell 运行」，或直接双击 修复桌面图标.bat。'
    if ([Environment]::UserInteractive) { Read-Host '按回车关闭' }
  }
  exit 0
}

$fatal = {
  param($msg)
  Warn $msg
  if ([Environment]::UserInteractive) { Read-Host '按回车关闭' }
  exit 1
}

if (-not (Test-Path -LiteralPath $target)) { & $fatal "找不到目标文件：$target" }
if (-not (Test-Path -LiteralPath $icon))   { & $fatal "找不到图标文件：$icon" }

# ── 第一步：重建快捷方式 ────────────────────────────────────────────────────
Info '第一步：重建桌面快捷方式'

# 2026-11-03：先把旧名字的那个删掉，避免桌面上出现两个图标
if (Test-Path -LiteralPath $oldLnk) {
  try {
    Remove-Item -LiteralPath $oldLnk -Force -ErrorAction Stop
    Info "  已删除旧快捷方式：$(Split-Path -Leaf $oldLnk)"
  } catch {
    Warn "  旧快捷方式删不掉（$($_.Exception.Message)）—— 手动删也行，不影响下面"
  }
}

$old = New-ShortcutObject $lnk
Info "  改前 目标 = $($old.TargetPath)"
Info "  改前 图标 = $($old.IconLocation)"

$s = New-ShortcutObject $lnk
$s.TargetPath       = $target
$s.WorkingDirectory = $workdir
$s.IconLocation     = "$icon,0"
$s.Description      = 'QQ Agent（桌面应用）'
$s.Save()

$new = New-ShortcutObject $lnk
Info "  改后 目标 = $($new.TargetPath)"
Info "  改后 图标 = $($new.IconLocation)"
Info "  改后 工作目录 = $($new.WorkingDirectory)"
if ($new.IconLocation -ne "$icon,0") { Warn '  图标没写进去，请把这段输出发给我。' }
else { Info '  快捷方式已重建 ✔' }

# ── 第二步：清图标缓存 ──────────────────────────────────────────────────────
Info '第二步：清理 Windows 图标缓存'
$removed = 0
$icdb = Join-Path $env:LOCALAPPDATA 'IconCache.db'
# 用 Get-Item -ErrorAction SilentlyContinue 而不是 Test-Path + Get-Item：
# explorer 会立刻重建这个文件，两步之间文件可能已被删掉，Test-Path 之后取属性会报错
$icdbItem = Get-Item -LiteralPath $icdb -Force -ErrorAction SilentlyContinue
if ($icdbItem) {
  try { Remove-Item -LiteralPath $icdb -Force -ErrorAction Stop; $removed++; Info '  已删除 IconCache.db' }
  catch { Warn ('  IconCache.db 删除失败（explorer 可能还占着，重启后会自动重建）：' + $_.Exception.Message) }
} else { Info '  IconCache.db 不存在，跳过' }

$explorerDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
if (Test-Path -LiteralPath $explorerDir) {
  $caches = Get-ChildItem -LiteralPath $explorerDir -Filter 'iconcache*.db' -Force -ErrorAction SilentlyContinue
  foreach ($c in $caches) {
    try { Remove-Item -LiteralPath $c.FullName -Force -ErrorAction Stop; $removed++; Info "  已删除 $($c.Name)" }
    catch { Warn "  $($c.Name) 删除失败（重启后会重建）" }
  }
} else { Info '  找不到 Explorer 缓存目录，跳过' }
Info "  共删除 $removed 个缓存文件"

# 通知 shell 图标变了
try {
  Add-Type -Namespace QqAgent -Name Shell32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(int wEventId, uint uFlags, System.IntPtr dwItem1, System.IntPtr dwItem2);
'@
  [QqAgent.Shell32]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
  Info '  已通知资源管理器刷新'
} catch { Warn '  SHChangeNotify 调用失败（不影响后续）' }

# ── 第三步：重启 explorer（缓存文件被占用时最关键）──────────────────────────
if (-not $NoExplorerRestart -and [Environment]::UserInteractive) {
  $ans = Read-Host '现在就重启资源管理器让新图标生效？(Y/n)'
  if ($ans -notmatch '^[Nn]') {
    Info '  正在重启资源管理器…'
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
    Start-Sleep -Seconds 2
    if (Get-Process -Name explorer -ErrorAction SilentlyContinue) { Info '  资源管理器已重启 ✔' }
    else { Warn '  资源管理器没起来，请按 Ctrl+Shift+Esc → 文件 → 运行新任务 → explorer.exe' }
  }
}

Info '完成。桌面图标现在应该换成小鲸鱼了。'
Info '如果还是旧的：注销一次再登录（图标缓存也会在注销时彻底重建）。'
if ([Environment]::UserInteractive) { Read-Host '按回车关闭' }
