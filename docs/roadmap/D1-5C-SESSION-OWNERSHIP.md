# D1-5C：Session 归属与所有权判定

> 时间：2026-11-04
> 性质：设计/只读；不终止进程、不隔离生产 Session

## 一、为什么不能只用目录名/修改时间/PID

- 目录名 `session-*` 只说明是 DSH 产物，不说明属于哪个聊天/项目；
- mtime 可能被读写更新，不能证明“无人使用”；
- PID 会复用；本仓库没有 DSH 子进程持久注册表；PID 文件只用于 bot 单实例；
- DSH 内部 zstd 内容未解析，无法证明“无价值”。

## 二、归属证据分层

| 层 | 证据 | 本批结果 |
|---|---|---|
| L1 项目路径 | `data/dsh-home/sessions/<project>/`，project 由 dataDir 父路径推导（`--E-dsh-QQ-agent--`） | 10 个孤儿均在本项目路径；外部 `--E-dsh--` 排除 |
| L2 映射 | `dsh-sessions.json` 的 sessionId | 10 个均无映射；唯一映射指向 `session-2de90a0a…` |
| L3 聊天引用 | `data/messages/<chatKey>.json` 是否存在 | 10 个均无 |
| L4 领域引用 | companion-state / autonomous / Goal/Pending/Action 字符串 | 10 个均无 |
| L5 本地 Session | `data/sessions/*.json` 深度扫描 | 10 个均无 |
| L6 内容 | 解析 zstd / DSH 索引 | **UNKNOWN**（不解析） |
| L7 进程 | 启动时间+路径+命令行/nonce | **UNKNOWN**（无注册表，fail-closed） |
| L8 备份 | `.session-backups/<sid>/manifest.json` + hash | 10 个均无 |

## 三、所有权判定（fail-closed）

要执行隔离/终止，必须同时满足：

1. L1 项目归属明确（本项目，非 external）；
2. L2 无有效映射；
3. L3–L5 无任何引用；
4. L6 内容可判定（当前 UNKNOWN → 不隔离）；
5. L7 无运行中所有者（多因子：PID + 启动时间 + 可执行路径 + 命令行/nonce；无法确认 → 不动作）；
6. L8 有可验证备份（manifest + 逐文件 hash）；
7. 年龄 ≥ 阈值；
8. 显式人工确认 + 审计。

本批 10 个孤儿：L1/L2/L3/L4/L5 满足“项目内、无引用”，但 **L6/L7/L8 不满足**，且年龄 < 7 天 → `unmapped_project_owned`，不是 `quarantine_candidate`。

## 四、外部项目

`--E-dsh--` 下的 `session-30465ba3…` 属其它项目/工作目录，**不属于本项目**；默认计划显式排除，不得纳入隔离/删除。

## 五、进程身份方案（设计，不实现 kill）

- 若未来需终止：记录 `pid + 进程启动时间 + 可执行文件路径 + 命令行/环境 nonce + sessionId`；
- 校验时全部匹配才允许；PID 复用、启动时间不符、路径不符、无 nonce → 拒绝；
- 不能读取命令行/启动时间时 → UNKNOWN，不终止；
- 只做文件级 quarantine 时，也需先确认无活动写句柄（独占打开/锁探测），失败则不动。

## 六、结论

- 归属证据足以把 10 个孤儿标记为“本项目、无映射、无引用”，但不足以安全隔离；
- 当前唯一映射 Session 为 active，必须保留；
- 外部项目不处理；
- 任何生产隔离需补：内容判定 + 备份 + 进程确认 + 人工授权。
