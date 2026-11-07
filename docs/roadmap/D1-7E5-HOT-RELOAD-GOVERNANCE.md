# D1-7E5：热重载治理方案

> 时间：2026-11-04
> 性质：只读调查 + 方案设计；未改生产行为/配置
> 结论：推荐 **A（完整进程重启作为代码更新边界）**；B 仅限无共享状态插件；C 暂不建设。代码级防护本批**未接线**（需独立设计/授权与测试）

## 一、现有机制复核

| 点 | 事实 |
|---|---|
| 入口加载 | `import(\`${entryUrl}?t=${Date.now()}\`)` 仅刷新插件入口 |
| 依赖缓存 | 静态 import 的 `src/**` 按 URL 缓存，不随入口刷新 |
| 旧实例退役 | setup 前 deactivate；成功后才摘 registry/清能力；失败 activate 旧实例 |
| 新实例失败 | 工具回滚；不调用新模块 dispose；模块级状态可能残留 |
| Core | `context.js` 的 ChatStore 是模块级单例；`createCompanionCore` 无全局实例 |
| autonomous | setup 只注册工具；activate 起 loop；deactivate 停 loop；不会双 loop |
| 其他插件 | 同样只刷新入口；依赖 `src/**` 的插件都可能混合版本 |
| 重复加载 | 工具按 id 覆盖；能力/registry 有清理；定时器依赖 deactivate；无统一实例 ID/版本 |
| deactivate 等待 | `stopLoop` 同步 clearInterval，不等待在跑 tick/异步任务结束 |
| 失败回滚 | 旧实例恢复；但新模块未 dispose，可能残留监听器/定时器 |

## 二、方案比较

### A. 完整进程重启（推荐）

- 代码变更后不递归刷新依赖；以进程重启加载一致版本；
- 热重载仅限“确认无共享 Core 状态、无不可逆副作用”的插件；
- 优点：依赖图一致、单例不分裂、资源随进程回收；
- 缺点：有中断（需维护窗口）；需重启授权；
- **适用当前项目**：Core/ChatStore/插件共享状态多，A 最稳。

### B. 插件级安全热重载（受限）

- manifest 标 `reloadPolicy: hot | restart-required`；
- 依赖 Core/ChatStore 的插件默认 `restart-required`；
- 仅 `hot` 插件允许局部刷新；
- 必须证明：旧实例 deactivate 完成、无在跑任务、资源释放、失败回滚完整；
- 优点：减少重启；缺点：需要逐插件审计，边界复杂；
- 可作为 A 的补充，不替代 A。

### C. 完整模块图版本化

- 需要统一构建/模块图、单例注册表、版本快照、跨模块引用迁移、卸载/回收；
- 当前项目无构建图，插件直接 import `src/**`；改造成本高、风险大；
- 递归加 `?t=` 会造成多实例/单例分裂，**不可作为方案**；
- 结论：**暂不建设**。

## 三、代码级防护候选（未实施）

1. manifest `reloadPolicy`（`hot`/`restart-required`）；
2. 静态/运行时扫描插件依赖是否包含 `src/companion-core`/`context`/`store`，命中即 `restart-required`；
3. watcher 对 `restart-required` 插件只打印“需重启”，不重新 import；
4. 加载前后记录 instanceId、插件入口 hash、Core 版本、依赖 hash；
5. deactivate 必须返回/等待完成（Promise + 超时），失败拒绝切换；
6. dispose 失败记录并禁止新实例接管；
7. dev 模式断言同一进程 Core/ChatStore 只有一个实例；
8. 旧实例资源清单（timer/listener）由插件显式提供，加载器校验；
9. 加载失败时调用新模块 dispose（若存在）；
10. 生产默认 `hotReload=false`，开发显式开启（需配置变更/授权）。

> 这些均可能改变热重载行为；本批未接线，避免在未授权情况下改变生产。

## 四、自动化测试（计划/未实施）

| # | 用例 | 状态 |
|---|---|---|
| 1 | 同一插件重复加载 | 未实施 |
| 2 | 旧实例 deactivate 成功后切换 | 未实施 |
| 3 | deactivate 失败拒绝切换 | 未实施 |
| 4 | 新 setup 失败恢复旧实例 | 部分由现有 loader 逻辑保证，未专项测 |
| 5 | 新 activate 失败不双 loop | 未实施 |
| 6 | ChatStore 注册不丢失 | 未实施（需 fake app） |
| 7 | Core 单例不分裂 | 未实施 |
| 8 | 监听器/定时器不重复 | 未实施 |
| 9 | 卸载无遗留任务 | 未实施 |
| 10 | restart-required 不被局部热重载 | 未实施 |

- 需要 Fake Timer/Fake Store/受控依赖注入的独立测试环境；本批不写生产行为代码，故不伪造测试通过。
- 现有 E1 调查 + E2 隔离测试不覆盖上述生命周期；标记 **UNKNOWN/未实施**。

## 五、结论与建议

- **治理方案：A（进程重启边界）**；
- 热重载只保留给明确安全插件；带 Core/ChatStore 依赖的插件标注 `restart-required`；
- 代码级防护需独立工作包，先做假环境测试，再接线；本批不实现；
- 生产当前 hotReload=true 且已发生混合版本，必须在授权重启后恢复一致；
- 在 A 落地前，**不建议**继续在 watcher 监听目录编辑 `src/**`。
