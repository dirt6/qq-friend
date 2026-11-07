# D1-3d 验收报告：Reset 安全专项（隔离）

> 时间：2026-11-04
> 方式：隔离临时目录 + 真实文件/删除/恢复 + 受守卫故障注入；**未执行生产 reset**
> 结果：**演练 24/24 通过**；B4 专项 58/58、B3 记忆删除 17/17 复跑通过；全量回归见 §五

## 一、执行摘要

| 能力 | 结果 | 证据 |
|---|---|---|
| preflight 拒绝（pending/损坏/idem/日记根在 data/备份根在 data） | PASS（5 项） | `test/reset-safety-drill-test.mjs` §1 |
| manifest v2 自校验 + 逐文件 SHA256/大小 | PASS | §2：manifestChecksum、files.data 数量、备份逐文件比对 |
| junction 不跟随（真实 Windows junction） | PASS | §2：只记录 link、备份无内容、外部目标文件 hash 不变 |
| symlink | **INCONCLUSIVE** | 当前 Windows 权限不允许创建文件 symlink；未伪造通过 |
| Windows 文件句柄占用 | PASS（真实子进程 cwd） | §8：删除失败→`needs_manual_recovery`；释放后 resume 完成 |
| 磁盘不足/权限失败 | PASS（注入模拟） | §6：备份失败→`status=failed`、不删除、备份保留；**真实磁盘满 UNKNOWN** |
| 写入屏障 / 并发 | PASS | §7：`state-store` 写入被拒、解除恢复；备份后并发写→删除前复核拒绝 |
| 删除中途崩溃（真实子进程 exit 97） | PASS | §9：`delete_in_progress`、部分删除；resume 续删完成 |
| **完整恢复 + 逐文件 hash** | PASS | §3：8 个文件全部 hash 与原始一致；空目录重建；日记未动；审计存在 |
| 损坏备份拒绝恢复 | PASS | §4：`备份不完整`，目标未写入 |
| 目标冲突拒绝覆盖 | PASS | §3：`已存在新数据` |
| 恢复中途失败 | PASS | §5：`ok:false` + `needsManual:true` + `partial:true`，已恢复保留、备份保留；再次恢复因冲突拒绝（需人工） |

## 二、完整恢复证据（逐文件）

场景 `s-normal`：8 个普通文件（含 256KB `large.bin`、嵌套目录、空目录）+ 1 个 junction + 1 个日记文件。

1. reset 后：data 只剩 `qq-agent.lock`；备份 `data/` 下逐文件 SHA256/大小与源一致；junction 只记录不跟随；日记正文 hash 不变；
2. `restore scope=data` 后：**8/8 文件 hash 与原始完全一致**；`empty-dir` 重建；日记未动；`restore-audit.jsonl` 写入；
3. 已知限制：**恢复不重建 junction/symlink**（manifest 记录 links，restore 只恢复普通文件/目录）；junction 目标始终未被破坏。

## 三、恢复中途失败语义（本次新增）

`restoreResetBackup` 新增受守卫的 `hooks.failCopyRel`（仅 `DIARY_TEST_GUARD=1` 可用），并明确返回：

- `ok:false`、`needsManual:true`、`partial:true`、`restored`/`failed` 明细；
- 已复制文件保留、失败文件缺失、备份完整保留；
- 审计记录 `needsManual:true`；
- **不做自动回滚**（部分恢复不会被称作成功）；再次恢复会因“目标已存在新数据”拒绝，需人工清理/补齐。

## 四、生产保护

- 演练全部在 `%TEMP%\reset-drill-*`，结束后清理；
- 生产 `data/`、日记、pending/idem 未被读写（仅只读 hash 对比）：memory `ee772eb3…`、日记 `fb5cfac7…`、learned `af040667…`、pending `ca880159…`、idem `96d610c4…`（批次前后一致）；
- 未执行生产 reset/restore；未重启 Electron。

## 五、回归

- D1-3d 专项：**24/24**；
- D1-3b B4 专项：**58/58**（restore 返回结构新增字段向后兼容）；
- D1-3b B3 记忆删除：**17/17**；
- 全量：**74 项，70 PASS / 4 FAIL**（`selftest`、`tools-skill-audit`、`gallery-test` 既有基线失败；`setup-qq-version` 既有偶发）；新增 `reset-safety-drill-test` 通过，`store-concurrent` 本次通过（上一轮曾偶发 EPERM，保留记录）。

## 六、未验证 / 风险

1. **symlink**：Windows 权限不足，标 INCONCLUSIVE；junction 已覆盖真实场景；
2. **磁盘真满**：无法在不影响宿主的情况下可靠制造，使用注入 I/O 失败验证 fail-closed；真实磁盘满 UNKNOWN；
3. **链接恢复未实现**：恢复后不重建 junction/symlink，需要时人工处理；
4. 恢复中途失败不做自动回滚，需人工按 `needsManual` 处理；
5. 生产 reset 仍未执行（授权禁止）。
