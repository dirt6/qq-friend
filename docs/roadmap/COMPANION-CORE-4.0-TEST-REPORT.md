# COMPANION CORE 4.0 测试报告

> 时间：2026-11-04
> 环境：隔离 `bootApp`/临时目录；未使用生产数据做故障注入

## 一、专项

| 测试 | 结果 | 说明 |
|---|---|---|
| `test/companion-core-4.0-test.mjs` | **16/16 PASS** | golden empty/goal；snapshot parity；Core 委托写入；readRecentDiary 原文一致；跨 chatKey 同主体；diary 幂等/删除；Memory Hub 只读；端口只读/allowWrite；并发 pending；隔离 |
| `test/companion-core-test.mjs` | **18/18 PASS** | 原有 Core 契约 |
| `test/companion-core-integration-test.mjs` | **12/12 PASS** | 原有聊天/自主共享状态 |
| `test/autonomous-test.mjs` | **97/97 PASS** | 自主行为；修复 DATA_DIR 隔离后复跑 |
| `test/data-admin-ui-test` 等既有专项 | 通过 | 未受 4.0 影响 |

### 首次失败记录

- 4.0 专项首次运行 7/8：`snap.activity` 返回 `{ok,items}` 而非数组；修复为 `.items` 后 16/16。
- 未修改 golden 或断言掩盖行为差异。

## 二、全量回归

**82 项：78 PASS / 4 FAIL**。

既有基线失败（与本批无关）：

- `selftest`
- `tools-skill-audit`
- `gallery-test`
- `setup-qq-version`（偶发）

新增 `companion-core-4.0-test` 通过；其余相关专项全过。

## 三、Parity

| 项 | 结果 |
|---|---|
| 空状态 companionText | 字节/hash 与旧入口一致 |
| 有 Goal companionText | 字节/hash 与旧入口一致 |
| readRecentDiary 原文 | 与旧 fs 读取字节一致 |
| prompt 拼接顺序/其他字段 | 未改 |
| chatKey 差异 | companionText 相同（同一伙伴主体） |

## 四、并发/隔离

- 并发 pending 写入：均有明确结果，状态可读；
- diary 同内容重复写：仅 1 行（领域幂等）；
- 跨活动：Core 写日记后快照可读；
- 端口默认只读；
- 所有测试临时目录；生产数据未用于故障注入。

## 五、生产写入事故（测试隔离缺陷）

- **时间**：2026-11-04 21:39:59
- **触发**：全量回归中的 `test/autonomous-test.mjs` 只隔离了日记 root，未隔离 `QQ_AGENT_DATA_DIR`；`appendDiaryLine` 仍向生产 `data/diary-meta/pending.json` 与 `data/diary-idempotency.json` 写入 2 条 10-20 completed 测试记录。
- **影响**：pending hash `01c2a25d…→c0a379cf…`；idem `3f6f12eb…→3cb7f9f2…`；日记正文/sessions/learned/DSH 未变。
- **修复**：测试在导入插件前设置临时 `QQ_AGENT_DATA_DIR` 并动态 import；复跑 97/0，生产 pending/idem hash 前后一致。
- **未回滚生产记录**：需单独授权；不在本批删除/修改。
- 结论：不是 4.0 业务代码写生产，而是既有测试隔离缺陷；已修复防复发。

## 六、未验证/限制

- 未做真实多进程聊天+自主压力（仅有并发 pending/锁级）；
- 未验证 DSH 内部 persona 缓存；
- 浏览器/ACL 等 D1-6 UNKNOWN 不影响本批代码测试，但 4.0 真实 UI 未部署。
