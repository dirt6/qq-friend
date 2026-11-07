# D1-3b 附属调查：两个 pending 幂等键的历史证据

> 时间：2026-11-04 晚
> 授权：**只读调查**。未修改 `pending.json`、幂等键、日记正文、meta、outbox 或任何生产数据；未执行 reconcile `--confirm`、删除、补写、标记 done；未重启应用。
> 目标：
> - `auto:2026-11-01:806adae3d6c90350`
> - `auto:2026-11-03:99ba09dd88fab6bf`
> 结论：两条均为 **confirmed_not_written**（依据代码路径 + 历史状态重建；残留假设见 §七）。

---

## 一、调查前后 hash（完全一致）

| 文件 | SHA256 | 大小 | mtime |
|---|---|---|---|
| `data/diary-meta/pending.json` | `e046e06734eac3e9679cc594c74469b9c5768fe1482d8c552bc9e85f87dc4926` | 5930 | 2026-11-03T17:07:43.634Z |
| `data/diary-idempotency.json` | `d254aaec88cf93fa725bb63fd771fa59a88fb039aed01bb553e8471a4e993331` | 17275 | 2026-11-03T17:07:43.623Z |
| `E:\dsh\日记\每日\2026-11-01.md` | `d868ff363e91de232f549bf04edf3ef13ec37019763e8d7be3b2025a3f8438f7` | 2477 | 2026-11-01T15:34:29.991Z |
| `E:\dsh\日记\每日\2026-11-03.md` | `a5cf577fb0ad6159fdfeba92e032c4537b4da37b787dcfc6ade06aae6f3bb0ff` | 2396 | 2026-11-03T15:17:16.378Z |

聚合 hash（前后一致）：日记树 `fb5cfac7931c6b78aae0f2cbbb470a5f7968377d0172cd978b040e52b489c5f6`（31 文件）；`data/diary-meta` `054157abed8b29628ca122925c74c127c373ea6f68b916d7f9af7371c4346d8c`；`data/memory` `ee772eb3c51428d27c15d562b2261c072e6e9316f76dd20473c543c31330f9bf`。

---

## 二、幂等键的生成规则（先复核，后判读）

`src/diary/writer.js`：

- `write()`（`:159`）生成幂等键：`idemKey = idempotencyKey || auto:<source>:<day>:<contentHash>`（内容 hash 见 `:102-107`：`sha1(mood|importance|text)[:16]`）；
- **① 先登记 outbox 意图**（`beginOp`，`:193`）；
- **② 写前标 pending**（`:225`）：`{state:'pending', at, source, day, hash}`；
- **③ 落盘**（`appendLine`，`:333-364`）：若找到「前 14 个规范化字符相同」的旧行（`findSimilar`，`:110-120`）：
  - **仅当新文本 `length` 严格大于旧行文本**才替换（`:356`）；
  - 否则**不改内容**，但仍返回 `{ok:true, merged:true, line:<新行>}`（`:357-359`）；
- **④ 确认**（`:235`）：`confirmed = 正文中存在与 r.line 完全相等的行 || (merged && 正文存在 text 前 20 字)`；
- **⑤ 记录状态**（`:238-247`）：`state = confirmed ? 'done' : 'pending'`，并写入 `line`（截 200 字）与 `merged`；
- **⑥ 返回值 `ok = confirmed`**（`:273/:277`）；`ok=false` 时 `write()` 在 `:283` **提前返回，不发 `diary.written` 事件**；`ok=true` 才发事件（`:285-300`）。

因此：
- `pending + merged=true` 只可能来自「合并分支被触发、但确认失败」；
- 若发生**替换**，正文必然出现与 `r.line` 完全相等的行 → `confirmed=true` → 应为 `done`，与现状矛盾；
- 所以只能是**未替换**（新文本不比旧行更长）→ 正文未新增该行 → `pending`；
- 这与「无 `diary.written` 事件」互相印证：`ok=false` 就不会发事件。

---

## 三、记录 1：`auto:2026-11-01:806adae3d6c90350`

### 3.1 记录内容

```json
{ "state":"pending", "day":"2026-11-01", "source":"autonomous", "merged":true,
  "at":1793507095069, "atIso":"2026-11-01T04:24:55.069Z",
  "hash":"806adae3d6c90350",
  "line":"- 心情：想找人说话｜想找老大说话，没发出去——没外部内容，就顺着上次想问的事开口；下次想等老大回话，看他说吃了没、淋没淋" }
```

- 按 line 反算 `contentHash` = `806adae3d6c90350`，**与记录 hash 完全一致** → `line` 就是该幂等键对应的目标内容（文本 50 字）。

### 3.2 生成来源（有记录）

- `data/autonomous.json` `history[29]`：`roundId=round-d5c7cad6`，`startedAt=1793507090797`（12:24:50.797 +08），`endedAt=1793507095042`（12:24:55.042 +08）；
- 该轮 action：`chat`，`why="没外部内容，就顺着上次想问的事开口"`，`next="等老大回话，看他说吃了没、淋没淋"`，`result=success`；
- `data/autonomous-log.md:210-217`：`## 2026-11-01 12:24`，同样记录 why / next；
- 幂等键写入时间 `12:24:55.069`，在轮次结束后 **27ms** —— 即轮末的自述日记写入（`plugins/autonomous/index.js:1511-1520`，由 `activityMemory` 用 `why/next` 拼句，`:446-448`）。
  - 备注：该句写“没发出去”是插件既有文案路径（`sent=mode==='live'`，而 action 子记录只有 `mode:"live"`、没有 `shareMode`），不代表 chat 失败；与本调查结论无关。

### 3.3 写入判定（正文未变）

`appendLine` 的合并分支（`:352-359`）：

- 目标日 `2026-11-01.md` 第 9 行是**更早的**已确认写入（幂等键 `auto:2026-11-01:d1c541a531d49cd2`，`state=done`，写入于 11-01 02:27:42Z，正文行与记录行完全一致）；
- 该行文本长度 **51**；本次新文本长度 **50** → `50 > 51` 为 **false** → **不替换**，正文保持原样；
- 确认逻辑：正文没有与 `r.line` 完全相等的行；正文也不包含新文本前 20 字 → `confirmed=false` → 记录 `pending`（与现状一致）；
- `ok=false` → `write()` 提前返回 → **没有 `diary.written` 事件**（事件表实测：该 hash 无事件；同时段已确认写入的 `d1c541…` 在 02:27:42.956Z 有事件，属对照组）。

### 3.4 “事后被删除”的排除

- `.trash/2026-11-01.md.1793505408016.bak`（03:56:47.997Z）已包含第 9 行 → 04:24 之前该 51 字旧行存在；
- 04:24 之后、当天的幂等记录只有 `ef66abc0…`（05:59Z）与 `23630cbd…`（13:32Z），两者 `merged=false`（追加），**不能删除已有行**；
- `.trash` 无 04:24 之后的 11-01 备份；`writer.removeLine` 的删除会先备份，未见备份 → 无领域删除证据；
- 全日记树（含 `.trash`）与 `data/sessions` 对该句的检索：**0 命中**（仅 autonomous 状态/日志/幂等表含“意图”文本）。

### 3.5 结论

**confirmed_not_written**：该条日记内容没有写入 `2026-11-01.md`；记录 `pending` 是“合并被跳过、确认失败”的准确结果。

---

## 四、记录 2：`auto:2026-11-03:99ba09dd88fab6bf`

### 4.1 记录内容

```json
{ "state":"pending", "day":"2026-11-03", "source":"autonomous", "merged":true,
  "at":1793682568667, "atIso":"2026-11-03T05:09:28.667Z",
  "hash":"99ba09dd88fab6bf",
  "line":"- 心情：想找人说话｜想找老大说话，没发出去——没有外部内容，就按上次留的话来——想问QQ黄脸修好没；下次想等他回话，没回就换个说法再催一次" }
```

- 按 line 反算 `contentHash` = `99ba09dd88fab6bf`，**与记录一致**（文本 59 字）。

### 4.2 生成来源（有记录）

- `data/autonomous.json` `history[46]`：`roundId=round-0bfc94cb`，`startedAt=1793682564189`（13:09:24.189 +08），`endedAt=1793682568632`（13:09:28.632 +08）；
- 该轮 action：`chat`，`why="没有外部内容，就按上次留的话来——想问QQ黄脸修好没。"`，`next="等他回话，没回就换个说法再催一次。"`，`result=success`；
- `data/autonomous-log.md:43-50`：`## 2026-11-03 13:09`，同样记录；
- 幂等键写入 `13:09:28.667`，轮末后 **35ms**。

### 4.3 写入判定（正文未变）

- 目标日 `2026-11-03.md` 第 8 行是更早的已确认写入（幂等键 `auto:2026-11-03:a5f222afb36a23fa`，`state=done`，`merged=true`，写入于 02:16:10Z；正文第 8 行与记录行完全一致）；
- 该行文本长度 **68**；本次新文本长度 **59** → `59 > 68` 为 **false** → **不替换**；
- 确认失败（无完全相等行、无前 20 字匹配）→ `pending`；
- 无 `diary.written` 事件（该 hash 无事件；对照组 `a5f222…` 在 02:16:10.948Z 有 `merged:true` 事件，且正文第 8 行与记录一致）。

### 4.4 “事后被删除”的排除

- 02:16 之后、13:09 之前的 11-03 幂等记录均为 `merged=false`（追加），第 8 行不可能被它们改动；
- 13:09 之后的记录（15:02Z、15:17Z 等）也全部 `merged=false`，不能删除已有行；
- 11-03 **没有任何** `.trash` 备份（`removeLine` 删除会先备份）→ 无领域删除证据；
- 全日记树与 `data/sessions` 检索该句：**0 命中**。

### 4.5 结论

**confirmed_not_written**：该条日记内容没有写入 `2026-11-03.md`。

---

## 五、outbox / 审计记录为什么不能作为反证

- 生产 `pending.json` 在 2026-11-03 曾被日记测试污染并重建（见 `docs/roadmap/INCIDENT-DIARY-TEST-LEAK.md`）：当前只剩测试写入（`A 的内容`、`只读测试` 等，15:39–17:07）与 2 条 10-20 真实 append；**11-01 / 11-03 13:09 的 completed op 已不在文件中**；
- 因此“pending.json 里没有对应 completed 记录”不能用来说明“没写过”，也不能反证“写过”；本调查不以它作为判定依据；
- `pending.json` 当前唯一未完成项是 `8050e5df…`（`match=只读测试`，`stage=prepared`），与本两条幂等键无关。

---

## 六、三态判定

| 记录 | 判定 | 主要依据 |
|---|---|---|
| `auto:2026-11-01:806adae3d6c90350` | **confirmed_not_written** | 生成记录完整；hash 与 line 互证；合并规则要求新文本严格长于旧行（50 vs 51）才替换，实际未替换；确认失败 → pending；无事件；正文与备份/后续记录一致；无删除证据 |
| `auto:2026-11-03:99ba09dd88fab6bf` | **confirmed_not_written** | 同上；59 vs 68；后续均为追加；无 `.trash` 删除备份；无事件 |

> 不是 `unresolved`：两条都能沿 `writer.js` 的确定性分支完整解释（merge 分支 → 不替换 → confirmed=false → pending），并与“正文无该行、无事件、旧行仍在、后续只追加”四项事实一致。

---

## 七、残留假设与不确定性（如实）

1. 没有 04:24:55 / 13:09:28 当时日记文件的**逐字节快照**；判定依赖“旧行当时存在且长度保持不变”的重建：
   - 11-01：trash 备份（03:56）直接证明旧行存在；之后无合并写入；
   - 11-03：旧行的 `done` 记录与 `diary.written` 事件（02:16）证明其存在；之后无合并写入；
2. 无法从文件系统层面 100% 排除“外部人工编辑”在两次尝试之后改过正文；但即使存在，也不会改变“本次写入在合并分支被跳过”的代码判定；且未有 `.trash`/日志/事件显示此类编辑；
3. `line` 字段在幂等表中截断为 200 字；本两条实际长度远小于 200，未受截断影响；
4. 事件表 `active.ndjson` 可能被轮转/归档；本调查只以“同一天其他写入有事件、这两条没有”作为辅助证据，主证据是代码路径与正文。

---

## 八、结论与建议（不执行）

- 两条幂等键应保持 `pending`，**不要**标记 `done`：`done` 会让未来同内容写入被跳过（且账本声称“写过”而正文没有），与 writer 的“以文件为准”原则冲突；
- 若机主希望解除 reset 门禁，需要明确决定这两条“未写入”的自主日记如何处理（例如：确认放弃并删除键 → 允许未来重试；或保留 pending → reset 继续禁用）。**本次未做任何处置**；
- pending outbox 的 `8050e5df…`（`只读测试`）是另一个独立阻塞项，dry-run 判定 `already_removed`，也**未执行**；
- 建议后续把“幂等键三态解释”做成只读 CLI/报告（本次为人工调查），但不在本阶段扩大范围。

---

## 九、证据文件清单

- `src/diary/writer.js`（`:102-107`、`:110-120`、`:159`、`:193`、`:225`、`:235-247`、`:273-300`、`:333-364`）
- `plugins/autonomous/index.js`（`:384-389`、`:424-448`、`:1511-1520`）
- `data/diary-idempotency.json`、`data/diary-meta/pending.json`
- `data/autonomous.json`（`history[29]`、`history[46]`）、`data/autonomous-log.md`（`:43-50`、`:210-217`）
- `data/companion-events/active.ndjson`（对照组 `d1c541…` / `a5f222…`；目标 hash 无事件）
- `E:\dsh\日记\每日\2026-11-01.md`、`2026-11-03.md`；`E:\dsh\日记\.trash\2026-11-01.md.1793505408016.bak`
- `docs/roadmap/INCIDENT-DIARY-TEST-LEAK.md`

