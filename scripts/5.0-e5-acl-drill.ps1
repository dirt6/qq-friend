# 5.0-E5：管理员 ACL 精确回滚演练（必须在提升的 PowerShell 中运行）
# 仅操作独立临时目录；不触碰生产 data/5.0-g1。
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  [pscustomobject]@{ ok = $false; status = 'BLOCKED'; reason = 'requires_administrator'; note = '当前会话不是管理员；未创建/修改任何 ACL' } | ConvertTo-Json
  exit 2
}
$user = "$env:USERDOMAIN\$env:USERNAME"
$root = Join-Path $env:TEMP ('e5-acl-admin-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $env:TEMP ('e5-acl-backup-' + [guid]::NewGuid().ToString('N') + '.txt')
try {
  $sub = Join-Path $root 'a\b'
  New-Item -ItemType Directory -Path $sub -Force | Out-Null
  Set-Content -Path (Join-Path $sub 'one.txt') -Value 'one' -Encoding ASCII
  Set-Content -Path (Join-Path $root 'two.txt') -Value 'two' -Encoding ASCII
  # 显式加一个继承 ACE，模拟生产目录的 Authenticated Users Modify。
  icacls $root /grant "NT AUTHORITY\Authenticated Users:(OI)(CI)M" | Out-Null
  $before = Get-Acl $root
  $beforeAudit = Get-Acl -Audit $root
  $beforeSddl = $before.Sddl
  $beforeOwner = $before.Owner
  $beforeGroup = $before.Group
  Set-Location (Split-Path $root -Parent)
  icacls $root /save $backup /T | Out-Null

  icacls $root /inheritance:r | Out-Null
  icacls $root /remove:g "NT AUTHORITY\Authenticated Users" "BUILTIN\Users" | Out-Null
  icacls $root /grant:r "${user}:(OI)(CI)M" "BUILTIN\Administrators:(OI)(CI)F" "NT AUTHORITY\SYSTEM:(OI)(CI)F" | Out-Null
  Set-Content -Path (Join-Path $root 'write-check.txt') -Value 'ok' -Encoding ASCII
  $minimal = Get-Acl $root
  $minimalBroadWrite = @($minimal.Access | Where-Object { $_.IdentityReference -match 'Authenticated Users|BUILTIN\\Users' -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -match 'Modify|Write|FullControl' }).Count -gt 0

  icacls (Split-Path $root -Parent) /restore $backup | Out-Null
  $after = Get-Acl $root
  $afterAudit = Get-Acl -Audit $root
  $sddlEqual = ($beforeSddl -eq $after.Sddl)
  $auditEqual = ($beforeAudit.Sddl -eq $afterAudit.Sddl)
  $ownerEqual = ($beforeOwner -eq $after.Owner)
  $groupEqual = ($beforeGroup -eq $after.Group)
  $hasBroadWrite = @($after.Access | Where-Object { $_.IdentityReference -match 'Authenticated Users|BUILTIN\\Users' -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -match 'Modify|Write|FullControl' }).Count -gt 0
  [pscustomobject]@{
    ok = ($sddlEqual -and $auditEqual -and $ownerEqual -and $groupEqual)
    status = if ($sddlEqual -and $auditEqual -and $ownerEqual -and $groupEqual) { 'PASS' } else { 'FAIL' }
    ownerBefore = $beforeOwner; ownerAfter = $after.Owner
    groupBefore = $beforeGroup; groupAfter = $after.Group
    daclEqual = $sddlEqual; saclEqual = $auditEqual
    minimalBroadWrite = $minimalBroadWrite
    restoredBroadWrite = $hasBroadWrite
    nonAuthorizedAccountWriteTest = 'UNVERIFIED_NO_SECOND_ACCOUNT'
    note = '仅临时目录；精确比较包含 DACL SDDL/Owner/Group/SACL；非授权账户实际写入需第二账户'
  } | ConvertTo-Json -Depth 4
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  Remove-Item -Force $backup -ErrorAction SilentlyContinue
}
