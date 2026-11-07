# D1-5 最终报告：历史数据收敛与生命周期闭环

> 时间：2026-11-04
> 范围：D1-5A 幂等历史、D1-5B Diary Trash、D1-5C DSH Session、D1-5D 只读 UI、D1-5E 可靠性
> 性质：只读调查 + 设计 + 隔离实现/测试；**未执行生产写入/删除/隔离/进程终止/重启/reset**

## 一、提交清单

| 批次 | commit |
|---|---|
| D1-5A 幂等历史 + 审计 verdict/测试语料 | `1978322` |
| D1-5B 13 个 trash 清单 + 旧备份隔离恢复 | `16af064` |
| D1-5C Session 清单/归属 + 带 manifest 隔离 + 重置设计 | `8ed82d7` |
| D1-5D 只读数据管理页面 + 5 个只读 API | `83127d2` |
| D1-5E 综合可靠性 11 PASS/2 UNKNOWN | `c4cb23d` |
| 本报告 | 见最终 commit |

## 二、各批测试报告

| 批次 | 专项 | 结果 |
|---|---|---|
| A | `test/data-consistency-audit-test.mjs`（verdict 三态/测试语料/hash 不一致/合并链/重复键） | **12/12 PASS** |
| B | `test/legacy-backup-recovery-test.mjs`（清单/补录/恢复/冲突/损坏/中断/hash） | **8/8 PASS** |
| C | `test/session-inventory-test.mjs`（状态/备份/引用/映射拒绝/隔离恢复/manifest） | **8/8 PASS** |
| D | `test/data-admin-ui-test.mjs`（页面/入口/只读/5 API） | **5/5 PASS** |
| E | `test/d1-5e-reliability-test.mjs` | **11 PASS / 0 FAIL / 2 UNKNOWN** |
| 全量 | `scripts/run-regression.ps1` | **81 项：77 PASS / 4 FAIL**（均为既有基线：selftest、tools-skill-audit、gallery-test、setup-qq-version 偶发） |

E 开发过程中曾出现 2 次 FAIL（handle 场景参数错误、UI 子进程 config 绑定生产端口），修复后最终 11 PASS/2 UNKNOWN；最终无 FAIL，未用重跑覆盖最终失败。

## 三、生产数据 hash（D1-5 前后一致）

| 目标 | 值 |
|---|---|
| memory | `ee772eb3c51428d27c15d562b2261c072e6e9316f76dd20473c543c31330f9bf` |
| 日记树 | `fb5cfac7931c6b78aae0f2cbbb470a5f7968377d0172cd978b040e52b489c5f6` |
| sessions | `ff13eb830d6eb15fe7d242e545b00cf8041f301121a4988939efc2542c1b649e` |
| learned | `f9f754a986e0ae22672accc4e6512120ec1587f6b34d32c65eee80ed25bfa26e` |
| pending | `ca8801590d91dbfef487a132d62e643f17d76d051e106d96c56b9c58c3944785` |
| idempotency | `96d610c4d9821782b4228b759b6b3e18090aa25f01c67de885eb523baca18493` |
| dsh 映射 | `42bb56e82627d8b977d146ee16ea06b6353d8ae4a70be677efec0fc09253f00a` |
| dsh-home | `4147b1b0b16af952eaccb2020de60ba75af417cfed804e45beb6e33bdbc3affb` |
| reset 备份 | 不存在 |

> 与 D1-5 开始基线完全一致；本批工具未写生产。P1 审计口径变化（5 warn→1 warn）仅工具判定，不是数据改动。

## 四、全部历史不确定项

1. **幂等 `d9fb…`（11-01）**：事件与 `.trash` 证明曾写入，当前正文缺失，无删除记录 → `historical_unverifiable`；不补写、不删除键。
2. **Diary Trash 13 个**：
   - 12 个 `verified_recoverable`：可读、hash 可算、含当前正文没有的唯一旧内容；但**是否应恢复取决于删除是否有意**，无法证明；
   - 1 个 `promises.md` 迁移备份：无当前正文 → `historical_unknown`；
   - 0 corrupted；全部保留，无 manifest 原始状态。
3. **DSH 10 个本项目孤儿**：项目归属/无映射/无聊天/companion/本地引用均可核；但**进程归属 UNKNOWN、zstd 内容 UNKNOWN、无可验证备份、年龄 4 天 < 7 天** → 全部 `unmapped_project_owned`，不是 quarantine_candidate。
4. **外部项目 `--E-dsh--`**：1 个 Session，不属本项目，永久排除。
5. **UI 真实浏览器渲染**：UNKNOWN（Edge headless mojo/ACL 拒绝，无替代渲染器；未伪造截图）。
6. **真实 Windows ACL/磁盘满**：UNKNOWN（仅注入验证 fail-closed）。

## 五、仍需人工判断的记录

| 对象 | 需要判断 |
|---|---|
| `d9fb…` 幂等键 | 保留 historical 标记，还是补充说明；不得直接删/补写 |
| 12 个可恢复 trash | 逐个人工决定是否恢复；恢复用隔离工具，先确认删除是否有意 |
| `promises.md` 迁移备份 | 是否保留/迁移语义；无当前正文 |
| 10 个孤儿 Session | 是否补备份后隔离；需先确认内容/进程归属；当前 0 候选 |
| `--E-dsh--` Session | 由外部项目所有者处理 |
| UI 截图/浏览器验收 | 需可用渲染环境补 |
| 4 个全量基线失败 | 与本批无关，未修改 |

## 六、生产执行所需独立授权清单

1. 修改生产日记/记忆/pending/幂等表；
2. 删除或恢复生产 `.trash`；
3. 删除/隔离生产 Session，或修改 `dsh-sessions.json` 映射；
4. 终止生产 DSH/子进程；
5. 重启 Electron / 部署新 UI（当前生产进程仍是旧代码，新增 `/data-admin.html` 与 API 尚未生效）；
6. 执行生产 reset；
7. 修改生产配置/NapCat/selfWake/调度/预算。

## 七、下一阶段依赖关系

```
D1-5A 幂等语义（已完成）
  └─ 生产修复依赖：人工决定 d9fb + 独立授权
D1-5B Trash（已完成清单/恢复演练）
  └─ 生产恢复依赖：逐个人工确认 + 授权；manifest 补录需授权
D1-5C Session（已完成清单/归属/隔离演练）
  ├─ 生产隔离依赖：备份 + 内容/进程确认 + 授权
  ├─ 清空后重置依赖：产品/UI 授权（显式入口，不做自动清理）
  └─ 进程终止依赖：可靠 Windows 所有权验证（当前 UNKNOWN，fail-closed）
D1-5D UI（只读）
  └─ 生产可用依赖：重启/部署（未授权）；浏览器截图补验
D1-5E 可靠性
  └─ 真实 ACL/磁盘满/浏览器渲染仍 UNKNOWN，需专门环境
```

## 八、结论

D1-5A–E 全部完成；历史数据未删除/未修改/未隔离；生产 hash 与基线一致；剩余工作均需人工判断或生产授权。
