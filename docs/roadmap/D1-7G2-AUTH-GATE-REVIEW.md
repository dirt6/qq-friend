# D1-7G2：重启执行器授权闸门审查

> 时间：2026-11-04
> 对象：`scripts/d1-7f-restart.mjs`
> 结论：**闸门 PASS（fail-closed）**；当前身份 UNKNOWN，执行仍拒绝

## 一、审查发现（修复前）

| 问题 | 风险 |
|---|---|
| marker 只绑 HEAD/PID/startTime/expiry | 配置变化、动作替换未绑定 |
| 无 action 字段 | restart/force 可能混用 |
| 无 configSha256 | 配置被改后仍可执行 |
| 无 nonce/一次性账本 | marker 可复制重放 |
| 无 issuedAt | 可提前签发/长期有效 |
| 执行前虽重跑 preflight | 但上述字段未重验 |
| 失败时只输出 stdout | 无持久审计记录 |

## 二、修复

- marker 必须包含：
  - `scope=restart-production`
  - `action`（`restart`/`force`，与 `--action` 一致）
  - `authorizedBy`
  - `targetHead`（40/短 HEAD 精确匹配）
  - `pid` + `startTime`
  - `configSha256`
  - `nonce`（≥16 字符）
  - `issuedAt` ≤ now < `expiresAt`
- 执行前重新运行 preflight，逐项比对；变化即 fail-closed；
- `--marker-state <file>`：一次性消费 nonce，重放拒绝；
- 工作区不干净、身份 UNKNOWN、hash 基线不一致、缺少 marker state → 拒绝；
- 不创建 marker；不按进程名批量 kill；不自动结束 NapCat；
- `--execute` 当前仍拒绝：身份 Path/CommandLine 不可读，且无程序化托盘退出。

## 三、专项测试

`test/d1-7f-tools-test.mjs` **19/19**：

- 身份四要素；缺 Path/CommandLine → unverified；
- scope/action/targetHead/pid/startTime/configSha256/nonce/issuedAt/过期全部拒绝；
- 完整匹配通过；
- nonce 首次消费成功、重放拒绝、不同 nonce 可消费；
- 数据基线一致/不一致；
- 实测 `--execute` 无 marker：blocked，未执行任何进程操作。

## 四、剩余风险

1. marker 文件本身的权限/来源未由脚本强制（需文件系统 ACL/机主保管）；
2. `--marker-state` 由调用方指定，必须放在受控路径；脚本不默认写生产；
3. 强制停止路径未启用；正常重启仍需机主托盘退出；
4. 无持久审计文件（当前 stdout；执行时可由外部重定向保存）；
5. 身份不可读时永远拒绝，这是设计而非缺陷。

## 五、结论

**授权闸门 PASS**；执行能力仍 BLOCKED（身份 UNKNOWN）。符合“不能因为授权就跳过身份校验”的要求。
