# R8-B 实施报告：纠正状态三态（v2）

> 时间：2026-11-03
> 本文取代同路径的早前版本（`false/true/unknown` 矩阵 + 结构冲突暂停版）；历史版本在 git 中可查。
> 授权：机主「R8-B：纠正状态三态修正与实现执行指令」
> 设计：`docs/roadmap/R8-B-TRISTATE-DESIGN.md`（v2）
> 基线：`ad7b7b7`（C 回滚后）、`4007105`（Token 替换）仍在历史中
> 边界：**未改生产记忆记录、未运行会写入生产数据的迁移/演练**

---

## 零、结论

| 项 | 结果 |
|---|---|
| B1 设计（三态 + 矩阵） | ✅ `105d4bf` |
| B2 `resolveCorrectionState` + 新建 clear | ✅ `0e6a560` |
| B3 晋升/归档统一门禁 + 兼容测试 | ✅ `a644e7b` |
| 专项测试 | **全过**（见第五节） |
| 全量回归 | 见第六节 |
| 生产记忆 hash | 见第七节 |
| 遗留 | 见第八节（两项设计缺口） |

---

## 一、基线核对（先做，未直接照搬旧矩阵）

| 检查 | 结果 |
|---|---|
| 分支 / HEAD（开始前） | `main` / `054718b`，工作区干净 |
| `ad7b7b7`（C 回滚） | 是 HEAD 祖先 ✅ |
| `4007105`（Token 替换） | 是 HEAD 祖先 ✅ |
| 旧报告 `R8-B-TRISTATE-REVIEW.md` 88–164 行 | 已读；`false/true/unknown` 矩阵标注为历史记录，不再作为实现依据 |
| 当前实现 | `DEFAULT_META`/`withMeta`/`addExperience`/`suggestPromotion`/`archiveStale` 与旧报告描述一致（行号有偏移，语义一致） |

`learned-test` 的 4 个失败（归档相关）根因确认：新建条目写 `historicalUnresolved: true`，被归档保护当成"未解决"。

---

## 二、三态定义与唯一入口

```js
export const CORRECTION_STATES = ['clear', 'unresolved', 'unknown'];
```

| 状态 | 含义 | 晋升 | 归档 |
|---|---|---|---|
| `clear` | 明确没有未解决的纠正 | 允许（仅过纠正检查） | 允许 |
| `unresolved` | 存在明确未解决的纠正 | 禁止 | 禁止 |
| `unknown` | 历史信息不足 | 禁止 | 禁止 |

`resolveCorrectionState(item)` 是唯一解释器：纯函数、不修改入参、无 I/O、不调模型。

### 证据优先级（命中即返回）

| 优先级 | 证据 | 结果 |
|---|---|---|
| 1 | `correction.state` ∈ 三态 | 该值（显式声明最高） |
| 2 | `historicalUnresolved === true` | `unresolved` |
| 3 | `historicalUnresolved === false` + `events` 最后一条 `source/kind/by ∈ {owner, user_stated}` | `clear`（明确的用户认可记录） |
| 4 | 其余 | `unknown` |

**明确不成立的推导**：`count:0` ✗ clear；`events:[]` ✗ clear；`count>0` ✗ unresolved；`false` 单独 ✗ clear；`historicalUnresolved` 默认 true ✗ 新建 unresolved。

---

## 三、迁移矩阵（与实现逐项对应）

| # | 数据情况 | 规范状态 | 实现点 |
|---|---|---|---|
| 1 | `addExperience` 新建 | `clear` | 显式写入 |
| 2 | 旧条目无 `correction` | `unknown` | 优先级 4 |
| 3 | 只有 `corrections` 计数 | `unknown` | 优先级 4 |
| 4 | 只有 `correction.count` | `unknown` | 优先级 4 |
| 5 | `events: []` | `unknown` | 优先级 4 |
| 6 | `count:0, events:[]` | `unknown` | 优先级 4 |
| 7 | `historicalUnresolved: true` | `unresolved` | 优先级 2 |
| 8 | `false` + 最后一条 `user_stated`/`owner` | `clear` | 优先级 3 |
| 9 | `false` + 最后一条非用户认可 | `unknown` | 优先级 4 |
| 10–12 | 显式 `state` 三值 | 对应值 | 优先级 1 |
| 13 | `state:'clear'` + `true` | `clear` | 优先级 1 |
| 14 | `state:'unknown'` + 用户认可事件 | `unknown` | 优先级 1 |
| 15 | 非法 `state` | 按 2–4 判；仍无证据 → `unknown` | — |
| 16 | 合并（相似文本） | `unresolved` | 显式写入 |
| 17 | `memory.js` 新建印象 | `clear` | 显式写入 |
| 18 | `memory.js` 内容变更 | `unresolved` | 显式写入 |
| 19 | `memory.js` 内容未变 | `resolveCorrectionState(prev)`（旧数据即 unknown） | 不猜 |
| 20 | `saveItem` 改文本 | 不改纠正状态 | — |

---

## 四、测试矩阵与结果

| # | 用例 | 结果 |
|---|---|---|
| 1 | 新建 learned → `clear` | ✅ |
| 2 | 历史缺 `correction` → `unknown` | ✅ |
| 3 | `count:0` → `unknown` | ✅ |
| 4 | `events:[]` → `unknown` | ✅ |
| 5 | `count:1` 单独 → `unknown` | ✅ |
| 6 | 明确未解决（true） → `unresolved` | ✅ |
| 7 | 显式 clear → `clear` | ✅ |
| 8 | 显式 unresolved → `unresolved` | ✅ |
| 9 | 矛盾（state clear + true）→ `clear` | ✅ |
| 10 | 不修改入参 | ✅ |
| 11 | `withMeta` 不污染历史 | ✅ |
| 12 | 重复读一致 | ✅ |
| 13 | 旧接口兼容（false + 用户认可） | ✅ |
| 14 | 晋升/归档对 unknown/unresolved 的处理 | ✅ |
| 15 | memory 新建 clear | ✅ |
| 16 | memory 变更 unresolved | ✅ |
| 17 | adapters 输出 `correctionState` | ✅ |
| 18 | dry-run 只读隔离（打桩写入抛错） | ✅ |

全部落在 `test/r8b-tristate-test.mjs`（41 项，含边界）。

---

## 五、三个 commit 与专项测试

| 批次 | commit | 内容 | 专项 |
|---|---|---|---|
| B1 | `105d4bf` | 三态 v2 设计、20 条迁移矩阵、18 条测试矩阵；旧报告矩阵标注作废 | 文档 |
| B2 | `0e6a560` | `resolveCorrectionState`、`withMeta` 读时计算、新建 clear、合并 unresolved、memory/adapters | `r8b-tristate` 25/25 |
| B3 | `a644e7b` | `suggestPromotion` / `archiveStale` 统一门禁、兼容测试 | `r8b-tristate` 41/41 |

B3 相关回归：

| 测试 | 结果 |
|---|---|
| `r8b-tristate-test` | 41 / 41 |
| `learned-test` | 46 / 46（原 4 个失败已修） |
| `r8b-promotion-test` | 54 / 54 |
| `stage30r2-memory-meta-test` | 49 / 49 |
| `stage30r3a-impression-meta-test` | 43 / 43 |
| `stage30r4-memory-hub-test` | 38 / 38 |
| `readpoints-2.4-test` | 31 / 31 |
| `dsh-context-test` | 33 / 33 |

**兼容测试的语义更新**（不是放宽断言，是把旧断言改成新语义）：

- `stage30r2` / `stage30r3a`：`historicalUnresolved === true/false` → `state === 'clear'/'unresolved'`。
- `r8b-promotion`：需要"能晋升/能归档"的 fixture 补显式 `state:'clear'`（模拟新建路径）；新增 `unknown-arch` 用例验证"历史缺状态不归档"。

---

## 六、全量回归

**48 项：44 PASS / 4 FAIL**。4 项全部是基线既有失败（`git stash` 对比已确认，W5 时就存在）：

| 失败 | 原因 |
|---|---|
| `selftest` | 「工具名不带 qq_ 前缀」 |
| `tools-skill-audit` | 工具定义/分类/能力消费方 3 项 |
| `setup-qq-version` | `--check` 不报告协议栈 CLIENT_BUILD |
| `gallery-test` | 仓库缺 `skills/gallery/index.js`（`ERR_MODULE_NOT_FOUND`） |

本轮新增的 `r8b-tristate-test` 在回归清单中（48 项 = 基线 45 + store 两个 + r8b-tristate）。**没有新增失败，也没有把既有失败改成通过。**

---

## 七、生产记忆数据

| 项 | 实施前 | 实施后 |
|---|---|---|
| `data/learned.json` sha256 | `A065EFE2…D193`（7548 bytes） | `A065EFE2…D193`（7548 bytes） |
| `data/memory` 文件数 | 1 | 1 |
| `data/memory` 聚合 sha256 | `5D4B8C9E…7C56` | `5D4B8C9E…7C56` |

**未修改生产记忆文件、未运行迁移或演练。**

---

## 八、遗留与设计缺口（如实记录）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | **旧生产条目多数没有 `state`** → 全部 `unknown` | 这些条目不再自动晋升/归档（保守，符合"历史不明"） | 需要时由人工/后续工作包显式标记；**不得批量改成 clear** |
| 2 | **没有"用户认可 → 写 `clear`"的运行时入口** | 被合并/纠正过的条目会停在 `unresolved`，无法自动恢复晋升资格 | R8-C/R8-D 或单独工作包补（需要机主确认入口语义） |
| 3 | `historicalUnresolved:false` 单独不再产生 `clear` | 旧数据里"只有 false 没有 events"的条目变 `unknown` | 有意保守；如有真实案例再评估 |
| 4 | R8-C / R8-D | 未启动 | 按指令暂停，等下一次授权 |

---

## 九、分类

| 项 | 分类 |
|---|---|
| B1 三态设计 | PASS |
| B2 唯一入口 + 新建初始化 | PASS |
| B3 晋升/归档门禁 | PASS |
| 专项测试 | PASS |
| 全量回归 | 见第六节 |
| 生产数据未被动 | 见第七节 |

---

## 十、实现顺序与边界自查

- ✅ 先核对仓库与报告（一）
- ✅ 先修订矩阵再实现（B1 → B2 → B3）
- ✅ `resolveCorrectionState` 是唯一规范化入口（`withMeta`/晋升/归档/adapters/memory 都调用）
- ✅ 新建显式 clear；历史缺状态 unknown；`count`/空 events 不推导
- ✅ unknown/unresolved 均阻止晋升与归档
- ✅ 未增加可信度总分，未改 epistemicType
- ✅ 未改生产数据、未跑迁移、未启用 silence-ping
- ✅ 三个独立 commit
