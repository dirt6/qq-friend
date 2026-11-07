# DSH Session 恢复与清理设计（不删除、不终止）

> 时间：2026-11-04
> 性质：设计；隔离验证；**生产未授权执行**
> 前提：DSH 没有可验证的 delete/TTL 接口；不解析 zstd 内容；不依赖 PID 判断归属

## 一、原则

1. 不删除生产 Session，不 kill 生产 DSH 进程；
2. 只做**文件级隔离**（同卷 rename 到 quarantine），可恢复；不复制、不改内容；
3. 映射重建、外部项目、重复映射、僵尸本地会话 → **人工动作**，工具只报告；
4. 无法确认归属/状态 → fail-closed，不动作；
5. 所有动作需显式确认 + 审计；生产 CLI 不提供 apply（仅模块，供后续授权流程）。

## 二、恢复流程（隔离/授权后）

```
inspect（只读）
  → plan（quarantine 候选：本项目 + 未映射 + 年龄≥阈值；其余 manual）
  → 人工复核 planHash/候选清单
  → quarantineSession（dryRun → 实移；映射引用则拒绝）
  → 验证目标存在/源消失/树 hash
  → 需要时 restoreQuarantined（目标已存在则拒绝覆盖）
  → 审计记录（who/planHash/from/to/result）
```

- 隔离目录：`data/dsh-home/.quarantine/<stamp>/<project>/<session>/`；
- 恢复：移回 `data/dsh-home/sessions/<project>/<session>/`；不动映射；
- 不提供“删除隔离目录”的自动动作（人工确认后再处理）。

## 三、映射恢复（人工）

| 情况 | 动作 |
|---|---|
| 映射 sid 目录不存在 | 报告 `manual_rebuild_mapping`；人工决定：删除映射（下一轮冷启动）或找回 Session；工具不自动改 |
| 多个 chatKey 同 sid | 报告 `manual_review_mapping`；人工确认是否串扰，必要时为其中一个 chatKey 重置映射 |
| 映射对应 chat 文件不存在 | info；人工确认是否为已删除聊天 |

**不自动改 `dsh-sessions.json`**：写映射会改变聊天记忆归属，属生产行为。

## 四、清空聊天后的 Session（方案，不改默认行为）

| 方案 | 行为 | 评价 |
|---|---|---|
| A（现状，默认） | clear 只清本地消息，保留 DSH 映射 | 不改行为；需在 UI 说明“清空不删 DSH 记忆” |
| B（显式入口） | 新增「重置她的 DSH 会话」动作，调用现有 `resetSession(chatKey)`（死接口复活）+ 审计 | 推荐后续独立包；需 UI 二次确认 |
| C（清空时隔离旧 Session） | clear 时把旧 session 目录移入 quarantine 并重建映射 | 风险高（会话记忆归属变化），需独立授权 |

本阶段：**保持 A**，只记录风险。

## 五、异常退出与所有权验证

- 子进程超时 kill 使用 `/T /F`，但无持久注册表；可能残留 node 持写句柄；
- 若要终止残留进程，必须多因子验证：
  1. PID 存在 + 启动时间与记录一致（防止 PID 复用）；
  2. 可执行路径在允许列表；
  3. 命令行含期望 sessionId/nonce（父进程注入的环境 nonce，或 cmdline 标记）；
  4. 显式人工授权 + 审计；
  任一缺失 → **不终止**，只报告/隔离文件。
- 恢复 Session 目录时，先确认无活动写句柄（尝试独占打开/锁文件；无法确认则不动）。

## 六、验收标准（隔离）

- inspect 能识别映射缺失/孤儿/重复/无本地聊天/闲置/本地僵尸；
- plan 只把“本项目 + 未映射 + 超期”列为 quarantine，映射引用/外部项目/异常映射为 manual；
- quarantine/restore 只移动、不删除；映射引用目录拒绝；
- 目标冲突拒绝覆盖；失败保留源；
- 审计记录完整；生产 CLI 无 apply 入口。

## 七、风险与后续

1. 不解析 DSH zstd 内容 → 无法证明孤儿目录“无价值”；只能按未映射+年龄+项目过滤；
2. 外部项目（`--E-dsh--`）必须人工确认；
3. “清空后复用”未改，需 UI 文案或独立重置入口；
4. 进程归属当前 UNKNOWN；任何 kill 方案需独立实现并经过 Windows 实机验证；
5. 生产清理/隔离需单独授权，且先备份映射文件。
