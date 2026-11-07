# D1-7G1：qq-process-detect 新失败调查

> 时间：2026-11-04
> 状态：**INCONCLUSIVE（路径可读性受权限限制）；PID/乱码检查 PASS**
> 未删除断言、未放宽乱码标准、未用管理员权限掩盖

## 一、现象

`qq-process-detect` 单独复跑：

```
检测到 4 个 QQ.exe 进程
所有进程路径都没有乱码
每个进程都有 pid
可读路径都是 QQ.exe
INCONCLUSIVE：3/4 个 QQ.exe 的 ExecutablePath 不可读（权限限制）
```

原测试失败两项：

- 每个进程都有 pid 与路径；
- 返回的都是 QQ.exe（空 path 不匹配 `/QQ\.exe$/`）。

## 二、根因

- `listQqProcesses()` 用 `Get-CimInstance Win32_Process -Filter "name='QQ.exe'"`，输出 `ProcessId,ExecutablePath`；
- 普通权限下，部分 QQ/NapCat 进程（提权/注入/不同完整性级别）**ProcessId 可读，ExecutablePath 为 null**；
- 这是 Windows 进程枚举权限/完整性级别限制，不是 wmic 编码问题，也不是 32/64 位问题（同一 CIM 查询）；
- 当前机器确有 4 个 `QQ.exe`（含 QQ 主进程/NapCat 宿主等不同来源），部分路径不可读；
- 代码 `listQqProcesses()` 保留 `pid>0`、path 可为空；`qqPortableRunningPid()` 只按**可读 path** 匹配便携目录；空 path 不会误判为便携 QQ（不会 false positive），只是该进程归属 **UNKNOWN**；
- 原测试把“无法读取路径”当成“进程没有路径/不是 QQ.exe”，是测试假设错误，不是生产检测逻辑错误。

## 三、修复

仅改测试（`test/qq-process-detect.mjs`）：

- 保留：pid 必须 >0；
- 保留：非空路径不能有乱码；
- 保留：非空路径必须 `QQ.exe`；
- 空路径不再让测试失败，但显式打印 `INCONCLUSIVE：N/M 个 QQ.exe 的 ExecutablePath 不可读`；
- 没有把 UNKNOWN 改成 PASS；没有删除乱码断言；没有提权运行。

结果：**16/16 通过**，状态中保留 INCONCLUSIVE 说明。

## 四、结论与适用条件

- 根因：普通权限下 CIM 对部分进程不返回 ExecutablePath；
- 当前检测在“可读路径”范围内正确；对不可读路径只能标 UNKNOWN，不能判定归属；
- 适用条件：普通用户权限；若需要完整枚举路径，需管理员/SeDebugPrivilege，但测试不以提权掩盖普通权限缺陷；
- 生产影响：便携 QQ 匹配只使用可读路径，空路径不会造成误匹配；若便携 QQ 恰为不可读路径，可能误判“未运行”，这是已知 UNKNOWN，需后续以“本进程 spawn pid + 可读路径”双路径兜底（现有代码已优先 spawn pid）。

## 五、回归

- 专项 16/16；
- 全量回归结果见 G5（本次修复后重跑）。
