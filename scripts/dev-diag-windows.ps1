# 提权诊断：NapCat 那个控制台窗口到底属于哪个进程；QQ 与启动器是否还在；谁在监听 3000/3001
# 自己把结果写到 -Out 指定的文件（不靠管道重定向，避免外层包装出错）
param(
  [string]$Out = 'E:\dsh\QQ-agent\data\diag-windows.txt'
)

$ErrorActionPreference = 'Continue'
$lines = New-Object System.Collections.ArrayList
function Add-Line([string]$s) { [void]$lines.Add($s) }

try {
  $names = @('QQ.exe','cmd.exe','conhost.exe','NapCatWinBootMain.exe','node.exe','WindowsTerminal.exe','powershell.exe')
  Add-Line "=== 进程（PID / 父PID / 名字 / 命令行）==="
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $names -contains $_.Name } |
    Select-Object ProcessId,ParentProcessId,Name,CommandLine | Sort-Object Name,ProcessId)
  $byPid = @{}
  foreach ($p in $procs) {
    $byPid[[int]$p.ProcessId] = $p
    $cl = [string]$p.CommandLine
    if ($cl.Length -gt 120) { $cl = $cl.Substring(0,120) + '...' }
    Add-Line ("  PID {0,-7} 父 {1,-7} {2,-22} {3}" -f $p.ProcessId, $p.ParentProcessId, $p.Name, $cl)
  }

  Add-Line ""
  Add-Line "=== 可见窗口（进程名 / PID / 父PID / 标题）==="
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class QqDiagU {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
'@
  $wins = New-Object System.Collections.ArrayList
  $cb = [QqDiagU+EnumProc]{
    param([IntPtr]$h, [IntPtr]$l)
    try {
      if ([QqDiagU]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 400
        [void][QqDiagU]::GetWindowText($h, $sb, 400)
        $t = $sb.ToString()
        if ($t) {
          $owner = 0
          [void][QqDiagU]::GetWindowThreadProcessId($h, [ref]$owner)
          [void]$wins.Add([pscustomobject]@{ pid = [int]$owner; title = $t })
        }
      }
    } catch {}
    return $true
  }
  [void][QqDiagU]::EnumWindows($cb, [IntPtr]::Zero)

  foreach ($w in ($wins | Sort-Object pid)) {
    $name = if ($byPid.ContainsKey([int]$w.pid)) { $byPid[[int]$w.pid].Name } else { '(不在上面列表)' }
    $par  = if ($byPid.ContainsKey([int]$w.pid)) { $byPid[[int]$w.pid].ParentProcessId } else { '?' }
    Add-Line ("  {0,-22} PID {1,-7} 父 {2,-7} 标题: {3}" -f $name, $w.pid, $par, $w.title)
  }

  Add-Line ""
  Add-Line "=== 谁在监听 3000 / 3001 ==="
  foreach ($port in @(3000, 3001)) {
    try {
      $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
      foreach ($x in $c) {
        $o = Get-Process -Id $x.OwningProcess -ErrorAction SilentlyContinue
        Add-Line ("  端口 {0} <- PID {1} ({2})" -f $port, $x.OwningProcess, $o.ProcessName)
      }
    } catch { Add-Line ("  端口 {0}: {1}" -f $port, $_.Exception.Message) }
  }

  Add-Line ""
  Add-Line "=== 结论判据 ==="
  $launcher = @($procs | Where-Object { $_.Name -eq 'NapCatWinBootMain.exe' })
  $qq = @($procs | Where-Object { $_.Name -eq 'QQ.exe' })
  $cmd = @($procs | Where-Object { $_.Name -eq 'cmd.exe' })
  $conhost = @($procs | Where-Object { $_.Name -eq 'conhost.exe' })
  Add-Line ("  启动器 NapCatWinBootMain.exe 还在 = {0}  PID: {1}" -f [bool]$launcher, ($launcher.ProcessId -join ','))
  Add-Line ("  QQ.exe 进程数 = {0}  PID: {1}" -f $qq.Count, ($qq.ProcessId -join ','))
  Add-Line ("  cmd.exe 进程数 = {0}  PID: {1}" -f $cmd.Count, ($cmd.ProcessId -join ','))
  Add-Line ("  conhost.exe 进程数 = {0}  PID: {1}" -f $conhost.Count, ($conhost.ProcessId -join ','))
  Add-Line ("  管理员 = {0}" -f ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
} catch {
  Add-Line ("异常: " + $_.Exception.Message)
}

$text = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
[System.IO.File]::WriteAllText($Out, $text, [System.Text.UTF8Encoding]::new($false))
Write-Host $text
