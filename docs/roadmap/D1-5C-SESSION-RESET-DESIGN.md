# D1-5C：清空聊天后重置 Session 的产品流程（设计）

> 时间：2026-11-04
> 性质：设计；**不实现生产写入口**，清空聊天不自动清理 Session
> 原则：用户主动、可预览、可备份、失败保持原映射、绝不默认删除 DSH 内部 Session

## 一、现状

- 清空聊天（`/api/chats/:key/clear`）只清本地消息，**保留** `dsh-sessions.json` 映射；
- 下一轮同一 chatKey 仍复用旧 sessionId；
- `resetSession(chatKey)` 是死接口，无 UI/路由调用；
- DSH 无 delete/TTL 接口；Session 目录由 DSH 子进程写。

## 二、目标流程（7 步）

1. **用户主动选择重置**：聊天设置里独立入口“重置她的 DSH 会话”，不与“清空聊天”混用；
2. **显示影响**：chatKey、当前 sessionId、turns、lastUsedAt、Session 目录大小/年龄；明确“只重置记忆会话，不删除聊天记录/日记”；
3. **确认无其他聊天引用**：扫描 `dsh-sessions.json`，若有其他 chatKey 指向同一 sessionId → 禁用重置并提示；
4. **创建可恢复映射备份**：写入 `data/backups/dsh-sessions/<stamp>/manifest.json`（原映射片段 + SHA256 + createdAt），并保留原 sessionId 目录（不删）；
5. **旧 Session 标记为不再复用**：在同一事务中写 `retiredSessions` tombstone（sessionId/chatKey/retiredAt/backupPath/reason），并移除该 chatKey 的映射；旧目录保留，供人工恢复；
6. **新聊天使用新 Session**：下一次消息无映射 → 冷启动新 session；旧 sessionId 不再被该 chatKey 使用；
7. **失败时保持原映射**：备份失败/写映射失败/事务失败 → 不删除映射；若已写 tombstone 但映射未改，回滚 tombstone；审计记录失败。

## 三、事务与失败处理

```
precheck（引用/映射/备份盘）
  → 写映射备份（hash）
  → withFileLock(dsh-sessions.json)
      read map
      if chatKey 映射不存在 → no-op（幂等）
      if 其他 chatKey 引用同 sid → 拒绝
      write { ...map 去掉 chatKey, retiredSessions: [...], retiredAt }
  → 审计
  → 失败：保留原文件/回滚 tombstone；旧 session 目录不动
```

- 不做“先删映射再备份”；
- 不修改 DSH Session 目录内容；
- 不把清空聊天与重置绑定（清空仍保持现状 A 方案）。

## 四、恢复入口

- 列出 retiredSessions（sessionId/chatKey/retiredAt/backupPath）；
- “恢复映射”：校验备份 manifest + 原目录仍存在 + chatKey 当前无映射 → 写回映射（原子；失败不改）；
- 冲突（chatKey 已有新映射/目录丢失）→ 拒绝并提示；
- 只读清单可在数据管理页查看；写恢复需独立授权。

## 五、UI/API（后续实现）

- `GET /api/data-management/sessions`：只读状态 + 可重置预览（不写）；
- 重置按钮：二次确认 + 显示影响 + 备份路径 + 失败提示；
- 本批 D1-5D 只做只读查看/计划，不提供生产重置按钮；
- 不提供任意 sessionId 输入（只能从清单选择）。

## 六、验收（未来实现时）

- 其他聊天引用 → 拒绝；
- 备份失败 → 映射不变；
- 写映射失败 → 原映射不变、tombstone 回滚；
- 成功 → chatKey 无映射、tombstone 存在、旧目录仍在、新会话冷启动；
- 恢复 → 映射/目录/hash 校验通过才写回；
- 审计完整；清空聊天不触发 Session 清理。

## 七、明确不做

- 不删除/移动 DSH Session 目录（本流程只停用映射）；
- 不自动在 clear 时清理；
- 不依赖 PID 终止进程；
- 不在本批实现生产写入口。
