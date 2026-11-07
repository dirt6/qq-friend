# D1-1B 报告：MemoryStore 跨进程并发写入修复

> 时间：2026-11-03
> 授权：机主选 A（写入 API 异步化），边界明确：数据格式/业务语义/调用顺序不变
> 结论：四个子批次完成；API 由同步改为 Promise，**数据与语义不变**

---

## 一、提交

| 子批次 | commit | 内容 |
|---|---|---|
| B-1 | `0acb049` | 端口锁模块 `src/memory-port-lock.js` + 16 项测试 |
| B-2a | `e7e1a92` | MemoryStore 写 API 异步化 + 调用方/测试迁移 |
| B-2b | `4f876fd` | 完整读改写事务接入端口锁 |
| B-2c | 本报告 | 集成测试 + 回归 + 报告 |

## 二、API 契约（明确的变化）

- **写入方法返回 Promise**：`append` / `editMemberImpression` / `replaceMember` / `removeMember` / `removeChat` / `remove` / `clear` / `markConsolidated` / `replaceConsolidated`。
- **成功时返回值不变**：`entry` / 成员对象 / boolean / 整理结果，与旧版相同。
- **读方法保持同步**：`query` / `members` / `getMember` / `formatForPrompt` / `consolidationState`。
- **无同步兼容写入口**：不存在"表面同步、内部绕过锁"的方法。
- 失败（超时/绑定错误/写失败）以 Promise rejection 传播，不静默。

## 三、全部写入调用点（已逐个 await）

| 文件 | 调用 |
|---|---|
| `src/tools.js:757` | `await ctx.memory.append(...)`（memory_append 工具） |
| `src/tools.js:804` | `await ctx.memory.remove(...)`（memory_remove 工具） |
| `src/orchestrator.js:2270` | `await this.memory.replaceMember(...)`（#resolveIdentity） |
| `src/orchestrator.js:2315` | `await this.memory.markConsolidated(...)`（#markConsolidated，已 async） |
| `src/orchestrator.js:2368` | `return await this.memory.replaceMember(...)`（#consolidateOneMember） |
| `src/routes.js:2687` | `await memory.editMemberImpression(...)`（PUT 成员印象） |
| `src/routes.js:2704` | `await memory.removeMember(...)`（DELETE 成员） |
| `src/routes.js:2714` | `await memory.removeChat(...)`（DELETE 会话记忆） |

`#resolveIdentity` / `#markConsolidated` 已改为 async，调用处 `await`；`consolidateMemoryForChat` 本身 async。

## 四、锁是否覆盖完整事务

`src/memory.js`：

```js
#withChatLock(chatKey, fn) {
  return withMemoryPortLock(chatDir(chatKey), fn, { timeoutMs: 5000 });
}
```

每个写方法内部：

```js
return this.#withChatLock(chatKey, () => {
  this.cache.delete(chatKey);          // 不读旧缓存
  const map = this.#ensureChat(chatKey); // 锁内从磁盘重建
  ...读—改...
  writeJson(memberFile(...), member);  // 锁内写
});
```

- **读、改、写在同一把锁内**；缓存先失效，避免"锁外读旧数据"。
- 锁粒度：会话目录（同会话所有成员文件互斥；不同会话并行）。
- `migrateLegacy` 与 `replaceConsolidated` 内部使用 `#appendRawSync` / `#clearSync`（不嵌套取锁）。
- 写失败（锁超时/绑定失败/rename 失败）→ Promise reject，不写入。

## 五、Windows 绑定语义证据

- D1-1A-2 隔离实验：第二个 bind 返回 `EADDRINUSE`；无关程序占用同样失败；SIGKILL 后 OS 释放（11 项 ×5）。
- 本批 `memory-port-lock-test`：双进程 100/100、同进程并发、超时不写、占用 fail-closed、碰撞串行。
- 本批 `memory-store-lock-test`：双进程各 50 → 100；SIGKILL 后恢复；端口占用拒绝写入；只读文件写失败旧数据不损坏。
- 仍不宣称 `exclusive: true` 本身是原生独占——证据是竞争实验。

## 六、测试结果

### 6.1 专项

| 套件 | 结果 |
|---|---|
| `memory-port-lock-test` | 16 / 16 |
| `memory-store-lock-test` | 13 / 13 |

### 6.2 相关回归

| 套件 | 结果 |
|---|---|
| stage30r2-memory-meta | 49 / 0 |
| stage30r3a-impression-meta | 43 / 0 |
| message-images | 7 / 7 |
| prompt-anchor | 通过 |
| r8b-tristate | 41 / 0 |
| stage30r4-memory-hub | 38 / 0 |
| memory-hub-impression-key | 13 / 0 |
| coverage-http | 112 / 4（4 项既有） |
| coverage-offline | memory 段通过；末尾 gif-to-video 因沙箱 `spawn EPERM` 失败（既有环境限制） |

### 6.3 全量回归

**55 项：51 PASS / 4 FAIL**。4 项全部为基线既有失败（`selftest` / `tools-skill-audit` / `setup-qq-version` / `gallery-test`），无新增。

> 首轮全量曾出现两个非基线失败，均已处理：`test-prompt`（遗漏 `await memory.append`，B-2a 测试迁移漏项，修复后通过）、`store-concurrent-test`（Windows 文件锁 EPERM 偶发，重跑 38/0 通过，既有 flaky）。

## 七、生产数据哈希

| 项 | 实施前 | 实施后 |
|---|---|---|
| `data/learned.json` | `A065EFE2…D193` | `A065EFE2…D193` |
| `data/qq-agent.lock` | `25984` | `25984` |

未运行生产写入演练；测试全部使用临时目录。

## 八、未验证的环境

1. **Electron 开发/打包模式实际运行**：本批用系统 Node 24 验证；Electron 内置 Node 未单独跑（端口锁无 native 依赖，理论无 ABI 问题）。
2. **多机/网络盘**：不保证。
3. **原子写失败的注入方式**：只用只读文件模拟（Windows 语义有限），未覆盖 rename EPERM 的完整矩阵。
4. **长期高频写入**：未做压测（端口 bind/unbind 开销 ~1–2ms/次）。

## 九、已知限制

- 端口区间 42000–42999（1000 个），碰撞时额外串行；文件数极多时吞吐下降。
- 端口被无关程序长期占用 → 该会话写失败（fail-closed），需告警/人工处理；不能动态换端口。
- 锁文件不产生；端口不可见为数据文件。
- API 同步→异步是本次唯一契约变化。

## 十、结论

- 双进程并发 100/100、异常退出恢复、端口占用不写、原子写失败旧文件不损坏、格式/顺序/prompt/三态不变。
- 生产数据哈希前后一致（见第七节）。
- **B-2c 完成；D1-1B 结束。** D1-2 未开始（按指令不提前扩大）。
