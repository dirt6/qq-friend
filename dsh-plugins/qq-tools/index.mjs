// 给 DSH 用的 QQ 工具（Cordis 插件）。
//
// 为什么需要：DSH 的 agent loop 世界里没有"QQ"这个概念，所以她没法发表情、
// 也写不了日记。这个插件把这两件事补上 —— 但她仍然用 DSH 的推理和工具系统。
//
// 设计约束（重要）：
//   · **不直接发消息**。正常说话仍由网关把 DSH 的最终文本合成 send_message，
//     这样限频/去重/分条/存档一个都不会被绕开。工具只放行"文本表达不了的动作"
//     （表情），以及"需要落盘的东西"（日记）。
//   · 表情走**文件队列** outbox，由网关在拿到最终回复后一起发出去 —— 因为
//     DSH 子进程执行时，QQ Agent 正阻塞等它返回，加个 HTTP 端点只会多一条
//     需要鉴权的本地通路。
//
// 导出约定照 @deepseek-ai/dsh-tool-todo：name / inject / apply / Config。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// 插件放在 QQ-agent 目录下，那里没有 dsh 的依赖树，所以 `@deepseek-ai/dsh-tools`
// 解析不到（会报 failed to import）。用绝对 file:// 导入，路径可用环境变量覆盖。
const DSH_TOOLS_URL = process.env.QQ_DSH_TOOLS
  || 'file:///C:/Users/lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

const { defineTool } = await import(DSH_TOOLS_URL);

// 浏览/评论能力复用 QQ Agent 里的实现，避免两边各写一份。
// 注意：插件在 QQ-agent 目录下，这些相对路径是相对**本文件**的。
import {
  makeClients as makeSocialClients,
  searchBili, detailBili, searchXhh, detailXhh, guessSource, formatItemList, downloadImages,
  parseShareLink, expandShortLink
} from '../../plugins/autonomous/lib/social/browse.js';
import { BiliWriter } from '../../plugins/autonomous/lib/social/bili-write.js';
import { XhhWriter } from '../../plugins/autonomous/lib/social/xhh-write.js';
import {
  inboxBili, inboxXhh, formatInbox, readBiliCookie
} from '../../plugins/autonomous/lib/social/inbox.js';
// 画图：渲染 + 归档（标题/风格/来源）统一走 src/draw.js，
// 和自主活动那边共用一套，避免"聊天画的没有标题、自主活动画的有"。
import { renderScene, recordDrawing } from '../../src/draw.js';

const name = 'qq-tools';
const inject = ['tools'];

// 这两个路径和 QQ Agent 约定死，改一边就要改另一边
const QQ_DATA = 'E:\\dsh\\QQ-agent\\data';
const DIARY_ROOT = 'E:\\dsh\\本子\\日记\\每日';
const NOTEBOOK_FILE = 'E:\\dsh\\本子\\小鲸鱼的本子.md';
const QQ_CONFIG = path.join(QQ_DATA, 'config.json');
const STT_TMP = path.join(QQ_DATA, 'stt-tmp');
const PHONE_PYTHON = 'E:\\dsh\\AIPhone\\ocr\\venv\\Scripts\\python.exe';
const PHONE_SCRIPT = 'E:\\dsh\\AIPhone\\phone_eye.py';
// 显式指定 adb：机器人进程的 PATH 是启动时的旧快照，可能根本没有 adb，
// 也可能命中别的版本（server 版本不一致时设备列表会空，表现成“未授权”）。
const ADB_PATH = 'C:\\Users\\lenovo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\'
  + 'Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\\scrcpy-win64-v4.1\\adb.exe';

/** 手机调用的排障记录（最近一次），失败时连 env/adb 一起记下来。 */
function notePhone(obj) {
  try {
    fs.writeFileSync(path.join(QQ_DATA, 'phone-eye-last.json'), JSON.stringify(obj, null, 1), 'utf8');
  } catch { /* ignore */ }
}

/** 读 QQ Agent 里的 whisper 配置（不重复写死路径，改配置两边同步）。 */
function sttConf() {
  try {
    const c = JSON.parse(fs.readFileSync(QQ_CONFIG, 'utf8'));
    const s = c?.skills?.['speech-to-text'] || {};
    return {
      exePath: String(s.exePath || 'E:\\dsh\\whisper\\Release\\whisper-cli.exe'),
      modelPath: String(s.modelPath || 'E:\\dsh\\whisper\\models\\ggml-small.bin'),
      language: String(s.language || 'zh')
    };
  } catch {
    return {
      exePath: 'E:\\dsh\\whisper\\Release\\whisper-cli.exe',
      modelPath: 'E:\\dsh\\whisper\\models\\ggml-small.bin',
      language: 'zh'
    };
  }
}

// outbox 按调用批次隔离：网关 spawn 时通过 QQ_OUTBOX_ID 传入本次调用的 id，
// 这样并发/连续调用不会互相读到对方的表情请求。
function outboxFile() {
  const id = String(process.env.QQ_OUTBOX_ID || process.pid).replace(/[^\w.-]/g, '');
  return path.join(QQ_DATA, 'dsh-outbox', `${id}.jsonl`);
}

function pushOutbox(action) {
  const file = outboxFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ...action, at: Date.now() })}\n`, 'utf8');
  return file;
}

/** 手机截一张图并留下路径（给她 read_image 看画面用）。失败返回空串。 */
async function phoneShot(env) {
  try {
    const { stdout } = await execFileP(PHONE_PYTHON, ['-X', 'utf8', PHONE_SCRIPT, 'shot'], {
      timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8', env
    });
    const line = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
    if (!line) return '';
    const r = JSON.parse(line);
    return r?.ok ? String(r.image || '') : '';
  } catch {
    return '';
  }
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 机主在该平台的昵称（@ 用），配置在 data/social-config.json。 */
function ownerMention(source) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(QQ_DATA, 'social-config.json'), 'utf8'));
    return String(j?.owner?.[source]?.name || '').trim();
  } catch {
    return '';
  }
}

// 日记行是 `- 心情：xx｜正文`。她偶尔会把「心情：好笑｜」连着正文一起当 content 传进来，
// 结果写出「- 心情：好笑｜心情：好笑｜下午…」（2026-10-23 实际发生）。
// 统一在这里剥掉，最多剥 3 层，防止旧行重复套前缀。
const DIARY_PREFIX_RE = /^\s*心情\s*[：:]\s*[^｜|]{0,20}[｜|]\s*/;
function stripDiaryPrefix(text) {
  let t = String(text ?? '').trim();
  for (let i = 0; i < 3 && DIARY_PREFIX_RE.test(t); i += 1) {
    t = t.replace(DIARY_PREFIX_RE, '').trim();
  }
  return t;
}

/**
 * 当前聊天的记忆目录。chatKey 由网关通过 QQ_CHAT_KEY 传进来
 * （private:1846383180 → memory/private_1846383180）。
 */
function chatMemoryDir() {
  const key = String(process.env.QQ_CHAT_KEY || '').trim();
  if (!key) return '';
  return path.join(QQ_DATA, 'memory', key.replace(/[:\\/]/g, '_'));
}

/** 读一个聊天里的所有成员印象，返回 [{name, userId, impressions:[string]}]。 */
function loadImpressions() {
  const dir = chatMemoryDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === '_meta.json') continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const list = Array.isArray(j?.impressions)
        ? j.impressions.map((x) => String(x?.content ?? '')).filter(Boolean)
        : [];
      if (!list.length) continue;
      out.push({ name: String(j?.name || j?.userId || f), userId: String(j?.userId || ''), impressions: list });
    } catch { /* 单个坏文件跳过 */ }
  }
  return out;
}

/**
 * 从 stickers.json 挑一张能发的表情（本地图还在的优先）。
 *
 * hint：按备注/描述关键词挑。她的 system prompt 里只列了备注、**没有 id**
 * （QQ 的表情 id 一条 55 个字符，5 条就 275 字符，每轮白烧 200+ token），
 * 所以她说「发那个叉腰炸毛的」比背一串十六进制现实得多。
 * 命中不了就退回随机 —— 不能因为她记错一个字就发不出去。
 */
export function pickSticker(hint = '') {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(QQ_DATA, 'stickers.json'), 'utf8'));
    if (!Array.isArray(arr) || !arr.length) return null;
    const withId = arr.filter((s) => s && s.id && s.localFile);
    if (!withId.length) return null;
    const local = withId.filter((s) => {
      try {
        const p = decodeURIComponent(String(s.localFile).replace(/^file:\/\/\//, '').replace(/\//g, '\\'));
        return fs.existsSync(p);
      } catch { return false; }
    });
    const pool = local.length ? local : withId;

    const kw = String(hint || '').trim().toLowerCase();
    if (kw) {
      const hay = (s) => `${s.localNote || ''} ${s.desc || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
      const hits = pool.filter((s) => hay(s).includes(kw));
      if (hits.length) return hits[Math.floor(Math.random() * hits.length)];
    }

    const sorted = [...pool].sort((a, b) => (Number(a.useCount) || 0) - (Number(b.useCount) || 0));
    const top = sorted.slice(0, Math.max(3, Math.ceil(sorted.length / 3)));
    return top[Math.floor(Math.random() * top.length)];
  } catch {
    return null;
  }
}

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'qq_sticker',
    description: '给当前 QQ 聊天发一个收藏表情。**可以单独发表情、不带文字**（一条消息只能一张表情）；'
      + '想配一句话就另发一句正文，不想说话就只发这张。'
      + '**只发表情时，正文一个字都不要写**：不要写「发出来了」「这轮我一个字都没写」「给你」这类说明或汇报，直接调用本工具就行。'
      + '传 hint 用关键词挑（比如「叉腰」「炸毛」「晚安」，按表情备注匹配）；不传就随机挑一张。已知的常用表情见 system prompt 里的【表情包】一段。',
    parameters: {
      hint: {
        type: 'string',
        description: '可选：关键词，按表情备注匹配。不知道发哪张就别传，交给工具随机挑。'
      },
      stickerId: {
        type: 'string',
        description: '可选：精确指定表情 id（一般用不上，除非你确知 id）。'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          desc: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.queued ? `表情已排队（${value.desc || '随机一张'}）。` : '没排上。'
      }]
    },
    execute(args) {
      let stickerId = String(args?.stickerId ?? '').trim();
      let desc = '';
      if (!stickerId) {
        const picked = pickSticker(String(args?.hint ?? ''));
        if (!picked) throw new Error('表情库里没有可用表情（stickers.json 为空或图片都不在）');
        stickerId = String(picked.id || picked.resId || '');
        desc = String(picked.desc || picked.localNote || '').slice(0, 40);
      }
      if (!stickerId) throw new Error('这个表情没有 id，换一张');
      pushOutbox({ type: 'sticker', stickerId });
      return Promise.resolve({ queued: true, desc });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '发个表情',
      kind: 'other',
      rawInput: args
    })
  }));

  ctx.tools.register(defineTool({
    name: 'qq_diary',
    description: '把一件事写进今天的日记（长期记忆）。只记值得留的：有后续行动、'
      + '或者想记住的具体瞬间。等级：一般 / 重要 / 非常重要。'
      + '同一个件事不要重复写，写之前先想一下今天是不是已经记过。\n'
      + '**写入是排队的**：这轮回复后由 QQ Agent 真正落盘，所以本轮用 qq_diary_read 还看不到，下一轮才读得到。\n'
      + '**如果这条是老大教你的规矩/你答应要长期照做的事**：mood 填「记住了」，'
      + '正文写成一句**能直接照做**的短句（40 字以内，一条只讲一件事）。'
      + '这类条目会每轮出现在你眼前，所以**一条一条写**——五条规矩就调五次，别抄成一段。',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: '要记的内容，一句话，第一人称，带具体画面。若是老大教的规矩，写成一个能直接照做的动作'
      },
      importance: {
        type: 'string',
        required: true,
        enum: ['一般', '重要', '非常重要'],
        description: '一般=只对当天有意义；重要=有明确后续行动；非常重要=影响长期'
      },
      mood: {
        type: 'string',
        description: '当天心情，默认「平静」。**老大教你的规矩/要你长期照做的事，这里填「记住了」**'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          written: { type: 'boolean', required: true },
          file: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.written ? `写进日记了：${path.basename(value.file)}` : '没写成。'
      }]
    },
    execute(args) {
      const content = stripDiaryPrefix(args?.content);
      if (!content) throw new Error('content 不能为空');
      const importance = String(args?.importance ?? '一般');
      const mood = String(args?.mood ?? '平静').trim() || '平静';
      // 不在这里直接写 E:\dsh\本子\日记 —— 那在 DSH 的沙箱 workspace（QQ-agent）之外，
      // 会被拒。改成排队，由 QQ Agent 在收到这轮回复后写入（同表情的 outbox 机制）。
      pushOutbox({ type: 'diary', content, mood, importance });
      return Promise.resolve({ written: true, file: `${dayKey()}.md（已排队）` });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '写日记',
      kind: 'other',
      rawInput: args
    })
  }));

  // ── 删日记 ──
  // 她手上只有 qq_diary（追加）和 qq_diary_read（读），而 E:\dsh\本子\日记 在 DSH 沙箱
  // workspace 之外，她自己也改不了。没有这个工具时，「让她删一条」的结果是
  // 她回一句「删了」、文件一行没动（2026-10-26 实际发生）。
  ctx.tools.register(defineTool({
    name: 'qq_diary_forget',
    description: '从日记里删掉一条。老大明确让你删（「把那两条删了」「重复的去掉」）时用。'
      + 'match 给那条日记里的一段原文（两个字以上），越具体越好。'
      + '匹配到多条会拒绝并列出候选，那时把 match 写长一点再删一次 —— 不要硬猜。'
      + '删之前会自动备份到 .trash\\，删错了能捞回来。'
      + '**说要删就真的调这个工具**，不要只在回复里说「删了」。',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: '那条日记里的一段原文片段（两个字以上，越具体越不会撞）'
      },
      day: {
        type: 'string',
        description: '可选：限定日期，格式 YYYY-MM-DD。不确定就别传，会在最近 30 天里找'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          match: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.queued
          ? `已经在删了（${value.match}），这条回复发出去之后执行。`
          : '没排上。'
      }]
    },
    execute(args) {
      const match = String(args?.match ?? '').trim();
      if (match.length < 2) throw new Error('match 至少两个字，不然定位不到是哪条');
      const day = String(args?.day ?? '').trim();
      pushOutbox({ type: 'diary-forget', match, day });
      return Promise.resolve({ queued: true, match });
    },
    presentCall: (args) => ({ card: 'generic', title: '删一条日记', kind: 'other', rawInput: args })
  }));

  // ── 改日记等级 ──
  // 2026-10-29 机主：「让她可以修改等级，我让她修改一下」。
  // 她要能听懂「这条该算重要」并自己改，而不是重写一遍或删了重记。
  // 和追加/删除一样走 outbox：E:\dsh\本子\日记 在 DSH 沙箱之外，她写不进去。
  ctx.tools.register(defineTool({
    name: 'qq_diary_level',
    description: '改某条日记的重要性等级（一般 / 重要 / 非常重要）。'
      + '老大说「这条该算重要」「把那条改成非常重要」「这个其实没那么重要」时用。'
      + '只动等级，正文和心情都不动 —— 不需要重写那条，也不要删了重记。'
      + '要带 day（YYYY-MM-DD）和 match（那两个字的原文片段），匹配到多条会被拒绝并列候选。',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: '那条日记里的一段原文（两个字以上，越具体越不会撞）'
      },
      importance: {
        type: 'string',
        required: true,
        enum: ['一般', '重要', '非常重要'],
        description: '改成哪一级'
      },
      day: {
        type: 'string',
        required: true,
        description: '哪一天的日记，YYYY-MM-DD'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          match: { type: 'string', required: true },
          importance: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.queued
          ? `已经在改了（${value.match} → ${value.importance}），这条回复发出去之后执行。`
          : '没排上。'
      }]
    },
    execute(args) {
      const match = String(args?.match ?? '').trim();
      if (match.length < 2) throw new Error('match 至少两个字，不然定位不到是哪条');
      const importance = String(args?.importance ?? '').trim();
      if (!['一般', '重要', '非常重要'].includes(importance)) throw new Error('importance 只能是 一般 / 重要 / 非常重要');
      const day = String(args?.day ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day 要写 YYYY-MM-DD');
      pushOutbox({ type: 'diary-level', match, importance, day });
      return Promise.resolve({ queued: true, match, importance });
    },
    presentCall: (args) => ({ card: 'generic', title: '改日记等级', kind: 'other', rawInput: args })
  }));

  // ── 语音重听：消息里带「（语音原件：路径）」时用这个再转一次 ──
  // 为什么能在 DSH 里同步返回：这里直接 spawn 本机 whisper-cli，不走 QQ Agent
  // 的 outbox 队列（那个队列是「发出去就结束」，拿不到结果）。
  ctx.tools.register(defineTool({
    name: 'qq_transcribe',
    description: '把一段语音重新转成文字。聊天记录里出现「（语音原件：<路径>）」时用，'
      + '想核对转写有没有写错、或者想再“听”一遍时调用。只能转本机已有的音频文件。',
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: '语音文件的绝对路径（来自消息里的「语音原件」）'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.text : `转写失败：${value.text}`
      }]
    },
    async execute(args) {
      const file = String(args?.file ?? '').trim();
      if (!file) throw new Error('file 不能为空');
      if (!fs.existsSync(file)) return { ok: false, text: `找不到语音文件：${file}` };
      const c = sttConf();
      fs.mkdirSync(STT_TMP, { recursive: true });
      const base = path.join(STT_TMP, `qv-${Date.now()}`);
      try {
        await execFileP(c.exePath, ['-m', c.modelPath, '-l', c.language, '-f', file, '-otxt', '-of', base], {
          timeout: 180_000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8'
        });
      } catch (e) {
        return { ok: false, text: String(e?.message ?? e).slice(0, 300) };
      }
      const txt = `${base}.txt`;
      const text = fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8').trim() : '';
      try { fs.rmSync(txt, { force: true }); } catch { /* ignore */ }
      return { ok: true, text: text || '(没识别出内容)' };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '重听语音',
      kind: 'other',
      rawInput: args
    })
  }));

  // ── 手机：DSH 里没有 QQ Agent 的 phone-eye 工具，这里补一个只读的 ──
  // 不加这个的话，老大问「你能用手机了吗」她只能去调 qq_tool 的账号查询，
  // 于是答成「通道连上了、排队中」——驴唇不对马嘴（2026-10-23 21:58 实际发生）。
  ctx.tools.register(defineTool({
    name: 'qq_phone',
    description: '看看借来的那台手机的屏幕（小黑盒或 B 站）。能往下滚，也能**点进某一条帖子**'
      + '去看正文和评论；但还是只读：不能点赞、不能评论、不能 @、不能收藏。'
      + '手机没连、锁着、或者屏幕上看不出东西时，它会直接告诉你原因——照实说，别编。',
    parameters: {
      app: {
        type: 'string',
        enum: ['xiaoheihe', 'bilibili'],
        description: '看哪个应用：小黑盒或 B 站，默认小黑盒'
      },
      scroll: {
        type: 'number',
        description: '往下滚几屏（0-3），默认 0 只看当前屏'
      },
      open: {
        type: 'number',
        description: '点进上一次看到第几条（从 1 开始），进去读正文和评论。要先 look 过一次'
      },
      keyword: {
        type: 'string',
        description: '或者按标题关键词点进去；和 open 二选一'
      },
      see: {
        type: 'boolean',
        description: '要不要把手机屏幕截下来给你看（true 时返回一张图的本地路径，'
          + '你再用 read_image 打开就能看懂画面，而不只是读文字）'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.text : `手机没看成：${value.text}`
      }]
    },
    async execute(args) {
      const app = ['xiaoheihe', 'bilibili'].includes(String(args?.app || '')) ? String(args.app) : 'xiaoheihe';
      const scroll = Math.min(3, Math.max(0, Number(args?.scroll) || 0));
      const openIdx = Math.max(0, Number(args?.open) || 0);
      const keyword = String(args?.keyword || '').trim();
      const opening = Boolean(openIdx || keyword);
      let cmd;
      if (opening) {
        // 点进详情页：会 tap 一次、读全文，然后自动退回列表（只读）
        cmd = ['open'];
        if (openIdx) cmd.push('--index', String(openIdx));
        if (keyword) cmd.push('--keyword', keyword);
        cmd.push('--scroll', '1');
      } else {
        cmd = ['look', '--app', app, '--engine', 'u2'];
        if (scroll) cmd.push('--scroll', String(scroll));
      }
      // adb server 启动时要写 %TEMP%\adb.log；DSH 的沙箱不放行用户 Temp，
      // 于是 daemon 起不来、报 10061（2026-10-23 22:14 实测）。
      // 把 TEMP/TMP 指到工作区里，adb 就有地方写日志了。
      const phoneTmp = path.join(QQ_DATA, 'tmp');
      try { fs.mkdirSync(phoneTmp, { recursive: true }); } catch { /* ignore */ }
      const env = { ...process.env, AIPHONE_ADB: ADB_PATH, TEMP: phoneTmp, TMP: phoneTmp };
      const started = Date.now();
      const envInfo = {
        USERPROFILE: process.env.USERPROFILE || '',
        LOCALAPPDATA: process.env.LOCALAPPDATA || '',
        adb: ADB_PATH
      };
      // 先把 adb server 拉起来并把输出记下来：u2 连的是 127.0.0.1:5037，
      // server 没起来时它只会报 WinError 10061，看不出是“没连手机”还是“server 崩了”。
      try {
        const srv = await execFileP(ADB_PATH, ['start-server'], { timeout: 25_000, windowsHide: true, encoding: 'utf8', env });
        notePhone({
          at: new Date().toISOString(), source: 'qq_phone', step: 'start-server',
          stdout: String(srv.stdout || '').slice(-400),
          stderr: String(srv.stderr || '').slice(-400),
          env: envInfo
        });
      } catch (e) {
        notePhone({
          at: new Date().toISOString(), source: 'qq_phone', step: 'start-server',
          error: String(e?.message ?? e).slice(0, 300),
          stderr: String(e?.stderr || '').slice(-400),
          env: envInfo
        });
      }
      try {
        const { stdout, stderr } = await execFileP(PHONE_PYTHON, ['-X', 'utf8', PHONE_SCRIPT, ...cmd], {
          timeout: 120_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
          env
        });
        const line = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
        if (!line) {
          notePhone({ at: new Date().toISOString(), source: 'qq_phone', app, ms: Date.now() - started, error: 'no output', env: envInfo, stderr: String(stderr || '').slice(-2000) });
          return { ok: false, text: '手机脚本没有输出' };
        }
        const r = JSON.parse(line);
        if (!r?.ok) {
          notePhone({ at: new Date().toISOString(), source: 'qq_phone', app, ms: Date.now() - started, result: r, env: envInfo, stderr: String(stderr || '').slice(-2000) });
          return { ok: false, text: `${String(r?.error || '手机那边没给出结果')}${r?.adb ? `（adb: ${r.adb}）` : ''}` };
        }
        let outText;
        if (opening) {
          const detail = String(r.text || '').trim() || '(点开了，但没认出字来)';
          const head = `《${r.from_title || '?'}》${r.author ? ` —— ${r.author}` : ''}`;
          notePhone({ at: new Date().toISOString(), source: 'qq_phone', app, ms: Date.now() - started, ok: true, opened: true, chars: detail.length, env: envInfo });
          outText = `${head}\n\n${detail}`;
        } else {
          const cards = Array.isArray(r.cards) ? r.cards : [];
          const body = cards.length
            ? cards.slice(0, 6).map((c) => `- ${c.title}`).join('\n')
            : String(r.summary || '(屏幕上没认出能看的内容)');
          const head = cards.length ? `手机上（${app}）看到 ${cards.length} 条：\n` : '';
          notePhone({ at: new Date().toISOString(), source: 'qq_phone', app, ms: Date.now() - started, ok: true, cards: cards.length, env: envInfo });
          outText = `${head}${body}`;
        }
        if (args?.see === true) {
          const shot = await phoneShot(env);
          if (shot) outText += `\n\n【手机截图（想看懂画面就 read_image 打开这个路径）】\n- ${shot}`;
        }
        return { ok: true, text: outText };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/ETIMEDOUT|timed out/i.test(msg)) return { ok: false, text: '手机响应超时（可能没连着）' };
        return { ok: false, text: msg.slice(0, 200) };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '看一眼手机',
      kind: 'other',
      rawInput: args
    })
  }));

  // ── 读取侧：只写不读的话，写进去的东西她自己看不到，照样是健忘 ──

  ctx.tools.register(defineTool({
    name: 'qq_memory',
    description: '翻你还记得的人（长期印象）。聊到某个人、想确认之前记过什么、'
      + '或者想知道自己跟谁熟的时候用。返回的是你以前写下的印象，不是聊天记录。',
    parameters: {
      who: {
        type: 'string',
        description: '按名字或 QQ 号过滤；不填就列出全部'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    execute(args) {
      const who = String(args?.who ?? '').trim();
      let list = loadImpressions();
      if (who) list = list.filter((p) => p.name.includes(who) || p.userId.includes(who));
      if (!list.length) {
        return Promise.resolve({
          found: false,
          text: who ? `你对「${who}」还没有任何印象。` : '这个聊天里你还没记过谁。'
        });
      }
      const lines = list.map((p) => `- ${p.name}：${p.impressions.join(' / ')}`);
      return Promise.resolve({ found: true, text: `你记得这些人：\n${lines.join('\n')}` });
    },
    presentCall: (args) => ({ card: 'generic', title: '翻记忆', kind: 'other', rawInput: args })
  }));

  ctx.tools.register(defineTool({
    name: 'qq_diary_read',
    description: '翻你自己的日记（长期记忆）。想回忆以前发生过什么、或者老大问起旧事时，先翻这里再回答，别凭印象编。\n'
      + '两种翻法：\n'
      + '· 给 keyword → 在**全部**日记里搜包含这个词的条目，只回匹配的几行（找具体的事用这个，省得多天全文）\n'
      + '· 不给 keyword → 读最近 days 天的全文（默认 7 天，最多 60）',
    parameters: {
      keyword: {
        type: 'string',
        description: '可选：关键词。给了就在所有日记里搜，只返回包含它的条目'
      },
      days: {
        type: 'integer',
        description: '往前读几天。给 keyword 时默认搜 60 天，不给时默认读 7 天。上限 60'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    execute(args) {
      const keyword = String(args?.keyword ?? '').trim();
      // 搜的时候默认扫得更远（60 天），读全文时默认 7 天 —— 两种用法目的不同
      const fallback = keyword ? 60 : 7;
      const n = Math.max(1, Math.min(60, Number(args?.days) || fallback));

      // 一次把窗口内的天读出来（最新的在前）
      const daysData = [];
      for (let i = 0; i < n; i += 1) {
        const d = new Date(Date.now() - i * 86_400_000);
        const key = dayKey(d);
        const f = path.join(DIARY_ROOT, `${key}.md`);
        try {
          const t = fs.readFileSync(f, 'utf8').trim();
          if (t) daysData.push({ key, text: t });
        } catch { /* 那天没写 */ }
      }
      if (!daysData.length) return Promise.resolve({ found: false, text: `最近 ${n} 天没有日记。如果你刚调用 qq_diary 写过，写入会在本轮回复后完成，下一轮再读。` });

      // 关键词搜索：只挑包含它的条目（整行），按天归组
      if (keyword) {
        const hits = [];
        for (const day of daysData) {
          const lines = day.text.split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('- ') && l.includes(keyword));
          if (lines.length) hits.push(`【${day.key}】\n${lines.join('\n')}`);
        }
        if (!hits.length) {
          return Promise.resolve({
            found: false,
            text: `最近 ${n} 天的日记里没有找到含「${keyword}」的条目。换个词试试，或者不给 keyword 直接读最近几天的全文。`
          });
        }
        const body = hits.join('\n\n');
        // 搜索命中太多时截断：她一次也读不完，还占上下文
        const capped = body.length > 4000 ? `${body.slice(0, 4000)}\n…（还有更多，把关键词写具体点）` : body;
        return Promise.resolve({ found: true, text: `搜到这些（含「${keyword}」）：\n\n${capped}` });
      }

      const chunks = daysData.map((d) => `【${d.key}】\n${d.text}`);
      return Promise.resolve({ found: true, text: chunks.join('\n\n') });
    },
    presentCall: (args) => ({ card: 'generic', title: '翻日记', kind: 'other', rawInput: args })
  }));

  // ── 她自己的本子（读可以直接；写/改/删走 outbox，由主进程代写）────────
  // 背景：本子在 DSH 沙箱 workspace 之外，她直接写会被拒（2026-11-05 实测）。
  ctx.tools.register(defineTool({
    name: 'qq_notebook_read',
    description: '读你自己的私人本子（只有你自己看）。里面的内容都是你自己写的——包括空闲时写的，不是别人或脚本。想回忆自己写过什么时直接读。',
    parameters: {
      chars: { type: 'integer', description: '读末尾多少字，默认 3000，最多 12000' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    execute(args) {
      const n = Math.max(200, Math.min(12000, Number(args?.chars) || 3000));
      try {
        const t = fs.readFileSync(NOTEBOOK_FILE, 'utf8');
        const tail = t.slice(-n);
        return Promise.resolve({
          found: Boolean(tail.trim()),
          text: tail.trim()
            ? `【你自己的本子（末尾 ${n} 字）】\n${tail}\n\n（这是你自己写的，包括空闲时写的，不是别人或脚本。）`
            : '本子现在是空的。'
        });
      } catch {
        return Promise.resolve({ found: false, text: '本子还读不到（文件不存在或没有权限）。' });
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '翻本子', kind: 'other', rawInput: args })
  }));

  ctx.tools.register(defineTool({
    name: 'qq_notebook_write',
    description: '往你自己的私人本子里追加一段（只有你自己看）。真正写入由 QQ Agent 在你这轮回复后完成；**说要写就调这个工具**，不要只在回复里说「写了」。',
    parameters: {
      text: { type: 'string', required: true, description: '正文，最多 3000 字' },
      title: { type: 'string', description: '小标题，可选' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          note: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.note }]
    },
    execute(args) {
      const text = String(args?.text ?? '').trim();
      if (!text) throw new Error('text 不能为空');
      if (text.length > 3000) throw new Error('单次最多 3000 字');
      pushOutbox({ type: 'notebook-append', text, title: String(args?.title ?? '') });
      return Promise.resolve({ queued: true, note: '已排队，这轮回复后写进本子。' });
    },
    presentCall: (args) => ({ card: 'generic', title: '写本子', kind: 'other', rawInput: args })
  }));

  ctx.tools.register(defineTool({
    name: 'qq_notebook_edit',
    description: '改你自己本子里的一段。match 必须在整本里**唯一出现**，否则不改（避免改错）；真正修改由 QQ Agent 在这轮回复后完成。',
    parameters: {
      match: { type: 'string', required: true, description: '要替换的原文片段（必须唯一）' },
      text: { type: 'string', required: true, description: '替换后的新内容，最多 3000 字' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          note: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.note }]
    },
    execute(args) {
      const match = String(args?.match ?? '').trim();
      const text = String(args?.text ?? '').trim();
      if (!match) throw new Error('match 不能为空');
      if (!text) throw new Error('text 不能为空');
      pushOutbox({ type: 'notebook-edit', match, text });
      return Promise.resolve({ queued: true, note: '已排队，这轮回复后改本子。' });
    },
    presentCall: (args) => ({ card: 'generic', title: '改本子', kind: 'other', rawInput: args })
  }));

  ctx.tools.register(defineTool({
    name: 'qq_notebook_delete',
    description: '删你自己本子里的**一整条**（按内容定位整条）。match 必须唯一出现；真正删除由 QQ Agent 在这轮回复后完成（本轮读不到，下一轮才看得到）；**说要删就调这个工具**，不要只在回复里说「删了」。',
    parameters: {
      match: { type: 'string', required: true, description: '要删的条目里的一句原文（必须唯一）' },
      confirm: { type: 'boolean', required: true, description: '确认删除，必须为 true' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          note: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.note }]
    },
    execute(args) {
      const match = String(args?.match ?? '').trim();
      if (!match) throw new Error('match 不能为空');
      if (args?.confirm !== true) throw new Error('删除需要 confirm: true');
      pushOutbox({ type: 'notebook-delete', match });
      return Promise.resolve({ queued: true, note: '已排队，这轮回复后删这条（会先备份）。' });
    },
    presentCall: (args) => ({ card: 'generic', title: '删本子', kind: 'other', rawInput: args })
  }));

  // ── 浏览与评论：B 站 / 小黑盒 ─────────────────────────────────
  // 读（搜索、详情、评论列表）随时可用；写需要登录态：
  //   · B 站 → data/bili-auth.json（Cookie：SESSDATA + bili_jct）
  //   · 小黑盒 → data/xhh-auth.json（现成的）
  // 客户端只建一次，之后每次调用前它们自己会重读凭据文件，
  // 所以重新导入 Cookie 不用重启机器人。

  let socialCache = null;
  function socialKit() {
    if (socialCache) return socialCache;
    let biliCookie = '';
    try {
      const j = JSON.parse(fs.readFileSync(path.join(QQ_DATA, 'bili-auth.json'), 'utf8'));
      biliCookie = Object.entries(j.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
    } catch { /* 没导入也能读，只是读接口不需要 Cookie */ }
    socialCache = {
      readers: makeSocialClients({ dataDir: QQ_DATA, biliCookie }),
      bili: new BiliWriter({ authFile: path.join(QQ_DATA, 'bili-auth.json') }),
      xhh: new XhhWriter({
        authFile: path.join(QQ_DATA, 'xhh-auth.json'),
        outboxFile: path.join(QQ_DATA, 'social-outbox.json')
      })
    };
    return socialCache;
  }

  ctx.tools.register(defineTool({
    name: 'qq_browse',
    description: '去 B 站或小黑盒上搜东西、或者看一条内容的详情。看详情时会把标题、正文/简介和评论一起给你——'
      + '你据此总结「这条在讲什么、大家在说什么」。B 站贴 BV 号、小黑盒贴帖子 id、'
      + '**或者直接把分享链接整条贴进来**，都能直接看详情；给关键词就是搜索。'
      + '**这只是看，不会发任何东西。**',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '关键词（如「黑神话」「丝之歌定价」），或者 BV 号 / 小黑盒帖子 id'
      },
      source: {
        type: 'string',
        enum: ['auto', 'bili', 'xhh'],
        description: '去哪找：bili=B站，xhh=小黑盒；auto 会按 query 像不像 ID 自动判断，关键词时两边都搜'
      },
      replyLimit: {
        type: 'number',
        description: '详情里带几条评论，默认 6，最多 20'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : `没看成：${value.text}` }]
    },
    async execute(args) {
      const raw = String(args?.query ?? '').trim();
      if (!raw) return { ok: false, text: 'query 不能为空' };
      const limit = Math.max(1, Math.min(20, Number(args?.replyLimit) || 6));
      const kit = socialKit();
      let source = ['auto', 'bili', 'xhh'].includes(String(args?.source || '')) ? String(args.source) : 'auto';

      // 机主分享时发的是链接，不是 ID —— 先试着从链接里抠出 id，
      // 抠不到再退回「当关键词搜」（2026-10-26：小黑盒分享链接曾整条被当成关键词）。
      let share = parseShareLink(raw);
      let q = raw;
      if (share) {
        let link = share;
        if (!link.id && link.source === 'bili' && /b23\.tv/i.test(raw)) {
          const real = await expandShortLink(raw);
          if (real) link = parseShareLink(real) || link;
        }
        if (link.id) {
          q = link.id;
          if (source === 'auto') source = link.source;
        } else if (link.source) {
          // 认得域名但抠不到 id（比如短链展开失败、或帖子链接的结构变了）
          return {
            ok: false,
            text: `这是个 ${link.source === 'bili' ? 'B 站' : '小黑盒'}链接，但里面没有能直接用的内容 id。`
              + '把标题或者帖子里的关键词发我，我去搜。'
          };
        }
      }

      const looksId = Boolean(guessSource(q));
      if (source === 'auto') source = guessSource(q) || 'both';

      try {
        if (looksId && source !== 'both') {
          const d = source === 'bili'
            ? await detailBili(kit.readers.bili, q, { replyLimit: limit })
            : await detailXhh(kit.readers.xhh, q, { replyLimit: limit });
          if (!d.ok) return { ok: false, text: d.error || '拿不到详情' };
          // 只有小黑盒的图值得看（帖子里的截图/攻略图）；B 站封面没信息量，
          // 按机主要求不下（2026-10-24）。
          let imgHead = '';
          try {
            if (source === 'xhh' && d.imageUrls?.length) {
              const imgs = await downloadImages(d.imageUrls, {
                dir: path.join(QQ_DATA, 'social-images'),
                limit: 3
              });
              if (imgs.length) {
                // ★ 放最前面：帖子正文很长，路径跟在末尾容易被截断，她就「看不了图」
                imgHead = `【这条内容有 ${imgs.length} 张图，想看懂画面就 read_image 打开下面的路径】\n`
                  + `${imgs.map((f) => `- ${f}`).join('\n')}\n\n`;
              }
            }
          } catch { /* 下载失败不影响文字 */ }
          return { ok: true, text: imgHead + d.text };
        }

        if (source === 'bili' || source === 'both') {
          const r = await searchBili(kit.readers.bili, q, { limit: 6 });
          if (r.ok && r.items.length) {
            return { ok: true, text: `B 站搜到这些（想看哪条就再来一次，query 传 BV 号）：\n${formatItemList('bili', r.items)}` };
          }
          if (source === 'bili') return { ok: false, text: r.error || 'B 站没搜到' };
        }
        if (source === 'xhh' || source === 'both') {
          const r = await searchXhh(kit.readers.xhh, q, { limit: 6 });
          if (r.ok && r.items.length) {
            return { ok: true, text: `小黑盒搜到这些（想看哪条就再来一次，query 传帖子 id）：\n${formatItemList('xhh', r.items)}` };
          }
          if (source === 'xhh') return { ok: false, text: r.error || '小黑盒没搜到' };
        }
        return { ok: false, text: `两边都没搜到「${q}」` };
      } catch (e) {
        return { ok: false, text: String(e?.message ?? e).slice(0, 200) };
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `看看 ${args?.query ?? ''}`, kind: 'other', rawInput: args })
  }));

  ctx.tools.register(defineTool({
    name: 'qq_comment',
    description: '在 B 站视频或小黑盒帖子下面发一条评论。可以回复某条已有评论（楼中楼），也可以 @ 人。'
      + '发之前先确认内容和对象；发完把平台的真实结果告诉她（成功就说发了，失败就原样说原因，别粉饰）。'
      + '**这会用她自己的账号公开发言**，别拿来刷、别发重复内容。',
    parameters: {
      source: {
        type: 'string',
        enum: ['bili', 'xhh', 'xhh-app', 'xhh-inbox'],
        required: true,
        description: 'bili=B 站视频评论区，xhh=小黑盒接口（会被资质拦），'
          + 'xhh-app=小黑盒用手机 App 发主评论，'
          + 'xhh-inbox=小黑盒**回复收件箱里第 N 条消息**（真机走 OCR，慢但能成）'
      },
      target: {
        type: 'string',
        description: 'B 站传 BV 号；小黑盒传帖子 id。xhh-app 时这项可传帖子标题里的关键词（或改用 keyword）'
      },
      text: {
        type: 'string',
        required: true,
        description: '评论正文。她已经会说人话，按她的口吻写，别放客套模板'
      },
      keyword: {
        type: 'string',
        description: 'xhh-app 专用：要发到哪篇帖子，传标题里的一段文字（比 index 稳）'
      },
      index: {
        type: 'number',
        description: 'xhh-inbox 专用：收件箱里第几条消息（从上往下数，1 开始，默认 1）'
      },
      replyTo: {
        type: 'string',
        description: '回复哪条评论（楼中楼）：传那条评论的 id（B 站 rpid / 小黑盒 commentid）。不传就是发主评论'
      },
      root: {
        type: 'string',
        description: '楼中楼的楼层根 id，默认等于 replyTo'
      },
      mention: {
        type: 'string',
        description: '要 @ 的人：传 "owner" 就是 @ 老大本人（昵称从配置读，别自己拼）；'
          + '也可以传具体昵称。B 站正文里其他 @ 会被自动转成全角，避免误 @ 到路人'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    async execute(args) {
      const source = String(args?.source || '');
      const target = String(args?.target ?? '').trim();
      const text = String(args?.text ?? '').trim();
      const replyTo = String(args?.replyTo ?? '').trim();
      const root = String(args?.root ?? '').trim();
      const rawMention = String(args?.mention ?? '').trim();
      // "owner" 是给她的简写：她不用记住老大的 B 站昵称，配置里读
      const mention = rawMention === 'owner' ? ownerMention(source) : rawMention;
      if (!['bili', 'xhh', 'xhh-app', 'xhh-inbox'].includes(source)) return { ok: false, text: 'source 只能是 bili / xhh / xhh-app / xhh-inbox' };
      if (source !== 'xhh-inbox' && !target && !String(args?.keyword || '').trim()) return { ok: false, text: 'target 不能为空' };
      if (!text) return { ok: false, text: '评论内容不能为空' };

      // 小黑盒真机路线：web 接口被账号资质挡死（-「评论功能暂不可用」），
      // 但 App 里能发。走 phone_eye.py comment：点进帖子 → 输入 → 发送。
      if (source === 'xhh-app') {
        const phoneTmp = path.join(QQ_DATA, 'tmp');        try { fs.mkdirSync(phoneTmp, { recursive: true }); } catch { /* ignore */ }
        const env = { ...process.env, AIPHONE_ADB: ADB_PATH, TEMP: phoneTmp, TMP: phoneTmp };
        const cmd = ['-X', 'utf8', PHONE_SCRIPT, 'comment', '--text', text];
        const kw = String(args?.keyword || target || '').trim();
        if (kw) cmd.push('--keyword', kw);
        if (mention) cmd.push('--mention', mention);
        try {
          const { stdout } = await execFileP(PHONE_PYTHON, cmd, {
            timeout: 180_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env
          });
          const line = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
          if (!line) return { ok: false, text: '手机脚本没有输出' };
          const r = JSON.parse(line);
          notePhone({ at: new Date().toISOString(), source: 'qq_comment', step: 'phone-comment', result: r });
          if (!r?.ok) return { ok: false, text: `手机上没发出去：${r?.error || r?.reason || '原因不明'}` };
          return {
            ok: true,
            text: `在手机上发出去了（${r.from ? `《${r.from}》下` : '当前帖子'}）。${r.reason || ''}`
          };
        } catch (e) {
          const msg = String(e?.message ?? e);
          if (/ETIMEDOUT|timed out/i.test(msg)) return { ok: false, text: '手机那边超时（可能没连着或卡住了）' };
          return { ok: false, text: `手机路径失败：${msg.slice(0, 160)}` };
        }
      }

      if (source === 'xhh-inbox') {
        const idx = Math.max(1, Math.min(20, Number(args?.index) || 1));
        const phoneTmp = path.join(QQ_DATA, 'tmp');
        try { fs.mkdirSync(phoneTmp, { recursive: true }); } catch { /* ignore */ }
        const env = { ...process.env, AIPHONE_ADB: ADB_PATH, TEMP: phoneTmp, TMP: phoneTmp };
        // 收件箱一屏只放得下三条左右，第 4 条以后「回复」按钮在屏幕外
        // （2026-10-25 机主实测）。传 keyword=对方昵称更稳，脚本会滚动去找；
        // 只给 index 就只在当前屏找，找不到会明确报错而不是点错人。
        const args2 = ['-X', 'utf8', PHONE_SCRIPT, 'inbox-reply', '--text', text];
        const who = String(args?.keyword ?? '').trim();
        if (who) args2.push('--match', who);
        else args2.push('--index', String(idx));
        try {
          const { stdout } = await execFileP(PHONE_PYTHON, args2, {
            timeout: 240_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env
          });
          const line = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
          if (!line) return { ok: false, text: '手机脚本没有输出' };
          const r = JSON.parse(line);
          notePhone({ at: new Date().toISOString(), source: 'qq_comment', step: 'inbox-reply', result: r });
          if (!r?.ok) return { ok: false, text: `手机上没回成：${r?.error || r?.reason || '原因不明'}` };
          return {
            ok: true,
            text: who
              ? `已经在手机上回了「${who}」那条（楼中楼）。`
              : `已经在手机上回复了收件箱第 ${idx} 条消息（楼中楼）。`
          };
        } catch (e) {
          const msg = String(e?.message ?? e);
          if (/ETIMEDOUT|timed out/i.test(msg)) return { ok: false, text: '手机那边超时（可能没连着或卡住了）' };
          return { ok: false, text: `手机路径失败：${msg.slice(0, 160)}` };
        }
      }

      const kit = socialKit();
      try {
        if (source === 'bili') {
          const w = kit.bili;
          if (!w.loggedIn) {
            return { ok: false, text: `B 站还没导入登录态，发不了评论（${w.lastAuthError}）。让老大往 data/bili-auth.json 导入 Cookie。` };
          }
          const r = await w.comment(target, text, {
            root: root || replyTo || undefined,
            parent: replyTo || undefined,
            mention,
            resolveAid: async (bvid) => {
              const v = await kit.readers.bili.video(bvid);
              return v.ok ? v.aid : 0;
            }
          });
          if (!r.ok) return { ok: false, text: `没发出去：${r.error}` };
          const kind = r.root ? '回复' : '评论';
          return { ok: true, text: `发出去了（B 站${kind}${r.mentioned ? `，@了 ${r.mentioned}` : ''}，rpid ${r.rpid}）。` };
        }

        const w = kit.xhh;
        if (!w.loggedIn) return { ok: false, text: `小黑盒还没导入登录态（${w.lastAuthError}）` };
        const r = await w.comment({
          linkId: target,
          text,
          replyId: replyTo || '-1',
          rootId: root || replyTo || '-1',
          mention
        });
        if (r.duplicated) return { ok: r.ok, text: r.error || '这条刚发过，没重复发' };
        if (!r.ok) {
          return {
            ok: false,
            text: r.sendUnknown
              ? `结果不确定：${r.error}。先别再发，我核对过最近评论再说。`
              : `没发出去：${r.error}`
          };
        }
        return { ok: true, text: `发出去了（小黑盒${replyTo ? '楼中楼' : '评论'}${r.mentioned ? `，@了 ${r.mentioned}` : ''}）。` };
      } catch (e) {
        return { ok: false, text: String(e?.message ?? e).slice(0, 200) };
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `评论 ${args?.target ?? ''}`, kind: 'other', rawInput: args })
  }));

  ctx.tools.register(defineTool({
    name: 'qq_inbox',
    description: '看谁回复了你、谁 @ 了你（B 站和/或小黑盒）。每条都会告诉你「要回这条」该传什么参数——'
      + '拿着 target / replyTo / root 去 qq_comment 就能回楼中楼。'
      + '有人回你时先看这里再说话，别凭印象猜。',
    parameters: {
      source: {
        type: 'string',
        enum: ['both', 'bili', 'xhh'],
        description: '看哪个平台，默认两个都看'
      },
      limit: {
        type: 'number',
        description: '每个平台取几条，默认 8，最多 20'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    async execute(args) {
      const source = ['both', 'bili', 'xhh'].includes(String(args?.source || '')) ? String(args.source) : 'both';
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 8));
      const kit = socialKit();
      const [bili, xhh] = await Promise.all([
        source === 'xhh'
          ? Promise.resolve(null)
          : inboxBili({ cookie: readBiliCookie(path.join(QQ_DATA, 'bili-auth.json')), limit })
            .catch((e) => ({ ok: false, error: String(e?.message ?? e), items: [] })),
        source === 'bili'
          ? Promise.resolve(null)
          : inboxXhh(kit.readers.xhh, { limit }).catch((e) => ({ ok: false, error: String(e?.message ?? e), items: [] }))
      ]);
      const text = formatInbox({ bili, xhh, limit });
      return { ok: true, text };
    },
    presentCall: (args) => ({ card: 'generic', title: '看收件箱', kind: 'other', rawInput: args })
  }));

  ctx.tools.register(defineTool({
    name: 'qq_publish',
    description: '在小黑盒发一篇帖子（纯文字，可选分区/话题）。走手机 App 真机操作，20–40 秒。'
      + '**发出去就是公开内容**，会挂在她的账号下；想清楚再发，别刷屏、别发测试垃圾。'
      + '分区/话题传她能确认存在的名字（如「盒友杂谈」「ai.ai」），搜不到就不选。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: '标题'
      },
      body: {
        type: 'string',
        required: true,
        description: '正文'
      },
      topics: {
        type: 'string',
        description: '分区/话题，多个用逗号分隔，例如「盒友杂谈,ai.ai」。不传就只发文字'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    async execute(args) {
      const title = String(args?.title ?? '').trim();
      const body = String(args?.body ?? '').trim();
      const topics = String(args?.topics ?? '')
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 6);
      if (!title) return { ok: false, text: '标题不能为空' };
      if (!body) return { ok: false, text: '正文不能为空' };

      const phoneTmp = path.join(QQ_DATA, 'tmp');
      try { fs.mkdirSync(phoneTmp, { recursive: true }); } catch { /* ignore */ }
      const env = { ...process.env, AIPHONE_ADB: ADB_PATH, TEMP: phoneTmp, TMP: phoneTmp };
      const cmd = ['-X', 'utf8', PHONE_SCRIPT, 'publish', '--title', title, '--body', body];
      for (const t of topics) cmd.push('--topic', t);
      try {
        const { stdout } = await execFileP(PHONE_PYTHON, cmd, {
          timeout: 300_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env
        });
        const line = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
        if (!line) return { ok: false, text: '手机脚本没有输出' };
        const r = JSON.parse(line);
        notePhone({ at: new Date().toISOString(), source: 'qq_publish', result: r });
        if (!r?.ok) return { ok: false, text: `没发出去：${r?.error || r?.reason || '原因不明'}` };
        const picked = Array.isArray(r.topics) && r.topics.length ? `（分区：${r.topics.join('、')}）` : '';
        return { ok: true, text: `已经在手机上发出去了${picked}。` };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/ETIMEDOUT|timed out/i.test(msg)) return { ok: false, text: '手机那边超时（可能没连着或卡住了）' };
        return { ok: false, text: `手机路径失败：${msg.slice(0, 160)}` };
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `发帖：${args?.title ?? ''}`, kind: 'other', rawInput: args })
  }));

  // ── 发本地图片（手机截图 / 帖子里的图）──
  // 她能看图（read_image），但一直不能把图发出去。这里写进 outbox，
  // 网关在拿到回复后合成 `send_image(localPath=…)`，由 QQ Agent 那边
  // 读文件转 base64 发出去（目录白名单在 tools.js 里校验）。
  ctx.tools.register(defineTool({
    name: 'qq_send_image',
    description: '把一张**本机图片**发到当前 QQ 聊天。典型场景：你在小黑盒/B 站刷到想跟老大分享的内容——'
      + '先用 qq_browse 看详情（它会把帖子里的图下到 social-images 并给你路径），'
      + '或者先用 qq_phone 传 see:true 截一张手机屏，'
      + '或者用 qq_draw 画一张（传 send:false 时它只画不发，路径给你）。'
      + '然后把拿到的路径传进来。'
      + '可以配一句话一起发（note），链接和文字用 send_message 正常说。'
      + '**发之前先想清楚这张图适不适合给他看**（截图可能带别人的头像/私信）。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '图片的本地绝对路径（必须是 qq_phone / qq_browse 返回给你的那个路径）'
      },
      note: {
        type: 'string',
        description: '可选：配一句话一起发（不传就只发图）'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          path: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.queued ? '图排上队了，这条回复发出去之后跟着发。' : '没排上。'
      }]
    },
    execute(args) {
      const p = String(args?.path ?? '').trim();
      if (!p) throw new Error('path 不能为空');
      pushOutbox({ type: 'image', path: p, note: String(args?.note ?? '') });
      return Promise.resolve({ queued: true, path: p });
    },
    presentCall: (args) => ({ card: 'generic', title: '发一张图', kind: 'other', rawInput: args })
  }));

  // ── 列已经存下来的图 ──
  // 2026-10-31 她说「我这边翻目录的工具坏了，只能按记得的路径挑一张」——
  // qq_browse 只给**当前这条内容**的图路径，历史图没有入口，她只能凭记忆报路径。
  // 这个工具补的就是"翻自己的图库"：列最近存下的图（帖子图 / 自己画的），给绝对路径。
  ctx.tools.register(defineTool({
    name: 'qq_images',
    description: '列出已经存下来、可以直接发的图。'
      + 'social=你翻帖子时下载的图；draw=你自己画过的画。记不清路径、或者想挑一张以前存的图时用。'
      + '拿到路径传给 qq_send_image 就能发。',
    parameters: {
      source: {
        type: 'string',
        enum: ['all', 'social', 'draw'],
        description: '要哪一类：social=帖子图，draw=自己画的，all=都要（默认）'
      },
      limit: {
        type: 'number',
        description: '最多列几张，默认 10，最多 30'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          count: { type: 'number', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    execute(args) {
      const src = ['all', 'social', 'draw'].includes(String(args?.source || '')) ? String(args.source) : 'all';
      const limit = Math.max(1, Math.min(30, Number(args?.limit) || 10));
      const dirs = [];
      if (src === 'all' || src === 'social') dirs.push({ dir: path.join(QQ_DATA, 'social-images'), tag: '帖子图' });
      if (src === 'all' || src === 'draw') dirs.push({ dir: path.join(QQ_DATA, 'drawings'), tag: '自己画的' });

      const all = [];
      for (const d of dirs) {
        let files = [];
        try { files = fs.readdirSync(d.dir); } catch { continue; }
        for (const f of files) {
          if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
          if (/^style-/i.test(f)) continue;   // 画风模板图，不是作品
          const p = path.join(d.dir, f);
          try { all.push({ p, tag: d.tag, t: fs.statSync(p).mtimeMs }); } catch { /* 读不到就跳过 */ }
        }
      }
      all.sort((a, b) => b.t - a.t);
      const picked = all.slice(0, limit);
      if (!picked.length) return { ok: true, count: 0, text: '图库里还没有存下来的图。' };
      const lines = picked.map((x) => `- ${x.p}（${x.tag}，${new Date(x.t).toLocaleString('zh-CN', { hour12: false })}）`);
      return {
        ok: true,
        count: picked.length,
        text: `最近存下来 ${picked.length} 张：\n${lines.join('\n')}\n\n要发哪张，把路径传给 qq_send_image。`
      };
    },
    presentCall: (args) => ({ card: 'generic', title: '列图片', kind: 'other', rawInput: args })
  }));

  // ── 画画 ──
  // 她没有文生图模型（这台机器只有 DeepSeek 文本 key），所以「画」不是描述一句话
  // 就出图，而是**用几何图元拼**：她给画布 + 一组图形指令，scripts/draw/render.py
  // 用 Pillow 画成 PNG。适合简笔画、示意图、梗图、祝福小卡。
  //
  // 为什么不在 JS 里画：没有 sharp/canvas/resvg，Electron 的 Chromium 又不在
  // headless 子进程里；而 Pillow 早就装好了（AIPhone 的 OCR venv 之外，
  // 系统 Python 3.14 自带 12.x）。
  ctx.tools.register(defineTool({
    name: 'qq_draw',
    description: [
      '画一张图发给老大。',
      '',
      '你没有文生图模型，所以不是「说一句话就出图」，而是**用几何图形拼**：',
      '你给画布和一组图形指令，本机渲染器画成 PNG，再按 style 上一层手绘感。',
      '适合简笔画、示意图、梗图、小卡片、把一件事画给他看。',
      '',
      '## 先选画风（scene.style）',
      '· crayon（默认）：蜡笔手绘，线条会抖、有纸纹、整张略微歪——最像「你画的」',
      '· picturebook：绘本，边缘更柔、颜色更暖更饱和',
      '· flat：干净扁平，大色块，适合示意图/图表',
      '· pixel：像素风，块状复古',
      '',
      '## scene 的形状',
      '{"width":900,"height":600,"background":"#1e2a45","style":"crayon","shapes":[ 图形, 图形, ... ]}',
      '· width/height 默认 900x600，最大 2000；坐标原点在**左上角**，x 向右、y 向下，单位是像素',
      '· background 可以写 "#1e2a45"，也可以写 {"type":"linear","from":"#112","to":"#446","angle":90}',
      '· shapes 按数组顺序叠：后面的盖住前面的',
      '',
      '## 能用哪些图形',
      '· {"type":"rect","x":..,"y":..,"w":..,"h":..,"radius":..,"fill":..,"stroke":..,"strokeWidth":..}',
      '· {"type":"circle","cx":..,"cy":..,"r":..,"fill":..}',
      '· {"type":"ellipse","cx":..,"cy":..,"rx":..,"ry":..,"fill":..}',
      '· {"type":"polygon","points":[[x,y],[x,y],[x,y]],"fill":..}  ← 三角、星星、箭头、任意形状都靠它（至少 3 点）',
      '· {"type":"line","points":[[x,y],[x,y],...],"stroke":..,"strokeWidth":..}  ← 折线，拐角自动圆滑',
      '· {"type":"arc","cx":..,"cy":..,"rx":..,"ry":..,"start":0,"end":180,"stroke":..,"strokeWidth":..}',
      '· {"type":"text","x":..,"y":..,"text":"…","size":40,"fill":"#fff","font":"sans|hei|song|mono","bold":false,"anchor":"lt|mt|mm|mb","align":"left|center|right"}',
      '每个图形都可以再加 opacity（0~1）和 rotate（角度，顺时针）。',
      '颜色：\'#rrggbb\'、\'#rrggbbaa\'、[r,g,b] 或 \'red\'。不写 fill 就是透明，描边要 stroke 配 strokeWidth。',
      '',
      '## 画得像的五条',
      '1. 先铺背景（深色底 + 亮色主体最出效果），再画主体，最后放文字。',
      '2. 主体用**大色块**，别用细线勾轮廓——扁平比线稿好看得多。',
      '3. 留白：四周留 60~120px，别把画布塞满。',
      '4. 一张画最多 3 个元素 + 1 行标题，多了就乱。',
      '5. 标题 size 36~48、anchor:"mt"，x 取画布宽度的一半。',
      '',
      '## 你的调色板（用顺了就有辨识度，不是硬规定）',
      '奶油白 #f7f1e3 / 暖橘 #f6a259 / 雾蓝 #8cc5ea / 夜空 #1c2541 / 薄荷 #9ed9c3 / 珊瑚 #ef7b6f。',
      '底色深就用奶油白写字，底色浅就用夜空色写字。',
      '',
      '## 语法示例（只看格式，构图别照抄——画你自己的）',
      '{"width":900,"height":600,"background":"#1c2541","style":"crayon","shapes":[',
      '{"type":"circle","cx":250,"cy":165,"r":68,"fill":"#ffe9a8"},',
      '{"type":"circle","cx":300,"cy":140,"r":58,"fill":"#1c2541"},',
      '{"type":"ellipse","cx":430,"cy":445,"rx":88,"ry":105,"fill":"#f6a259"},',
      '{"type":"circle","cx":430,"cy":310,"r":76,"fill":"#f6a259"},',
      '{"type":"polygon","points":[[368,262],[396,192],[432,258]],"fill":"#f6a259"},',
      '{"type":"circle","cx":402,"cy":298,"r":13,"fill":"#2b2b2b"},',
      '{"type":"text","x":450,"y":40,"text":"今晚的月亮很圆","size":34,"fill":"#ffe9a8","anchor":"mt"}]}',
      '',
      '## 起个标题（title 参数）',
      '给画起个短标题，存在画廊里（不会画在画面上）。像「今晚的月亮很圆」「给你的小鱼」这种，',
      '老大翻面板时看到的就是这个名字。不起就只显示时间。',
      '',
      '## 发不发',
      '· 默认 send=true：画好**直接发出去**，note 会当配文一起发。',
      '· 没把握就先 send=false：只画不发，你用 read_image 看一眼，满意再 qq_send_image 发这个路径。',
      '· 返回的 path 也能直接 read_image 复查。'
    ].join('\n'),
    parameters: {
      scene: {
        type: 'json',
        required: true,
        description: '完整的场景对象：{width,height,background,style,shapes:[...]}，语法见上面的说明。'
      },
      title: {
        type: 'string',
        description: '可选：给这幅画起个标题（画面上不会自动写，但会存进画廊，老大翻的时候能看见）。像「今晚的月亮很圆」这种，别超过 12 个字。'
      },
      note: {
        type: 'string',
        description: '可选：跟图一起发的一句话（比如「给你画的」）。'
      },
      send: {
        type: 'boolean',
        description: '可选：默认 true 直接发；传 false 只画不发，留给你自己先看。'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          drawn: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          title: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          style: { type: 'string' },
          sent: { type: 'boolean' }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.drawn
          ? (value.sent === false
            ? `画好了${value.title ? `（《${value.title}》）` : ''}：${value.path}（${value.width}x${value.height}，还没发，你先看）`
            : `画好了${value.title ? `（《${value.title}》）` : ''}，已经发出去（${value.width}x${value.height}）。存进画廊了，老大在面板里翻得到。`)
          : '没画成。'
      }]
    },
    async execute(args) {
      const scene = args?.scene;
      if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
        throw new Error('scene 必须是一个对象：{width,height,background,shapes:[...]}');
      }
      const shapes = scene.shapes || scene.layers;
      if (!Array.isArray(shapes) || !shapes.length) {
        throw new Error('shapes 是空的，至少画一个图形');
      }
      const spec = { ...scene };
      delete spec.layers;
      if (!spec.shapes) spec.shapes = shapes;

      const title = String(args?.title ?? '').trim().slice(0, 60);
      const note = String(args?.note ?? '');
      const rendered = await renderScene(spec);
      if (!rendered.ok) {
        throw new Error(`没画出来：${String(rendered.error || '渲染失败').slice(0, 200)}`);
      }

      const png = String(rendered.path);
      // 记进索引：画廊要靠它显示标题、按来源分组。画图本体已经落盘，
      // 这里失败也不该让整次调用失败（图还是发得出去的）。
      try {
        recordDrawing({
          file: path.basename(png),
          title,
          note,
          style: rendered.style,
          source: 'chat',
          width: rendered.width,
          height: rendered.height,
          bytes: rendered.bytes
        });
      } catch { /* 索引写不进去不影响发图 */ }

      const shouldSend = args?.send !== false;
      if (shouldSend) {
        pushOutbox({ type: 'image', path: png, note });
      }
      return {
        drawn: true,
        path: png,
        title,
        width: Number(rendered.width) || 0,
        height: Number(rendered.height) || 0,
        style: String(rendered.style || ''),
        sent: shouldSend
      };
    },
    presentCall: (args) => ({ card: 'generic', title: '画一张图', kind: 'other', rawInput: args })
  }));

  // ── 通用桥：调 QQ Agent 自己的工具 ──
  // 这些工具（提醒 / 空间 / 资料）依赖聊天上下文（ctx），没法在 DSH 里重写，
  // 所以只把「调用意图」写进队列，由网关在拿到回复后合成真正的 tool_call，
  // 交回原有的执行路径（限频、存档、ctx 全都还在）。

  ctx.tools.register(defineTool({
    name: 'qq_tool',
    description: '调用 QQ 平台的能力（这些工具不在你的常规工具列表里）。可用：\n'
      + '- `set_reminder`：设提醒。参数 {"text":"到点说什么","delayMinutes":30} 或 '
      + '{"text":"…","atTime":"18:30"}；"到点拍我"用 {"action":"poke"}\n'
      + '- `qqzone__post_mood` / `qqzone__post_diary`：发空间说说/日记。参数 {"content":"…"}\n'
      + '- `qq-self__get_self_state`：看自己的昵称、签名、性别和最近动态（无参数）。'
      + '改资料前先调它，能确认当前值、也能避免重复改\n'
      + '- `qq-self__update_profile`：改昵称/签名/性别。参数 '
      + '{"nickname":"…","signature":"…","sex":0|1|2}（都可选，传哪个改哪个）\n'
      + '- `qq-self__publish_dynamic`：发 QQ 动态。参数 {"content":"…"}，可选 '
      + '{"visibility":"friends|public|self"}\n'
      + '- `qq-self__set_avatar`：换头像。参数 {"stickerId":"…"} 或 {"imageUrl":"公开图片链接"} 之一\n'
      + '- `send_poke`：拍一拍。私聊不用参数；群聊传 {"targetUserId": 数字QQ号}\n'
      + '注意：QQ 接口对资料修改有频控，改太快会被拒（报"账号侧限制/频控"），'
      + '这时如实告诉老大，不要反复重试。\n'
      + 'argsJson 传该工具参数的 JSON 字符串，不传就当 {}。',
    parameters: {
      tool: {
        type: 'string',
        required: true,
        description: '工具名，如 set_reminder / qqzone__post_mood / qq-self__get_self_state'
      },
      argsJson: {
        type: 'string',
        description: '该工具参数的 JSON 字符串，例如 {"text":"该吃饭了","delayMinutes":30}'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          tool: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.queued ? `${value.tool} 已排队，回复发出后会执行。` : '没排上。'
      }]
    },
    execute(args) {
      const tool = String(args?.tool ?? '').trim();
      if (!tool) throw new Error('tool 不能为空');
      let parsed = {};
      const raw = String(args?.argsJson ?? '').trim();
      if (raw) {
        try { parsed = JSON.parse(raw); } catch { throw new Error('argsJson 不是合法 JSON'); }
      }
      pushOutbox({ type: 'tool', name: tool, args: parsed });
      return Promise.resolve({ queued: true, tool });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `调用 ${args?.tool ?? ''}`,
      kind: 'other',
      rawInput: args
    })
  }));
}

export { name, inject, apply };
