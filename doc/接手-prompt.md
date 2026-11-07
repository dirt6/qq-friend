# 接手任务：维护 Windows 11 上的 QQ 伙伴机器人 QQ Agent v0.4.0

> 版本：**第 11 版**（2026-10-25 16:20）。旧版（v2–v8）已按机主要求删除，只保留这一份；
> 每次大改直接改本文，不再另存副本（git 里能看历史）。
> **新对话请优先看 `doc/接手卡-2026-10-28.md`**（精简版：现状 / 启动顺序 / 这三天的改动 / 坑 / 待办），
> 这份长文档用来查细节。（原 `doc/新对话启动卡.md` 已于 2026-10-28 删除，内容被接手卡取代。）
> 第 11 版更新（2026-10-24 ~ 10-25）：
> - **她真的能操作 B 站和小黑盒了**：B 站评论/楼中楼/@ 全通（Cookie 导入）；小黑盒因为 web 端被账号资质挡住，改走**真机**——发评论、@ 人（`KEYCODE_AT` 弹选人）、回收件箱楼中楼（OCR + 坐标）、发帖（纯文字 + 分区/话题）。
> - **她能看图了**：帖子图片下载到 `data/social-images`，手机截图走 `qq_phone(see:true)`，她 `read_image` 直接理解画面（实测准确）；你的表情包也通过 `image-cache` 路径透传给她了。
> - **她能发图了**：新工具 `qq_send_image`（本机图片 → base64 → QQ），目录白名单四个。
> - **DSH 会话锁冲突根治**：给网关独立 `DSH_HOME`（`data\dsh-home`），桌面端再怎么开都不抢她的会话。这是「DSH 又没接管」的第三个变种。
> - **拆条修正**：她习惯用空格断句不写句号，`splitForChat` 加了空格兜底（保护引号内空格）。
> - **她会画画了**（2026-10-25）：第 13 个工具 `qq_draw`。这台机器没有出图模型（只有一个 DeepSeek 文本 key，也没装 ComfyUI/SD），所以不是文生图，而是**几何图形 + 画风层**拼：`scripts/draw/render.py`（Pillow）渲染，四种画风 `crayon`（默认，线条抖/纸纹/整体微歪，文字不参与风格化）/ `picturebook` / `flat` / `pixel`。图存 `data/drawings/`，标题/风格/来源记 `index.json`；画廊 `http://127.0.0.1:3210/gallery.html`（看大图、筛来源、删除、打开文件夹），后端是 `src/draw.js`（渲染+归档，工具和自主活动共用）。空闲时自主活动也会画：planner 新增 `draw` 动作 + 四种构图模板（night/cat/flower/sky），受安静时段与每轮分享额度约束。
> - 新坑记到 60。

> 第 10 版更新（2026-10-24）：
> - **她可以自己浏览 B 站和小黑盒了**：新的统一层 `plugins/autonomous/lib/social/`（`browse.js` 搜索+详情+评论，`bili-write.js` / `xhh-write.js` 写操作）。DSH 里对应两个新工具：`qq_browse`（搜、看详情，够她总结标题/简介/评论）和 `qq_comment`（发评论、回复楼中楼、@ 人）。
> - **手机能点进小黑盒的帖子了**：`qq_phone` 加了 `open` / `keyword` 参数，走 `phone_eye.py open`，读完整正文和评论区（仍然只读，不点赞不评论）。
> - **B 站评论要 Cookie**：新增 `scripts/bili-import.mjs`，导入 `SESSDATA` + `bili_jct` 到 `data/bili-auth.json`。没导入时读接口照常可用，只有写操作会明确说「还没导入登录态」。
> - **小黑盒评论暂时发不出去**：接口和签名全对（参数必须走 query、`_rnd=15:` 必填但值随意），但服务端稳定返回「评论功能暂不可用」。根因是**账号侧社区权限**（`bbs_basic_permission=0`），不是代码问题。
> - **删掉了 20 个调试遗留的 DSH 会话**（10-23 调网关/插件时留在「未分组」里的那批），保留她当前会话 `d09bc427`。
> - 新坑记到 48。

> 第 5 版更新：DSH 迁到官方桌面端（端口不固定）、API Key 轮换、自查脚本改带值匹配。
> 第 6 版更新：新增**自主活动**（定时自己醒来翻 B 站/小黑盒、决定分享或聊天、写日记）、**小黑盒只读接入**（网页 Cookie 导入）、**日记三级分类与约定并入**、**每天 11:00/23:00 自动回顾**、分享切 live。并记下 8 个新坑。
> 第 7 版更新：**AIPhone 手机采集接进来了**（她可以「看一眼」手机屏幕，只剩只读）、**小黑盒卡片改成坐标分槽**（修掉「标签被当成标题」）、**B 站双列只分列不硬切**、**自主活动有了独立 token 账本**（日 12 次 / 月 5 元封顶）。另外记下 4 个新坑，其中「移动目录后沙箱写不进去」最费时间。
> 第 8 版更新：**她的对话已经改由 DSH 接管**（`dsh headless` 网关 + `personaPrefix` 人格注入 + Cordis 插件补 QQ 工具），**记忆库从 10-15 那次 wipe 里恢复**，日记改由 DSH 直接读写。现在私聊是「DSH 的大脑 + QQ Agent 的手」；群聊仍走旧路径。记下 5 个新坑，其中「机器人进程写不了 `~/.dsh`」最耗时间（表现为静默回落、看不出错）。
> 第 9 版更新（2026-10-23 晚）：
> - **自主活动改成每 3 小时**（原 4 小时），来源加**手机**（只读看屏幕），分享仍 live；token 限制不变（单次 4000 输入 / 日 12 次 / 月 5 元）。
> - **修好手机链路**：u2 引擎启动 App 必须传**包名**（原来传 `xiaoheihe` 导致停在桌面），锁屏会**自动唤醒 + 上滑解锁**，u2 也给出粗卡片；B 站包名 `tv.danmaku.bili`。
> - **修掉自主活动 HTTP 400**（`unexpected end of hex escape`）：详情文本按 UTF-16 切 emoji 会留孤立代理，现在 `safeSlice` + 发送前 `sanitizeForMessages` 双保险。
> - **修掉日记重复前缀**（`心情：好笑｜心情：好笑｜…`）：`qq_diary` / diary 技能 / 自主活动三处都先剥前缀。
> - **DSH 网关补了落盘日志** `data\dsh-gateway.log`，并且给 `~/.dsh` 的 sessions/storages 等目录补了 Low 完整性标签（原来只有 profiles/headless 补过）。
> - **她主动说的话会回灌进 DSH 上下文**（autonomous 分享不经过 DSH，之前她会忘了自己刚说过什么）；`phone_eye__look` 明确「默认小黑盒、B 站要显式传 app」；`qq_tool` 补上 `send_poke`（之前她说「拍你了」只是嘴上说说）。坑记到 43。
> 维护约定：以后每次大改直接改本文；改动点写在上面这段「第 N 版更新」里。

## 0. 怎么用这份 prompt

把**从第一节开始的整段**复制给新对话。新对话里你会是"接手人"，请先做**第九节：确认现状**（只读），把结果报给用户，再听指令。

---

# 一、环境与硬约束（都是实测撞出来的，别重走）

- 机器：Windows 11。工作目录 `E:\dsh`，QQ Agent 在 `E:\dsh\QQ-agent`（源码 + 运行数据都在这里）。**AIPhone 手机采集项目在 `E:\dsh\AIPhone`**（2026-10-22 晚从 `E:\AIPhone` 移进来，脚本里的路径已经改成相对自身 `__file__`）。
- **移动目录会把沙箱权限弄丢**（坑 24）：DSH 的文件沙箱要求工作区里的对象带 **Low Mandatory Level** 完整性标签，从盘位外用 Explorer 拖进来的目录**不继承**这个标签，表现是「目录明明在、ACL 看着也有写权限，但一写就 Access denied」。CLI 里 `adb pull` 更迷惑，报的是 `cannot create ... No such file or directory`。修法是给目录补 `(OI)(CI)Low` 标签 + 补当前用户 FullControl，两者缺一不可（只补 ACL 不够，只补标签会因为缺 WRITE_OWNER 而失败）。
- 用户通过 **DSH 桌面端**操作（`C:\Users\lenovo\AppData\Local\Programs\DeepSeek Harness`，profile `~\.dsh\profiles\desktop`）。**GUI 端口每次启动都不同**，以运行时给的 URL 为准，别写死。旧 Web（3080）已停用，要回退跑 `E:\dsh\open-deepseek-harness.ps1`；迁移见 `E:\dsh\DSH-迁移报告.md`。
- **沙箱能力边界**：
  - 普通 shell 是**低完整性**：`tasklist` 看不到别的进程、`Get-CimInstance Win32_Process` 常 Access denied、`curl`(schannel) 不可用。
  - **会话不是管理员**；`sandbox_permissions: danger-full-access` 只解除文件沙箱/进程回收，**不给管理员令牌**。
  - **受限 shell 里 Node 不能 spawn 子进程**（EPERM）。所以需要 Python 生成图片时，**拆成两段**：Node 写文件 → `pwsh` 单独调 python，别在 Node 里 `execFileSync`。
  - **`pip install` 在本机沙箱会失败**（临时目录 `Permission denied`）。要装纯 Python 包就**手动下 wheel 解压**到 `data/pylibs`（见 4.2 二维码）。
  - **bash 运行时偶尔起不来**（`CreateFileMapping ... Win32 error 5`），换 `pwsh`。
  - **`Start-Process -FilePath xxx.bat` 会挂住**；用 `cmd /c start "" ...`。
  - **explorer 代启机器人有时静默失败**：改用 `Start-Process electron.exe "E:\dsh\QQ-agent" --no-sandbox`（需 danger）。
  - 杀 QQ 需要管理员；提权脚本里循环 `taskkill` 直到为空再注入。
- 网络：Node **不读系统代理**；直连 `cn.bing.com` / `api.deepseek.com` / `api.bilibili.com` 正常；github.com 直连被重置，GitHub API 可用，下载用 `https://gh-proxy.com/` 前缀。
- **改配置一律用 Node 脚本**：PowerShell 读含中文 JSON 会乱码、`Set-Content -Encoding UTF8` 会写 BOM 让 `JSON.parse` 炸。
- **含中文的 `.ps1` 必须补 UTF-8 BOM**；`edit`/`write` 写出来没有 BOM。**含中文的 `.bat` 一律不要写**——cmd 按 GBK 解析会乱码、把命令拆碎（实测过一次，整个 bat 崩掉）。
- **临时脚本写在 `E:\dsh` 下时，`import` 相对路径是相对 `E:\dsh`**，不是相对 `QQ-agent`。写 `./QQ-agent/...`，否则报 `ERR_MODULE_NOT_FOUND`（这个坑踩了三次）。
- **PowerShell 内联 `node -e "..."` 里不要写中文全角括号/引号**；中文多的逻辑直接落成 `.mjs`。

# 二、系统架构

- **协议端**：NapCat v4.18.37，`E:\dsh\QQ-agent\napcat\shell`。OneBot HTTP `127.0.0.1:3000`、WS `127.0.0.1:3001`、WebUI `http://127.0.0.1:6099/webui/`。令牌在 `data\config.json` 的 `snowluma` 块。
- **登录的 QQ**：`D:\NTQQ\QQ.exe`，版本 9.9.36-53644（不能降级）。机器人账号 **2029382488**（昵称「！？哦鲸鲸？！」）。
- **核心**：`127.0.0.1:3210`；**控制面板**：`127.0.0.1:8899`（`scripts/web-panel-server.mjs` 生成）。
- **机主 QQ**：**1846383180**（别和 `1846386180` 搞混）。
- **白名单**：以 `config.allow` 为准，本快照 `groups: []`、`private: ["1846383180"]`。
- **语音转文字**：`plugins/speech-to-text` + whisper.cpp（`E:\dsh\whisper`，ggml-small）+ opencc 转简。**不要加 `--prompt`**。
- **听歌**：`skills/now-playing` 读 SMTC，优先 QQ 音乐。网易云 3.1.40 禁了 MediaSessionService，读不到。
- **相册**：`skills/gallery`，数据在 `E:\dsh\相册\`。
- **日记**：`skills/diary`，根目录 `E:\dsh\日记\`，每日文件在 `每日\YYYY-MM-DD.md`。**约定和愿望也写进日记**（见 4.3），根层只有 `core_profile.md` 和 `.trash\`。
- **自主活动**：`plugins/autonomous`，每 **3 小时**醒一次，读 B 站排行榜 + 小黑盒推荐流 + **借来的手机屏幕（只读）**，自己决定分享/聊天/写日记。**活动日志** `data\autonomous-log.md`，状态 `data\autonomous.json`。
- **小黑盒**：`plugins/autonomous/lib/xhh/`（`sign.js` 签名 + `client.js` 只读客户端），登录态 `data\xhh-auth.json`。**只读**，没有任何写操作。
- **手机（借来的）**：`skills\phone-eye`（`look` / `status` 两个工具）+ `E:\dsh\AIPhone\phone_eye.py`（adb 截屏 → RapidOCR → `AIPhone\data\parse_cards.py` 坐标分槽；u2 引擎读控件树）。**只读**：能看屏幕，不能点、不能赞、不能评论、不能 @。手机是 vivo T1x / Android 11 / 串号 `3414299520001QP`，平时不连。**息屏会自动唤醒+上滑解锁**，有密码锁则需人工解一次。
- **token 账本**：`plugins\autonomous\lib\usage.js`，存 `data\token-usage.json`。只记自主活动自己发起的调用，和对话用的 `usage-today.json` 分开记——混在一起就看不出「她闲着时花了多少」。

## 启动顺序（不能反）

1. `napcat\启动NapCat-QQ.bat` → **UAC 点「是」**（非提权注入会静默失败）→ 需要时扫二维码。
2. `启动QQ机器人.bat`（内置 `--no-sandbox`）。

> 更省事：先双击桌面「QQ Agent 控制面板」（提权拉起面板），用面板按钮启动。

## 硬约束

- `snowluma.autoLaunch` 必须 `false`（SnowLuma 会抢 3000/3001）。
- **不要跑 `npm run setup`**。
- NapCat ≥ 4.18.37 才支持 QQ 9.9.36。
- **改 `config.json` 必须停机改**：运行时改磁盘会被内存旧值回写覆盖。流程：面板 `bot.stop` → 改 → `bot.start`。
- **面板改代码必须"先关后开"**：双击快捷方式不会重启已在运行的面板。
- **主进程模块有缓存**：改 `plugins/*/index.js` 后热重载能生效，但**改它 import 的子模块（`lib/*`）不会**——子模块走 ESM 缓存。遇到"改了没效果"，重启一次。

# 三、当前运行状态（2026-10-23 22:20 核对；数字一律实读）

| 组件 | 状态 | 说明 |
|---|---|---|
| 机器人（Electron） | **运行中** | 控制台 3210；对话走 DSH（只开了私聊 `private:1846383180`） |
| NapCat / QQ | 运行中 | OneBot 已连（2029382488） |
| 控制面板 | 运行中，8899 | |
| **DSH 后端** | **启用** | `config.dsh.enabled=true`；会话映射在 `data\dsh-sessions.json`；人设走 `personaPrefix`，工具走 `dsh-plugins/qq-tools` |
| 自主活动 | 启用 | 每 **3 小时**一轮；来源 `bili,xhh,phone`；HTTP 400 已修（坑 39） |
| 小黑盒 | 已登录 | uid `21987774`（她自己的号），只读 |
| 日记 | v2.6.1 | 位置 `E:\dsh\日记\每日\`；DSH 通过 `qq_diary` / `qq_diary_read` 直接读写 |
| 手机 | **这次没连** | 只做小黑盒 + B 站；OCR 和 u2 两个引擎都在；能点进帖子看详情（只读） |
| 相册 | **已删除** | `skills/gallery` 在 2026-10-23 移除 |
| **浏览/评论** | **B 站可浏览、评论待 Cookie** | `lib/social/`；`qq_browse` 可用；`qq_comment` 走 B 站要 `data/bili-auth.json`，小黑盒被账号权限挡 |

> 判断「DSH 有没有真的接手」：只看 `data\dsh-sessions.json` 里有没有对应 chatKey。日志里的 `[orchestrator]` 是 `console.log`，**不进日志文件**。

**人设卡 3272 字**不会自己变；`data\autonomous.json` 里有校准系数和最近几轮记录。

# 四、本轮（10-20 ~ 10-22）做了什么

## 4.1 自主活动（`plugins/autonomous`）

一轮的流程：

```
每 3 小时醒来
  ├─ B 站排行榜（前 100 条里取 40 → 去重 → 取 10）
  ├─ 小黑盒推荐流（同样去重）
  ├─ 手机屏幕（在线时；u2 读控件树 → 粗卡片；不在线就跳过）
  └─ 合并 → 模型挑一条 → share（带链接）/ chat（不带链接）/ diary / finish
```

- **调度**：tick 每 5 分钟检查一次（`setTimeout(4h)` 扛不住休眠）；同一天不重复醒来。
- **预算**：单次输入硬上限 8000 tokens（由程序在调用前检查）。超了先减候选（10→6→3→1）、再压摘要（200→120→60→0），压到最少还超就**整轮跳过**。候选为 0 时（比如日记回顾）也要走降级，别直接判失败。
- **来源**：`lib/sources.js`，B 站用公开 JSON 接口（`ranking/v2`、`popular`），小黑盒用 `lib/xhh/client.js`，手机用 `phone_eye.py look --engine u2`（只读）。**单个来源失败隔离**，不影响另一个；手机不在线就当这个来源不存在。
- **安全过滤**：成人/赌博/诈骗等关键词在来源层就滤掉（第一轮就拦下一条成人科普）。
- **分享**：`shareMode`（`dryRun`/`live`）、安静时段 `quietRange`（默认 23:30–08:00）、每轮最多 2 条。发送优先走核心 `chat.send` 能力，没有就**OneBot HTTP 直发兜底**。
- **发送后必须补记聊天记录**：`store.appendSelf(chatKey, {text, ts})`。不补的话下一轮她看不见自己说过什么（今早"边缘行者"就是这么丢的）。
- **活动日志**：`data\autonomous-log.md`，最新在最上面，记来源/翻了哪些/想干什么/为什么挑/决定/说给你听/下次想接着干嘛。保留最近 120 轮。

## 4.2 小黑盒只读接入

- **登录**：扫码接口是通的（`/account/get_qrcode_url/` + `/qr_state/`），但**App 点确认后服务端一直停在 `ready`**（换了账号也一样，怀疑 App 端确认没发出去）。最后走**网页登录 + 导入 Cookie**：登录 `www.xiaoheihe.cn`，F12 → Application → Cookies，复制 `user_pkey`、`user_heybox_id` 到 `data\xhh-cookie.txt`，跑 `node scripts/xhh-import.mjs`。
- **签名**：`lib/xhh/sign.js`，hkey 算法从 astrbot 适配器（MIT）移植，用 Python 参考实现生成的 4 组向量锁死（`test/xhh-sign-test.mjs`）。GF(2^8) 乘法溢出必须 `& 255`，否则前缀对、后缀全错。
- **接口**（详见 `doc\小黑盒接口笔记.md`）：搜索 `/bbs/app/api/general/search/v1`（`search_type` 只能 `link`/`user`，传 `post` 返回 0 条）、推荐流 `/bbs/app/feeds`、帖子 `/bbs/app/link/tree`、通知 `/bbs/app/user/message`、身份 `/bbs/app/api/user/permission`（**成功返回权限字典，没有 `status:ok`**）。
- **@ 结构**：`userid_b` 就是被 @ 的人，直接和 uid 比，不用解析 HTML。`linkid` 是 32 位十六进制，不是纯数字。
- **写操作一个都没做**：没有评论、没有发帖、没有 @。要做得先解 `_rnd=15:<签名>`，还要幂等表 + 草稿审核。

## 4.3 日记改版（`skills/diary` v2.6.x）

- **三级分类**：`一般`（默认，不加标记）/ `重要`（`[重要]`）/ `非常重要`（`[非常重要]`）。判据：有明确后续行动才算重要；只因为有趣/感人不足以判重要。
- **约定和愿望并入日记**：`kind=promise/wish` 直接写当天日记，固定 `[非常重要]`，正文前缀「约定：」「愿望：」。**不再生成 `promises.md` / `wishlist.md`**，旧文件已迁移并备份到 `.trash\`。
- **取消字数上限**（原 500 字），只留 8000 字异常保护。
- **重复合并**：同一件事写第二遍时，前 14 字相同即判定重复（比较前会去掉「约定：/愿望：」前缀），新内容更完整就替换旧行。
- **定时回顾**：每天 `11:00` 和 `23:00`（`diaryReviewTimes`）读当天最近 40 条聊天 + 最近两天日记，判断有没有值得记的。同一天同一时间点只跑一次，状态记在 `autonomous.json` 的 `diaryReview`。

## 4.4 分享切 live

`shareMode` 已从 `dryRun` 改成 `live`，真实发送验证过一次（`shares` 里有记录）。**安静时段内只记录不发送**。

## 4.5 时间感（`src/prompt.js`）

系统提示里加了一条：「你会留意时间：现在几点、今天周几、他上一次说话是多久之前。但不要报时、不要显得在盯时间」。**没有**单独罗列「距上次发言 N 分钟」——原设计有意删掉（会助长汇报式开场）。

## 4.6 删掉的东西

- **发语音技能已整体删除**（`voice-reply` + piper + 试听脚本 + `data/voice-out`）。别再提"她也能发语音"——现在只有语音转文字（听），没有语音合成（说）。

## 4.7 手机接入（`skills/phone-eye` + `AIPhone/phone_eye.py`）

老大把旧手机（vivo T1x）**借给她**用，只读。链路：

```
phone_eye__look(app)
  └─ adb screencap → pull → RapidOCR → parse_cards.py 按坐标分槽 → 一段人话
```

- **ADB 不在 PATH 里**（DSH 进程是旧 PATH 快照）。`phone_eye.py` 自己找：环境变量 `AIPHONE_ADB` → `which adb` → winget 里的 **scrcpy** 包目录（`...\Genymobile.scrcpy_*\scrcpy-win64*\adb.exe`）。找不到才退回裸 `adb`。
- **u2 启动 App 必须传包名**（坑 40）：`device.app_start("xiaoheihe")` 会静默失败、停在桌面，于是她只会看到「计算器/相册/哔哩哔哩」这些图标，然后说「手机用不了」。`PACKAGES` 现在有 `xiaoheihe=com.max.xiaoheihe`、`bilibili=tv.danmaku.bili`。
- **息屏会自动解锁**（坑 41）：`ensure_unlocked()` 先 `KEYCODE_WAKEUP`，再 `wm dismiss-keyguard`，还不行就上滑；有密码/图案锁则返回「手机还锁着」，别当成脚本坏了。
- **u2 现在也返回粗卡片**：按 y 间距聚类，每组第一行长文本当标题，其余拼进 `desc`；没有 OCR 那么准，但够她挑一条。
- **引擎有两个**：默认 `u2`（uiautomator2 读控件树），`--engine ocr` 才是老的截图+OCR。u2 快 10 倍、正文不截断、没有错字，**优先用它**；OCR 只在 atx-agent 起不来时兜底（代码里会自动降级）。
- `open` 靠 `data\last-look.json` 里记的坐标点（OCR 引擎）或按文字定位（u2 引擎）——**ocr 引擎必须先 `look` 一次**。点完会自动按两次返回键退回列表，否则下次 `look` 看到的是详情页、坐标也会被覆盖。
- **滚动采集**：`look --scroll N` 滚 N 屏、每屏取一次，最后合并去重。实测滚 2 屏能从 2 条看到 6 条。**只有最后一屏的卡片带可点坐标**——前面的屏已经滚走了，拿旧坐标会点错东西。
- **u2 的额外好处**：评论按钮能按文字找到（小黑盒叫「参与讨论」，不是「评论」）；`set_text` 直接支持中文，**不需要 ADBKeyboard**——这是将来做写操作的前提。
- `--no-launch` 可以只看当前屏幕、不切前台；默认会 `launch` 把 App 切到前台。
- 截图/OCR 落在 `AIPhone\screenshots` 和 `AIPhone\ocr\results`；解析器是 `AIPhone\data\parse_cards.py`。
- **手机平时不连着**，所以任何依赖手机的来源都要能优雅失败，不能当成日常主力。

## 4.8 自主活动的限制（只留硬指标）

- **单次输入硬上限 4000 tokens**（裁剪目标 3400）、**每日主动调用 ≤12 次**、**每月 ≤5 元**。改限额动 `config.skills.autonomous` / `plugin.json` 的 settings，别改代码。
- 记账点只有 `callModel()` 一处；闸门在 `runSession` 拿到候选之后、`runDiaryReview` 调用之前。到顶就 `finish(原因)`，不调模型。
- 没新内容时在闸门之前就 return，不花 token。费用按配置单价算，不写死价格。
- 账本 `data\token-usage.json`（按天，保留 90 天），和对话用的 `usage-today.json` 分开记。

## 4.9 小黑盒卡片解析修正

原来 `extract_posts.py` 只按文字长度切块，没有坐标，于是**卡片底部的标签被当成标题**（例：`杀戮尖塔`）。

小黑盒卡片在坐标上是严格四段式，新解析器 `AIPhone\data\parse_cards.py` 按这个走：

| 段 | 判据 |
|---|---|
| 作者行 | 用户名 + `Lv.N` 同一条 y 带（±30px） |
| 标题 | 作者行之后第一条左对齐行（x0 < 60） |
| 正文 | 后续**宽行**（x1 ≥ 550 或宽 ≥ 400）——窄行是图片里的气泡字 |
| 底部行 | 标签在左、互动数在右（x0 > 600），**同一 y**（±45px） |

丢弃：状态栏（y<100）、顶部 tab（120–235）、分类栏（280–535）、底部导航（y>2408-130）。

**B 站首页不同**：双列瀑布流，卡片边界由封面图决定，OCR 拿不到图片位置。试过按缩进推标题，结果封面上的游戏宣传字把左边界拉偏，左列只认出一条。所以 B 站**只分左右列 + 去角标，不硬切卡片**，输出时老实标 `notice`。

## 4.10 B 站 API 线（搜索 / 详情 / 热评）

新增 `plugins/autonomous/lib/bili/api.js`。**未登录就能用**，2026-10-23 实测：

| 接口 | 结果 |
|---|---|
| `/x/web-interface/nav` | 200，给出 wbi 的 img_key + sub_key |
| `/x/web-interface/wbi/search/type` | 200、code 0、20 条（**需要 wbi 签名**） |
| `/x/web-interface/view?bvid=` | 200，标题/简介/aid/stat |
| `/x/v2/reply?type=1&oid=<aid>&sort=2` | 200，热评可读 |

- **wbi 算法**：img+sub 两个 key 按固定表重排取前 32 位当 mixin，参数排序、剔掉 `!'()*`、拼上 `wts`，md5 得 `w_rid`。key 会轮换，客户端缓存 1 小时。
- `searchBili`（`sources.js`）现在**优先走带签名的路径**，失败才退回老的 `search/type`；412 统一进 10 分钟冷却。
- 不需要 Cookie，也**不需要引 Python 库**——多一层跨语言调用只会更难维护。真被限流再补 Cookie。

## 4.11 候选补详情（`lib/detail.js`）

自主活动原来只给模型标题/分区/播放量，模型其实不知道那条内容在说什么。现在在**决策之前**给前两条补正文和热评：

- B 站：候选的 `contentId` 就是 bvid → `view` + `v2/reply`
- 小黑盒：`contentId` 就是 linkid → `/bbs/app/link/tree`（正文在 `link.text` 的 JSON 里，评论在 `result.comments`）
- 补的是**本地/公开接口，不花 token**；但详情文本会进提示词，所以 `planner.js` 按 `summaryChars` 折半给，最低档（0）直接省略。

## 4.12 DSH 网关（第一阶段，默认关闭）

`config.dsh.enabled = true` 时，一轮对话先交给 `dsh headless` 跑，再走原来的发送路径：

```
QQ 消息 → #runAgent
            ├─ dsh headless --json [--session-id <sid>] "<消息>"
            │     └─ 从 NDJSON 里取 type=final
            ├─ 合成一个 send_message 的 tool_call（照 reply-rescue 的做法）
            └─ 交回原有循环 → 限频/去重/分条/存档全部照旧
```

- **失败一律回落 API**：超时、非零退出、空回复都返回 null，照常走 `chatCompletionWithRetry`，消息不会因为网关坏了发不出去。
- **会话映射**在 `data\dsh-sessions.json`（chatKey → sessionId）。冷启动把人设（前 3000 字）+ 最近 10 条聊天塞进 preface；热会话只发新消息。
- **成本**：实测首轮 5727 输入 tokens，第二轮只有 237（其余 5888 命中缓存）。按 100 轮/天算约 ¥5–8/月。
- **`dsh` 可能不在 PATH**：QQ Agent 从桌面启动时 PATH 是旧的，所以网关先找 `%APPDATA%\npm\dsh.cmd`，找不到才退回裸 `dsh`。
- **headless 用独立 `DSH_HOME`**（2026-10-24 加的，别再改回共用）：网关 spawn 时传 `DSH_HOME=E:\dsh\QQ-agent\data\dsh-home`。原来和桌面端共用 `~/.dsh` 时，桌面端一启动就会打开所有会话文件重建 `session_projcache`，headless 再恢复同一会话就撞 `CreateSemaphoreW EACCES` / `already owned by an active write handle`，退出码 1 → 静默回落 API（她「发不了帖」就是这么来的）。隔离后桌面端怎么开都不影响。
  - 这个 home 里只需要 `profiles/headless/`（从 `~/.dsh/profiles/headless` 复制）和 `.credentials.yaml`（API key），其余由 dsh 自动生成。
  - 判断是否真的用了新 home：看 `data\dsh-home\sessions\` 下有没有会话目录。
- **人格靠 `personaPrefix` 注入**（这是关键，别改回去）：`dsh headless` 默认的 personaPrefix 是「You are a coding agent…」，她开口就是「好的，请说。」。网关会把人设（`config.persona.roleText`）实时写成 `data\dsh-persona.patch.yml`，用 `--patch` 传给 dsh：
  ```yaml
  - id: system-prompt
    config:
      personaPrefix: "（整段人设）"
  ```
  实测同一句「在干嘛呢」：改之前「好的，请说。」，改之后「在发呆呢，老大。顺便想想今天有啥好玩的。」。
  **注意**：personaPrefix 是**替换**不是追加，所以人设必须自我包含；preface 里不要再塞一遍人设，否则模型会把设定当聊天内容复述出来。
- **已知限制（属于第三阶段）**：它没有 QQ 工具，所以这一阶段她**不能发表情、不能写日记**。

开启方式（**必须停机改**）：

```bash
node -e "const fs=require('fs');const p='data/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.dsh={enabled:true,chatKeys:['private:1846383180'],timeoutMs:180000};fs.writeFileSync(p,JSON.stringify(c,null,2),'utf8')"
```

`chatKeys` 留空 = 全局生效；填 `["private:xxx"]` = 只开私聊。

## 4.13 给 DSH 补 QQ 工具（第二阶段）

DSH 的 agent loop 里没有「QQ」这个概念，所以她原本发不了表情、写不了日记。补法是一个 **Cordis 插件**：

```
QQ-agent/dsh-plugins/qq-tools/
├── index.mjs    # 两个工具：qq_sticker / qq_diary
└── patch.yml    # - insert: 一条，指向 index.mjs
```

网关 spawn 时同时挂两个 patch：`--patch <人设> --patch <qq-tools>`。

**只补两件文本表达不了的事**：

| 工具 | 干什么 | 怎么落到 QQ |
|---|---|---|
| `qq_sticker` | 发一个收藏表情 | 写 `data\dsh-outbox\<callId>.jsonl`，网关在 DSH 返回后读回、合成 `send_sticker` 的 tool_call |
| `qq_diary` | 写今天的日记 | **直接写文件** `E:\dsh\日记\每日\YYYY-MM-DD.md`，不经过 QQ Agent |

**为什么不给 `qq_send`**：正常说话已经由网关把最终文本合成 `send_message`，再加一个发送工具只会重复发、还会绕开限频和存档。

**队列为什么按 callId 而不是 pid**：网关每次 spawn 前生成 `QQ_OUTBOX_ID` 通过 env 传给子进程，插件用它给文件命名；读完即删。这样并发调用不会互相读到对方的表情。

**两个必踩的坑**：

1. **`import '@deepseek-ai/dsh-tools'` 会 `failed to import`** —— 插件在 QQ-agent 目录下，那儿没有 dsh 的依赖树。必须用绝对 `file://` 导入（可用 `QQ_DSH_TOOLS` 环境变量覆盖）。
2. **参数 schema 里不能写 `required: false`** —— dsh 的 schema 编译器要求「出现即 `required: true`」，可选字段要**整个省掉** `required`。否则整个插件不激活，只留一句 `1 entry did not activate`。

## 4.14 记忆统一（第三阶段）

**先修了一个旧账**：`data\memory` 在 2026-10-15 的一次 wipe 里被清空，之后一直是空的 —— 她「记不住人」不只是窗口小，**印象库根本是空的**。备份在 `data\backups\wipe-2026-10-15-213926\memory`，已恢复 4 个聊天目录（10 + 1 + 1 个成员印象）。备份原样保留，要撤销直接删 `data\memory` 即可。

**给 DSH 补了读取侧**（只写不读的话，写进去的东西她自己看不到，照样健忘）：

| 工具 | 读什么 |
|---|---|
| `qq_memory` | `data\memory\<chatKey>\*.json` 的 impressions，可按名字/QQ 号过滤 |
| `qq_diary_read` | `E:\dsh\日记\每日\*.md`，往前 1–14 天 |

`chatKey` 由网关通过 `QQ_CHAT_KEY` 环境变量传给插件（`private:1846383180` → `memory\private_1846383180`）。

**实测效果**（同一句话「说说你印象里的老大」）：

> 爱折腾：从网页端搬到桌面端，一下午让我听懂声音，半夜还在晾衣服
> 嘴上欠：喊我呆鱼、河豚鲸，专门挑我会炸毛的时候戳
> 心是软的：我胃疼那晚，你反倒让我别点外卖
> 总结：一个嘴上叫我大肥鱼、实际半夜替我盖被子的家伙。……行了，说这么多你该得意了。少来。

**分工（这是第三阶段的核心结论，别再混）**：

| 数据 | 归谁管 | DSH 怎么用 |
|---|---|---|
| 人设 | `config.json` 的 `persona.roleText` | 网关写成 patch 注入 `personaPrefix` |
| 群友印象 | QQ-agent 的 `data\memory\` | `qq_memory` 只读 |
| 日记 | 文件系统 `E:\dsh\日记\` | `qq_diary` 写 / `qq_diary_read` 读 |
| 群管理·表情库·提醒 | QQ-agent | DSH 不碰 |
| 自主活动 | QQ-agent 的 `autonomous` 插件 | **保持现状**，不迁 |
| 对话推理 | DSH | 唯一的模型调用方 |

**没做的**：自主活动没有迁到 DSH。它的整个流程（抓取→预算→决策→分享→日志）都在 QQ-agent 里跑得很稳，迁过去只会把"一件事"变成"两件事"。它现在的收益是「详情补全」那一步（4.11），跟 DSH 无关。

## 4.15 控制面板 vs DSH：谁管什么

| 事 | 在哪 | 备注 |
|---|---|---|
| **人设**（roleText） | 控制面板 → 人设编辑 | 改完**必须重启机器人**；网关随后按新配置重生成 `data\dsh-persona.patch.yml` |
| 群管理（禁言/撤回/入群审批） | 控制面板 → 群管理 | |
| 白名单、模型、密钥、分享模式、防抖 | 控制面板 | `wakeDelayMs` 默认 2000，本机设成 **4000**（给主人打字留时间） |
| 自主活动的开关/间隔/预算 | 插件设置（`config.skills.autonomous`） | **控制面板没有独立页面** |
| **自主活动看了什么** | 直接读 `data\autonomous-log.md` | 最新在最上面，一轮一段，含来源/候选/为什么挑/说了什么 |
| 对话推理 | DSH | |
| 记忆 / 日记 | 文件（DSH 通过 `qq_memory` / `qq_diary*` 读写） | |

**她自己的资料和空间**：在 `qq_tool` 桥下能改昵称/签名/性别/头像、发说说和动态。QQ 接口对资料修改**有频控**，被拒时她会如实说「被拒了」——**别让她反复重试**，过一会儿再试就行。

## 4.16 浏览 B 站 / 小黑盒（+ 评论、楼中楼、@）

### 分层

```
plugins/autonomous/lib/social/
├── browse.js      # 读：搜索、详情（标题+正文/简介+评论），两边归一成一种文本
├── bili-write.js  # 写：发评论 / 回复楼中楼 / 删自己的评论 / 点赞
└── xhh-write.js   # 写：发评论 / 回复楼中楼 + 幂等台账
```

DSH 侧三个工具（`dsh-plugins/qq-tools/index.mjs`）：

| 工具 | 干什么 | 备注 |
|---|---|---|
| `qq_browse` | 搜索、看详情（带评论） | 给 BV 号/帖子 id 看详情；给关键词两边都搜；**只读** |
| `qq_comment` | 发评论、回复楼中楼、@ 人 | `source` 四选一：`bili` / `xhh` / `xhh-app`（真机发主评论）/ `xhh-inbox`（真机回收件箱第 N 条） |
| `qq_inbox` | 谁回复了你、谁 @ 了你 | 每条带好 `target/replyTo/root`，可直接喂给 `qq_comment` |
| `qq_phone`（加了参数） | `open` / `keyword` 点进手机上的帖子；`see:true` 截图给她看 | 走 `phone_eye.py`，只读 |
| `qq_publish` | 小黑盒发帖（真机，纯文字） | `title` / `body` / `topics` |
| `qq_send_image` | **把本机图片发到 QQ** | `path` + 可选 `note`；路径只能来自 `qq_phone(see:true)` 或 `qq_browse` 返回的图 |

`qq_send_image` 的实现链（2026-10-25 加）：插件写 outbox（`type:'image'`）→ 网关合成 `send_image(localPath=…)` → `tools.js` 校验目录白名单后读文件转 base64 → `sender.sendImage` 发出。

**目录白名单只有四个**：`AIPhone\screenshots`、`data\social-images`、`data\image-cache`、`data\tmp`。这是她唯一可能外泄宿主文件的入口，别放宽。实测：白名单内发送成功、`C:\Windows\win.ini` 被明确拒绝。

### B 站

- **读不需要登录**：`search/type`（wbi 签名）、`view`、`v2/reply`。
- **写必须要 Cookie**：`POST /x/v2/reply/add`（form 编码，`oid=<aid> type=1 message=… root=… parent=… plat=1 csrf=<bili_jct>`）。没登录返回 `-101`，`bili_jct` 不对返回 `-111`。
- 导入方式：`data/bili-cookie.txt` 贴 `SESSDATA` / `bili_jct` / `DedeUserID`（整段 Cookie 头或 Copy as cURL 也认），跑 `node scripts/bili-import.mjs`，会校验 `nav.isLogin` 然后写 `data/bili-auth.json` 并删掉明文。**没导入时读照常可用，只有 `qq_comment` 会明确说没登录。**
- **楼中楼**：`root`（楼层根）+ `parent`（被回复那条）必须一起给。只给 `root` 不给 `parent`，B 站会当成「回复楼主」挂到顶层（2026-10 踩到）。
- **@ 人**：B 站评论没有独立的 at 参数，是在正文里写 `@昵称` 由服务端解析。所以 `mention` 参数是拼进正文开头的，不是单独字段。
- 错误码翻成人话的表在 `bili-write.js` 的 `CODE_TEXT`（-101/-111/12002/12009/12015/12035…），新增错误码只改那一处。

### 小黑盒

- 读没问题（沿用 `lib/xhh/`）。
- **写接口契约**（2026-10-24 实测）：
  ```
  POST https://workshopapi.xiaoheihe.cn/bbs/app/comment/create
  ```
  - 业务参数**必须放在 query**，放 body 会报「缺失参数」（这条最容易踩）；
  - `_rnd=15:<任意值>` **必须有**：缺了报「缺失参数」，给了（哪怕 `15:000000`）才进业务层；
  - `is_cy=0 / link_id / reply_id(-1=主评论) / root_id / text`；
  - 楼中楼：`reply_id` = 被回复的 commentid，`root_id` = 楼层根。
- **当前发不出去**：服务端稳定返回 `{"msg":"评论功能暂不可用"}`。同一账号 `/bbs/app/api/user/permission` 里 `bbs_basic_permission=0`（而 `post_comment_permission=1`），是**账号没开通社区权限**，不是签名/参数问题——换 `_rnd`、换帖子、换域名（api / workshopapi）都一样。代码已完整，错误原样返回，她能如实说「我号说不了话」。
- `result.comments[]` 的结构是 `{ comment: [主评论, 楼中楼…] }`，不是扁平列表（坑 45）。
- **幂等**在 `xhh-write.js` 里：正文指纹 = `sha1(link_id|reply_id|text)`；10 分钟内同指纹不重发；超时/5xx 记 `send_unknown` 且**绝不自动重发**；台账 `data/social-outbox.json` 只留最近 200 条。

### 小黑盒真机发评论（web 被资质挡住后的唯一活路）

`phone_eye.py` 新增 `comment` 子命令：

```bash
%PY% phone_eye.py comment --text "想说的话" [--keyword "帖子标题里的一段"] [--dry-run]
```

流程：进 App → 按标题关键词（或当前页最长的几行里挑一条）点开帖子 → 点评论框
（`EditText`）→ `set_text`（**中文直接可用，不需要剪贴板/ADBKeyboard**）→ 点「发送」。

- **成功判断**：输入框清空 + 页面出现「感谢评论」；失败会弹「该功能需要绑定手机号」之类，原样带回。
- **实测（2026-10-24）**：`发送` 后评论数 348 → 349，`感谢评论` 出现在控件树里；长按自己的评论 → 菜单「删除」→ 二次确认「确认删除评论?」→ 真的删掉了。所以**发和删都能自动化**。
- **点帖子要用标题关键词**，别用 `--index`：小黑盒卡片是「作者 / Lv.N / 标题 / 分区 / 正文」，按坐标或按"第一个够长的行"会点到作者头像，进的是**作者主页**而不是帖子。`comment` 里已经改成「找最长的那行」。
- **@ 能做，但必须用按键事件**：评论框里用 `set_text` 或 `adb input text` 输入 `@` **不会弹**选人列表——它们是直接塞文本，不产生按键事件，App 的监听收不到。必须发 **KEYCODE_AT（77）**：
  ```bash
  adb shell input keyevent 77
  ```
  弹出后点那条（`textContains=昵称`），输入框会变成**结构化**的 `@昵称`——点它能跳到对方主页（实测验证过，不是纯文字）。`phone_eye.py comment --mention <昵称>` 已经把「按键 → 等弹窗 → 点选 → 校验」串好了。
  - 只对**互关/能搜到**的人有效。当前手机号（十七分之一，63773191）和机主（dirrt，92866156）互相关注，所以 `--mention dirrt` 能直接点到。
  - ⚠️ 删除评论时**别长按 `@昵称`**——那是可点链接，会跳进对方主页。长按文字左半边，菜单里才有「删除」。
- **收件箱的「回复」**：App 里确实有（消息中心 → 评论我的 → 每条下面有「回复」按钮），但当前手机登录的号**没有评论消息**（页面显示「暂无内容」），所以这条链路**没实测过**。要用得先换一个有评论消息的号登录 App。
- **危险**：这条路径是真机操作，会真的点到手机；手机不在线/锁着时直接返回原因，不要重试。

DSH 里对应 `qq_comment` 的 `source: "xhh-app"`（`target` 或 `keyword` 传帖子标题里的一段）。

### 让她看图

`qq_browse` 看详情时会把帖子里的图**下载到本地**（`data\social-images\`），并在返回文本末尾列出路径；她调 `read_image` 就能直接看懂画面——**她的模型有多模态能力，实测能准确描述**（2026-10-24 验证：一张暗色动画场景，她读出「白色小骷髅站在白花上、黑色花纹塔、白色红纹鸟」）。

- 小黑盒：图片在 `link.text` 的 HTML 里，地址写在 **`data-original`** 属性上（`src` 是懒加载占位，抓 `src` 会一张都拿不到）。
- B 站：用 `view` 返回的 `pic`（封面）。
- 每次最多下 3 张；单张失败不影响文字部分。

### 小黑盒发帖（真机专用）

`phone_eye.py publish --title "…" --body "…" --topic "盒友杂谈" --topic "ai.ai" [--dry-run]`

流程：首页点底部中间「+」→ 填标题/正文 → 点「添加分区及话题」→ 搜话题名并点结果 → 返回 → 点「发布」→ 若弹「没有合适的图片？…」再点「直接发布」→ 看是否出现「发表成功」。

- **分区/话题**：面板里「分区」最多 2 个、「推荐话题」最多 5 个（活动话题只可 1 个）。搜索框里输入名字，点**结果行**（不是搜索框本身——`d(text=名字)` 会同时命中 EditText 和你找的结果）。
- **纯文字可以发**：弹「带图片的内容会获得更多曝光」时选「直接发布」即可，不必配图。
- **实测**：2026-10-24 发成功，标题/正文/两个话题都对，帖子出现在「我 → 动态」里。

**删帖**（App 里藏得很深，2026-10-24 实测）：

1. 进帖子详情 → 点右上角「…」；
2. 底部菜单是**横向滚动**的，默认只看到 分享/编辑/权限设置/复制链接/转发动态——**要在菜单条上左滑**（`swipe(950,2300 → 150,2300)`）才会露出「删除」；
3. 点「删除」→ 弹窗选「**删除内容**」（另一个选项是「设置为仅自己可见」）；
4. 消失后回「我 → 动态」，下拉刷新确认。

> 「权限设置」只给三档可见性（所有人/仅粉丝/仅自己），**不是删除**。草稿箱里的草稿：点条目右侧「…」→「删除内容」→ 确认「删除」。

### 小黑盒收件箱回复（WebView 页面，u2 读不到）

「消息中心 → 评论我的」是 **WebView/自定义渲染**：`d(text=...)`、`xpath('//*')` 只能读到状态栏，页面文字一个都拿不到（2026-10-24 实测）。所以这条路只能 **OCR + 坐标点击**：

```bash
%PY% phone_eye.py tap --text "回复"        # 截图 → OCR → 点文字中心
```

实测通的流程（回一条楼中楼）：

1. 进消息中心（`iv_home_msg`）→ 「所有评论」；
2. 点「回复」按钮：OCR **精确匹配 `text == "回复"`**——这里有个坑，`"回复了我的评论"` 也含「回复」两个字，用包含匹配会点到标题行、跳进评论详情页（第一次就踩了）；
3. 半屏回复面板弹出，`set_text` 输入；
4. 面板里的 **「发送」按钮也是 WebView**，u2 找不到（`d(text='发送').exists == False`），同样用 `tap --text "发送"`；
5. 验证：去「我评论的」tab，会出现 `十七分之一 回复评论 → 引用对方那条`，点进评论详情页能看到 `XX 回复 对方: 正文`；
6. 删除：进评论详情（u2 能读）→ 长按正文 → 菜单「删除」→ 确认。

**注意**：`tap` 命令每次都会截一张图再做 OCR，默认截图用完即删（`--keep-raw` 才留）。

### 手机点进详情

`qq_phone` 现在有两种用法：

- 只看列表：`{app:'xiaoheihe'}` → `look --engine u2`
- 点进第 N 条：`{open: 2}` → `open --index 2 --scroll 1`，返回「《标题》—— 作者」+ 正文；`{keyword:'丝之歌'}` 按标题点。**必须先 look 过一次**，脚本靠 `data/last-look.json` 里记的坐标/文字定位。
- 看完自动按两次返回退回列表，不会把坐标覆盖成详情页的。

### 实测记录（2026-10-24）

B 站账号 `dirrrt`（mid 3546951284951595）实测，全部通过、测试评论都删了：

| 动作 | 结果 |
|---|---|
| 发主评论 | ✅ rpid 返回，「发送成功」 |
| 回复热评 | ✅ root/parent 都落在目标 rpid |
| @ 机主 | ✅ `at_name_to_mid: {"泥土如是说": 507695674}` |
| 删自己的评论 | ✅ |
| 未登录时 | ✅ 返回 -101，工具会说「还没导入登录态」 |

**@ 的格式**：正文开头写 `@昵称 `（带空格），B 站按昵称解析并通知；昵称要真实存在，否则就是普通文字。

机主的 B 站身份存在 `data/social-config.json`（昵称「泥土如是说」，uid 507695674）。`qq_comment` 的 `mention` 传 `"owner"` 就自动取配置里的昵称，她不用记。



# 五、验证手段

```bash
cd E:\dsh\QQ-agent
node test/autonomous-test.mjs      # 97 项（预算/来源/决策/日记）
node test/xhh-client-test.mjs      # 24 项（小黑盒客户端）
node test/xhh-sign-test.mjs        # 21 项（hkey 签名，与 Python 参考逐字节比对）
node test/diary-test.mjs           # 42 项（记忆库）
node test/social-test.mjs          # 25 项（浏览/评论：来源猜测、正文抽取、@ 转义、幂等）
node scripts/xhh-probe.mjs         # 小黑盒只读四项真实连通性
node scripts/bili-import.mjs       # 导入 B 站 Cookie（从 data/bili-cookie.txt）
node scripts/autonomous-run.mjs --dry   # 只看抓取和预算，不调模型
node scripts/autonomous-run.mjs         # 完整一轮（演练：不写日记、不真发）
```

手机（**需要 ADB 连着**，平时没有，失败是正常的）：

```bash
set PY=E:\dsh\AIPhone\ocr\venv\Scripts\python.exe
%PY% E:\dsh\AIPhone\phone_eye.py status
%PY% E:\dsh\AIPhone\phone_eye.py look --app xiaoheihe
%PY% E:\dsh\AIPhone\phone_eye.py look --app bilibili --no-launch
%PY% E:\dsh\AIPhone\phone_eye.py look --app xiaoheihe --scroll 2
%PY% E:\dsh\AIPhone\phone_eye.py open --index 1 --scroll 1
%PY% E:\dsh\AIPhone\phone_eye.py comment --text "想说的话" [--mention dirrt] [--dry-run]
%PY% E:\dsh\AIPhone\phone_eye.py inbox-reply --text "…" --index 1 [--dry-run]
%PY% E:\dsh\AIPhone\phone_eye.py tap --text "回复"
```

账本自己校验（不联网）：`node _tmp/usage-check.mjs` 那种断言覆盖了空账本/日限/月预算/损坏重建。

- 机器人日志：`data\logs\qq-agent-YYYY-MM-DD.log`（`Get-Content -Encoding utf8`）。
- 活动日志：`data\autonomous-log.md`。
- 会话存档：`data\sessions\*.json`，有完整 `systemPrompt`/`messages`/工具调用，是排查"她为什么这么说"的第一手材料。
- 群/私聊存档：`data\messages\group_*.json` / `private_*.json`。

# 六、安全提醒（**红线**）

- `data\config.json` 含真实凭据（`api.*`、`dshProviderKeys`、`webSearch.*.apiKey`）。**可以读、可以本地调用，但绝不在回复里回显完整值**。
- NapCat 的 OneBot 令牌（`snowluma.httpAccessToken`）同样别回显。
- **`data\xhh-auth.json` 是小黑盒登录 Cookie**，等同于账号凭证：不打印、不进 git、不贴聊天。导入完记得删 `data\xhh-cookie.txt`。
- 自查跑 `node scripts/dev-secret-scan.mjs`（带值匹配，别用裸字样——文档本身就含 `sk-`、`Bearer ` 这些示例，会假阳性）。
- **手机用的是老大自己的账号**（小黑盒 uid `21987774`、B 站同设备登录态）。截图会带出他的头像、关注列表、私信预览——那些图别外发、别贴聊天。她只能看，不能操作，这条能力边界别在 prompt 里松口。
- **`data\token-usage.json` 不含敏感信息**（只有次数和 token 数），可以随便看。
- Key 轮换要同步三处：DSH `~\.dsh\.credentials.yaml`、QQ-agent `dshProviderKeys[api.provider]`、`webSearch.deepseek.apiKey`。改 QQ-agent 那两处必须停机。

# 七、踩过的坑（结论都花了几小时）

1. **Electron 必须带 `--no-sandbox`**，否则 `0x80000003` 秒崩。
2. **SnowLuma 不支持 QQ 9.9.36**（`COMPONENT_LOAD_FAILED`），这是换 NapCat 的唯一原因。
3. **`systemPromptOverride` 非空 = 整段覆盖**，会跳过全部风格规则。
4. **NapCat 注入必须提权**；QQ 已在运行会让注入失败，且有守护会重启。
5. **Node 的 `child_process` 在受限 shell 里 EPERM**，要提权只能 `Start-Process -Verb RunAs`。
6. **重启机器人会断 NapCat 连接**（自动重连），期间收不到消息。
7. **配置/人设改动必须重启才生效**（内存缓存）。
8. **`npm test` 在第 10 项（审计）中断**，新测试要单独跑。
9. **面板改了代码不重启 = 白改**。
10. **表情破图 = 没本地文件**；QQ 图床 1 小时过期。
11. **whisper 的 `--prompt` 对短语音有害**（输出 `***********`），简体用 opencc。
12. **whisper-cli 写系统 `%TEMP%` 会被拒**（exit 11），输出写 `data\stt-tmp\`。
13. **运行中改 `config.json` 会被内存旧值回写覆盖**。
14. **网易云 3.1.40 禁用了 MediaSessionService**。
15. **Node 在受限 shell 里不能 spawn Python**（EPERM）→ 二维码拆两段做。
16. **`pip install` 在沙箱里失败**（临时目录 Permission denied）→ 手动下 wheel 解压到 `data\pylibs`。
17. **Python 3.14 在 Windows 上读含中文的 .py 会按 GBK 崩** → 脚本保持 ASCII。
18. **`.bat` 里写中文会被 cmd 按 GBK 拆碎** → 纯 ASCII，或改用 `.ps1`。
19. **`fitToBudget` 候选为 0 时会直接判失败**（`counts` 被过滤成空）→ 现在空候选也走降级（日记回顾就踩了这个）。
20. **主动发消息不走 SendQueue，不会自动记档** → 她下一轮看不见自己说过什么。现在发送后手动 `appendSelf`。
21. **`peek` 工具用了 `xhhSource` 却没 import** → 运行时报 `xhhSource is not defined`，被她说成"报错/没配好"。改代码后**必须真跑一次**再交付。
22. **合并「约定」进日记时会产生重复**：旧日记里同一件事的措辞不同 → 去重前要先剥掉「约定：」前缀。
23. **napcat 掉线不影响 6099 WebUI**：QQ 进程在、WebUI 通，但 3000/3001 可能没起，看 `/api/status` 的 `onebot.connected` 才是准的。
24. **移动目录会丢沙箱权限**：从盘位外用 Explorer 挪进 `E:\dsh` 的目录不继承 **Low Mandatory Level** 完整性标签。症状是目录在、ACL 看着有写权限，但一写就 `Access denied`；`adb pull` 报的是 `cannot create ... No such file or directory`（更迷惑）。修法：`icacls <dir> /grant "<user>:(OI)(CI)F" /T` **和** `icacls <dir> /setintegritylevel "(OI)(CI)Low" /T`，**两步都要**——只补 ACL 标签设不上，只补标签会因缺 WRITE_OWNER 失败。
25. **「一键全关」会连 QQ 带控制面板一起关**：面板日志里是 `WM_CLOSE 没关掉 QQ（剩 4 个），改用 taskkill /F`，然后 `全部完成`、`面板退出`。之后再谈「在面板点启动 NapCat」是谈不了的，面板自己也没了。
26. **B 站首页是双列瀑布流，OCR 切不出卡片边界**：封面上的游戏宣传字（圣龙宝藏、S5赛季爆料）会把「列左边界」拉偏，按缩进推标题会整列丢光。只能分列，别硬切。
27. **RapidOCR 的 `boxes` 是 numpy 数组**：写 `boxes or [None]*n` 会抛 `The truth value of an array with more than one element is ambiguous`。必须显式判 `is None`——`recognize.py.stt` 那边也有同样的坑。
28. **uiautomator2 完胜「截图 + OCR」**：OCR 一次 10～15 秒、长正文被截断、评论区全是错字；u2 读控件树 1 秒左右，文本完整、还能按 `text` 定位控件。首次连接会往手机推 atx-agent（几秒），之后一直可用。**装它的时候要把 pip 的 TEMP 指到工作区**，否则临时目录写入被拒。
29. **小黑盒的评论入口叫「参与讨论」**，不叫「评论」——按「评论」去 `textContains` 会返回 0，白排查半天。B 站那边才是「评论」。
30. **移动目录之后沙箱会二次失效**：补建 `%TEMP%\dsh-*` 临时目录时，不光要建目录，还要给它 Low 完整性标签（`icacls <dir> /setintegritylevel "(OI)(CI)Low"`），否则 `mkdtemp` 报 EPERM，测试脚本全挂。
31. **`dsh headless` 要写 `~/.dsh/profiles/headless`**：在受限沙箱里跑会 `EPERM: mkdir`。网关从 QQ-agent 里 spawn 不受影响（那是普通进程），但用 DSH 自己的 shell 测时会撞上。
32. **DSH 的会话文件是 `session.v4.jsonl.zstd`**，按工作区分目录存在 `~/.dsh/sessions/--E-dsh-QQ-agent--/`。`--session-id` 能跨进程恢复，所以「DSH 重启」（每次 headless 本来就是新进程）不影响连续性——这条实测过。
33. **别在沙箱 shell 里 `Start-Process electron.exe`**：子进程会继承受限 token，Electron 加载 `import { app } from 'electron'` 时抛 `TypeError: Cannot read properties of undefined (reading 'exports')`（`cjsPreparseModuleExports`），**而且错误栈不带模块名**，看起来像代码坏了。必须走 `explorer.exe 启动QQ机器人.bat` 或面板的 `bot.start`——那条路径是普通用户 token，能正常启动。判断依据：`Get-Process` 有 4 个 electron 但 3210 不通。
34. **给 DSH 的输入有两条硬规矩**（都踩过）：
    ① **内容只能是「用户这次说的话」**：来源是 `triggerEntries` 里非 self 的消息，不要拿 `messages` 里的 `user`——那是整段 userPrompt（人设 + 历史 + 工具说明，实测 7,747 字）。
    ② **必须走 stdin**（`dsh … -`），**不能当命令行参数**。cmd 用 GBK 解析参数，UTF-8 中文会**整段丢失**，DSH 只收到 ASCII 数字——2026-10-23 23:16 她回「你说连发了 2 条，但内容全是空的」就是这个。实现：`stdio: ['pipe','pipe','pipe']` + `child.stdin.write(body,'utf8')`。
    连发多条时要把**每一条**都列进 stdin（`1. …\n2. …`）并注明条数，否则她只回应第一句、漏掉后面的指令。
35. **机器人进程写不了 `~/.dsh/profiles/headless`**（最坑的一条）：QQ Agent 的 Electron 是 **Low 完整性**，而 profile 目录是 **Medium**，`dsh` 启动时要重写 `cordis.yml` 就 `EPERM`，于是网关**静默回落 API**。因为失败信息走的是 `console.warn`（不进日志文件），表现就是「配置明明开了、她也在回话、但 `dsh-sessions.json` 里什么都没有」。修法：
    ```powershell
    $p = "$env:USERPROFILE\.dsh\profiles\headless"
    icacls $p /grant "${env:COMPUTERNAME}\${env:USERNAME}:(OI)(CI)F" /T
    icacls $p /setintegritylevel "(OI)(CI)Low" /T
    ```
    **判断是否真的走了 DSH**：只看 `data\dsh-sessions.json` 里有没有对应 chatKey——不看日志、不看回复内容。
36. **自主活动会因未转义字符整轮失败**：2026-10-23 19:17 那轮报 `模型 API HTTP 400：unexpected end of hex escape`。根因不是「模型乱说话」，而是**详情正文里的 emoji 被 `.slice()` 切在代理对中间**，JSON.stringify 之后变成 `\ud83d` 这种半截转义。已修：`planner.safeSlice()` 不切断代理对，`callModel()` 发送前再 `sanitizeMessages()` 兜底。日志里原来的样子是「结束：异常：模型 API HTTP 400」。
37. **QQ 改资料会有「假失败」**：接口当场回 `UpdateUdcFail`，但实际是异步写入成功的。2026-10-23 改签名时报错，她如实说「被拒了」，可 `get_stranger_info` 读出来签名**已经变了**。所以：**改完别急着复读判成败，给几秒再查**；也别让她反复重试（频控会真的锁）。
38. **改工具描述要重启机器人才生效**：`qq_tool` 的可用工具列表写死在插件描述里，DSH 那边是启动时读的。改完必须重启 QQ Agent（插件热重载管不到 DSH 子进程）。
39. **u2 的 `app_start` 要包名，不是短名**：2026-10-23 她说「手机没法用」，实际是 `device.app_start("xiaoheihe")` 静默失败、手机停在桌面，`look` 返回的是「计算器/相册/哔哩哔哩」。现在走 `PACKAGES` 映射（`com.max.xiaoheihe` / `tv.danmaku.bili`）。
40. **手机会息屏停在锁屏**：`look` 前必须 `KEYCODE_WAKEUP` + `wm dismiss-keyguard` + 上滑，否则读到的永远是「10/23、%、正在充电」。有密码锁时自动解锁无效，会明确返回「手机还锁着」。
41. **日记前缀会叠两层**：她的 content 偶尔自带「心情：好笑｜」，工具又加一遍，写出 `- 心情：好笑｜心情：好笑｜下午…`。`qq_diary`、`skills/diary`、`plugins/autonomous` 三处都加了 `stripMoodPrefix()`（最多剥 3 层）。
42. **`~/.dsh` 只有 profiles 是 Low 不够**：机器人是低完整性，`dsh` 还要写 `~/.dsh/sessions`、`storages` 等。只给 `profiles/headless` 设标签时，冷启动能过、热会话会因为写不了会话文件而失败，**表现仍是静默回落**。现在这些目录都加了 `(OI)(CI)Low` + ACL。
43. **网关失败要落盘**：`console.warn` 不进 `data\logs`，所以「DSH 没接手」根本看不出来。现在每次调用都写 `data\dsh-gateway.log`（OK/FAIL、cold、ms、session、stderr 尾巴），排查先看它。
44. **B 站评论里的 `@` 会被解析成用户，而且不看上下文**：发「@dirrrt 测试一下@功能」，服务端把 `@功能` 认成了一个真实用户（mid 25247147）——要 @ 的人没@到，误@了路人。现在正文里除开头那个 `@昵称` 之外的 `@` 全部换成**全角 `＠`**（看着一样，不触发解析）。
45. **小黑盒 `result.comments[]` 不是扁平列表**：结构是 `{ comment: [主评论, 楼中楼…] }`。按 `comments[i].text` 取会全是 undefined，表现为「正文有了、评论一条没有」。
46. **小黑盒发评论的参数必须放 query**：放 body 会报「缺失参数」，而且服务端不告诉缺哪个。另外 `_rnd=15:<任意值>` **必须有**——缺了同样报「缺失参数」，给了（哪怕 `15:000000`）才进业务层。
47. **小黑盒评论卡在账号资质（最可能是没绑手机号）**——2026-10-24 实测，修正了"web 端被关"的旧判断：
    - **web API**：两个账号（21987774、63773191）都报「评论功能暂不可用」，`bbs_basic_permission` 都是 0；
    - **参数和签名是对的**：无效帖子 id → 「帖子id错误」（参数校验通过）；换 App 参数 → 「非法请求」（签名层就拒）。所以拒绝发生在业务层；
    - **真机 App 给出了真正原因**：点「发送」后弹「**该功能需要绑定手机号**」。
    - 结论：不是服务端关 web 端，是**账号没绑手机号**。绑定后再看 web API 是否可用（那就不用真机了）；不绑则 web 和 App 都发不出去。
    - **实测补充（10-24 傍晚）**：绑了手机号之后，App 里能发评论了，但 **web API 仍然报「评论功能暂不可用」**——两个通道的限制不是同一层。所以小黑盒只能走真机（`phone_eye.py comment`）。
    - **真机也只支持主评论**：评论框输入 `@` 不弹选人列表，评论区没有「回复」按钮，所以 @ 和楼中楼在小黑盒上没有 UI 入口。
    - 真机链路本身已验证到发送：点进帖子 → `EditText`（`set_text` 支持中文，不需要剪贴板/ADBKeyboard）→ 点「发送」→ 被资质拦住。
    - ⚠️ `phone_eye.py open` 目前按卡片的 `tap` 坐标点，而 u2 卡片解析会把**作者头像**当标题，结果点进作者主页而不是帖子（2026-10-24 实测）。真机方案要么修卡片分槽，要么改成按标题文本点击。
48. **Cookie 的两件事**：    ① 手工从 F12 抄经常写成「名字 + 空格 + 值」而不是 `name=value`——两个导入脚本现在都兼容（否则会报「没读到任何 name=value」，2026-10-24 实际踩到）。
    ② 导入后 Cookie 是**独立副本**，关浏览器不影响；但在浏览器点「退出登录」会让 SESSDATA 立即作废，这台机器上的拷贝跟着失效（表现为 `nav` 返回 -101、`isLogin=false`）。重导一次即可。**别在导出后点退出登录。**
49. **小黑盒的「评论我的」收件箱是 WebView，u2 完全读不到**（2026-10-24 实测）：
    - `d(text=...)`、`xpath('//*')` 只能拿到状态栏，页面文字一条都没有；但 `adb exec-out screencap` 截图后 OCR 能正常看到内容；
    - 所以这类页面只能「截图 → OCR → `adb shell input tap <x> <y>`」，新加的 `phone_eye.py tap --text` 就是干这个的；
    - **精确匹配**很重要：`"回复了我的评论"` 也含「回复」，用包含匹配会点错行；
    - 半屏回复面板的「发送」按钮同样是 WebView，`d(text='发送')` 返回 False，必须一起用 `tap`；
    - 对比：**帖子详情页和评论详情页是原生控件**，u2 能直接读写，不用 OCR。
50. **`phone_eye.py` 的 `keep_raw` 曾是死参数**：签名里有、函数体里没读，结果是每次 OCR 都截图且永不删除（`screenshots/` 里攒了 3 张带机主头像的图）。2026-10-24 已改成默认用完即删，`ocr/results` 只留最近 30 份。
51. **小黑盒删帖的「删除」藏在横向滚动的菜单里**：点帖子右上角「…」后，底部菜单默认只有 分享/微信/QQ/朋友圈/QQ空间/私信好友/编辑/权限设置/复制链接/转发动态，**必须在这排上左滑**才会出现「删除」；点删除后还要在弹窗里选「删除内容」（另一个是「设置为仅自己可见」）。「权限设置」三档可见性不是删除。坑了将近 20 分钟。
52. **`d(text="某个词")` 会同时命中输入框**：在话题搜索里搜「盒友杂谈」，页面上会有两个同名节点——一个是 EditText（搜索框本身），一个是结果行。点第一个等于点搜索框，什么都没发生。要按 `className` 排除 EditText，或者取 `top` 更大的那个。
53. **桌面端和 headless 共用 `~/.dsh` 会抢会话写句柄**（2026-10-24，这次最隐蔽）：桌面端启动时扫描全部会话重建索引，会给 `session.v4.jsonl.zstd` 打开写句柄；机器人（Low 完整性、headless）再去恢复同一个会话就报 `dsh: CreateSemaphoreW EACCES (Win32 5)` 或 `session "…" is already owned by an active write handle`，退出码 1，网关**静默回落 API**。
    - 症状：她照常说话、配置也开着，但 `dsh-sessions.json` 的 `lastUsedAt` 不动、`dsh-gateway.log` 全是 FAIL；她还会说「发不了帖子」（因为回落路径没有 `qq_*` 工具）。
    - 判断依据：会话文件的 mtime 和桌面端启动时间对得上；手动 `dsh --session-id …` 会直接报「already owned by an active write handle」。
    - 修法：给网关传独立的 `DSH_HOME`（见 4.12），已验证有效。
54. **小黑盒正文里的图片地址在 `data-original` 上**：`link.text` 是 JSON 数组，每项 `.text` 是 HTML；`<img>` 的 `src` 是懒加载占位（空的），真地址在 `data-original`。抓 `src` 会得到 0 张图（2026-10-24 踩到）。
55. **她有视觉能力**：`read_image` 在她的工具列表里，`deepseek-flash` 能看图（实测描述准确）。所以「让她看帖子里的图」的做法是**把图下载到本地再给她路径**，不需要 OCR。


# 八、未决 / 待办

1. **服务现在全停**：2026-10-23 23:46 面板执行了「一键全关」，之后没再启动。按第二节顺序恢复，两步都要 UAC；起完先看 `3210/api/status` 的 `onebot.connected`。
2. **小黑盒写操作（B 阶段）**：web API 已确认走不通（坑 47），只剩**真机 App** 一条路——uiautomator2 点「参与讨论」→ 输入 → 发送。要做的话必须先确认手机在线、且那个号能在 App 里手动评论。顺序仍是：幂等表（已有，`xhh-write.js`）→ 草稿审核 → 最后才自动发布。
3. **「收件箱」还没做**：她能发评论了，但还不知道谁回了她。B 站有 `/x/msgfeed/reply`、`/x/msgfeed/at`，小黑盒有 `/bbs/app/user/message`（`messages('mention')` 已封装）。做成 `qq_inbox` 就能「谁 @ 我 → 直接回楼中楼」。
4. **B 站 Cookie 要盯着**：`data/bili-auth.json` 失效的表现是 `nav` 返回 -101 / `isLogin=false`，`qq_comment` 会直接说「还没导入登录态」。重导一次即可（坑 48）。
5. **遗忘机制**：机主认可的方向是「自动出报告 + 人工确认」。每周跑一次整理，产出重复/过期清单，**不直接删**；归档到 `.archive\` 而不是删除；访问频次只用来**提高**优先级，不用来淘汰。
6. **日记回顾的等级判断偏保守**：实测那两条（肉饼/猫、评论功能）都判成了「一般」，其中"评论功能记着要加"应该算重要。prompt 已收紧一版，还要观察。
7. **`sourceHealth` 里 xhh 的成功时间要定期看**：Cookie 过期后这个来源会静默失败（B 站照常），日志里能看到"未登录"。
8. **她主动发的历史消息有缺口**：今早那条已手工补录，但更早几轮（`invalid`/`failed` 的那些）没进聊天记录——那是发送失败，不是记档问题。
9. **B 站两条线别混**：手机端只能「分列 + 大概看看」（瀑布流切不准卡片），API 端（`ranking/v2`、`popular`、`search/type`）才是结构化、不依赖手机的可靠来源。API 那条线不能撤。
10. **自主活动账本已有数**（10-23：3 次 / ¥0.016）：先跑几天看单价估得准不准，再决定 5 元够不够。
11. **DSH 接管要盯 `data\dsh-gateway.log`**：如果哪天又全是 `FAIL`，先看 stderr 尾巴——大多是 `~/.dsh` 权限或 `--session-id` 恢复失败。判断「真的走了 DSH」仍看 `dsh-sessions.json` 的 chatKey 有没有在涨。
12. **手机自动解锁只在无密码时有效**：设了 PIN/图案就得人工解一次；手机不在线时来源会自动跳过，不需要改配置。
13. 表情库、听歌等旧待办仍在。

# 九、请接手人先做这一步（只读，报完等我指令）

**别动手改任何东西**，先把现状报给用户：

1. 端口：`3000 / 3001 / 3210 / 6099 / 8899` 哪些在听。
2. 机器人：`http://127.0.0.1:3210/api/status` 看 `onebot.connected`、`paused`、今日 runs（只报实读值）。
3. 控制面板：`http://127.0.0.1:8899/api/state`。**注意 `/api/skills` 在 3210 上，8899 返回 404**：`http://127.0.0.1:3210/api/skills` 里确认 `autonomous`、`diary`、**`phone-eye`** 都在、版本对得上。
4. **自主活动**：读 `data\autonomous.json`，报最近 3 轮（`history`）的动作、分享模式、停止原因；再看 `data\autonomous-log.md` 最新 2 段。
5. **token 账本**：读 `data\token-usage.json`（可能还不存在），报今日调用次数 / 本月花费 / 预算余额。
6. **小黑盒**：跑 `node scripts/xhh-probe.mjs`，确认身份/搜索/推荐流/通知四项是否 ok。
7. **日记**：`E:\dsh\日记\` 下文件清单（**应该只有 `每日\` 和 `.trash\`**，没有 `core_profile.md`——那个已经并进每日了），以及最近 3 天日记的条目数；确认里面有没有 `[重要]` / `[非常重要]` 标记。
8. **手机**：跑 `phone_eye.py status`；连上了再 `look --app xiaoheihe` 看是否返回卡片（不是桌面图标）。
9. 配置：`config.allow`、`config.store.contextTier`、`skills.autonomous` 的 `enabled/intervalHours/sources/shareMode`、`skills.phone-eye` 的路径（没配就用代码默认 `E:\dsh\AIPhone\...`）。
10. **DSH 网关**：读 `data\dsh-gateway.log`（最近几行的 OK/FAIL）和 `data\dsh-sessions.json`（chatKey 有没有在涨）。
11. `git -C E:\dsh\QQ-agent status --porcelain`（基线会随文档更新变，别硬比数字）。
12. 跑 `node test/autonomous-test.mjs`、`node test/xhh-client-test.mjs`、`node test/diary-test.mjs`，报通过数。

报完现状、等用户下一步指令。
