# D1-1A-2：MemoryStore 端口锁隔离验证报告

> 时间：2026-11-03
> 性质：**隔离实验 + 文档**；未接 MemoryStore、未改生产代码/配置/data
> 实验：`scripts/experiments/d11a-port-lock/`（port-lock.mjs / worker.mjs / run.mjs / result.json）
> 结论：**11 项全部通过（每项 5 次），建议进入 D1-1B**

---

## 一、方案

把"文件互斥"映射为 **Windows loopback TCP 端口的独占 bind**：

```
进入临界区：net.Server.listen({ port: 映射端口, host: '127.0.0.1', exclusive: true })
  ├─ 绑定成功 = 持锁（OS 保证独占）
  ├─ EADDRINUSE = 已被占用 → 20ms 后重试，直到超时
  └─ 超时 → 抛 EPORTLOCK（绝不写）
退出：server.close()（OS 释放端口；进程崩溃时 OS 自动释放）
```

- **不依赖** PID 过期判断、rename 认领、陈旧锁回收；
- **不扫描端口**：直接 bind，用绑定结果判断；
- 连接进入锁端口 → 立即 `socket.destroy()`（不提供任何业务）。

## 二、端口映射算法

1. **规范化**：`path.resolve(file)` → 若存在则 `fs.realpathSync.native`（解析符号链接/8.3 短名）→ 反斜杠统一 → **小写**（Windows 大小写不敏感）。
2. **哈希**：FNV-1a 32 位（确定性、无随机盐）。
3. **端口区间**：`42000 + (hash % 1000)` → 42000–42999。
4. **冲突**：不同文件可能落到同一端口 → **保守串行**（不会换备用端口，因此不会双持）；同一文件的所有进程必然同端口。
5. **失败**：绑定失败/超时 → fail-closed（不写），不退化。

实测样例：`...\Temp\...\Sample.JSON` → `c:\users\lenovo\appdata\local\temp\...\sample.json` → 端口 `42427`。

## 三、实验结果（11 项 × 5 次，全部通过）

| # | 实验 | 结果（5/5） |
|---|---|---|
| 1 | 两个独立 bind 同端口 | 第一个成功，第二个 **EADDRINUSE** |
| 2 | 持锁期间第二个进入 | 第二个 **超时失败**，计数 0 |
| 3 | 正常退出后第二个取得 | 第二个成功，计数 1 |
| 4 | SIGKILL 后恢复 | 恢复进程 ok=2，计数 3 |
| 5 | 持锁期间超时 | failed=1、ok=0、**不写入** |
| 6 | 不同文件 | 端口不同（42247 / 42014），并发耗时 416–421ms（并行） |
| 7 | 映射碰撞 | 同端口，耗时 732–762ms（**安全串行**，不选备用端口） |
| 8 | 无关程序占端口 | **EPORTLOCK:EADDRINUSE**，不写 |
| 9 | 两进程并发读改写 | 50+50 → **100/100** |
| 10 | 临界区内 SIGKILL | 文件可解析、count=1、恢复成功 |
| 11 | 资源关闭 | 各场景后端口均可重新 bind |

完整数据：`scripts/experiments/d11a-port-lock/result.json`（可复跑 `node scripts/experiments/d11a-port-lock/run.mjs`）。

## 四、Windows 绑定语义（实测）

- Node `listen({ port, host: '127.0.0.1', exclusive: true })` 在 Windows 上由 libuv 使用 **SO_EXCLUSIVEADDRUSE** 语义；
- 两个独立进程竞争：第二个返回 **`EADDRINUSE`**；
- 无关程序（另一进程）先占：MemoryStore 锁侧同样 `EADDRINUSE`，**fail-closed**；
- 未设置 `SO_REUSEADDR`；`exclusive: true` 只是显式声明，**不以此宣称原生独占**——上面的竞争实验才是证据；
- 强制终止（SIGKILL）后端口由 OS 释放，下一进程可立即 bind（实验 4/11）。

## 五、端口安全与部署检查

| 项 | 结论 |
|---|---|
| 仅绑定 127.0.0.1 | ✅ 代码固定；不监听 0.0.0.0 |
| 不提供网络服务 | ✅ 连接即 destroy |
| 与现有服务冲突 | ✅ 42000–42999 避开 3210 / 3000 / 3001 / 6099 / 8899（已删）/ DSH 56505 |
| Windows 动态端口 | ✅ 动态范围通常 49152+，本方案不占用 |
| 普通用户 vs 管理员 | ⚠️ 高端口无需特权；**管理员/服务账户未单独实测** |
| Electron 开发/打包路径 | ✅ 映射基于绝对路径 + realpath；同一 DATA_DIR 下一致；**打包环境未实测** |
| 端口被抢占 | ✅ fail-closed（实验 8） |
| 正常/异常退出释放 | ✅ 正常 close、SIGKILL 均由 OS 释放（实验 3/4/11） |

## 六、已知限制

1. **1000 个端口**：文件数增多时碰撞率上升 → 额外串行（安全，但吞吐下降）。
2. **每次写 bind/unbind 开销**（约 1–2ms）：MemoryStore 写是短操作，可接受；同进程高频写需进程内队列优化。
3. **端口被无关程序长期占用** → 该文件永久 fail-closed；需要告警/人工处理，**不能动态换端口**（否则同文件不同进程可能不同端口 → 双持）。
4. **路径规范化依赖 realpath**：符号链接/大小写/短名必须先解析；不同挂载点可能映射不同（同一 DATA_DIR 下不会）。
5. **未验证**：企业防火墙/安全软件对 loopback bind 的拦截、管理员/服务账户差异、Electron 打包实测、多机（本方案只保证单机）。
6. **端口占用可见性**：`netstat` 能看到 42000–42999 的短暂监听（正常）。

## 七、是否建议进入 D1-1B

**是。** 满足全部验收标准：

- 同一文件多进程只有一个进入；
- 正常退出与强制终止都能恢复；
- 失败/超时不写；
- 不同文件不意外双持（碰撞时安全串行）；
- 无关程序占端口不误判；
- Windows 绑定语义有实测错误码；
- 不依赖 PID 过期/rename 认领/陈旧锁回收。

D1-1B 接入设计（下一批）：`src/memory-port-lock.js` 提供 `withMemoryPortLock(file, fn, { timeoutMs, retryMs })`，`memory.js` 的 `writeJson` 包锁；失败抛 `EMEMORY_LOCK_TIMEOUT` 不写；进程内同文件队列优化；补并发/超时/崩溃测试。

## 八、本次未做

- 未修改 memory.js / file-lock.js；
- 未接 MemoryStore；
- 未安装依赖；
- 未碰生产 data。
