# D1-5A：幂等历史收敛（剩余 5 条 warn）

> 时间：2026-11-04
> 性质：只读复核；未删除幂等键、未改正文、未改 pending
> 结论：**confirmed_consistent 4 / historical_unverifiable 1 / confirmed_anomaly 0**
> 工具升级后生产审计：**0 critical / 1 warn / 28 info**（原 5 warn 中 4 条经测试语料证据转入 info）

## 一、逐条档案

| # | 幂等键 | 日期 / 原 hash | 写入/更新时间 | 写入事件 | 最终正文 | 合并/删除/改写历史 | 结论（置信） |
|---|---|---|---|---|---|---|---|
| 1 | `auto:autonomous:2026-10-20:896868867d1cb463` | 10-20 / `8968…` | 10-31 15:28:07Z | 有（15:28:07.584Z） | 无此行；10-20 正文为“搬家/约定”两条 | 同 hash 第二形态（#3）；文本出现在 `test/autonomous-test.mjs:237` 测试样例 | **confirmed_consistent（测试残留；高）** |
| 2 | `auto:autonomous:2026-10-20:1cecd5095287d044` | 10-20 / `1cec…` | 10-31 15:28:07Z | 有（15:28:07.598Z） | 无此行 | 同 #4；文本见 `test/autonomous-test.mjs:246` | **confirmed_consistent（测试残留；高）** |
| 3 | `auto:2026-10-20:896868867d1cb463` | 10-20 / `8968…` | 11-03 17:07:43Z | 测试时段多次（10-31/11-02/11-03 05:28） | 无此行 | 与 #1 重复键形态；测试样例同 #1 | **confirmed_consistent（重复测试写入；高）** |
| 4 | `auto:2026-10-20:1cecd5095287d044` | 10-20 / `1cec…` | 11-03 17:07:43Z | 同上 | 无此行 | 与 #2 重复键形态；测试样例同 #2 | **confirmed_consistent（重复测试写入；高）** |
| 5 | `auto:2026-11-01:d9fb17632c2d0df7` | 11-01 / `d9fb…` | 11-01 03:55:46Z | **有**（03:55:46.208Z） | 当前正文无此行；第 13 行为 `7bbbb…` 的另一句 | `.trash/2026-11-01.md.1793505408016.bak`（03:56:47Z）**包含该行**；1 秒后 `7bbbb…` 追加；无合并链、无删除事件（outbox 历史已被 2026-11-03 测试污染重建） | **historical_unverifiable（中）** |

补充：`auto:2026-11-03:36d951…` 不在 warn（工具因前 20 字命中判为存在），实际是合并改写（后继 `a5f222…`），本报告不改其状态。

## 二、为什么 4 条重复键可判“测试残留”

- 两段文本 `看到一个用鱼缸改的路由器` / `又看到一只会按按钮的猫` 直接出现在 `test/autonomous-test.mjs:237/246` 的 `appendDiaryLine` 样例；
- 事件时间（10-31 15:28、11-02 10:12、11-03 05:28）与测试运行时段一致；
- 10-20 正文从未包含这些行（正文是“搬家/约定”两条真实内容）；
- 两种键形态（`auto:` 与 `auto:autonomous:`）指向同 day+hash，属历史迁移/重复写入；
- 因此不是生产内容丢失，归类 **confirmed_consistent（测试残留/重复键）**，但记录本身仍保留（不删除）。

## 三、d9fb 的不确定性

- 事件与 `.trash` 证明它**确实写入过** 11-01 正文；
- 1 秒后另一条（`7bbbb…`）追加，当前正文只保留后者；
- 没有 `removeLine`/改写/合并事件，outbox 历史在 2026-11-03 测试中丢失；
- 无法证明是“用户主动改写删除”还是“异常丢失” → 保留 **historical_unverifiable**，不补写、不删除幂等键。

## 四、审计工具升级（本批独立提交）

1. **verdict 三态**：
   - `confirmed_consistent`：精确行/内容 hash 命中、测试残留（source=test 或测试语料命中）、合并链后继匹配；
   - `historical_unverifiable`：done 缺失且无合并链/测试证据；重复键但无测试证据；
   - `confirmed_anomaly`：记录自身 `hash` 与 `line` 反算不一致、幂等表损坏等明确异常；
2. **测试语料识别**：读取 `test/*.mjs|js`，若记录行文本出现在测试样例中 → `idem_test_residue`（info），避免把测试残留误报为生产异常；
3. **内部 hash 校验**：`hash` 与 `line` 反算不一致 → `idem_hash_mismatch`（warn，confirmed_anomaly）；
4. **保守边界**：重复键但无测试证据 → 仍为 `historical_unverifiable` warn，不擅自判一致。

## 五、边界测试（构造数据）

`test/data-consistency-audit-test.mjs` 覆盖：

- 精确行一致（不告警）；
- 合并链（同 12 字族 + 后继记录 hash）→ info/consistent；
- `source=test` → info/consistent；
- 测试语料命中 → info/consistent；
- 重复键无测试证据 → warn/historical；
- done 缺失无解释 → warn/historical；
- 记录 hash 与 line 不一致 → warn/confirmed_anomaly；
- pending 已写入/未写入；
- 损坏 pending → critical。

结果：**12/12 通过**。

## 六、结论与未决

- 5 条 warn 全部复核：4 条 confirmed_consistent（测试残留/重复键），1 条 historical_unverifiable；0 条 confirmed_anomaly；
- 未删除任何幂等键/正文/pending；未补写；
- d9fb 保持 historical_unverifiable，等待人工决定是否补充说明或保留；
- 生产 4 条测试残留记录仍保留在幂等表中（不因告警消除而删除）。
