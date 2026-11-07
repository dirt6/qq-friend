<#
  QQ Agent 快速启动器（人设 → NapCat 扫码 → 机器人）

  设计意图（按机主 2026-10-12 的需求）：
    ① 先出界面改人设 —— 直接编辑 persona.roleText，改完保存
    ② 再启 NapCat 并**打开网页版二维码**（命令行里那个二维码扫不到，WebUI 的能扫）
    ③ 最后启机器人

  ⚠️ 人设是配置项，而运行中的应用有内存缓存 —— 所以改了人设必须重启机器人
     才生效。启动器里的「停止机器人」就是干这个的，别让机主改完一脸茫然。

  说明：本脚本不写任何二进制配置；人设的读写一律委托给 scripts/persona-cli.mjs
  （Node，UTF-8 无 BOM，只改指定字段）。
#>

[CmdletBinding()]
param(
  # 非交互自检：只验证各部件（读配置、读人设、探测 NapCat/机器人状态），不弹窗。
  # 用途：改完脚本先跑一遍确认没写坏，不用真的点界面。
  [switch]$SelfTest
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Continue'
[System.Windows.Forms.Application]::EnableVisualStyles()

$Root        = Split-Path -Parent $MyInvocation.MyCommand.Path
# R8-0-A3：数据目录跟随 PROFILE（与核心/面板同一套规则）
$ProfileSuffix = if ($env:QQ_AGENT_PROFILE -match '^\d+$') { "-$($env:QQ_AGENT_PROFILE)" } else { '' }
$DataDir       = if ($env:QQ_AGENT_DATA_DIR) { $env:QQ_AGENT_DATA_DIR } else { Join-Path $Root "data$ProfileSuffix" }
$ConfigPath  = Join-Path $DataDir 'config.json'
$PersonaCli  = Join-Path $Root 'scripts\persona-cli.mjs'
$StartBotBat = Join-Path $Root '启动QQ机器人.bat'
$StartNapBat = Join-Path $Root 'napcat\启动NapCat-QQ.bat'
$ElectronExe = Join-Path $Root 'node_modules\electron\dist\electron.exe'
$LockFile    = Join-Path $DataDir 'qq-agent.lock'

# ── 窗口尺寸按屏幕可用区收窄（在自检之前算好，自检要打印它）───────────────
# 这台机器实测可用区只有 1536×864 —— 早先固定 1000×1010 的窗口比屏幕还高，
# 底部那排按钮直接掉到屏幕外，"点了快捷方式像没反应"就是这么来的。
# 下面所有控件坐标都从 $formW/$formH 反推，小屏上也保证按钮可点。
$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$formW = [Math]::Max(820, [Math]::Min(1000, $work.Width - 40))
$formH = [Math]::Max(560, [Math]::Min(1010, $work.Height - 40))

# 底部各行按"窗口下沿"定位（也在自检之前算，自检要打印它们做边界检查）：
# 用 $formH 反推 y，而不是写死像素 —— 小屏上这些控件跟着窗口上移，
# 不会被挤到屏幕底下点不到。
$yStep3 = $formH - 258   # ③ 标题
$yRow3  = $formH - 232   # ③ 那排按钮
$yAll   = $formH - 192   # 一键按钮
$yBusy  = $formH - 184   # 状态文字
$yLog   = $formH - 152   # 日志框（高度固定）
$logH   = 118

# ── 小工具 ────────────────────────────────────────────────────────────────
function Get-ConfigObject {
  $bytes = [System.IO.File]::ReadAllBytes($ConfigPath)
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
  return $text | ConvertFrom-Json
}

function Get-RoleText {
  # 走 Node 读（PowerShell 的 ConvertFrom-Json 在中文上不可靠），但**自己接字节**：
  # 早先版本用 `| Out-File -Encoding utf8`，踩了两个坑：
  #   ① PS5.1 的 Out-File 总会写 BOM，回读时开头多出一个 U+FEFF；
  #   ② 它把文本里的 `\n` 全换成 `\r\n`，整份人设凭空多出上百字符 —— 而这里读出后
  #      又会被写回去，等于"每开一次启动器就把人设改写一遍"（2026-10-12 实测：
  #      人设从 2587 字涨到 2695 字）。
  # 所以改为：node 的 stdout 直接重定向到文件（字节级、不经 PowerShell 管道），
  # 再按 UTF-8 读、剥掉可能存在的 BOM，并把行尾统一回 `\n`。
  $tmp = Join-Path $env:TEMP ("qqa-persona-" + [Guid]::NewGuid().ToString('N') + ".txt")
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = "`"$PersonaCli`" get"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  [System.IO.File]::WriteAllText($tmp, $stdout, (New-Object System.Text.UTF8Encoding($false)))
  $text = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
  $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
  return $text
}

function Save-RoleText([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return @{ ok = $false; msg = '人设不能为空' } }
  # 行尾统一成 `\n`：文本框交回来的可能是 `\r\n`，不归一化就会在每次保存时
  # 悄悄给整份人设"加长"，也会让 diff 全是噪声
  $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
  $tmp = Join-Path $env:TEMP ("qqa-persona-" + [Guid]::NewGuid().ToString('N') + ".txt")
  # 用 .NET 写：无 BOM 的 UTF-8（Out-File -Encoding utf8 在 PS5.1 会带 BOM）
  [System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($false)))
  $out = & node $PersonaCli set $tmp 2>&1
  $code = $LASTEXITCODE
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if ($code -eq 0) { return @{ ok = $true; msg = "已保存（$($text.Length) 字）" } }
  return @{ ok = $false; msg = ($out -join ' ') }
}

function Test-BotRunning {
  if (-not (Test-Path $LockFile)) { return $false }
  $lockPid = (Get-Content $LockFile -Raw).Trim()
  if (-not $lockPid) { return $false }
  $p = Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue
  return [bool]$p
}

<#
  关闭所有 QQ 进程（含 QQEX 等伴生进程）。

  为什么单独成函数并且要提权：NapCat 注入后 QQ 的完整性级别高于普通进程，
  普通权限下 Stop-Process 会 "Access is denied" —— 而它**不会抛异常到调用方**
  的返回上（实测里报了"已结束"但进程仍在），于是表现为"清了 QQ 却还是注入失败"。
  这里统一走一次 UAC（-Verb RunAs），在提权进程里用 taskkill 强杀。
  返回 $true 表示轮询确认所有 QQ 都已退出。
#>
function Close-AllQq {
  $names = @('QQ', 'QQEX')
  $before = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
  if ($before.Count -eq 0) { return $true }

  Write-Log "正在提权关闭 QQ（$($before.Count) 个进程，会弹一次 UAC）…"
  try {
    Start-Process -FilePath 'taskkill.exe' -ArgumentList '/F','/IM','QQ.exe','/T' -Verb RunAs -WindowStyle Hidden -ErrorAction Stop
    Start-Sleep -Seconds 2
    Start-Process -FilePath 'taskkill.exe' -ArgumentList '/F','/IM','QQEX.exe','/T' -Verb RunAs -WindowStyle Hidden -ErrorAction Stop
  } catch {
    Write-Log "⚠️ 提权关闭失败：$($_.Exception.Message)"
  }

  # 轮询确认真的没了（taskkill 是异步的，必须等）
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $left = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) { Write-Log '✅ QQ 已全部退出，可以干净注入了。'; return $true }
    [System.Windows.Forms.Application]::DoEvents()
  }
  $left = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
  Write-Log "⚠️ 仍有 $($left.Count) 个 QQ 进程：$(($left | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join '、')"
  return $false
}

function Test-OneBotLoggedIn([string]$httpUrl, [string]$token) {
  try {
    $headers = @{}
    if ($token) { $headers['authorization'] = "Bearer $token" }
    $r = Invoke-RestMethod -Uri "$($httpUrl.TrimEnd('/'))/get_login_info" -Method Post `
      -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 5
    return [bool]($r -and $r.status -eq 'ok' -and $r.data.user_id)
  } catch { return $false }
}

# 供按钮回调用的界面元素（脚本作用域）
$script:Log = $null
$script:Editor = $null
$script:SaveHint = $null
$script:BusyLabel = $null
$script:QrBox = $null
$script:QrHint = $null

function Write-Log([string]$msg) {
  $stamp = Get-Date -Format 'HH:mm:ss'
  $script:Log.AppendText("[$stamp] $msg`r`n")
  $script:Log.SelectionStart = $script:Log.TextLength
  $script:Log.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

function Set-Busy([string]$msg) {
  $script:BusyLabel.Text = $msg
  [System.Windows.Forms.Application]::DoEvents()
}

# ── 各步骤动作 ────────────────────────────────────────────────────────────

function Do-SavePersona([switch]$Silent) {
  $r = Save-RoleText $script:Editor.Text
  $script:SaveHint.Text = if ($r.ok) { "✅ $($r.msg)" } else { "❌ $($r.msg)" }
  $script:SaveHint.ForeColor = if ($r.ok) { [System.Drawing.Color]::FromArgb(0, 128, 0) } else { [System.Drawing.Color]::Red }
  if (-not $Silent) { Write-Log "人设：$($r.msg)" }
  return $r.ok
}

function Do-StopBot {
  if (-not (Test-BotRunning)) { Write-Log '机器人本来就没在运行。'; return }
  $lockPid = (Get-Content $LockFile -Raw).Trim()
  Write-Log "停止机器人（PID $lockPid）…"
  try {
    Stop-Process -Id ([int]$lockPid) -Force -ErrorAction Stop
    Start-Sleep -Seconds 3
    if (Test-BotRunning) { Write-Log '⚠️ 没停掉：可能权限不足，请手动在任务管理器结束 electron.exe。' }
    else { Write-Log '机器人已停止。' }
  } catch {
    Write-Log "⚠️ 停止失败：$($_.Exception.Message)"
  }
}

function Do-StartBot {
  if (-not (Test-Path $ElectronExe)) { Write-Log '❌ 找不到 electron.exe，先跑 npm install。'; return }
  if (Test-BotRunning) { Write-Log '机器人已经在运行了（要应用新人设请先「停止机器人」再启）。'; return }
  Write-Log '启动机器人…'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$StartBotBat`"" -WorkingDirectory $Root
  Set-Busy '机器人启动中…'
  Start-Sleep -Seconds 10
  if (Test-BotRunning) { Write-Log '✅ 机器人已启动（控制台 http://127.0.0.1:3210）。' }
  else { Write-Log '⚠️ 没有检测到 electron 进程，看看有没有弹窗报错。' }
  Set-Busy ''
}

function Do-StartNapCat {
  if (-not (Test-Path $StartNapBat)) { Write-Log "❌ 找不到 $StartNapBat"; return $false }

  $cfg = Get-ConfigObject
  $wsUrl = [string]$cfg.snowluma.wsUrl
  $httpUrl = [string]$cfg.snowluma.httpUrl
  $token = [string]$cfg.snowluma.httpAccessToken
  $wj = Join-Path $Root 'napcat\shell\napcat\config\webui.json'
  $webPort = 6099
  if (Test-Path $wj) {
    $wjBytes = [System.IO.File]::ReadAllBytes($wj)
    $wjText = [System.Text.Encoding]::UTF8.GetString($wjBytes)
    try { $webPort = (($wjText | ConvertFrom-Json).port) } catch { }
  }
  $webUrl = "http://127.0.0.1:$webPort/webui/"

  $already = Test-OneBotLoggedIn $httpUrl $token
  if ($already) {
    Write-Log 'NapCat 已经在运行且已登录，跳过启动与扫码。'
    return $true
  }

  # ── 先清残留在跑的 QQ ──
  # 实测（2026-10-12）：QQ 已经在跑时，NapCat 注入会失败并弹出
  # "Windows 找不到文件 'QQ'"。清掉残留进程后重新注入即可成功 —— 所以这一步
  # 不是保险，是修一个真实故障。做成"询问后关"而不是直接杀：机主可能正在用 QQ。
  $qqProcs = @(Get-Process -Name QQ -ErrorAction SilentlyContinue)
  if ($qqProcs.Count -gt 0) {
    $info = ($qqProcs | ForEach-Object { "PID $($_.Id)（启动于 $($_.StartTime.ToString('MM-dd HH:mm'))）" }) -join '、'
    Write-Log "发现 $($qqProcs.Count) 个正在运行的 QQ：$info"
    $ans = [System.Windows.Forms.MessageBox]::Show(
      "检测到 QQ 正在运行（$info）。`n`nNapCat 需要重新注入 QQ 才能接管协议；" +
      "QQ 已在运行时注入会失败，典型报错是「Windows 找不到文件 'QQ'」。`n`n" +
      '要现在关掉这些 QQ 再继续吗？（QQ 里未发送的内容会丢失）',
      'QQ Agent 快速启动', 'YesNo', 'Warning')
    if ($ans -ne [System.Windows.Forms.DialogResult]::Yes) {
      Write-Log '⚠️ 你选择了保留 QQ。注入很可能失败 —— 若失败请先完全退出 QQ 再点「启动 NapCat」。'
      Set-Busy ''
      return $false
    }
    # 关 QQ 必须提权：QQ 被 NapCat 注入后完整性级别高于普通进程，
    # 普通权限下 Stop-Process 会直接 Access is denied（2026-10-12 实测：明明
    # 报了"已结束"，进程却还活着）。所以走一次 UAC，在提权进程里 taskkill。
    $killed = Close-AllQq
    if (-not $killed) {
      Write-Log '⚠️ QQ 没能清干净 —— 注入很可能失败（报错就是「Windows 找不到文件 \'QQ\'」）。'
      Write-Log '   请手动完全退出 QQ（含托盘）后，再点一次「启动 NapCat」。'
      $ans2 = [System.Windows.Forms.MessageBox]::Show(
        'QQ 没能自动关闭（需要管理员权限）。' + "`n`n" +
        '要继续尝试启动 NapCat 吗？' + "`n" +
        '（大概率会失败并弹出「Windows 找不到文件 QQ」；建议先手动退出 QQ，选「否」去处理）',
        'QQ Agent 快速启动', 'YesNo', 'Warning')
      if ($ans2 -ne [System.Windows.Forms.DialogResult]::Yes) { Set-Busy ''; return $false }
    }
  }

  Write-Log '启动 NapCat（会弹 UAC 授权框，点「是」）…'
  Set-Busy '等待 UAC 授权…'
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$StartNapBat`"" -WorkingDirectory (Split-Path $StartNapBat -Parent) -Verb RunAs -ErrorAction Stop
  } catch {
    Write-Log "❌ 提权被取消或失败：$($_.Exception.Message)"
    Set-Busy ''
    return $false
  }

  # ── 等二维码图片（走 NapCat 自己落盘的 cache\qrcode.png）──
  # 为什么不用 WebUI：命令行里那串二维码扫不到，而 WebUI 还要等它起来、再点进登录页。
  # NapCat 每次生成/刷新二维码都会**覆盖写**这个文件，直接把它显示出来最省事。
  $qrPath = Join-Path $Root 'napcat\shell\napcat\cache\qrcode.png'
  Write-Log "等待二维码生成（$qrPath）…"
  $deadline = (Get-Date).AddSeconds(180)
  $qrTime = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Path $qrPath) {
      $t = (Get-Item $qrPath).LastWriteTime
      if ($t -gt (Get-Date).AddSeconds(-15)) { $qrTime = $t; break }   # 刚写出来的才算新码
    }
    [System.Windows.Forms.Application]::DoEvents()
  }
  if ($qrTime) {
    Write-Log "✅ 二维码已更新（$($qrTime.ToString('HH:mm:ss'))）。"
    Show-QrCode $qrPath
    Set-Busy '请用手机 QQ 扫码登录（码会过期，过期后会自动刷新）'
  } else {
    Write-Log "⚠️ 没等到新二维码。可以手动打开：$qrPath"
  }
  return $true
}

# 在界面里直接显示二维码图片（不用你去文件夹里找）
function Show-QrCode([string]$path) {
  try {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    # 从流加载后要复制一份：MemoryStream 被释放后 PictureBox 的图会失效
    $img = [System.Drawing.Image]::FromStream($ms)
    $script:QrBox.Image = New-Object System.Drawing.Bitmap($img)
    $img.Dispose(); $ms.Dispose()
    $script:QrBox.Visible = $true
    $script:QrHint.Text = "二维码（$((Get-Item $path).LastWriteTime.ToString('HH:mm:ss')) 生成）—— 用手机 QQ 扫这个"
    $script:QrHint.Visible = $true
  } catch {
    Write-Log "⚠️ 显示二维码失败：$($_.Exception.Message)；图片在 $path"
  }
}

function Do-WaitLogin([int]$timeoutSec = 300) {
  $cfg = Get-ConfigObject
  $httpUrl = [string]$cfg.snowluma.httpUrl
  $token = [string]$cfg.snowluma.httpAccessToken
  $qrPath = Join-Path $Root 'napcat\shell\napcat\cache\qrcode.png'
  Write-Log '等待扫码登录…（二维码过期会自动刷新，直接扫界面上最新的那张）'
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $lastShown = if (Test-Path $qrPath) { (Get-Item $qrPath).LastWriteTime } else { $null }
  while ((Get-Date) -lt $deadline) {
    if (Test-OneBotLoggedIn $httpUrl $token) {
      Write-Log '✅ 登录成功（OneBot 已应答）。'
      if ($script:QrBox) { $script:QrBox.Visible = $false; $script:QrHint.Visible = $false }
      Set-Busy ''
      return $true
    }
    # 二维码刷新了就跟着换一张（NapCat 会覆盖写同一个文件）
    if (Test-Path $qrPath) {
      $t = (Get-Item $qrPath).LastWriteTime
      if (-not $lastShown -or $t -gt $lastShown) {
        $lastShown = $t
        Show-QrCode $qrPath
        Write-Log "二维码已刷新（$($t.ToString('HH:mm:ss'))），请扫最新这张。"
      }
    }
    Start-Sleep -Seconds 3
    [System.Windows.Forms.Application]::DoEvents()
  }
  Write-Log '⚠️ 等待超时：还没检测到登录。扫码完成后可以点「启动机器人」，或再点一次「启动 NapCat」。'
  Set-Busy ''
  return $false
}

# ── 界面 ──────────────────────────────────────────────────────────────────
if ($SelfTest) {
  Write-Host '=== 快速启动器 自检 ==='
  Write-Host "根目录        : $Root"
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  Write-Host "屏幕可用区    : $($wa.Width)x$($wa.Height)  -> 窗口按 $formW x $formH 开"
  Write-Host "底部控件 y    : ③排=$yRow3 一键=$yAll 日志=$yLog（应 < $formH）"
  foreach ($p in @($ConfigPath, $PersonaCli, $StartBotBat, $StartNapBat, $ElectronExe)) {
    Write-Host ("存在 {0,-6} {1}" -f (Test-Path $p), $p)
  }
  try {
    $cfg = Get-ConfigObject
    Write-Host "配置可解析    : True"
    Write-Host "  wsUrl       : $($cfg.snowluma.wsUrl)"
    Write-Host "  httpUrl     : $($cfg.snowluma.httpUrl)"
    Write-Host "  httpToken   : $(if ($cfg.snowluma.httpAccessToken) { '有' } else { '无' })"
    Write-Host "  botName     : $($cfg.persona.botName)"
    Write-Host "  masterId    : $($cfg.persona.masterId)"
    Write-Host "  roleText 长度: $($cfg.persona.roleText.Length)"
  } catch { Write-Host "配置可解析    : False -> $($_.Exception.Message)" }

  $rt = Get-RoleText
  Write-Host "Node 读人设   : 长度=$($rt.Length) 开头=$($rt.Substring(0, [Math]::Min(24, $rt.Length)).Replace("`n", ' '))"

  # 写入往返（写回原内容，不改动）
  $save = Save-RoleText $rt
  Write-Host "Node 写人设   : ok=$($save.ok) msg=$($save.msg)"

  $cfg = Get-ConfigObject
  Write-Host "NapCat 已登录 : $(Test-OneBotLoggedIn $cfg.snowluma.httpUrl $cfg.snowluma.httpAccessToken)"
  Write-Host "机器人在运行  : $(Test-BotRunning)"
  Write-Host '=== 自检结束 ==='
  exit 0
}

# 窗口尺寸已在文件开头算好（$formW/$formH）：自检分支也要用它，所以不能放这里。
$form = New-Object System.Windows.Forms.Form
$form.Text = 'QQ Agent 快速启动'
$form.Size = New-Object System.Drawing.Size($formW, $formH)
$form.StartPosition = 'CenterScreen'
$form.MinimumSize = New-Object System.Drawing.Size(820, 620)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

# 顶部标题
$title = New-Object System.Windows.Forms.Label
$title.Text = '① 先改人设 —— 改完保存，再往下走'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(12, 10)
$title.Size = New-Object System.Drawing.Size(500, 24)
$form.Controls.Add($title)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "下面是机器人的角色设定（config.json → persona.roleText）。保存后**需要重启机器人才生效**：先点「停止机器人」再点「启动机器人」。"
$hint.Location = New-Object System.Drawing.Point(12, 38)
$hint.Size = New-Object System.Drawing.Size(780, 20)
$hint.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($hint)

# 人设编辑框
$script:Editor = New-Object System.Windows.Forms.TextBox
$script:Editor.Multiline = $true
$script:Editor.ScrollBars = 'Both'
$script:Editor.WordWrap = $false
$script:Editor.AcceptsReturn = $true
$script:Editor.Font = New-Object System.Drawing.Font('Consolas', 9.5)
$script:Editor.Location = New-Object System.Drawing.Point(12, 62)
$script:Editor.Size = New-Object System.Drawing.Size(780, 300)
$script:Editor.Anchor = 'Top,Left,Right'
$form.Controls.Add($script:Editor)

# 保存行
$saveBtn = New-Object System.Windows.Forms.Button
$saveBtn.Text = '💾 保存人设'
$saveBtn.Location = New-Object System.Drawing.Point(12, 370)
$saveBtn.Size = New-Object System.Drawing.Size(110, 30)
$saveBtn.Add_Click({ Do-SavePersona | Out-Null })
$form.Controls.Add($saveBtn)

$reloadBtn = New-Object System.Windows.Forms.Button
$reloadBtn.Text = '↻ 重新读取'
$reloadBtn.Location = New-Object System.Drawing.Point(128, 370)
$reloadBtn.Size = New-Object System.Drawing.Size(100, 30)
$reloadBtn.Add_Click({ $script:Editor.Text = Get-RoleText; $script:SaveHint.Text = '已重新读取磁盘上的人设' })
$form.Controls.Add($reloadBtn)

$script:SaveHint = New-Object System.Windows.Forms.Label
$script:SaveHint.Text = ''
$script:SaveHint.Location = New-Object System.Drawing.Point(238, 377)
$script:SaveHint.Size = New-Object System.Drawing.Size(560, 20)
$form.Controls.Add($script:SaveHint)

# ② 启动行
$step2 = New-Object System.Windows.Forms.Label
$step2.Text = '② 启动 NapCat（拉起 QQ + 显示登录二维码）'
$step2.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$step2.Location = New-Object System.Drawing.Point(12, 410)
$step2.Size = New-Object System.Drawing.Size(600, 22)
$form.Controls.Add($step2)

# ── 底部各行：y 坐标已在文件开头按 $formH 算好（见 $yStep3/$yRow3/…）──
$napBtn = New-Object System.Windows.Forms.Button
$napBtn.Text = '🚀 启动 NapCat 并显示二维码'
$napBtn.Location = New-Object System.Drawing.Point(12, $yStep3 + 26)
$napBtn.Size = New-Object System.Drawing.Size(220, 32)
$napBtn.Add_Click({ if (Do-StartNapCat) { Do-WaitLogin | Out-Null } })
$form.Controls.Add($napBtn)

$qrBtn = New-Object System.Windows.Forms.Button
$qrBtn.Text = '🖼 刷新二维码'
$qrBtn.Location = New-Object System.Drawing.Point(238, $yStep3 + 26)
$qrBtn.Size = New-Object System.Drawing.Size(120, 32)
$qrBtn.Add_Click({
  $qrPath = Join-Path $Root 'napcat\shell\napcat\cache\qrcode.png'
  if (Test-Path $qrPath) { Show-QrCode $qrPath; Write-Log "已重新载入二维码（$((Get-Item $qrPath).LastWriteTime.ToString('HH:mm:ss'))）。" }
  else { Write-Log "还没生成二维码：$qrPath（先点「启动 NapCat」）" }
})
$form.Controls.Add($qrBtn)

# 二维码显示面板（在界面里直接扫，不用去文件夹找）
$script:QrBox = New-Object System.Windows.Forms.PictureBox
$script:QrBox.Size = New-Object System.Drawing.Size(200, 200)
$script:QrBox.Location = New-Object System.Drawing.Point(($formW - 220), 410)
$script:QrBox.SizeMode = 'Zoom'
$script:QrBox.BorderStyle = 'FixedSingle'
$script:QrBox.BackColor = [System.Drawing.Color]::White
$script:QrBox.Visible = $false
$script:QrBox.Anchor = 'Top,Right'
$form.Controls.Add($script:QrBox)

$script:QrHint = New-Object System.Windows.Forms.Label
$script:QrHint.Text = ''
$script:QrHint.Location = New-Object System.Drawing.Point(($formW - 220), 616)
$script:QrHint.Size = New-Object System.Drawing.Size(200, 44)
$script:QrHint.ForeColor = [System.Drawing.Color]::FromArgb(0, 90, 160)
$script:QrHint.Visible = $false
$script:QrHint.Anchor = 'Top,Right'
$form.Controls.Add($script:QrHint)

# ③ 机器人行
$step3 = New-Object System.Windows.Forms.Label
$step3.Text = '③ 机器人'
$step3.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$step3.Location = New-Object System.Drawing.Point(12, $yStep3)
$step3.Size = New-Object System.Drawing.Size(300, 22)
$form.Controls.Add($step3)

$botBtn = New-Object System.Windows.Forms.Button
$botBtn.Text = '▶ 启动机器人'
$botBtn.Location = New-Object System.Drawing.Point(12, $yRow3)
$botBtn.Size = New-Object System.Drawing.Size(130, 32)
$botBtn.Add_Click({ Do-StartBot })
$form.Controls.Add($botBtn)

$stopBtn = New-Object System.Windows.Forms.Button
$stopBtn.Text = '⏹ 停止机器人'
$stopBtn.Location = New-Object System.Drawing.Point(148, $yRow3)
$stopBtn.Size = New-Object System.Drawing.Size(130, 32)
$stopBtn.Add_Click({ Do-StopBot })
$form.Controls.Add($stopBtn)

$restartBtn = New-Object System.Windows.Forms.Button
$restartBtn.Text = '⟳ 重启机器人（应用新人设）'
$restartBtn.Location = New-Object System.Drawing.Point(284, $yRow3)
$restartBtn.Size = New-Object System.Drawing.Size(200, 32)
$restartBtn.Add_Click({ Do-StopBot; Do-StartBot })
$form.Controls.Add($restartBtn)

$webBtn = New-Object System.Windows.Forms.Button
$webBtn.Text = '🌐 打开机器人控制台'
$webBtn.Location = New-Object System.Drawing.Point(490, $yRow3)
$webBtn.Size = New-Object System.Drawing.Size(170, 32)
$webBtn.Add_Click({ Start-Process 'http://127.0.0.1:3210' })
$form.Controls.Add($webBtn)

# 一键
$allBtn = New-Object System.Windows.Forms.Button
$allBtn.Text = '⚡ 一键：保存人设 → NapCat → 机器人'
$allBtn.Location = New-Object System.Drawing.Point(12, $yAll)
$allBtn.Size = New-Object System.Drawing.Size(300, 34)
$allBtn.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Bold)
$allBtn.Add_Click({
  if (-not (Do-SavePersona -Silent)) { Write-Log '人设没保存成功，先修好再继续。'; return }
  Write-Log '人设已保存。'
  $napOk = Do-StartNapCat
  if ($napOk) { Do-WaitLogin | Out-Null }
  Do-StartBot
})
$form.Controls.Add($allBtn)

$script:BusyLabel = New-Object System.Windows.Forms.Label
$script:BusyLabel.Text = ''
$script:BusyLabel.Location = New-Object System.Drawing.Point(320, $yBusy)
$script:BusyLabel.Size = New-Object System.Drawing.Size(($formW - 340), 24)
$script:BusyLabel.ForeColor = [System.Drawing.Color]::FromArgb(0, 90, 160)
$script:BusyLabel.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($script:BusyLabel)

# 日志
$script:Log = New-Object System.Windows.Forms.TextBox
$script:Log.Multiline = $true
$script:Log.ScrollBars = 'Vertical'
$script:Log.ReadOnly = $true
$script:Log.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 245)
$script:Log.Location = New-Object System.Drawing.Point(12, $yLog)
$script:Log.Size = New-Object System.Drawing.Size(($formW - 40), $logH)
$script:Log.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($script:Log)

# ── 启动时的状态检查 ──────────────────────────────────────────────────────
$form.Add_Shown({
  Set-Busy '正在读取人设…'
  $script:Editor.Text = Get-RoleText
  $script:SaveHint.Text = "已载入当前人设（$($script:Editor.Text.Length) 字）"
  Set-Busy ''

  try {
    $cfg = Get-ConfigObject
    $httpUrl = [string]$cfg.snowluma.httpUrl
    $token = [string]$cfg.snowluma.httpAccessToken
    if (Test-OneBotLoggedIn $httpUrl $token) { Write-Log 'NapCat 已在运行且已登录。' }
    else { Write-Log 'NapCat 未登录（或未启动）。' }
  } catch { Write-Log "读取配置失败：$($_.Exception.Message)" }

  if (Test-BotRunning) { Write-Log '机器人已在运行中。' } else { Write-Log '机器人未运行。' }

  if ([string]$cfg.persona.masterId) { Write-Log "主人 QQ 号：$($cfg.persona.masterId)（他说话时会切主人模式）" }
  else { Write-Log '未设置主人 QQ 号（persona.masterId 为空）——主人模式不生效。' }
})

[void]$form.ShowDialog()
