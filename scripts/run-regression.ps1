# 聊天持久化修复 · 全量回归（W5）
#
# 为什么不用 npm test：`npm test` 是 `&&` 链，selftest 的既有失败会让后面的
# 测试根本不跑。这个脚本逐项执行、单项失败不中断，最后给汇总。
#
# 用法：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/run-regression.ps1
#
# 注意：每项测试自己用 mkdtemp 隔离数据目录；本脚本不碰生产 data/。

$Root = Split-Path -Parent $PSScriptRoot
$tests = @(
  'selftest','community-test','skill-test','onebot-whitelist-test','sticker-collect-test',
  'message-id-test','message-images-test','image-cache-test','master-mode-test','tools-skill-audit',
  'sticker-context','skill-modal-ui','render-test','scroll-test','usage-e2e','usage-daily-test',
  'test-prompt','prompt-anchor-test','wake-semantics-test','setup-qq-version','setup-download',
  'qq-pack','qq-process-detect','sender-file-uri-test','sender-send-path-test','vendor-mirror-test',
  'safe-fetch-file-test','market-zip-test','web-search-parse','recall-resolve-test',
  'qself-profile-write-test','reminder-action-test','diary-test','now-playing-test','gallery-test',
  'speech-to-text-test','state-store-test','learned-concurrent-test','token-ledger-concurrent-test',
  'store-corrupt-test','store-mutation-test','store-cache-test','silence-ping-store-test','store-concurrent-test','store-dedup-test','lock-reclaim-protocol-test','r8b-tristate-test','r8-0-data-dir-test','r8-0-single-instance-test','r8-0-entry-consistency-test','companion-core-test','memory-hub-impression-key-test','companion-core-integration-test','memory-port-lock-test','memory-store-lock-test','diary-edit-lock-test','diary-outbox-test','diary-op-fault-test','diary-meta-fault-test','diary-recover-hash-test','diary-paths-test','diary-append-identity-test','diary-isolation-guard-test','diary-append-boundary-test','diary-edit-sync-test','diary-reconcile-cli-test','diary-fault-matrix-test','diary-cleanup-test','diary-memory-delete-test','diary-reset-data-test','b5-cleanup-test','deploy-manifest-test','deploy-acceptance-test','reset-safety-drill-test','data-consistency-audit-test','backup-retention-test','dsh-session-audit-test','legacy-backup-recovery-test','session-inventory-test','data-admin-ui-test','d1-5e-reliability-test','companion-core-4.0-test','test-isolation-guard-test','companion-events-archive-test','token-ledger-test','usage-health-test','d1-7c-private-history-parity','companion-events-test','prompt-version-test','d1-7f-tools-test','5.0-a1-purpose-test','5.0-a2-closure-test','5.0-a3-activity-test','5.0-a4-receipt-test','5.0-b-continuity-test','5.0-c-sharing-test','5.0-d-memory-governance-test','5.0-integration-test','5.0-e1-execution-test','5.0-e2-coordinator-test','5.0-e3-e2e-test','5.0-e5-security-test','5.0-e5-g2g3-test','5.0-e5-g1-main-test','5.0-bili-summary-test','5.0-bili-write-test','5.0-bili-interactions-test','5.0-xhh-reader-test','5.0-diary-review-test','5.0-notebook-test','5.0-notebook-edit-test','5.0-self-memory-test','5.0-notes-programs-test','5.0-idle-scheduler-test','5.0-idle-actions-test','5.0-idle-wake-test','5.0-idle-goal-loop-test','5.0-idle-goal-log-test','5.0-idle-metrics-test','5.0-memory-governance-view-test','5.0-tool-permissions-test','5.0-split-quotes-test'
)
$results = @()
foreach ($t in $tests) {
  Push-Location $Root
  $skipPreload = @('selftest','instance-lock-sibling-test','r8b-promotion-test','prompt-version-test','r8-0-entry-consistency-test','r8-0-data-dir-test')
  if ($t -like 'diary-*') {
    $out = & node "test\run-diary-test.mjs" "test\$t.mjs" 2>&1 | Out-String
  } elseif ($skipPreload -contains $t) {
    $out = & node "test\$t.mjs" 2>&1 | Out-String
  } else {
    $out = & node --import "./test/_isolation-preload.mjs" "test\$t.mjs" 2>&1 | Out-String
  }
  $code = $LASTEXITCODE
  Pop-Location
  $status = if ($code -eq 0) { 'PASS' } else { 'FAIL' }
  $results += [pscustomobject]@{ test = $t; status = $status; exit = $code }
  Write-Output "RESULT $status $t exit=$code"
  if ($code -ne 0) {
    ($out -split "`n" | Select-String -Pattern 'FAIL |失败明细|✗ |AssertionError|Error:' | Select-Object -First 6) |
      ForEach-Object { Write-Output ('   ' + $_.Line.Trim()) }
  }
}
Write-Output ''
Write-Output '===== SUMMARY ====='
$results | Group-Object status | ForEach-Object { Write-Output ("$($_.Name): $($_.Count)") }
$results | Where-Object { $_.status -eq 'FAIL' } | ForEach-Object { Write-Output ("FAILED: $($_.test) (exit $($_.exit))") }

