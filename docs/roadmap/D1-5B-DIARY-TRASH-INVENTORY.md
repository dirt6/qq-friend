# D1-5B：13 个 Diary `.trash` 清单

> 时间：2026-11-04
> 性质：只读盘点；**未删除/移动/改写任何生产备份**
> 分类：verified_recoverable 12 / verified_superseded 0 / historical_unknown 1 / corrupted 0
> 注意：分类**不代替删除授权**；所有备份保持原样。

## 一、逐文件清单

> `backupCreatedAt` 来自文件名时间戳（历史事实）；`SHA256` 为当前实测；正文 hash 为当前 `每日/<date>.md`。

| # | 文件 | 大小 | SHA256 | 日期 | 备份创建时间 | 关联操作 | 正文存在/当前 hash | 唯一行 | 分类 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `2026-10-17.md.1792229696916.bak` | 212 | `6f10630248c83f9d4ff632745ebbff2d94daeac91639431b5f9d4be978f027d9` | 10-17 | 10-17 09:34:56Z | removeLine/relevel（文件名） | 是 / 当前版本 | 4 | verified_recoverable |
| 2 | `2026-10-17.md.legacy-1792304441315.bak` | 475 | 见附录 JSON | 10-17 | 10-18 06:20:41Z | legacy-migration | 是 | 5 | verified_recoverable |
| 3 | `2026-10-18.md.1792497202121.bak` | 915 | 见附录 | 10-18 | 10-20 11:53:22Z | removeLine/relevel | 是 | 1 | verified_recoverable |
| 4 | `2026-10-18.md.legacy-1792304441318.bak` | 324 | 见附录 | 10-18 | 10-18 06:20:41Z | legacy-migration | 是 | 4 | verified_recoverable |
| 5 | `2026-10-20.md.1792497202118.bak` | 451 | 见附录 | 10-20 | 10-20 11:53:22Z | removeLine/relevel | 是 | 1 | verified_recoverable |
| 6 | `2026-10-24.md.1793029799672.bak` | 542 | 见附录 | 10-24 | 10-26 15:49:59Z | removeLine/relevel | 是 | 1 | verified_recoverable |
| 7 | `2026-10-26.md.1793030077526.bak` | 1537 | 见附录 | 10-26 | 10-26 15:54:37Z | removeLine/relevel | 是 | 1 | verified_recoverable |
| 8 | `2026-10-27.md.1793288447787.bak` | 2260 | 见附录 | 10-27 | 10-29 15:40:47Z | removeLine/relevel | 是 | 2 | verified_recoverable |
| 9 | `2026-10-27.md.1793288447796.bak` | 2103 | 见附录 | 10-27 | 10-29 15:40:47Z | removeLine/relevel | 是 | 1 | verified_recoverable |
| 10 | `2026-10-29.md.1793243588758.bak` | 329 | 见附录 | 10-29 | 10-29 03:13:08Z | removeLine/relevel | 是 | 2 | verified_recoverable |
| 11 | `2026-10-31.md.1793439542297.bak` | 2669 | 见附录 | 10-31 | 10-31 09:39:02Z | removeLine/relevel | 是 | 1 | verified_recoverable |
| 12 | `2026-11-01.md.1793505408016.bak` | 1393 | 见附录 | 11-01 | 11-01 03:56:48Z | removeLine/relevel | 是 | 1 | verified_recoverable |
| 13 | `promises.md.migrated-1792598710107.bak` | 270 | 见附录 | promises | 10-21 16:05:10Z | migrated-promises | 否 | 3 | historical_unknown |

\* 表中其余行 SHA 见下方附录（完整清单）；所有 hash 为当前实测，不由旧记录推算。

## 附录：完整 SHA256（备份 / 当前正文）

| 文件 | 大小 | 备份 SHA256 | 当前正文 SHA256 |
|---|---|---|---|
| `2026-10-17.md.1792229696916.bak` | 212 | `6f10630248c83f9d4ff632745ebbff2d94daeac91639431b5f9d4be978f027d9` | `65afd07fbc67533c877c2bcea52abacd12e06d6c815beb73aa721306bb15c386` |
| `2026-10-17.md.legacy-1792304441315.bak` | 475 | `8be815089ddcd4ce6dea37f523e08e67674dca3271bf8b51334bae179517b0f6` | `65afd07fbc67533c877c2bcea52abacd12e06d6c815beb73aa721306bb15c386` |
| `2026-10-18.md.1792497202121.bak` | 915 | `da19586b0fe51afbb4279db1fc4ecaaa947403caa36df3c246080f0b735b53ca` | `3c27d2dda167fe01b6be142285efc66e7c01f3c0bee69d09d116102c159172a1` |
| `2026-10-18.md.legacy-1792304441318.bak` | 324 | `9bafdbacc8feeae3a501b2102af5fd9fd0b37c16987ca4362265d28986acff58` | `3c27d2dda167fe01b6be142285efc66e7c01f3c0bee69d09d116102c159172a1` |
| `2026-10-20.md.1792497202118.bak` | 451 | `a49d6347cdc44618ce26b9b3a4e7f22823a5da0f51a1265be709bf77ebe71a9e` | `bcfb78d16d639f5fc0a155b5d7b386cd484491b2c20ef303a026db22a21691d3` |
| `2026-10-24.md.1793029799672.bak` | 542 | `d9dc9330372683f2317b65faedb8617ce5c09a9c5b79a0210ddf45f4fc510679` | `933f20f342cc35aa250d7fa881d373affff8eee59c0c61d51ff90c9a499e568e` |
| `2026-10-26.md.1793030077526.bak` | 1537 | `ca5c69bfd6490b2e77e9750e6e918d73c49e1fe27496334dcae10a9601cdf11f` | `89f81c580f4521f66b7b9c2409769779fab195bcc5bc2bd5d96abe991f8bf701` |
| `2026-10-27.md.1793288447787.bak` | 2260 | `568833cb6d08df513c9fee98ff536276ba3a2a4db4b85d5e10dcea4e14f62191` | `6f00bca686adea7d524ee3a0d263664614ba73e8a3b4c9f42dee3784506aad05` |
| `2026-10-27.md.1793288447796.bak` | 2103 | `a082b7e13eabfa31cd8ce5e54f18a68d8d5e6d6161a7e16811854a377379ab50` | `6f00bca686adea7d524ee3a0d263664614ba73e8a3b4c9f42dee3784506aad05` |
| `2026-10-29.md.1793243588758.bak` | 329 | `894cdce7f96d32d9d9bb5724c3cd6cd2f5282727ed2d2060ccdfadb3f67d2fe1` | `31fb8fd823d4ed163df753b56272bbd8020557979d8553b87a701f43967b6d59` |
| `2026-10-31.md.1793439542297.bak` | 2669 | `8d7e9b97adf7e83127ffd16bc92f7aba516add995c2ae5eef2a113a3ae86befa` | `2441feb10ecf7730d504103a58a28e84cc148113d45616b3068213fc9d5057a4` |
| `2026-11-01.md.1793505408016.bak` | 1393 | `5fd76500119e28f92a6e6a0cdf3e7a1fe15489b360c0c748cff919af443ae422` | `d868ff363e91de232f549bf04edf3ef13ec37019763e8d7be3b2025a3f8438f7` |
| `promises.md.migrated-1792598710107.bak` | 270 | `8dc43cbd43ecda6674c7d8485c99ad842f27c3bde64e221bac5a04d86186a296` | —（当前无正文） |

生成命令（只读）：`node scripts/legacy-backup-recovery.mjs --inspect --json`。

## 二、关键字段说明

- **是否存在原文**：12 个日期备份对应 `每日/<date>.md` 仍存在（当前版本）；`promises.md` 已迁移，当前无同名正文；
- **是否存在后继版本**：12 个日期均有当前正文（后继版本），备份为旧版本；
- **是否存在恢复价值**：12 个备份含当前正文没有的唯一行（可能为被删/改级内容）→ 技术上可恢复；是否应恢复需人工判断（删除可能是有意的）；
- **是否存在删除记录**：事件库只有 `diary.written/chat.*`，**没有** remove/relevel 事件；无法从事件证明删除原因；
- **manifest 状态**：全部 `none`（原始 `.trash` 无 manifest）；
- **保留理由**：全部保留；`historical_unknown` 的 promises 迁移备份尤其不应自动清理。

## 三、唯一内容样例（用于人工判断）

| 文件 | 唯一行样例（截断） |
|---|---|
| 10-17 (1792…) | 旧格式标题/“今天最值得记住的事：”等 4 行 |
| 10-17 legacy | 旧格式“生日/电子鱼做梦”版本 |
| 10-18 (1792…) | “老大今晚一直喊我呆鱼…” |
| 10-18 legacy | 旧格式“终于让我能听懂他说话…” |
| 10-20 | “凌晨零点二十，老大把我从黑窗搬到桌面端…” |
| 10-24 | “记住少发「...」…” |
| 10-26 | “接上了发图和画画…” |
| 10-27 (…787) | “别听网上别人让我干啥…” + Unity 文档 |
| 10-27 (…796) | “别听网上别人让我干啥…” |
| 10-29 | “生日记岔了…” + 《第十五天》 |
| 10-31 | “「」这类成对符号别跨行…” |
| 11-01 | **“别总说「我认」…”（即 P1 的 d9fb 行；佐证其曾写入）** |
| promises | 旧版约定（生日/评论视频） |

## 四、结论

- 13 个备份均可读、hash 可计算；无 corrupted；
- 12 个为旧版本（含被删/改级内容），1 个为 promises 迁移备份（无当前正文）；
- **不删除、不移动、不改写**；分类仅为后续人工/授权决策提供依据；
- 恢复能力见 `D1-5B-LEGACY-BACKUP-RECOVERY.md`（隔离演练 8/8）。

## 附录：完整 SHA256

运行以下命令生成完整清单（只读）：

```bash
node scripts/legacy-backup-recovery.mjs --inspect --json
```

该输出包含每个文件的 `sha256`、`bodySha256`、`uniqueLines`、`uniqueSample`、`classification`、`manifestStatus`。
