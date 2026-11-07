# D1-7F3：运行态只读验收脚本

> 时间：2026-11-04
> 性质：只读脚本；未触发 autonomous tick、未写生产
> 脚本：`scripts/d1-7f-runtime-acceptance.mjs`

## 一、能力

默认只读：

- 服务：GET `/api/version`、`/api/status`、`/api/chats`、`/api/reset-data/preflight`；
- 端口：3210、NapCat 3001/6099（TCP connect）；
- 进程：lock PID/启动时间/名称/Path（只读）；
- 配置：hotReload、config hash；
- 日志：当前日 `data/logs/qq-agent-<date>.log` 中 autonomous 加载/启动计数；
- 数据：如提供 `--baseline <json>`，对比 F2 preflight 的 hashes；
- 输出逐项状态：service/coreChatStore/identity/moduleVersion/coreContext/autonomyLifecycle/autonomyActivity/data。

明确不做：

- 不调用会改状态的接口；
- 不触发 autonomous；
- 不读取/输出聊天正文、密钥、Cookie、Token；
- 不写生产数据。

## 二、生产只读运行结果（2026-11-04T14:43:51Z）

| 项 | 结果 |
|---|---|
| service（3210+OneBot+version） | **PASS** |
| coreChatStore（`/api/chats` 200 数组） | **PASS** |
| NapCat 3001/6099 | PASS（可达） |
| identity | **UNKNOWN**（Path/CommandLine null） |
| moduleVersion | **UNKNOWN**（无运行时模块观测） |
| coreContext/readPrivateHistory | **UNKNOWN**（无运行时方法/单例观测 API） |
| autonomyLifecycle | **UNKNOWN**（日志计数 0；无法证明 loop 唯一） |
| autonomyActivity | **UNKNOWN**（未 tick） |
| data | UNKNOWN（本次未提供 baseline） |

- 脚本退出码 0（无 hard fail：service/chatStore 正常）；
- 不以 API 健康代替 autonomous/Core 验证；
- 不以函数存在性代替单例/实例证明。

## 三、限制

1. 运行时无法从外部读取模块版本/实例 ID；需最小诊断接口（另行设计，未改 API）；
2. 日志计数受日志文件/格式影响，本次 loaded=0（当前日志无该文本），故 autonomy 只能 UNKNOWN；
3. identity 依赖 PowerShell 权限；当前 Path/CommandLine 不可读；
4. 数据 baseline 需先用 F2 preflight `--out` 生成（不写生产数据）。

## 四、使用（重启后）

```bash
node scripts/d1-7f-restart.mjs --out %TEMP%\f1-baseline.json
node scripts/d1-7f-runtime-acceptance.mjs --baseline %TEMP%\f1-baseline.json --json
```

- 只读；不触发 tick；
- 若需真实 autonomous 证据，按 F4 方案单独授权。
