# D1-7G3：运行时可观测性检查清单

> 时间：2026-11-04
> 性质：只读；不扩大生产 API、不读聊天正文/密钥
> 脚本：`scripts/d1-7f-runtime-acceptance.mjs`（D1-7F3）
> 结论：服务/ChatStore 可观测；**模块实例/版本、Core 注入、autonomous loop 仍 UNKNOWN**

## 一、可回答 / 不可回答

| 问题 | 现状 | 证据来源 | 状态 |
|---|---|---|---|
| 当前进程 PID/启动时间 | 可读 | lock + Get-Process | PASS（PID/start） |
| 可执行路径/命令行 | 不可读 | 权限拒绝 | UNKNOWN |
| 磁盘 HEAD/关键文件 hash | 可读 | git + sha256 | PASS |
| 进程实际运行代码版本 | **无法直接读** | 无运行期模块清单/实例 ID | UNKNOWN |
| Core 是否含 `readPrivateHistory` | 无法从外部读 | 无诊断接口 | UNKNOWN |
| ChatStore 是否注入 Core | 只能证明 `/api/chats` 可用 | 不能证明 Core context 注入 | UNKNOWN |
| autonomous 是否通过 Core 读私聊 | 无 tick/无日志 | 需受控 tick 或诊断日志 | UNKNOWN |
| autonomous loop 是否启动/唯一 | 日志文本计数 | 当前日志无 “自主活动已启动” 文本（0） | UNKNOWN |
| 重复 loop/旧实例 | 无实例 ID/日志 | 无法证明 | UNKNOWN |
| 服务 3210/OneBot | 可读 | GET status | PASS |
| NapCat 3001/6099 | 可读 | TCP connect | PASS |
| 生产数据 hash | 可读 | F2/F3 baseline | PASS（只读） |

## 二、只读检查方法

1. `node scripts/d1-7f-restart.mjs --out %TEMP%\baseline.json`：进程/hash/配置；
2. `node scripts/d1-7f-runtime-acceptance.mjs --baseline %TEMP%\baseline.json --json`：
   - `/api/version`、`/api/status`、`/api/chats`、`/api/reset-data/preflight`；
   - 3210/3001/6099；
   - 日志 autonomous 计数；
   - 数据 hash 对比。
3. 日志：boot-diag、`data/logs/qq-agent-<date>.log`（插件加载/热重载/错误）；
4. 不调用会改状态的接口；不读取正文/密钥。

## 三、缺口与最小诊断建议（未实施）

要真正证明模块版本/实例，需要启动时写入**非敏感诊断清单**（模块名+版本 hash+instanceId+Core/ChatStore 单例计数），或只读 `/api/diagnostics`：

- 不暴露聊天/密钥；
- 不改变业务语义；
- 需生产代码部署/重启，属 B/C 级授权；
- 当前不实现；G3 以 UNKNOWN 归档，不用函数存在性代替单例证明。

## 四、当前运行结果（只读）

```
service: PASS
coreChatStore (/api/chats): PASS
identity: UNKNOWN (Path/CommandLine null)
moduleVersion: UNKNOWN
coreContext: UNKNOWN
autonomyLifecycle: UNKNOWN
autonomyActivity: UNKNOWN
data: UNKNOWN (本次未带 baseline)
```

## 五、结论

**G3 提供可用只读检查清单/脚本，但不能证明运行时版本一致/单例/loop 唯一**；相关项保持 UNKNOWN，等待人工重启后诊断/受控 tick，或另行批准最小诊断接口。
