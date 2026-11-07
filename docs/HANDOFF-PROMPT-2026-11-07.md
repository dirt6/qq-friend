# 新对话交接 Prompt（2026-11-07 00:05）

> 复制下面「=== PROMPT 开始 ===」到「=== PROMPT 结束 ===」之间的内容，作为新对话的第一条消息。

---

=== PROMPT 开始 ===

你是接手「QQ Agent / 小鲸鱼 5.0」项目的编码代理。项目在 `E:\dsh\QQ-agent`（Windows），请用中文思考和回复。先读这份交接，再动手。

## 一、项目与运行环境（2026-11-07 已核实）

- QQ Agent：Electron 应用，面板 `http://127.0.0.1:3210`，启动方式：先 `POST /api/app/quit`，再 `Start-Process "$env:USERPROFILE\Desktop\QQ Agent.lnk"`，然后轮询 `/api/version`。
- 协议端：**NapCat 4.18.42**（`napcat/shell`），OneBot HTTP 3000 / WS 3001 / WebUI 6099；令牌在 `data/config.json` 的 `snowluma` 块（不要打印）。
- QQ：**9.9.33-52230**，装在 `D:\NTQQ-9.9.33`；数据目录 `E:\dsh\QQ-agent\runtime\qq-portable-data`；配置 `runtime.qqPortableDir = D:/NTQQ-9.9.33`。
- 日常 QQ 9.9.37 在安装 9.9.33 时被安装器卸载（`D:\NTQQ` 已删），**机主决定暂不重装**（重装会改注册表指向 9.9.37，导致 NapCat 又启动错版本）。
- SnowLuma 已停用（面板入口已移除），不要再启动它。
- QQ 自动更新：`D:\NTQQ-9.9.33\versions\channel.json` 已清空 channel（备份 `channel.json.bak`），尚未重启 QQ 验证。
- 当前状态：OneBot 已连接（账号 2029382488「！？哦鲸鲸？！」，主人私聊 `private:1846383180`）。

## 二、本次会话已完成（按主题）

1. **空闲系统 5.0（核心）**：
   - 每轮醒来最多 **3 个动作**，可提前结束（sleep/none）；动作定义：browse+分享/评论/写下来算 1 个；单独写日记/本子/分享/评论/说话/画画/写 skill 各算 1 个。
   - `browse`：按她想看的主题（不会另起炉灶）先提炼关键词，搜 B站+小黑盒；搜到只用搜索结果，搜不到才补推荐流；浏览记录写入 `data/idle-browse.json`（6 小时有效）。
   - browse 完在同一轮内追问「接下来」：分享 / 评论 / 写日记 / 停；评论、分享**只能基于刚浏览过的内容**，没看过就跳过。
   - 分享：B站与小黑盒同级候选，挑喜欢的；**可以没有配文**；只有配文像汇报（过长/带数字）时才改写成口语一句。
   - 评论可 @ 主人（`data/bili-owner.json` 的昵称），可评论+分享同一条。
   - 空闲时会先自动处理 B站收件箱（@/回复）与小黑盒通知（发 QQ 提醒）。
   - 新增画画（可分享可不分享，配文可空）、写 skill（生成 `her-*`，语法校验通过才落盘，危险词拦截）。
   - 每天 **11:00 / 23:00** 自动做「记录检查」：看最近聊天+浏览+本子，有值得写的就写日记/本子。
2. **聊天修复**：
   - 允许单发图/表情、不带文字（之前误加了强制文字，已撤销）。
   - 单发图/表情时不要写「发出来了」这类说明。
   - 过滤零宽字符/纯空白，单发表情不再多一条空消息。
   - 「先别回话 / 我说完了再回」的听写模式（`src/listen-mode.js` + orchestrator 拦截），期间完全不回、含已排定唤醒；说「我说完了」才醒来回应。
3. **技能与提示**：
   - `skills/gif-look` 改为 `skills/her-gif-look`（3210「她的工具」只认 `her-` 前缀）。
   - `skills/diary` 的系统提示已修正：旧路径 `E:\dsh\日记` → `E:\dsh\本子\日记`；旧工具名 `diary__*` → `qq_diary*`；`kind=promise` 改为正文前缀；「记住了」6→15 条。
4. **面板**：运维页 SnowLuma 启停入口已移除（后端 API 保留）；空闲页「上次醒来」在重启后不再显示 `—`（用账本兜底）；醒来记录显示「下一步」。

## 三、未完成 / 下一步（按优先级）

1. **星图记忆**（方案已定，未实现）：`docs/星图记忆方案.md`。只读投影，只依赖 Memory Hub 的 `search/get/stats`；日记直读 `/api/diary`，其他层走 Hub；编辑/删除复用现有 `/api/diary/edit`、`/api/diary/delete`；Canvas 2D（不引 three/ECharts）；内嵌日记页左星右日记。注意 `/api/diary` 目前 60 天上限，需加 `days=all`；UI 测试缺 canvas 桩。
2. **房间**（方案已定，未实现）：`docs/房间方案.md`。机主定：**3D（three.js）**、Live2D 用 `dsh-dfy`、3210 新 tab、不到空闲时间闲逛（摸猫/坐椅子）、空闲醒来决定（刷帖→手机/电脑、画画→书桌、去窗边）、**记忆与现有系统合并**（写进现有运行账本，不建第二套）。分阶段：P0 静态 3D 房间 + Live2D 站位/坐/躺/截图；P1 家具/天气；P2 待机闲逛与空闲集成。
3. **QQ 稳定性**：NapCat + QQ 9.9.33 目前可用；QQ 若崩溃需手动重启 NapCat。可选做 watchdog（检测 QQ 退出→自动拉起→重连），机主未最终拍板。
4. **B站/小黑盒 @ 流程**：已实现空闲自动回复+通知；若要“全自动即时”需再评估（机主已同意只在空闲/叫他时处理）。
5. 系统提示可能还有其它过时段落（机主提过），可继续对照 `docs/` 与代码检查。

## 四、工作约定（必须遵守）

- 所有思考与回复用中文。
- 改代码前先读文件；改完 `node --check` + 相关测试；提交到 git（不要提交 `data/config.json`、cookie/token/凭据）。
- 测试：`npm test`（或 `node test/5.0-xxx-test.mjs`）；新增功能补测试。
- 重启应用：`POST /api/app/quit` → 启动快捷方式 → 轮询 `/api/version`；重启后 OneBot 会自动重连（NapCat 进程独立）。
- 绝不打印 cookie、token、API key、`data/bili-auth.json`、`~/.heybox-ai/credentials.json` 内容。
- 不要删除：`data/backups`、日记（`E:\dsh\本子\日记`）、本子、画作、记忆、凭据、`docs/房间方案.md`、`docs/星图记忆方案.md`。
- 公开评论/回复属外部动作：保留去重、静默（00:00–08:00 不发）、每小时 3 条、失败不重发。
- 已知坑：`log.recentActions()` 没有 `action` 字段（要用 `log.recent()`）；`collectCandidates` 只读浏览记录；`runThink` 每轮最多 3 动作。

## 五、关键路径

- 空闲：`src/idle-activities.js`、`src/idle-scheduler.js`、`src/idle-wake.js`、`src/idle-actions.js`、`src/autonomous/idle-plan.js`
- 聊天：`src/orchestrator.js`、`src/listen-mode.js`、`src/split-chat.js`、`src/sender.js`
- B站/小黑盒：`src/bili-adapter.js`、`src/bili-write-adapter.js`、`src/bili-owner.js`、`src/xhh-heybox.js`
- 日记/本子：`src/diary/index.js`、`src/notebook.js`、`skills/diary/`
- 面板：`ui/app/17-readonly-pages.js`、`ui/app/15-ops.js`、`src/routes.js`
- 方案：`docs/roadmap/5.0-*.md`、`docs/星图记忆方案.md`、`docs/房间方案.md`

## 六、最近提交（可作为起点）

`13b1f53` 分享可无配文；`8e57138` 分享口语化；`d6ba7a7` 每天 11/23 记录检查；`de1a7ab` 评论/分享只看浏览记录；`8060f5f` 每轮 3 动作；`4ed5a72` browse 后同轮决策；`5462e59` browse 按主题搜；`504a5ef` 上次醒来兜底；`f470189` her-gif-look + diary 提示；`4d46667` 零宽字符过滤；`42d0b26`/`c7abba8` 单发媒体；`241f8cc` 听写模式；`807b57a` B站@方案与星图/房间决定。

=== PROMPT 结束 ===
