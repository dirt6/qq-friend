# 读取 Windows 媒体会话（SMTC），输出 JSON。
# 只读：不控制任何播放器，只读标题/歌手/进度/状态。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Json($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 6) }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
  $typeProps = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = @($mgr.GetSessions())
  $list = @()
  foreach ($s in $sessions) {
    try {
      $props = Await ($s.TryGetMediaPropertiesAsync()) $typeProps
      $info = $s.GetPlaybackInfo()
      $tl = $s.GetTimelineProperties()
      $list += [pscustomobject]@{
        app    = [string]$s.SourceAppUserModelId
        title  = [string]$props.Title
        artist = [string]$props.Artist
        album  = [string]$props.AlbumTitle
        status = [string]$info.PlaybackStatus
        pos    = [double]$tl.Position.TotalSeconds
        end    = [double]$tl.EndTime.TotalSeconds
      }
    } catch { }
  }
  Write-Json @{ ok = $true; sessions = @($list) }
} catch {
  Write-Json @{ ok = $false; error = [string]$_.Exception.Message; sessions = @() }
}
