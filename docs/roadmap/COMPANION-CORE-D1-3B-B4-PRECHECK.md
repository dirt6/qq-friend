# D1-3b-B4 预检：reset-data 跨目录 manifest、备份与阶段化恢复

> 时间：2026-11-04 晚
> 性质：**只读预检**；未修改代码、未执行 reset、未写生产数据
> 上游：B1（清理语义策略表）、D1-3a（reset 只读审计）、B3（备份/校验/hash 先例）

---

## 一、现状调用链（实际代码位置）

| 层 | 位置 | 行为 |
|---|---|---|
| 面板按钮 | `ui/app/06-settings-render.js:1004-1005` | 「重置为初始形态」+ 进度提示 |
| 面板事件 | `ui/app/07-settings-events.js:965-986` | 两次 `uiConfirm` → `POST /api/reset-data`（body `{}`） |
| 后端路由 | `src/routes.js:1547-1586` | 安全闸 → `orchestrator.abortAll()` + `onebot.close()` → 同步 `fs.cpSync` 全量备份 → 逐项 `fs.rmSync`（跳过 `qq-agent.lock`）→ `updateConfig(loadConfig())` |

现状缺口（与 D1-3a 审计一致）：

- **无 manifest**：备份目录只有 `<DATA_DIR>.backup-<ISO stamp>`，没有 opId、没有范围、没有阶段、没有失败原因；
- **无 hash 校验**：`cpSync` 是否完整复制不可知；
- **无 pending 检查**：`data/diary-meta/pending.json` 会随 data 一起删除，日记正文保留 → 正文/meta/待补偿失配；
- **无恢复入口**：中途崩溃后无法判断「备份是否完整、删除进行到哪」，只能人工猜；
- **同步全量复制**：211 MB 期间阻塞事件循环；
- **无并发闸**：两次点击可并发执行。

---

## 二、实际影响面（2026-11-04 19:2x 实测，只读）

| 项 | 值 |
|---|---|
| `DATA_DIR`（`/api/status`） | `E:\dsh\QQ-agent\data` |
| data 规模 | 2213 个文件 / 211,412,553 字节；24 个顶层目录（`memory`、`sessions`、`image-cache`、`diary-meta`、`logs`、`dsh-home`、`pylibs`…） |
| 删除范围 | `DATA_DIR` 的全部子项，**跳过 `qq-agent.lock`**；目录本身保留 |
| 日记根 | `config.skills.diary.root` 当前为空 → `src/diary/writer.js:54` 回退 `E:\dsh\日记` |
| 日记规模 | 31 个文件 / 39,950 字节（`每日/` 17 天 + `.trash/` 13 个 .bak + `每日/.2026-10-31.bak`） |
| 日记正文 | **不在删除范围**（reset 只删 data）；B4 会把它纳入**备份与删除后校验**，但**不删** |
| `data/diary-meta/` | 当前只有 `pending.json`（meta 写入开关默认关） |
| 历史备份 | 项目根当前**没有** `data.backup-*`（未在本次被测环境执行过 reset） |
| 磁盘余量 | E: 可用 ≈ 630 GB（全量备份 211 MB 无压力） |

**当前生产就处于「会被新规则拒绝」的状态**（只读核查，未改动）：

- `data/diary-meta/pending.json`：1 条未完成——`8050e5df…`，`op=remove`，`dateKey=2026-11-03`，`stage=prepared`，`attempts=0`；
- `data/diary-idempotency.json`：2 条 `state=pending`（`auto:2026-11-01:…`、`auto:2026-11-03:…`）。

→ B4 生效后，在该 pending 未对账前，生产 `/api/reset-data` 会**明确拒绝**（fail-closed）。这是预期行为，本批不代机主处理这些记录。

---

## 三、B4 设计决定

### 3.1 目录布局（备份在 data 之外）

```
<backupRoot>/<opId>/
  manifest.json                 # 唯一事实来源（原子写）
  data/<原相对路径...>           # DATA_DIR 全量副本（跳过 qq-agent.lock）
  diary/<原相对路径...>          # 日记根全量副本（只备份，不删除）
```

- `backupRoot` 默认 `DATA_DIR + '.reset-backups'`（同级，不进版本库，需加 `.gitignore`）；
- 可用 `QQ_AGENT_RESET_BACKUP_DIR` 覆盖（测试隔离用）；
- `opId = <UTC 时间戳>-<8 位随机 hex>`；**唯一、不覆盖历史**；
- 备份一律放在 data 之外：reset 会删除 data 子项，备份在里面等于没备份。

### 3.2 manifest 字段（schema 1）

```jsonc
{
  "schema": 1,
  "kind": "reset",
  "opId": "2026-11-04T11-40-00-000Z-ab12cd34",
  "atomic": false,                       // 显式声明：跨目录不是原子事务
  "scope": ["data", "diary"],
  "createdAt": "...", "finishedAt": "...",
  "paths": {
    "dataDir": "...", "dataDirReal": "...",      // 规范化真实路径
    "diaryRoot": "...", "diaryRootReal": "...",
    "backupRoot": "...", "backupDir": "...", "manifest": "..."
  },
  "stages": {
    "data":  { "stage": "planned|backed_up|removing|deleted|completed|failed", "at": "...", "error": "" },
    "diary": { "stage": "planned|backed_up|verified|absent|changed|failed",    "at": "...", "error": "" }
  },
  "files": {
    "data":  [{ "rel": "...", "sha256": "...", "size": 123 }],
    "diary": [{ "rel": "...", "sha256": "...", "size": 123 }]
  },
  "dirs": { "data": ["logs", "tmp"], "diary": ["每日", ".trash"] },
  "links": [{ "rel": "...", "target": "...", "scope": "data|diary" }],
  "pendingSnapshot": { "file": "...", "exists": true, "sha256": "...", "unfinished": 0, "idemPending": 0 },
  "deleted": { "entries": 12, "failed": [] },
  "result": "ok|ok_with_warnings|failed",
  "error": "",
  "notes": ["两目录非原子；日记正文不删除；删除不可回滚"]
}
```

### 3.3 阶段机（每个转换前原子写 manifest）

- **data**：`planned` → `backed_up`（全量复制 + 逐文件 SHA256 校验）→ `removing` → `deleted` → `completed`；任一步失败 → `failed`（保留 `error` 与已删/未删信息）；
- **diary**：`planned` → `backed_up` → 删除 data 后重算正文 hash：一致 `verified`，不一致 `changed`（并发写），根不存在 `absent`，失败 `failed`；
- **顺序**：先 diary（小、快）→ 再 data（大）→ 两边都 `backed_up` 才允许删除 data；
- **不声称原子**：manifest 固定 `atomic: false`；崩溃可能停在「data 已删、diary 只备份」的组合，恢复按 scope 分别继续。

### 3.4 拒绝条件（fail-closed，先拒绝再动手）

| # | 条件 | 处理 |
|---|---|---|
| 1 | `pending.json` 有 `stage !== completed` 的项 | 拒绝，返回 id/op/dateKey/stage 列表 |
| 2 | `pending.json` 存在但不可解析 | **拒绝**（不能当成「没有」） |
| 3 | `diary-idempotency.json` 有 `state=pending` | 拒绝（同样是未完成写） |
| 4 | 日记根 = data 或位于 data 内 | 拒绝（否则 reset 会连带删正文） |
| 5 | `backupRoot` 在 data 内 / 等于 data | 拒绝 |
| 6 | data 目录不存在 / 不是目录 | 拒绝 |
| 7 | 已有同 data 目录的**未完成** reset manifest | 拒绝，要求先 `resume` 或人工处理 |
| 8 | 备份复制/校验失败 | 中止，**不删除任何东西** |
| 9 | 并发 reset（`<backupRoot>/.reset.lock`，复用 `withFileLockAsync`） | 等锁超时后拒绝 |
| 10 | 测试门禁（`DIARY_TEST_GUARD=1`）下任一路径不在 `DIARY_TEST_TMP` 内 | 拒绝（复用 D1-2c-2c 的隔离思路） |

### 3.5 备份与校验

- 逐文件：复制 → 源/目标 SHA256 比对 → 记录 `{rel, sha256, size}`；任一不一致立即失败；
- 目录（含空目录）单独记录，便于人工恢复；
- **重解析点（junction/symlink）不跟随**：只记录 `{rel, target}`，删除阶段只删链接本身，不递归目标（当前 data 下无重解析点，属预防）；
- 未识别类型（socket/fifo 等）→ 备份失败并报错，不静默跳过；
- 不做增量/去重/压缩；历史备份不自动清理（保留策略后续批次）。

### 3.6 删除与删除后校验

- 只删 `DATA_DIR` 子项，跳过 `qq-agent.lock`；
- 逐项删除，**失败即停**并记录；**不回滚**（已删部分只能从备份人工恢复）；
- 删除后验证：data 目录只剩 lock（或为空）；
- 删除后重算日记正文 hash 与快照比对：一致 → `verified`；不一致 → `changed` 并写 `ok_with_warnings`，不谎称「重置后正文一致」。

### 3.7 阶段化崩溃恢复

- 入口：`scripts/reset-data-ops.mjs list | verify <opId> | resume <opId> --confirm <opId>`；**启动时不自动恢复**；
- `resume` 前先全部校验：manifest schema/opId、备份逐文件 hash、当前 data 目录；
- 按 data 阶段继续：
  - `planned`：补做 data 备份 → 删除；
  - `backed_up` / `removing`：**剩余文件必须仍与 manifest 记录一致**才继续删；出现未备份的新文件 → 拒绝（needsManual，列出文件名）；
  - `deleted` / `completed`：只补最终校验，**不再删除**（避免删掉重置后新产生的数据）；
- 备份损坏 / 路径配置变化 / manifest 不可读 → 拒绝，保留人工处理状态。

### 3.8 本批明确不做

- **不新增「连日记正文一起删」模式**：那是另一种语义（B1：禁止一个接口隐式承担多语义），需要独立入口与确认文案；本批只在 manifest/文案中说明「正文保留」；
- 不改 meta 写入开关、不改 DSH/Session/自主调度/人格/Prompt；
- 不在生产执行 reset 或演练删除/恢复；
- 不提供自动恢复 UI（CLI 即可，且需 `--confirm <opId>`）。

---

## 四、接口与前端改动

- 新增只读 `GET /api/reset-data/preflight`：返回 `canReset`、拒绝原因、data/diary 路径与文件数、pending 概况、`backupRoot`；
- `POST /api/reset-data`：保留原安全闸 → preflight → 拒绝返回 409（`ok:false, refused:true`）→ 通过则停业务、执行阶段化 reset，响应带 `opId/backupDir/manifestPath/stages`；
- 面板：先 preflight 取真实路径生成确认文案（说明「data 全删（含日记 meta/pending）、日记正文保留、会先备份、备份失败即中止」），被拒绝时直接展示原因，不再二次点下去才失败。

---

## 五、专项测试计划（隔离目录，经统一启动器）

`test/diary-reset-data-test.mjs`（实际 40 项，全部经统一启动器）：

1. preflight：正常 → `canReset:true`、路径/计数正确、backupRoot 在 data 外；
2. 未完成 pending → 拒绝、data 与日记 hash 不变、不产生备份目录；
3. pending.json 损坏 → 拒绝（不当成空）；
4. idempotency pending → 拒绝；
5. 日记根在 data 内 → 拒绝；
6. 正常 reset：data 全删（除 lock）、备份逐文件 hash 一致、日记正文 hash 不变、manifest 阶段完整、`atomic:false`；
7. 备份失败（注入）→ 拒绝删除、manifest 记录失败原因；
8. 删除失败（子进程把 data 子目录设为 cwd）→ 记录失败、备份保留、不谎报成功；
9. 崩溃注入（`QQ_RESET_TEST_STOP_AFTER`，仅测试守卫下生效）：
   - diary 备份后崩溃 → resume 补 data 备份并完成；
   - data 备份后崩溃 → resume 完成删除与校验；
   - removing 中断 → resume 续删；
   - 删除后崩溃 → resume 只补校验，不删新文件；
10. resume 时备份损坏 → 拒绝（needsManual）；
11. resume 时 data 出现未备份新文件 → 拒绝；
12. 并发 reset：经 `<backupRoot>/.reset.lock`（复用 `withFileLockAsync`）串行，无交叉覆盖；
13. 第二次 reset 生成新 opId、不覆盖旧备份；
14. 测试门禁：路径不在临时根 → 拒绝（防止测试误触生产）。

---

## 六、生产保护基线（本包前后比对用）

2026-11-04 19:2x 只读采集（配方：按相对路径排序，`rel|sha256|size` 拼接后 SHA256）：

| 目标 | hash | 备注 |
|---|---|---|
| `data/memory`（聚合，1 文件） | `ee772eb3c51428d27c15d562b2261c072e6e9316f76dd20473c543c31330f9bf` | files=1 |
| `data/diary-meta`（聚合） | `054157abed8b29628ca122925c74c127c373ea6f68b916d7f9af7371c4346d8c` | files=1 |
| `data/learned.json` | `af040667ae8fce51f453d0cd21f8c83763525b64cf2c41b764d44fc6ed8a666e` | |
| `data/diary-meta/pending.json` | `e046e06734eac3e9679cc594c74469b9c5768fe1482d8c552bc9e85f87dc4926` | |
| `data/diary-idempotency.json` | `d254aaec88cf93fa725bb63fd771fa59a88fb039aed01bb553e8471a4e993331` | |
| 日记正文 `E:\dsh\日记`（聚合，31 文件） | `fb5cfac7931c6b78aae0f2cbbb470a5f7968377d0172cd978b040e52b489c5f6` | 正文一个字节都不改 |

本批只读，预期前后完全一致（日记正文/pending/meta 不受影响；生产 `pending.json` 可能因机器人写日记而正常变化，届时单独说明）。

---

## 七、遗留风险（如实记录，不掩盖）

1. **两目录非原子**：data 删除完成、日记备份较旧时，没有「整体回到某一时刻」的单一事务；恢复需人工按 manifest 组合；
2. **删除阶段并发写**：`abortAll()`/`onebot.close()` 只停业务入口，日志/插件/DSH 仍可能写 data；删除期竞态不消除，失败会被记录而不是掩盖；
3. **事件循环阻塞**：改为逐文件异步复制/哈希，阻塞粒度从「211 MB 整体」降到「单文件」，但大文件仍会短暂卡顿；
4. **备份占双份空间**：211 MB × 2 + 历史备份；不自动清理；
5. **删除不可回滚**：备份是唯一恢复来源；恢复只提供人工/CLI 入口，无 UI；
6. **covered 测试**：`coverage-http` 的 reset 用例会新增 preflight 调用与临时日记根，避免测试读取生产日记目录。
