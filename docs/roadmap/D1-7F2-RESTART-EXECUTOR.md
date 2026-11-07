# D1-7F2：重启执行器与回滚工具

> 时间：2026-11-04
> 性质：工具开发；**未执行生产重启/停止/配置修改**
> 结论：执行器当前 **BLOCKED**（进程身份 UNKNOWN）；执行路径 fail-closed

## 一、`scripts/d1-7f-restart.mjs`

### 默认只读 preflight

输出：
- HEAD/脏状态；
- lock PID、进程启动时间/名称/Path、CommandLine/父 PID/ExecutablePath；
- 身份联合验证结果（PID+start+executablePath+commandLine，四者缺一即 unverified）；
- hotReload、config hash；
- 生产 hash（events/learned/pending/idem/dsh/companion/token/messages/diary）；
- 可选 `--out <file>` 写 JSON（人工指定，不写生产数据）。

当前实测：

```
PID 25300, StartTime 2026-11-04T12:26:53.609Z
Path = null
CommandLine = null
identity.verified = false
missing = [executablePath, commandLine]
```

→ 按设计**拒绝停止进程**。

### `--execute` 前置

必须同时满足：

1. 外部授权标记文件（`--authorization <file>`，脚本绝不创建）；
2. marker：`scope=restart-production`、`authorizedBy`、`targetHead`、`pid`、`startTime`、`expiresAt`；
3. 身份四要素 verified；
4. 工作区干净；
5. 生产 hash 与 `--baseline` 一致（若提供）；
6. 不按进程名批量 kill、不自动结束 NapCat。

本版本执行路径默认仍拒绝：
- 没有程序化托盘退出接口；
- `force` 只能作为经批准的故障恢复，且未启用；
- 因此 `--execute` 只会输出 blocked JSON，不执行 Stop-Process/Start-Process。

### 授权标记示例（需机主创建，脚本不创建）

```json
{
  "scope": "restart-production",
  "authorizedBy": "owner",
  "targetHead": "<40-hex>",
  "pid": 25300,
  "startTime": "2026-11-04T12:26:53.609Z",
  "expiresAt": "2026-11-04T16:00:00Z"
}
```

## 二、`scripts/d1-7f-rollback.mjs`

- 默认只读 preflight；`--execute` 需授权且仍拒绝执行（本批只预检）；
- 检查 `c9c06ac` 存在、commit、package version、关键文件存在、当前数据 hash；
- 实测：存在，版本 0.4.0 与当前一致，关键文件存在 → **compatible=true**；
- 回滚动作仅限代码 checkout + 重启；**禁止 reset/删数据/Session/Goal/Pending/日记**。

## 三、退出/启动方式

- 正常退出：托盘/窗口退出（`app.stop()`）；不是程序化强制 kill；
- 强制 Stop-Process 仅故障恢复，需单独授权；
- 启动：沿用桌面快捷方式 `electron.exe "E:\dsh\QQ-agent\." --no-sandbox`，cwd `E:\dsh\QQ-agent`；
- 启动前确认无第二个实例（lock/PID/3210）；
- NapCat（PID 33480，3001/6099）独立，不随 Electron 退出。

## 四、当前执行状态

| 条件 | 状态 |
|---|---|
| 预检工具 | 可用 |
| 身份联合验证 | **FAIL/UNKNOWN**（Path/CommandLine 为空） |
| 授权标记 | 未提供（不得由脚本创建） |
| 执行 | **BLOCKED** |
| 回滚目标 | `c9c06ac` 存在且版本兼容；未执行 checkout |
