# 记忆体系迁移计划（3.0 基线）

> 版本：v1.0（R0 设计稿）
> 时间：2026-11-02 23:40
> 状态：**设计文档，未实施**
> 范围：五层记忆的迁移方案、备份与恢复、双读、幂等、回滚
> **范围限定（2026-11-03）**：迁移只针对**单伙伴**的数据加字段/兼容；**不做跨 PROFILE 迁移、合并或同步**（见 `ARCHITECTURE-UNIFIED-COMPANION.md`）。

---

## 一、迁移的总原则

| # | 原则 | 理由 |
|---|---|---|
| **1** | **只加字段，不改现有字段** | 旧代码读新文件不能崩 |
| **2** | **旧数据读取不产生写入**（惰性迁移） | 读操作必须保持只读 |
| **3** | **迁移幂等** | 跑两次结果一样 |
| **4** | **迁移前必须备份** | 这次的 B6 教训 |
| **5** | **双读期 ≥ 一个版本** | 新旧代码能同时跑 |
| **6** | **出问题能回滚** | 不改原文件内容，只加字段 → 回滚 = 忽略新字段 |

---

## 二、逐层迁移方案

### 2.1 L1 经验（`data/learned.json`）

**风险等级**：**低**（结构化，22 条）

**迁移内容**：

```diff
  {
    "id": "l-mvq5ul9z-fla",
    "text": "...",
    "status": "pending",
+   "contentType": "preference",
+   "epistemicType": "direct",
+   "origin": { "kind": "user_stated", "ref": "2026-10-27", "at": "...", "quote": "..." },
+   "correction": { "count": 1, "events": [], "historicalUnresolved": true },
    "corrections": 1,          ← 保留
    ...
  }
```

**双读**：

```js
const epi = item.epistemicType ?? 'unknown';
const cnt = item.correction?.count ?? item.corrections ?? 0;
```

**写时**：

```js
item.correction = { ...item.correction, count: newCount };
item.corrections = newCount;   // 同步旧字段
```

**幂等**：已有 `epistemicType` 的跳过。

**回滚**：删掉新字段即可（旧代码不认它们）。

**历史 corrections 的恢复**：

| 情况 | 处理 |
|---|---|
| `text` 里有 `“X”改为「Y」` | **提取候选**，写进 `data/migration-review/learned-corrections.md`，**等人工确认** |
| 确认通过 | 写入 `correction.events` |
| 不确认 / 读不出 | `historicalUnresolved: true` |

**禁止**：自动推测 `correctedFrom` / `correctedTo`。

### 2.2 L2 聊天记忆（`data/memory/<chatKey>/`）

**风险等级**：**中**（`MemoryStore` 的结构要先确认）

**迁移内容**：

```diff
  {
    "impressions": ["她喜欢猫", "可能不喜欢被 @"],
+   "impressionMeta": [
+     { "epistemicType": "fact", "origin": {...} },
+     { "epistemicType": "inference", "origin": {...} }
+   ]
  }
```

**平行数组的风险**：

- 长度不一致 → **以 `impressions` 为准**，缺的补 `unknown`
- 顺序错乱 → **只追加，不重排**

**回滚**：删 `impressionMeta`。

### 2.3 L3 日记（`E:\dsh\日记\每日\*.md`）

**风险等级**：**低**（只加旁路文件，**原文一个字节不动**）

**迁移内容**：

```
E:\dsh\日记\每日\2026-11-02.md       ← 不动
data/diary-meta/2026-11-02.json      ← 新增
```

**格式**：

```json
{
  "dateKey": "2026-11-02",
  "sourceFile": "E:\\dsh\\日记\\每日\\2026-11-02.md",
  "sourceHash": "sha256:...",       ← 用于检测原文是否被改过
  "entries": [
    { "index": 0, "epistemicType": "fact", "origin": {...}, "roundId": "..." }
  ]
}
```

**幂等**：同 `dateKey` 已有元数据 → 跳过（除非 `sourceHash` 变了）。

**`sourceHash` 的作用**：日记被手动编辑后能发现，**不静默错位**。

**回滚**：删 `data/diary-meta/`。

### 2.4 L4 DSH 会话

**不迁移。**（机主明确：保留原始会话语义）

### 2.5 L5 Companion State

**不迁移。**（机主明确：不把 Companion State 变成普通记忆）

---

## 三、备份与恢复

### 3.1 备份策略

**这次必须做对**（B6 的教训：演练没有隔离写盘）。

| 对象 | 备份方式 | 保留 |
|---|---|---|
| `data/learned.json` | 时间戳文件，**排他创建** | 每次迁移一份 |
| `data/memory/` | 整目录打包 | 每次迁移一份 |
| `E:\dsh\日记\` | **只读，不备份**（原文不改） | — |
| `data/diary-meta/` | 迁移前如果存在则备份 | 每次 |

**命名规范**：

```
data/backups/learned.before-migration-3.0-<timestamp>.json
data/backups/memory.before-migration-3.0-<timestamp>.tar
```

**排他创建**：

```js
fs.writeFileSync(bp, content, { flag: 'wx' });   // 存在就报错，不覆盖
```

### 3.2 备份验证

**写完后必须读回比对**：

```js
const back = fs.readFileSync(bp, 'utf8');
if (back !== content) throw new Error('备份不一致');
```

### 3.3 恢复流程

```bash
node scripts/memory-migration.mjs --restore <backup-file>
```

**恢复必须**：
1. 先备份**当前**状态
2. 再覆盖
3. 读回验证
4. 记录日志

---

## 四、双读策略

### 4.1 双读期

**定义**：新字段写入后，**旧代码仍能正常读**。

**要求**：

- 旧字段（`corrections`）**永远保持同步**
- 新代码读时**优先新字段，回退旧字段**
- **不允许**只写新字段、不写旧字段

### 4.2 双读的退出条件

**至少一个版本之后**（3.0 发布 → 3.1 才能删旧字段）。

**3.0 不删任何旧字段。**

---

## 五、幂等性

### 5.1 每个迁移步骤都必须幂等

| 步骤 | 幂等键 |
|---|---|
| learned 加字段 | `id` |
| memory 加 meta | 成员 `userId` |
| diary 加 meta | `dateKey` + `sourceHash` |

### 5.2 幂等的验证方式

**迁移脚本跑两次，第二次输出 `changed: 0`。**

---

## 六、回滚方案

### 6.1 三级回滚

| 级别 | 触发条件 | 操作 |
|---|---|---|
| **L1 代码回滚** | 新代码有 bug | `git revert` |
| **L2 字段回滚** | 新字段导致读错 | 删新字段（旧代码不认） |
| **L3 数据回滚** | 数据损坏 | 从备份恢复 |

### 6.2 数据回滚的具体命令

```bash
# 1. 先备份当前
node scripts/memory-migration.mjs --backup-only

# 2. 恢复
node scripts/memory-migration.mjs --restore data/backups/learned.before-migration-3.0-20261103-120000.json

# 3. 验证
node scripts/memory-migration.mjs --verify
```

---

## 七、生产数据安全

### 7.1 铁律

| # | 铁律 |
|---|---|
| 1 | **迁移脚本必须支持 `--dry-run`，且 dry-run 真的不写盘**（B6 教训：不能只跳过几个分支） |
| 2 | **dry-run 的实现方式：注入只读的 store，不是靠 if 判断** |
| 3 | 所有写操作**走正式接口**，不直接改 JSON |
| 4 | 迁移前**必须**打印当前状态摘要 |
| 5 | 迁移后**必须**读回验证 |
| 6 | 每一步都写 **`data/memory-migration.log`** |

### 7.2 dry-run 的正确实现（吸取 B6 教训）

```js
// ❌ 错：靠 if 判断（B6 就是这么出事的）
if (!LIVE) return;   // 只跳过某个分支

// ✅ 对：注入只读 store
const store = LIVE ? realStore : makeReadOnlyStore(realStore);
// makeReadOnlyStore 里所有写方法直接 throw
```

**`makeReadOnlyStore`**：

```js
function makeReadOnlyStore(real) {
  return new Proxy(real, {
    get(t, k) {
      if (typeof t[k] === 'function' && /^(write|save|add|remove|set|update|delete)/.test(k)) {
        return () => { throw new Error(`dry-run 禁止调用 ${k}`); };
      }
      return t[k];
    }
  });
}
```

---

## 八、迁移的批次（对应 R2 ~ R5）

| 批次 | 迁移对象 | 风险 | 可并行 |
|---|---|---|---|
| **R2** | L1 经验 + 元数据规范 | 低 | ✅ |
| **R3** | L2 聊天记忆 + L3 日记 | 中 | ✅（与 R2 并行） |
| **R4** | 检索质量验证 | 低 | ❌ 依赖 R2/R3 |
| **R5** | 五层兼容回归 | 低 | ❌ 依赖 R2/R3 |

**每批都必须**：
- 备份
- dry-run（真的不写）
- 逐条验证
- 幂等验证（跑两次）
- 全量回归

---

## 九、迁移**不做**的事

| ❌ 不做 | 理由 |
|---|---|
| 重写 `learned.json` 的整个结构 | 只加字段 |
| 改日记原文 | 机主明确：原文不动 |
| 改 L4 / L5 的结构 | 机主明确 |
| 删旧字段 | 双读期 ≥ 一个版本 |
| 一次性迁移全部数据 | 分批，每批独立验证 |
| 用第三方迁移工具 | 自己写，可控 |

---

## 十、验收标准

| # | 标准 |
|---|---|
| 1 | 迁移前后 `learned.json` 的 `id` 集合完全一致（**不丢条**） |
| 2 | 迁移后旧字段（`corrections`）仍在且值正确 |
| 3 | 迁移跑两次，第二次 `changed: 0` |
| 4 | 日记原文的 `sha256` 迁移前后一致 |
| 5 | `data/diary-meta/` 的 `sourceHash` 与原文一致 |
| 6 | 备份文件读回一致 |
| 7 | `--dry-run` 时**文件字节级不变** |
| 8 | 全量回归全绿 |
| 9 | 迁移日志完整 |

---

## 十一、待确认

### ① 迁移脚本的 `--dry-run` 是否用 Proxy 注入只读 store

**我建议用**（这是 B6 教训的直接修正）。

**同意吗？**

### ② 日记元数据的 `sourceHash`

**作用**：检测原文被手动改过。

**代价**：每次读要算 hash（日记文件不大，可以接受）。

**同意吗？**

### ③ 迁移是否需要停机

**我建议需要**（暂停自主活动，和 B6 一样）。

**但**：这次**必须真的暂停**（不是只改个 flag）。
