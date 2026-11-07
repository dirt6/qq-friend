// DSH 网关：把一轮 QQ 对话交给 `dsh headless` 跑，拿回最终回复。
//
// 为什么要它：QQ Agent 自己的模型调用是无状态的，上下文只有最近 80 条，
// 工具也只有聊天域那 58 个。DSH 是完整 agent 运行时——有工作区、文件读写、
// shell、技能，会话还是持久化的。把对话转过去，她能记住更多、也能真的碰到
// 电脑上的东西（受 DSH 自己的权限策略约束）。
//
// 通信方式是子进程 + NDJSON：
//   dsh headless --json [--session-id <sid>] "<消息>"
// 事件流里 type=final 是最终回复，type=session 给 sessionId（存下来复用），
// type=status 的 step_end 带 usage。
//
// 设计原则：
//   · 只负责「拿到一段文本」，不负责发送 —— 发送仍走 QQ Agent 的 send_message，
//     这样限频、去重、存档、before-tool 守卫一个都不会被绕开。
//   · 任何失败都返回 {ok:false}，调用方据此落回原来的 API 路径。

import { spawn, spawnSync as childProcessSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 2026-10-31：她一直看不到插件声明的提示词片段（prompt.sections），
// 因为 DSH 的 system 只拼了人设/称呼/经验/表情包。那句「你能给自己加功能」
// 和「你自己待着的时候」从来没到过她上下文 —— 她自然说自己不会。
import { skillManager } from './skills/manager.js';

import { DATA_DIR, getConfig } from './config.js';
import { addExperience, LEARNED_FILE } from './learned.js';
// 4.0 收尾：经验 prompt 段经 Memory Hub 读取，业务不再直接读 learned。
import { renderLearned } from './memory-hub/index.js';
import { recordTurn, hashOf, promptJsVersion, learnedTemplateVersion } from './prompt-version.js';
// 4.0 / 1.5.8.4：把每次 DSH 调用的真实结果记进统一调用日志。
// roundId 从 ALS 取（父进程内传播）—— 不在这里重新生成。
import { recordCall, currentRound } from './model-calls.js';
import { assertWritesAllowed } from './reset-barrier.js';
// 日记目录以配置（skills.diary.root）为准，不再写死旧路径。
import { diaryDir } from './diary/writer.js';
// 5.0：把“空闲时的我”做过/写过的带回来（本子 + 运行账本）。
import { buildSelfMemorySection } from './self-memory.js';

const SESSIONS_FILE = path.join(DATA_DIR, 'dsh-sessions.json');
// 记录「她主动说过的话，哪些已经补进过 DSH 上下文」。
// 为什么要单独存：她主动发的消息不经过 DSH，得在下一轮补进去；补过之后不能再补，
// 否则同一句话每轮都出现，会把会话历史撑成复读机。
const INJECTED_FILE = path.join(DATA_DIR, 'dsh-injected.json');
// 她的日记目录：读配置里的 skills.diary.root（默认 E:\dsh\本子\日记）。
// 这里只读取「记住了」这一类条目，不碰其它内容。
const DIARY_DIR = process.env.QQ_DIARY_DIR || diaryDir();
/**
 * 注入上限：15 条、每条 45 字。
 *
 * 2026-10-27 从 6 提到 15：机主觉得「记住了」攒得快、6 条太早开始挤掉旧的。
 * 成本其实可忽略 —— 15 条 × 45 字 ≈ 540 token/轮，一天 50 轮也就 0.03 元。
 * 真正要盯的是**注意力稀释**：20 条以上她会挑最显眼的几条用，剩下的形同虚设。
 * 所以不做无限，留个「还有 N 条没列出来」的提示让她自己去翻。
 */
const LEARNED_MAX = 15;
const LEARNED_CHARS = 45;
const PERSONA_PATCH = path.join(DATA_DIR, 'dsh-persona.patch.yml');
const GATEWAY_LOG = path.join(DATA_DIR, 'dsh-gateway.log');
// DSH 子进程的临时目录。
// 2026-10-31 改过一次位置，原因写在这里免得以后又改回去：
// 原来是 %LOCALAPPDATA%\Temp\dsh-qq。那个目录的完整性标签带 (NW) 策略
// （No-Write），低权限进程连 mkdtemp 都 EPERM —— DSH 的 spill-local 直接起不来，
// 表现就是她说的「shell 和 glob 都是坏的」。icacls 改标签又被 Low 权限挡住。
// 实测「工作区的同级目录」（E:\dsh\dsh-tmp）在 Low 下能建能写，DSH 也不报
// 「必须在工作区之外」，所以挪到这里。需要别的路径时用 QQ_DSH_TMP 覆盖。
const DSH_TMP = process.env.QQ_DSH_TMP || '';
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 网关自己的日志文件。
 *
 * 为什么必须落盘：失败信息走的是 `console.warn`，而 Electron 主进程的 stdout
 * 不进 data/logs —— 表现就是「配置明明开着、她也在回话，但 dsh-sessions.json
 * 里什么都没有」，完全看不出错（2026-10-23 就这么耗了一晚上）。
 * 这里每次调用都写一行，成功失败都写，下次一眼能看出是超时、非零退出还是空回复。
 */
function logGateway(line) {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_LOG), { recursive: true });
    fs.appendFileSync(GATEWAY_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch { /* 日志写不进去也不能影响对话 */ }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
/** DSH 的临时目录：默认放在工作区同级（E:\dsh\dsh-tmp）——Low 权限下可写。 */
const DSH_TMP_RESOLVED = DSH_TMP || path.join(path.dirname(APP_ROOT), 'dsh-tmp');   // E:\dsh\QQ-agent
// 给 DSH 补 QQ 工具的 Cordis 插件（qq_sticker / qq_diary）
const PLUGIN_PATCH = path.join(HERE, '..', 'dsh-plugins', 'qq-tools', 'patch.yml');
const OUTBOX_DIR = path.join(DATA_DIR, 'dsh-outbox');

// headless 专属的 DSH 数据目录。
//
// 为什么必须隔离（2026-10-24 定位）：桌面端和 headless 原来共用 `~/.dsh`，
// 桌面端一启动就会打开全部会话文件重建 projcache；headless 再去恢复同一个
// 会话就撞 `dsh: CreateSemaphoreW EACCES (Win32 5)` 或
// `session "…" is already owned by an active write handle`，退出码 1 →
// 网关静默回落 API → 她「不会用工具了」。把数据目录分开，两边互不干扰。
const DSH_HOME = process.env.QQ_DSH_HOME || path.join(DATA_DIR, 'dsh-home');

/** 读走本次调用写下的动作队列（表情等），读完就删，避免堆积。 */
function drainOutbox(callId) {
  const file = path.join(OUTBOX_DIR, `${callId}.jsonl`);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 把当前人设写成 DSH 的 system-prompt patch。
 *
 * 为什么必须这么做：`dsh headless` 默认的 personaPrefix 是
 * 「You are a coding agent powered by the … model.」，所以她一开口就是
 * 「好的，请说。」——像个等任务的助手，而不是她本人。
 * 覆盖 personaPrefix 之后，同一句话会变成「没干嘛呀，在等你消息呢」。
 *
 * 人设从 config 实时读，改了配置下次调用自动生效，不用手动同步文件。
 */
function personaPatchFile(contextText = '', collectLearned = null, companionText = '') {
  let roleText = '';
  try {
    roleText = String(getConfig().persona?.roleText || '').trim();
  } catch { /* 配置还没就绪 */ }
  if (!roleText) return { file: '', roleText: '', stickerText: '' };

  // 「记住了」的规矩 + 表情包目录都拼进 **system prompt**，不拼进用户消息。
  // 差别很大：system prompt 每轮都会带、但不进对话历史；塞进用户消息的话，
  // 同一份清单会在会话里存 N 份，越聊越贵（这也是 proactiveNote 必须一次性的原因）。
  let stickerWanted = true;
  try { stickerWanted = getConfig().sticker?.enabled !== false; } catch { /* 默认按开 */ }
  const stickerText = stickerWanted ? stickerSection() : '';
  // 插件的 prompt.sections（autonomous 的「你自己待着的时候」等）也必须进来，
  // 否则她对"自己能干什么"的认知完全缺失（2026-10-31 查实）。
  let skillText = '';
  try {
    const list = skillManager.getPromptSections({ isPrivate: true });
    if (list.length) {
      skillText = ['【你会的东西】', ...list.map((s) => s.content)].join('\n\n');
    }
  } catch (e) {
    // 拿不到就算了，不能因为这段把对话搞挂
  }

  const sections = [
    roleText,
    skillText,
    // 称呼：2026-10-27 她说过「用户我准备让你学一下梗」——「用户」这个词不是我们注入的
    // （工具描述里只有注释提到、会话里查不到），是模型在指代人类时的习惯用词。
    // 人设里原本只说「习惯称呼他为老大」，不够硬；这里再加一条不可协商的。
    '【称呼】永远叫他「老大」。不要用「用户」「对方」这类词称呼他。',
    // collectLearned：把本轮实际选中的经验 id 收回去，写进提示词指纹
    learnedSection({ contextText, collect: collectLearned }),
    // 4.0 / 2.5：Companion State 的【你现在】。
    // DSH 和 API 两条路径用**同一份** companionText（同一轮算一次快照），
    // 免得主路径和回落路径看到不同状态。
    companionText,
    // 5.0：空闲时她做过什么、本子里写了什么。不带这段，她会把自己的本子当成“别人/脚本”写的。
    buildSelfMemorySection(),
    stickerText
  ].filter(Boolean);
  const personaText = sections.join('\n\n');

  const content = [
    '- id: system-prompt',
    '  config:',
    `    personaPrefix: ${JSON.stringify(personaText)}`
  ].join('\n') + '\n';

  const meta = { roleText, stickerText };
  try {
    if (fs.readFileSync(PERSONA_PATCH, 'utf8') === content) return { file: PERSONA_PATCH, ...meta };
  } catch { /* 还没写过 */ }
  try {
    fs.mkdirSync(path.dirname(PERSONA_PATCH), { recursive: true });
    fs.writeFileSync(PERSONA_PATCH, content, 'utf8');
    return { file: PERSONA_PATCH, ...meta };
  } catch {
    return { file: '', ...meta };
  }
}

// QQ Agent 从桌面/托盘启动时，PATH 里不一定有 npm 全局目录，
// 所以先找 dsh.cmd 的绝对路径，找不到再退回裸 "dsh"。
const NPM_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
const DSH_CANDIDATES = [
  NPM_DIR && path.join(NPM_DIR, 'dsh.cmd'),
  NPM_DIR && path.join(NPM_DIR, 'dsh.ps1')
].filter(Boolean);

function dshCommand() {
  // 测试用：指向一个假的 dsh 脚本，验证成功/超时/非零退出/空回复四条路径。
  const override = String(process.env.QQ_DSH_BIN || '').trim();
  if (override) return override;
  for (const c of DSH_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'dsh';
}

function loadSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function saveSessions(map) {
  assertWritesAllowed('DSH 会话映射写入'); // reset 删除期间不重建 data/dsh-sessions.json
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  const tmp = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 1), 'utf8');
  fs.renameSync(tmp, SESSIONS_FILE);
}

/** 同一会话的请求必须串行：DSH 的 session 不是并发安全的。 */
const queues = new Map();
function withQueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

export function hasSession(sessionKey) {
  return Boolean(loadSessions()[String(sessionKey)]?.sessionId);
}

/** 清掉某个对话的映射（下次会开新会话）。 */
export function resetSession(sessionKey) {
  const map = loadSessions();
  delete map[String(sessionKey)];
  saveSessions(map);
}

export function listSessions() {
  return loadSessions();
}

/**
 * 从日记里抽出「老大教的规矩」。
 *
 * 约定格式：`- 心情：记住了｜<一句能直接照做的短句>`。
 * 为什么不新开一个文件或字段：她写日记时只要多记一个心情取值，
 * 「约定：」「愿望：」「[重要]」这些现有解析全都不用动，也不会多一份要同步的地方。
 *
 * **这一类是常驻的，不靠「（已经做到了）」下线。** 一次性的事（答应把链接发给他、
 * 答应某天做某事）走的是现有「约定」机制；「记住了」只收长期习惯，
 * 划掉就等于把习惯忘掉 —— 所以这里只按时间取最近的 N 条。
 *
 * 返回 total，是为了在超限时**明说还有几条没进来**。静默丢弃是最糟的：
 * 真正长期的规矩反而最早被挤掉，而且没人知道。
 *
 * 成本：6 条 × 45 字 ≈ 270 汉字，约 200 token，占单轮输入的 4~6%。
 */
export function learnedSnapshot({ dir = DIARY_DIR, days = 14, max = LEARNED_MAX } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort()
      .reverse()            // 最近的日子优先
      .slice(0, days);
  } catch {
    return { rules: [], total: 0 };
  }
  const seen = new Set();
  const all = [];
  for (const name of names) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch { continue; }
    for (const line of text.split('\n')) {
      const m = line.match(/^-\s*心情[：:]\s*([^｜|]*)[｜|]\s*(.+)$/);
      if (!m) continue;
      // 心情这一栏她会自由发挥：除了「记住了」，实测还写过「记下了」「记上了」。
      // 只认「记住」会漏掉一半 —— 2026-10-27 那条「老大纠正我说话的主语」写成
      // 「记下了」，结果没被注入，等于白记。
      if (!/记(住|下|上|好|着)/.test(String(m[1] || ''))) continue;
      const body = String(m[2] || '').trim();
      if (!body) continue;
      // 允许「（已经做到了）」下线：她或机主想清掉某条时，改这一行就够了。
      // 但日记提示词明确劝她**别对长期习惯这么写** —— 习惯没有「做完」那天。
      if (/（已经做到了）\s*$/.test(body)) continue;
      if (seen.has(body)) continue;
      seen.add(body);
      all.push({
        day: name.replace(/\.md$/, ''),
        text: body.length > LEARNED_CHARS ? `${body.slice(0, LEARNED_CHARS)}…` : body
      });
    }
  }
  return { rules: all.slice(0, max), total: all.length };
}

/** 只要条目本身（调用方不关心总数时用）。 */
export function learnedRules(opts = {}) {
  return learnedSnapshot(opts).rules;
}

/**
 * 拼「记住了」那一段。
 *
 * 2026-10-27 改成三层结构之后，这里不再直接从日记抽：日记是流水账，
 * 真正该带进上下文的是提炼过的经验（src/learned.js）。日记只在**首次**当迁移源，
 * 之后运行时只看 learned.json —— 否则日记越写越长、上下文越塞越满。
 *
 * contextText 传「最近几句对话」，用来做相关性排序（3~8 条，不是最新 15 条）。
 */
export function learnedSection({ contextText = '', limit, collect = null } = {}) {
  ensureLearnedMigrated();
  return renderLearned({ contextText, limit, collect });
}

let migratedOnce = false;
/** 第一次跑：把日记里的「记住了」搬进经验库。只搬一次，之后以库为准。 */
function ensureLearnedMigrated() {
  if (migratedOnce) return;
  migratedOnce = true;
  try {
    if (fs.existsSync(LEARNED_FILE)) return;
  } catch { return; }
  const rules = learnedRules();
  if (!rules.length) return;
  for (const r of rules) {
    try { addExperience({ text: r.text, sourceDay: r.day }); } catch { /* 单条失败不影响其它 */ }
  }
}

/**
 * 给她一行「现在几点」。
 *
 * 为什么必须有：走 DSH 之后她**看不到任何时钟** —— 旧路径（src/prompt.js）每轮
 * 末尾都有 `【当前时间】`，历史消息也带时间戳；DSH 这条线只有「我：…」「对方：…」。
 * 2026-10-26 实测：下午 1:26 她说「早，那就先去上课」，因为她真的不知道那是几点。
 *
 * 只要「星期几 + 时分」：她需要的是"上午还是晚上"，秒数只会让她在回复里报时。
 */
export function clockLine(now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const week = '日一二三四五六'[now.getDay()];
  return `【当前时间】${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} `
    + `周${week} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
}

/**
 * 给她看一眼"手上有哪些表情"。
 *
 * 为什么需要：旧路径（src/prompt.js）每轮都会塞一整段【可用表情包】目录 + 表情包策略，
 * 她能看到具体有哪些、什么备注、什么时候用。DSH 这边原来只有人设里一句
 * 「或者突然发个表情包」——她知道"可以发"，但不知道"有什么"，于是想不起来用。
 * 2026-10-26 机主反馈「接上 DSH 后她好像不会主动发表情包了」，就是这个原因。
 *
 * 2026-10-31：她反馈「备注是有，可我这边只摆出来几张／剩下的没给我，我就说不出来了」
 * （聊天记录 5222–5228）。旧实现只列 5 个、备注还截 28 字；而 30 条备注的真实总长
 * 只有 670 字符（中位 20、最长 58），全列约 400~500 token，又落在稳定的 system
 * prompt 前缀里（可缓存）。所以改成全列、不截断：她能挑得准，也能把备注里的词
 * 原样传给 qq_sticker 去匹配。max 只作为收藏将来变多时的硬上限。
 */
export function stickerSection({ file = path.join(DATA_DIR, 'stickers.json'), max = 64 } = {}) {
  let entries = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    entries = Array.isArray(raw) ? raw : [];
  } catch {
    return '';
  }
  const withNote = entries.filter((e) => e && (e.localNote || e.desc));
  if (!withNote.length) return '';
  const limit = Math.max(1, Math.min(200, Number(max) || 64));
  const picked = [...withNote]
    .sort((a, b) => (Number(b.useCount) || 0) - (Number(a.useCount) || 0))
    .slice(0, limit);
  const lines = picked.map((e) => {
    // **不列 id**：QQ 的表情 id 一条就有 55 个字符，列几条光 id 就上百字符，
    // 换来的只是"能精确指定"。让 qq_sticker 按备注匹配关键词更省，也更符合
    // 她说话的方式（"发那个叉腰炸毛的"）。
    const note = String(e.localNote || e.desc || '').replace(/\s+/g, ' ').trim();
    return `- ${note}`;
  });
  // 频率策略：DSH 路径原来只有一句「想发就调」，没有档位 —— 而旧路径（prompt.js 的
  // stickerRules）是按 config.sticker.encourage 改频率的。结果 10-26 接 DSH 之后她
  // 发表情包的频率从 4.5% 掉到 0.5%（351 条里 1 张），而配置里 encourage 明明是 3。
  // 2026-10-29 机主反馈「好像没主动发过」，就是这一段丢了。
  let level = 3;
  try { level = Number(getConfig().sticker?.encourage ?? 3); } catch { /* 按最高档 */ }
  const freq = [
    '表情包是备选项，不勉强；纯文字回应完全没问题。',
    '普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '回应、吐槽、接梗时优先考虑配一个贴切的；别每次都用同一张。',
    '你是表情包爱好者：能配的地方尽量配，接梗、调侃、附和、被戳中时几乎都会带一张；注意换着用，不要连发同一张。'
  ][Math.min(3, Math.max(0, level))];
  const coverage = picked.length < withNote.length
    ? `先列常用的 ${picked.length} 个`
    : '全部列在下面';

  return `【表情包】你的 QQ 收藏表情里有 ${entries.length} 个表情（${withNote.length} 个有备注，${coverage}）：\n${lines.join('\n')}\n`
    + '想发就调 qq_sticker（传 hint 说个关键词，比如「叉腰」「炸毛」；不传就随机挑）。'
    + `一条消息只能是一张表情、不能带文字；想说的话单独发。\n【表情包策略】被戳中笑点、接梗、怼人、赞同、自嘲、无语、告别/晚安时都可以发。${freq}`;
}

function loadInjected() {
  try {
    const j = JSON.parse(fs.readFileSync(INJECTED_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 这个对话里，她主动说的话补到哪一刻为止（毫秒时间戳；没有则 0）。 */
export function getInjectedAt(sessionKey) {
  const n = Number(loadInjected()[String(sessionKey)]);
  return Number.isFinite(n) ? n : 0;
}

/** 记下已经补到哪一刻。写失败不影响对话。 */
export function setInjectedAt(sessionKey, ts) {
  const map = loadInjected();
  map[String(sessionKey)] = Number(ts) || 0;
  try {
    fs.mkdirSync(path.dirname(INJECTED_FILE), { recursive: true });
    const tmp = `${INJECTED_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 1), 'utf8');
    fs.renameSync(tmp, INJECTED_FILE);
  } catch { /* ignore */ }
}

/**
 * 拼出真正送进 DSH 的正文。
 *
 * 冷会话：preface 是完整历史（人设 + 近期对话），必须拼；
 * 热会话：preface 会和会话里已有的内容重复，丢掉 —— **但 hotNote 不能丢**。
 *
 * 2026-10-26 01:20 的 bug 就出在这：她 23:04 主动发了条消息（走 QQ Agent 的
 * 发送路径，不经过 DSH），23:07 用户引用回复问「什么感觉」，DSH 会话是热的，
 * 而当时 proactiveNote 被混在 preface 里一起丢掉了 —— 她不知道刚才说过什么，
 * 只能顺着会话里更早的「做视频」话题往下答，答成了「拆段 / 标题写具体点」。
 */
export function buildBody({ cold, preface = '', hotNote = '', text = '' }) {
  const head = [cold ? preface : '', hotNote].filter(Boolean).join('\n\n');
  return head ? `${head}\n\n—— 现在开始聊天 ——\n${text}` : text;
}

/** 这个对话上次交给 DSH 是什么时候（毫秒时间戳；没有则 0）。
 *  用来判断「哪些话是她自己在那之后主动说的」——那些不经过 DSH，它不知道。 */
export function lastUsedAt(sessionKey) {
  const t = loadSessions()[String(sessionKey)]?.lastUsedAt;
  const ms = t ? Date.parse(t) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 让 DSH 处理一句话。
 * @param {string} sessionKey 逻辑会话键（用 chatKey，如 private:1846383180）
 * @param {string} text 这次要说的话
 * @param {object} [opts]
 * @param {string} [opts.preface] 仅在该会话**首次**调用时拼在最前面的说明（人设/历史）
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, text?:string, sessionId?:string, usage?:object, error?:string, ms:number, cold?:boolean}>}
 */
export function ask(sessionKey, text, {
  preface = '',
  hotNote = '',
  contextHint = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  companionText = '',
  // **仅测试用**：注入假 spawn（生产不传）
  deps = {}
} = {}) {
  const key = String(sessionKey || 'default');
  return withQueue(key, () => runOnce(key, text, preface, hotNote, contextHint, timeoutMs, companionText, deps));
}

/**
 * 把一次 DSH 调用的真实结果记进 model-calls.ndjson（4.0 / 1.5.8.4）。
 *
 * 四条路径要分清 —— 尤其最后一条：
 *   · 成功                      → status=success
 *   · 超时/起不来/非零退出       → status=failed + 对应 failureCode
 *   · 进程正常退出但模型没给文本  → DSH_EMPTY_REPLY（**不是成功**）
 *   · 记录器自己坏了             → 只告警，不影响这一轮
 */
/** 仅供测试：验证四条路径的归类（生产由 finish() 调用）。 */
export function recordDshCall(out, { key, sessionId, usage, finalText, started, timeoutMs }) {
  try {
    const text = String(finalText || '').trim();
    const ok = Boolean(out.ok);
    const emptyReply = ok && !text;

    let failureCode = null;
    let failureDetail = null;
    if (!ok) {
      const err = String(out.error || '');
      if (/超时/.test(err)) failureCode = 'DSH_TIMEOUT';
      else if (/起不来/.test(err)) failureCode = 'DSH_SPAWN_FAILED';
      else if (/退出码/.test(err)) failureCode = 'DSH_NONZERO_EXIT';
      else failureCode = 'UNKNOWN';
      failureDetail = err.slice(0, 200) || `超时 ${timeoutMs}ms`;
    } else if (emptyReply) {
      failureCode = 'DSH_EMPTY_REPLY';
      failureDetail = '进程正常退出，但没有收到任何回复文本';
    }

    // 用量（4.0 / R6-C 修正）
    //
    // 本地实测：@deepseek-ai/dsh 0.2.0-rc.2
    // 核验日期：2026-11-03（隔离 DSH_HOME 真实请求）
    //
    // **之前的注释写错了**。真实情况是：
    //   · usage **有**，挂在 {"type":"status","phase":"step_end"} 上
    //   · turn_end **没有** usage
    //   · 字段是 camelCase：inputTokens / outputTokens / cacheReadTokens /
    //     cacheWriteTokens / totalTokens
    //   · 每个 step 的 usage 是**该次调用的增量**，多 step 时**逐步累加**
    //
    // 老代码查的是 prompt_tokens / input_tokens（snake_case），且只看 turn_end
    // —— 双重错过，所以 tokens 永远是 null。不是 DSH 不给。
    //
    // 现在用 normalizeUsage 统一规范化（缺失字段保持 null，不伪装成 0）。
    let tokens = null;
    {
      const u = normalizeUsage(usage);
      if (u) {
        // 保留 model-calls.ndjson 原有的三个字段名（prompt/completion/cached），
        // 另加 cacheRead/cacheWrite/total —— 旧消费者不受影响。
        tokens = {
          prompt: u.input,
          completion: u.output,
          cached: u.cacheRead,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          total: u.total
        };
      }
    }

    recordCall({
      purpose: 'chat.reply',
      backend: 'dsh',
      status: (ok && !emptyReply) ? 'success' : 'failed',
      durationMs: Date.now() - Number(started || Date.now()),
      failureCode,
      failureDetail,
      model: String(getConfig()?.api?.model || '') || null,
      tokens,
      round: currentRound()
    });
  } catch (e) {
    try { logGateway(`RECORD_FAIL ${e?.message ?? e}`); } catch { /* ignore */ }
  }
}

// ── 事件解析与结果判定（4.0 / R6-B1）────────────────────────────────
//
// 抽成纯函数的原因：spawn 在沙箱里会 EPERM，没法直接测 runOnce 内部；
// 抽出来之后测试可以喂事件对象 / 喂退出码，验证错误契约。
//
// 实测（DSH 0.2.0-rc.2）的错误形态有两种：
//   ① {"type":"error","message":"..."}                        —— 顶层错误事件
//   ② {"type":"status","phase":"turn_end",
//       "reason":{"kind":"error","error":{...}}}               —— 回合级错误

/**
 * 造一个空的收集器。
 * @returns {{sessionId:string, finalText:string, usage:object|null, errorEvents:Array, turnErrors:Array}}
 */
export function newEventState() {
  return {
    sessionId: '',
    finalText: '',
    // 4.0 / R6-C：usage 逐步累加（实测每 step 是增量）
    usage: null,
    // 记录每个 step 的原始 usage，便于审计
    usageSteps: [],
    // 4.0 / R6-C 收尾：**step usage 幂等**
    //   key = "turn:step"，值是规范化后的 usage
    usageByStep: new Map(),
    // 重复但内容不同的 step usage（诊断用，不覆盖）
    usageConflicts: [],
    usageConflictDropped: 0,        // 2026-11-03：超过上限丢弃的条数
    usageConflictDroppedFirstAt: null,
    usageConflictDroppedLastAt: null,
    // turn_end 上的 usage（只在没有 step usage 时兜底用）
    turnUsage: null,
    // step 聚合与 turn usage 不一致的诊断
    usageSourceConflict: null,
    errorEvents: [],
    turnErrors: []
  };
}

/**
 * 把**一条**已 parse 的事件喂进收集器（纯函数，就地改 st）。
 *
 * @param {object} st newEventState() 的返回值
 * @param {object} ev 解析后的 JSON
 * @returns {object} 同一个 st
 */
export function applyEvent(st, ev) {
  if (!ev || typeof ev !== 'object') return st;

  if (ev.type === 'session' && ev.sessionId) {
    st.sessionId = String(ev.sessionId);
    return st;
  }
  if (ev.type === 'final' && typeof ev.text === 'string') {
    st.finalText = ev.text;
    return st;
  }
  if (ev.type === 'status') {
    // 4.0 / R6-C 收尾：**usage 的来源与去重**
    //
    //   · step_end 上的 usage 是**每个 step 的增量** → 按 "turn:step" 去重后累加
    //   · turn_end 上的 usage 实测**没有**；万一将来有，只当兜底，
    //     **绝不和 step 相加**（那会双算）
    if (ev.usage) {
      const norm = normalizeUsage(ev.usage);
      if (norm) {
        const phase = String(ev.phase || '');
        const turn = Number(ev.turn) || 0;
        const step = Number(ev.step) || 0;
        const key = turn + ':' + step;

        if (phase === 'turn_end' && step === 0) {
          // turn 级 usage：候选兜底
          if (!st.turnUsage) st.turnUsage = norm;
        } else {
          // ── step 级 usage（2026-11-03：改成 DSH 的替换语义）────────────
          //
          // 三种情况，按机主的规则：
          //   ① 不同键 → 独立记录
          //   ② 相同键 + 相同 usage → 幂等跳过
          //   ③ 相同键 + 不同 usage → **替换旧值**，并记录冲突
          //
          // 为什么替换而不是忽略：DSH 官方的 tokenUsage 投影用的是
          //   totals: addReplacing(state.totals, previous, buckets)
          // （dsh-token-meter/lib/index.js 行 434）
          // 「先减旧值再加新值」。我们之前保留旧值，在流式补全场景下会少算。
          const prev = st.usageByStep.get(key);

          if (!prev) {
            // ① 不同键：独立记录
            st.usageByStep.set(key, norm);
            st.usageSteps.push({ phase, turn, step, raw: ev.usage });
            st.usage = addUsage(st.usage, norm);
          } else if (sameUsage(prev, norm)) {
            // ② 完全相同：幂等跳过（不产生冲突记录）
          } else {
            // ③ 不同：先减旧的、再加新的
            st.usage = addUsage(st.usage, negateUsage(prev));
            st.usage = addUsage(st.usage, norm);
            st.usageByStep.set(key, norm);
            // usageSteps 里那条也要换成最新的（它记录的是"最终值"）
            const si = st.usageSteps.findIndex((x) => x.turn === turn && x.step === step);
            if (si >= 0) st.usageSteps[si] = { phase, turn, step, raw: ev.usage };
            else st.usageSteps.push({ phase, turn, step, raw: ev.usage });

            // 冲突记录：至少保留旧值、新值、替换时间和来源
            pushConflict(st, {
              key,
              phase,
              turn,
              step,
              replacedAt: new Date().toISOString(),
              source: 'step_end',
              oldUsage: { ...prev },
              newUsage: { ...norm }
            });
          }
        }
      }
    }
    // 回合级错误（实测 MISSING_CREDENTIAL 走这条）
    if (ev.phase === 'turn_end' && ev.reason?.kind === 'error') {
      st.turnErrors.push({
        phase: String(ev.phase || ''),
        turn: Number(ev.turn) || 0,
        message: String(ev.reason?.error?.message || ev.reason?.error?.code || '未知回合错误'),
        code: String(ev.reason?.error?.code || '')
      });
    }
    return st;
  }
  // 顶层错误事件（实测不存在的 session / 空 task / 坏 patch 都走这条）
  if (ev.type === 'error') {
    st.errorEvents.push({
      message: String(ev.message || '未知错误'),
      code: String(ev.code || '')
    });
    return st;
  }
  return st;
}

/**
 * 把一份原始 usage 规范化成统一形状（4.0 / R6-C）。
 *
 * 实测 rc.2 的字段（camelCase）：
 *   inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / totalTokens
 *
 * 同时兼容旧的 snake_case / 其他写法的字段（不破坏任何现有逻辑）。
 *
 * **缺失的字段保持 null，不伪装成 0。**
 * 完全没有任何可识别字段时返回 null（表示"这份 usage 读不懂"）。
 *
 * @param {object} u
 * @returns {{input:number|null, output:number|null, cacheRead:number|null,
 *            cacheWrite:number|null, total:number|null}|null}
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;

  // 4.0 / R6-C：**先判断是不是已经是规范化格式**。
  // decideOutcome 返回的 usage 长这样：{input, output, cacheRead, cacheWrite, total}
  // 如果对它再走一遍原始字段查找会全部落空 → 返回 null → tokens 被写成 null。
  // （这就是「日志里有 usage、model-calls 里却是 null」的原因。）
  if ('input' in u || 'output' in u || 'cacheRead' in u || 'total' in u) {
    const norm = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    return {
      input: norm(u.input),
      output: norm(u.output),
      cacheRead: norm(u.cacheRead),
      cacheWrite: norm(u.cacheWrite),
      total: norm(u.total)
    };
  }

  const pick = (...names) => {
    for (const k of names) {
      const v = u[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    }
    return null;
  };

  const input = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens');
  const output = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens');
  // cacheRead 也兼容嵌套写法（老代码支持 usage.prompt_tokens_details.cached_tokens）
  let cacheRead = pick('cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens');
  if (cacheRead === null && u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object') {
    const nested = u.prompt_tokens_details.cached_tokens ?? u.prompt_tokens_details.cachedTokens;
    if (typeof nested === 'number' && Number.isFinite(nested) && nested >= 0) cacheRead = nested;
  }
  const cacheWrite = pick('cacheWriteTokens', 'cache_write_tokens');
  let total = pick('totalTokens', 'total_tokens');

  // 一个可识别的字段都没有 → 读不懂
  if (input === null && output === null && cacheRead === null && cacheWrite === null && total === null) {
    return null;
  }

  // total 缺失时**不自己推导**（避免在缺证据时造数）
  if (total === null) total = null;

  return { input, output, cacheRead, cacheWrite, total };
}

/** 两份 usage 是否完全相同（含 null 字段）。 */
export function sameUsage(a, b) {
  if (!a || !b) return a === b;
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];
  return keys.every((k) => a[k] === b[k]);
}

/** 两个 usage 相加（缺失字段按"两边都有才相加"处理）。 */
/**
 * ══ Token 冲突记录的有界队列（2026-11-03）══════════════════════════
 *
 * 机主要求：conflicts 最多 100 条，丢弃旧记录时：
 *   · 累计 dropped
 *   · 记录首次和最近丢弃时间
 *
 * 为什么要有界：长时间运行会无限累积，把会话状态撑爆。
 */
export const USAGE_CONFLICT_MAX = 100;

/**
 * 把 a 取负（用于"先减旧值"）。
 *
 * ⚠️ **不走 normalizeUsage** —— 那个函数会拒绝负数（v >= 0 ? v : null）。
 * addUsage 本身不校验正负，直接相加即可。
 */
export function negateUsage(a) {
  if (!a || typeof a !== 'object') return null;
  const neg = (v) => (typeof v === 'number' && Number.isFinite(v) ? -v : 0);
  return {
    input: neg(a.input),
    output: neg(a.output),
    cacheRead: neg(a.cacheRead),
    cacheWrite: neg(a.cacheWrite),
    total: neg(a.total)
  };
}

/**
 * 往 state 里推一条冲突记录，超过上限时丢最旧的并累计 dropped。
 *
 * @param {object} st    gateway state（要有 usageConflicts / usageConflictDropped）
 * @param {object} rec   冲突记录
 */
export function pushConflict(st, rec) {
  if (!st || typeof st !== 'object') return;
  if (!Array.isArray(st.usageConflicts)) st.usageConflicts = [];
  st.usageConflicts.push(rec);

  const overflow = st.usageConflicts.length - USAGE_CONFLICT_MAX;
  if (overflow > 0) {
    st.usageConflicts.splice(0, overflow);
    st.usageConflictDropped = (Number(st.usageConflictDropped) || 0) + overflow;
    const nowIso = new Date().toISOString();
    if (!st.usageConflictDroppedFirstAt) st.usageConflictDroppedFirstAt = nowIso;
    st.usageConflictDroppedLastAt = nowIso;
  }
}

export function addUsage(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const sum = (x, y) => (x === null && y === null ? null : (x || 0) + (y || 0));
  return {
    input: sum(a.input, b.input),
    output: sum(a.output, b.output),
    cacheRead: sum(a.cacheRead, b.cacheRead),
    cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    total: sum(a.total, b.total)
  };
}

/**
 * 根据**退出码 + 收集到的事件**判定这一轮是成功还是失败（纯函数）。
 *
 * 机主 2026-11-03 的要求：**不得把失败伪装成成功或空回复**。
 *
 * 判定顺序（**有意如此**）：
 *   ① 有顶层 error 事件      → 失败（**即使 code=0**）
 *   ② 有回合级 error         → 失败（**即使 code=0 且有 final**）
 *   ③ 非零退出码 且 无 final → 失败
 *   ④ code=0 但 final 为空   → 失败（不能返回空回复当成功）
 *   ⑤ 其余                   → 成功
 *
 * @param {object} o
 * @param {number} o.code 退出码
 * @param {string} o.stderr
 * @param {object} o.st 收集器
 * @returns {{ok:boolean, text?:string, sessionId?:string, usage?:object|null,
 *            error?:string, errorSource?:string, errorCode?:string,
 *            errorCount?:number, diagnostics?:object}}
 */
export function decideOutcome({ code, stderr = '', st }) {
  const diag = {
    code,
    stderrTail: String(stderr || '').trim().slice(-400).replace(/[\r\n]+/g, ' '),
    events: {
      errors: st.errorEvents.length + st.turnErrors.length,
      hasFinal: Boolean(st.finalText),
      sessionSeen: Boolean(st.sessionId)
    }
  };

  // ① 顶层 error 事件 → 失败（优先级最高）
  if (st.errorEvents.length) {
    const first = st.errorEvents[0];
    return {
      ok: false,
      error: first.message,
      errorSource: 'event',
      errorCode: first.code || '',
      errorCount: st.errorEvents.length,
      diagnostics: diag
    };
  }

  // ② 回合级错误 → 失败
  if (st.turnErrors.length) {
    const first = st.turnErrors[0];
    return {
      ok: false,
      error: first.message,
      errorSource: 'turn',
      errorCode: first.code || '',
      errorCount: st.turnErrors.length,
      diagnostics: diag
    };
  }

  // ③ 非零退出码 且 没有 final → 失败
  if (code !== 0 && !st.finalText) {
    return {
      ok: false,
      error: `dsh 退出码 ${code}：${diag.stderrTail}`,
      errorSource: 'exit',
      diagnostics: diag
    };
  }

  // ④ code=0 但没有 final → 失败（不能返回空回复当成功）
  if (code === 0 && !st.finalText) {
    return {
      ok: false,
      error: 'dsh 正常退出，但没有收到任何回复文本',
      errorSource: 'empty',
      diagnostics: diag
    };
  }

  // ⑤ 正常成功 —— **保持原有返回结构不变**
  // 4.0 / R6-C 收尾：**来源优先级**
  //
  //   ① 有 step usage → 以去重后的 step 聚合为准
  //   ② 没有 step usage → 才用 turn_end 的 usage 兜底
  //   ③ 两者都有且不一致 → **仍然用 step**，但留下诊断
  //   ④ 两者都没有 → null（不造 0）
  let usage = st.usage;
  let usageSource = usage ? 'step' : 'none';

  if (!usage && st.turnUsage) {
    usage = st.turnUsage;
    usageSource = 'turn';
  } else if (usage && st.turnUsage && !sameUsage(usage, st.turnUsage)) {
    // 不一致：保留诊断（**不覆盖、不相加**）
    st.usageSourceConflict = {
      used: 'step',
      stepTotal: usage,
      turnTotal: st.turnUsage
    };
  }

  const usageDiag = (st.usageConflicts && st.usageConflicts.length) || st.usageSourceConflict
    ? {
        conflicts: st.usageConflicts || [],
        sourceConflict: st.usageSourceConflict || null
      }
    : undefined;

  return {
    ok: true,
    text: st.finalText,
    sessionId: st.sessionId,
    // 4.0 / R6-C：逐步累加的 usage（没有就 null，不造 0）
    usage,
    usageSource,
    usageSteps: st.usageSteps ? st.usageSteps.length : 0,
    ...(usageDiag ? { usageDiag } : {})
  };
}

/**
 * @param {object} [deps] **仅测试用**：注入假的 spawn。
 *   deps.spawn 的签名必须和 node:child_process 的 spawn 一致。
 *   生产永远不传这个参数（默认用真正的 spawn）。
 */
function runOnce(key, text, preface, hotNote, contextHint, timeoutMs, companionText = '', deps = {}) {
  const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : spawn;
  const started = Date.now();
  const map = loadSessions();
  const prev = map[key]?.sessionId || '';
  const cold = !prev;

  // 冷启动时把人设和近况塞进去；热会话只发新消息，避免重复烧 token。
  // 但 hotNote（她刚主动说过、DSH 不知道的话）任何情况下都要带。
  const body = buildBody({ cold, preface, hotNote, text });

  const learnedIds = [];
  const patchInfo = personaPatchFile(contextHint, learnedIds, companionText);
  const patch = patchInfo.file;

  // ── 提示词指纹：这轮实际注入的是哪版人设、哪几条经验（只记指纹，不存全文）──
  // 三条来源分开记，免得以后分不清是人设变了、prompt.js 变了，还是只是这轮选中的经验不同。
  try {
    recordTurn({
      chat: key,
      backend: 'dsh',
      cold: cold ? 1 : 0,
      session: prev || '',
      persona: hashOf(patchInfo.roleText),
      personaLen: patchInfo.roleText.length,
      promptJs: promptJsVersion(),
      learnedTemplate: learnedTemplateVersion(),
      learnedIds,
      sticker: hashOf(patchInfo.stickerText),
      hotNote: hotNote ? hashOf(hotNote) : ''
    });
  } catch { /* 记账失败不影响这一轮 */ }
  try {
    fs.mkdirSync(DSH_TMP_RESOLVED, { recursive: true });
  } catch {
    // 建不了不是小事：DSH 的 shell/glob 全靠这个临时目录，缺了它们全挂
    // （2026-10-31 她原话：「我这边 shell 和 glob 都是坏的，报 Temp 目录不存在」）。
    // 机器人以低完整性运行，建不了用户 %TEMP% 下的目录 —— 得让机主跑一次
    // 「修DSH临时目录.bat」。这里只提示，不让它打断对话。
    warn(`临时目录建不了：${DSH_TMP_RESOLVED} —— 她的 shell/glob 会不可用，请运行 修DSH临时目录.bat`);
  }
  const callId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const args = ['--profile', 'headless'];
  if (patch) args.push('--patch', patch);
  try {
    if (fs.existsSync(PLUGIN_PATCH)) args.push('--patch', PLUGIN_PATCH);
  } catch { /* ignore */ }
  args.push('--json');
  if (prev) args.push('--session-id', prev);
  // ★ 任务文本必须走 stdin（`-`），不能当命令行参数：
  //   cmd 用 GBK 解析参数，UTF-8 中文会整段丢失，DSH 只收到 ASCII 数字。
  //   2026-10-23 23:16 实测：她收到「他连着发了 2 条…」但两条内容全是空，
  //   就是这一步造成的。
  args.push('-');

  return new Promise((resolve) => {
    // dsh 在 Windows 上是 .cmd/.ps1，直接 spawn 会失败，走 cmd /c。
    // 路径含空格时补引号，否则 cmd 会把它拆开。
    const exe = dshCommand();
    const cmdExe = exe.includes(' ') ? `"${exe}"` : exe;
    const child = spawnFn('cmd', ['/c', cmdExe, ...args], {
      // ★ cwd 必须钉在 QQ-agent 根目录：dsh 的会话文件记录了创建时的 cwd，
      //   恢复会话时要求当前 cwd 一致。Electron 主进程的 cwd 可能是
      //   C:\Windows\System32（从面板拉起时），于是热会话直接报
      //   `session "..." was recorded in "E:\dsh\QQ-agent", not "C:\Windows\System32"`
      //   并以退出码 1 失败 —— 表现为每一轮都静默回落 API（2026-10-23 21:50 抓到）。
      cwd: APP_ROOT,
      windowsHide: true,
      // QQ_OUTBOX_ID 让插件知道这次调用该往哪个文件写动作；
      // QQ_CHAT_KEY 让它知道当前是哪个聊天（读记忆库要用）；
      // TEMP/TMP 指到工作区：低完整性进程写不了用户 %TEMP%，见 DSH_TMP 的注释。
      env: {
        ...process.env,
        QQ_OUTBOX_ID: callId,
        QQ_CHAT_KEY: key,
        TEMP: DSH_TMP_RESOLVED,
        TMP: DSH_TMP_RESOLVED,
        // ★ 独立的 DSH_HOME：桌面端和 headless 共用 ~/.dsh 时，桌面端一启动
        //   就会打开所有会话文件（重建 projcache），headless 再恢复同一个会话
        //   就撞 `CreateSemaphoreW EACCES` / `owned by an active write handle`，
        //   然后静默回落 API —— 表现为「DSH 又没接管」。
        //   把 headless 的数据目录隔离出来，桌面端怎么开都不影响这边。
        DSH_HOME: DSH_HOME
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // 中文任务文本从 stdin 送进去（cmd 的参数通道会弄丢中文）
    try {
      child.stdin.write(String(body), 'utf8');
      child.stdin.end();
    } catch { /* 写不进去就让 dsh 自己报错 */ }

    // 事件收集器（4.0 / R6-B1 抽成纯函数，便于测试）
    const evState = newEventState();
    let sessionId = prev;
    // 下面四个仍被 finish 用（recordDshCall 的兜底 + 结算幂等）
    let finalText = '';
    let usage = null;
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = { ...result, cold, ms: Date.now() - started };
      // 4.0 / R6-B1：这些值现在收在 evState 里（原来是外层 let 变量）
      recordDshCall(out, {
        key,
        sessionId: evState.sessionId || sessionId,
        // 4.0 / R6-C：优先用 decideOutcome 的 usage（它就是 evState.usage 的快照），
        // 再退回 evState.usage，最后退回老的 let usage。
        usage: out.usage || evState.usage || usage,
        finalText: evState.finalText || finalText,
        started,
        timeoutMs
      });
      const tail = String(stderr || '').trim().slice(-400).replace(/[\r\n]+/g, ' ');
      // 4.0 / R6-C：text 和 usage 都从 evState 取（老的 let finalText 永远是空的），
      // 并把 usage 打进日志 —— 以后排查 token 问题不用再猜。
      const usedText = String(evState.finalText || finalText || '');
      const u = out.usage || null;
      const usageStr = u
        ? `${u.input ?? '-'}/${u.output ?? '-'}/${u.cacheRead ?? '-'}/${u.total ?? '-'}`
        : 'none';
      logGateway(`${out.ok ? 'OK' : 'FAIL'} cold=${cold ? 1 : 0} ${out.ms}ms`
        + ` session=${sessionId || '-'} text=${usedText.length} steps=${out.usageSteps || 0} usage=${usageStr}`
        + `${out.ok ? '' : ` err=${String(out.error || '').slice(0, 300)}`}`
        + `${tail ? ` stderr=${tail}` : ''}`);
      resolve(out);
    };

    const timer = setTimeout(() => {
      // 4.0 / R6-C0：**kill 失败不能静默**，也不能因为 kill 失败就认为"可以重试"。
      //
      // 超时的语义是「进程已经跑了一段时间，可能已经执行了任务」——
      // 这跟"没起来"是两回事。所以：
      //   · kill 成功 → 进程被杀，但任务可能已执行 → 仍然不可重试
      //   · kill 失败 → 进程还活着，更不可重试（重试会真的并发跑两份）
      // 两种情况都走同一条失败路径，**errorSource 不设 spawn**。
      //
      // ══ 2026-11-03（S8）：**必须杀整棵进程树** ══════════════════════
      //
      // 原来的 `child.kill()` 只杀直接子进程，而在 Windows 上那是 `cmd`：
      //
      //     child = spawn('cmd', ['/c', dshCommand(), ...])
      //              ↓
      //            cmd      ← child.kill() 只杀这个
      //              ↓
      //            node     ← **真正跑 DSH、持有 session 写锁的是这个，还活着**
      //
      // 后果（2026-11-03 实测）：
      //   超时 → cmd 被杀、node 还活着 → node 继续持有 session 的写锁
      //   → 下一次调用报 `session "..." is already owned by an active write handle`
      //   → **之后连续几次对话全部失败**，而机主看到的只是"她一直在思考"。
      //
      // 所以改成 taskkill /T（杀进程树）/F（强制）。taskkill 不可用时
      // 退回 child.kill() —— 聊胜于无，但至少不会比原来更差。
      let killOk = true;
      let killErr = '';
      const pid = child.pid;
      let treeKilled = false;
      if (pid) {
        try {
          // windowsHide + stdio:'ignore'：不捕获输出，避免沙箱的管道限制
          const r = childProcessSpawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 5000
          });
          treeKilled = r.status === 0;
        } catch (e) {
          killErr = String(e?.message ?? e);
        }
      }
      if (!treeKilled) {
        // 兜底：至少把直接子进程干掉（和原行为一致）
        try {
          child.kill();
        } catch (e) {
          killOk = false;
          killErr = killErr || String(e?.message ?? e);
        }
      }
      finish({
        ok: false,
        error: `DSH 超时（${timeoutMs}ms）`,
        errorSource: killOk ? 'timeout' : 'timeout_kill_failed',
        diagnostics: { killOk, killErr: killErr.slice(0, 200), treeKilled, pid: pid ?? null }
      });
    }, timeoutMs);

    let buf = '';
    // 4.0 / R6-C0：**区分「进程没起来」和「起来了之后出错」**。
    //
    // 机主指出的问题：原来 child.on('error') 一律标 errorSource='spawn'，
    // 但 Node 的 ChildProcess 在**启动成功之后**也可能 emit 'error'
    //   （kill 失败、流错误、AbortSignal…）
    // 那些情况进程明明跑过了，标成 spawn 就会导致"可安全重试"的误判 ——
    // 于是同一句话说两遍。
    //
    // 修法：监听 'spawn' 事件（进程真正创建成功时才触发），
    // 只有**从未触发过 spawn** 的 error 才算启动失败。
    let didSpawn = false;
    child.on('spawn', () => { didSpawn = true; });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        // 4.0 / R6-B1：解析交给纯函数（测试可单独验证）
        applyEvent(evState, parsed);
        if (parsed.sessionId) sessionId = parsed.sessionId;
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (err) => {
      // 4.0 / R6-C0：**按 didSpawn 区分两种 error**。
      //
      //   didSpawn === false → 进程从没起来 → errorSource='spawn'（**可安全重试**）
      //   didSpawn === true  → 进程起来了，这是运行期错误
      //                        → errorSource='runtime'（**不可重试**，任务可能已执行）
      //
      // 这一条是"不重复执行"的最后一道保险：
      // 宁可把能重试的情况判成不可重试（多失败一次），
      // 也不能把不可重试的判成可重试（同一件事做两遍）。
      if (didSpawn) {
        finish({
          ok: false,
          error: `dsh 进程已启动后出错：${err?.message ?? err}`,
          errorSource: 'runtime'
        });
        return;
      }
      finish({ ok: false, error: `起不来 dsh：${err?.message ?? err}`, errorSource: 'spawn' });
    });

    child.on('close', (code) => {
      // 4.0 / R6-B1：判定交给纯函数（错误契约见 decideOutcome 的注释）
      const parsed = evState;
      const outcome = decideOutcome({ code, stderr, st: parsed });

      if (!outcome.ok) {
        finish(outcome);
        return;
      }

      // 成功路径 —— **保持原有语义不变**
      if (parsed.sessionId) {
        const cur = loadSessions();
        cur[key] = {
          sessionId: parsed.sessionId,
          createdAt: cur[key]?.createdAt || new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          turns: (Number(cur[key]?.turns) || 0) + 1
        };
        try { saveSessions(cur); } catch { /* ignore */ }
      }
      finish({
        ok: true,
        text: outcome.text,
        sessionId: outcome.sessionId,
        usage: outcome.usage,
        // 4.0 / R6-C：把 step 数传下去（原来漏了，日志里一直是 steps=0）
        usageSteps: outcome.usageSteps || 0,
        actions: drainOutbox(callId)
      });
    });
  });
}
