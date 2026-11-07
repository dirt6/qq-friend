# 事故留档：日记测试写入生产 pending.json（2026-11-03）

## 发生了什么

D1-2a 的 `test/diary-edit-lock-test.mjs` 在**主测试进程**中 `import` 了 `src/diary/writer.js`。writer 的 `DATA_DIR` 在 `config.js` 导入时确定；测试在 import 之后才设置 `QQ_AGENT_DATA_DIR`，已经太晚。于是该测试通过 `writer.removeLine/relevelLine` 产生的 outbox 记录被写进了**生产** `data/diary-meta/pending.json`。

## 受影响的记录（7 条）

| match | op | 来源 |
|---|---|---|
| `A 的内容` | remove | diary-edit-lock-test |
| `B 的内容` | relevel | diary-edit-lock-test |
| `B 的内容` | relevel | diary-edit-lock-test |
| `只读测试` | remove（失败残留） | diary-edit-lock-test |
| `甲 的内容` | remove | diary-edit-lock-test |
| `乙 的内容` | remove | diary-edit-lock-test |
| `委托测试` | remove | diary-edit-lock-test |

## 如何精确识别与删除

- 只删 `match` 命中上述 6 个测试字符串的记录（共 7 条），逐条比对后删除；
- **保留**了 2 条机器人真实 append 记录：
  - `看到一个用鱼缸改的路由器`（2026-10-20）
  - `又看到一只会按按钮的猫`（2026-10-20）
- 删除后 pending.json 只剩这 2 条，与机器人写日记的行为一致。

## 根因

`DATA_DIR` / 幂等表 / outbox 路径都在**模块导入时**确定；测试文件里的“先设 env、再静态 import”无法改变已经缓存的路径。这是测试进程边界的缺口，不只是日记 meta 的问题。

## 修复

1. `test/run-diary-test.mjs`：统一启动器，在任何日记模块导入前用**子进程 env** 注入独立临时 `QQ_AGENT_DATA_DIR` / `DIARY_TEST_TMP` / `DIARY_TEST_GUARD`；结束后清理临时目录。
2. `src/diary/test-guard.js`：写路径门禁（解析真实路径、拒绝生产 data、拒绝 `..`/大小写/分隔符/符号链接绕过、拒绝无法解析的路径）；仅在 `DIARY_TEST_GUARD=1` 时激活，生产运行不受影响。
3. writer / outbox / meta 的写入口在测试模式下统一经过门禁；门禁失败在任何写入之前抛错。
4. `run-regression.ps1`：所有 `diary-*` 测试统一通过启动器运行。
5. 新增 `test/diary-isolation-guard-test.mjs`（13 项）覆盖：空根、合法根、改 DATA_DIR、四类写路径、`..`、大小写/分隔符、符号链接、多进程、异常退出后生产不变。

## 如何防止再次发生

- 日记测试一律走启动器，不依赖测试文件自行设置 env；
- 门禁以启动器提供的 `DIARY_TEST_TMP` 为唯一安全基准，模块不能自证“安全”；
- 生产路径判定基于解析后的真实路径，不用字符串前缀；
- 全量回归中日记测试全部通过启动器执行，任何写生产路径会直接失败。
