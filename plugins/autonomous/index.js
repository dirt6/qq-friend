// 自主活动：让她在你没说话的时候也有自己的事做。
//
// 一轮的骨架（对应文档里的状态机，但砍到最小可运行）：
//   IDLE → 到点 → ACTIVE（抓公开榜单 → 去重 → 模型挑一条 → 可选分享/记日记）→ FINALIZING → IDLE
//
// 三条硬约束写在代码里，不靠提示词：
//   1) 每次调用模型前，用 budget.fitToBudget 检查估算 token；超了先减候选、再压摘要，
//      压到最少还超就整轮跳过（不绕过、不截断请求硬发）。
//   2) 每轮有 30 分钟墙钟和 6 次调用上限，先到先停。
//   3) 只读公开来源；失败记一笔，换来源或直接收工，不重试到失控。
//
// 默认 dryRun：照常醒来、照常判断、照常记账，分享只写日志不真发。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { fitToBudget, recordCalibration, promptTokensOf } from './lib/budget.js';
import { readUsage, writeUsage, recordCall, gate, summaryLine, monthCost, monthCalls } from './lib/usage.js';
// 4.0 / 1.2：自主活动的记账统一走主账本（src/token-ledger.js），
// 不再自己 读-改-写 token-usage.json。
import { recordAutonomousCall, readMonth } from '../../src/token-ledger.js';
import { enrichItems } from './lib/detail.js';
import { BiliClient } from './lib/bili/api.js';
import { XhhClient } from './lib/xhh/client.js';
import { readState, writeState, mutateState, emptyState, isSeen, markSeen, markShared, pushHistory, recordSourceHealth } from './lib/state.js';
// 4.0 / 1.5.8.6：一轮自主活动的所有模型调用共用一个 roundId。
import { enterRound } from '../../src/model-calls.js';
// 4.0 / 2.4：currentGoal / pendingNextStep 的真源已迁到 Companion State。
// 这里只读新文件；autonomous.json 的同名字段保留只读兼容，不再作为运行时来源。
//
// 4.0 / 2.6-A：**setGoal（setCompanionGoal）暂时没有调用点了** ——
// 自主活动不再从 decision.goal 创建长期 Goal（那是即时动作意图）。
// import 先留着：2.6.6 接入「她明确表达跨轮意图」时还要用它。
// R8-C1 / 4.0：伙伴状态与领域写入统一经 Companion Core；Core 委托同一领域模块。
import { createCompanionCore } from '../../src/companion-core/index.js';

const companionCore = createCompanionCore({});
const readCompanion = () => companionCore.state.get();
const activePending = () => companionCore.pending.active();
const settlePending = (id, outcome, opts) => companionCore.pending.settle(id, outcome, opts);
const addCompanionPending = (opts) => companionCore.pending.add(opts);
const companionSection = (opts) => companionCore.state.prompt(opts);
const clearGoal = (opts) => companionCore.goals.clear(opts);
const setCompanionGoal = (text, opts) => companionCore.goals.set(text, opts);
const bumpAskCount = (...args) => companionCore.goals.bumpAsk(...args);
import { resolveSources, contentKeyOf, isSafeCandidate, biliSource, xhhSource } from './lib/sources.js';
import { makeBuilder, parseDecision, validateDecision, looksGeneric } from './lib/planner.js';
// 4.0：自述日记统一经 Companion Core 的 diary 端口（Core 委托 Diary Writer）。
// 不再直接 import diary/index.js。
// 2.2：先决定"想做什么"，再决定看什么（意图阶段不给候选）
import { makeIntentMessages, parseIntent, describeIntent, INTENT_NEEDS_CONTENT } from './lib/intent.js';
// 4.0 / 2.6-B5a：Round 摘要（历史的索引，不调模型、不建 Goal）。
import { buildDigest, appendDigest } from './lib/round-digest.js';
// 4.0 / 2.6-B5b：长期方向判断（独立模型调用，只通过 createAutonomousGoal 创建）。
import {
  shouldJudge, buildJudgeInput, parseJudgement, validateJudgement,
  historyRoundIds, appendJudgeLog, bumpJudgeCount, JUDGE_WINDOW
} from './lib/goal-judge.js';
// 空闲时画画：渲染器 + 归档和聊天里 qq_draw 用的是同一套。
import { renderScene, recordDrawing, sceneFromPreset, DRAW_DIR } from '../../src/draw.js';
// 空闲时评论：和聊天里 qq_comment 用的是同一对 writer（B 站接口 / 小黑盒真机）。
import { BiliWriter } from './lib/social/bili-write.js';
import { XhhWriter } from './lib/social/xhh-write.js';
import { searchBili, searchXhh } from './lib/social/browse.js';

const STORE = path.join(DATA_DIR, 'autonomous.json');
/** 人可读的活动日志：她一个人时翻了什么、挑了哪条、为什么、决定做什么。 */
const ACTIVITY_LOG = path.join(DATA_DIR, 'autonomous-log.md');
/** 自主活动自己的 token 账本（和对话用的 usage-today.json 分开记）。 */
const USAGE_FILE = path.join(DATA_DIR, 'token-usage.json');

// 补详情用的客户端（懒建，避免每次醒来都读一遍 auth 文件）
const BILI_CLIENT = new BiliClient();
let xhhDetailClient = null;
function getXhhClient() {
  if (!xhhDetailClient) {
    xhhDetailClient = new XhhClient({ authFile: path.join(DATA_DIR, 'xhh-auth.json') });
  }
  return xhhDetailClient;
}
const ACTIVITY_LOG_MAX = 120;
const TICK_MS = 5 * 60 * 1000;          // 每 5 分钟看一次"该不该醒"，比 setTimeout(3h) 抗休眠漂移
const DIARY_ROOT = 'E:\\dsh\\本子\\日记';
const DIARY_SUBDIR = '每日';
// 手机脚本（发帖走真机：小黑盒 web 端没有创建接口，App 里才通）
const PHONE_PYTHON = 'E:\\dsh\\AIPhone\\ocr\\venv\\Scripts\\python.exe';
const PHONE_SCRIPT = 'E:\\dsh\\AIPhone\\phone_eye.py';
const execFileP = promisify(execFile);
const DEFAULT_MOOD = '平静';

let api = null;
let timer = null;
let running = false;

/**
 * runSession 的重入锁（4.0 / 2.6-B5c）。
 *
 * **和 running 是两回事**：
 *   · running   ：tick 的锁，防定时器重入（只在 tick 里设，runSession 的 finally 释放）
 *   · sessionRunning：runSession 自己的锁，防**任何调用方**并发进状态读改写
 *
 * 为什么需要：autonomous-run.mjs 和测试会直接调 runSession，完全绕过 running。
 * 两个并发 runSession 会各自 readState → 修改 → writeState，
 * history 的 mergeByKey 曾经因此丢记录（B5c 已修 key，但重复跑本身也是浪费）。
 */
let sessionRunning = false;
let lastRunError = '';
// 核心的消息存档实例（在 hooks 里拿到），用来把自己主动发的话也记进聊天记录
let storeRef = null;

/* ── 配置与工具 ─────────────────────────────────────────────────────── */

function settings() {
  const fromApi = api?.config?.();
  if (fromApi && Object.keys(fromApi).length) return fromApi;
  // 独立脚本（没走 setup）时 api 是 null：直接读 config.json 里的技能配置，
  // 否则 `node scripts/autonomous-run.mjs` 会永远用空配置、只跑默认来源。
  try {
    const c = getConfig();
    const saved = c?.skills?.autonomous;
    if (saved && typeof saved === 'object') return saved;
  } catch { /* 配置还没就绪 */ }
  return {};
}

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function log(...args) {
  api?.log?.(...args);
}

function warn(...args) {
  api?.warn?.(...args);
}

/** 安静时段（默认 23:30-08:00，支持跨零点）。留空 = 不设。 */
export function inQuietRange(ts, range) {
  const spec = String(range ?? '').trim();
  if (!spec) return false;
  const m = spec.match(/^(\d{1,2}):(\d{2})\s*[-~到]\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const d = new Date(ts);
  const minute = d.getHours() * 60 + d.getMinutes();
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;   // 跨零点
}

/** 最近一次聊天活动时间（用 sessions 目录的 mtime 估算，比逐条读消息便宜）。 */
export function lastChatActivityAt(sessionsDir) {
  try {
    const names = fs.readdirSync(sessionsDir);
    let latest = 0;
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const st = fs.statSync(path.join(sessionsDir, n));
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    }
    return latest;
  } catch {
    return 0;
  }
}

/**
 * 她上次主动找人说话后，老大如果已经回过话，"等回话"这件事就结束了。
 *
 * 不结算的话，下一次醒来还会带着同一个 goal / pendingNextStep 再问一遍 ——
 * 2026-10-31 的「部署进度」就是这么被问到第四次的（20:55 那次之后其实已经聊过）。
 * 只结算 `sourceAction === 'chat'`；share/comment 这类等的是内容反馈，不在此列。
 *
 * @param {object} st 自主活动状态。
 * @returns {boolean} 是否结算了。
 */
/**
 * 最后一条**老大发来的**消息时间（4.0 / 2.5）。
 *
 * 为什么不用 lastChatActivityAt：那个只看会话文件 mtime，
 * 机器人自己回话也会把 mtime 顶上去 —— 分不清"老大回了"还是"我说了"。
 * 这里只读私聊存档里 self === false 的最后一条，群聊和系统事件都不算。
 *
 * @returns {number} 时间戳；没有则 0
 */
export function lastUserMessageAt() {
  const master = String(getConfig()?.persona?.masterId || settings().shareTarget || '').replace(/[^0-9]/g, '');
  if (!master) return 0;
  const r = companionCore.context.readPrivateHistory(`private:${master}`, { all: true });
  if (!r.ok) { warn(`私聊历史读取失败（lastUserMessageAt）：${r.error}`); return 0; }
  // 遍历全部，取**有效的最大时间戳** —— 不能直接返回数组末尾那一条：
  // QQ 的时间戳只有秒级精度，同一秒内的消息会倒挂几百毫秒。
  let latest = 0;
  for (const m of r.messages) {
    if (m.self) continue;
    const ts = Number(m.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts > latest) latest = ts;
  }
  return latest;
}

/**
 * 这段"下次要做的事"是不是**在等老大回应**（4.0 / 2.5）。
 *
 * waiting 的严格定义：等待老大回应。别的没做完的事一律 pending。
 * **不能只看文本里有个"等"字** —— "明天查资料"、"等活动开始" 都不是等老大。
 */
export function isWaitingForReply(text) {
  const t = String(text ?? '');
  if (!t) return false;
  // 说法一：等 [老大|你] …… [回|说|答|应]
  if (/等(着|候)?[^，。；]{0,12}(老大|你)[^，。；]{0,12}(回|说|答|应)/.test(t)) return true;
  // 说法二：等 …… [回一句|回话|回复|答复]（主语省略但落点明确）
  if (/等[^，。；]{0,12}(回一句|回个话|回话|回复|答复)/.test(t)) return true;
  return false;
}

/**
 * clearGoal 失败时的日志（4.0 / 2.6.3）。
 *
 * 去重：同一个 goal + 同一个错误码**连续失败只记一次**，成功后清掉。
 * 容量上限 50 —— 长期运行不会一直涨。
 *
 * **只记 goalId / code / operation / source**，不记 Goal 文本和用户原话。
 */
const lastClearGoalFail = new Map();
const MAX_CLEAR_FAIL_KEYS = 50;

function logClearGoalFailure(goalId, code, operation, source) {
  const key = `${goalId}:${code}`;
  if (lastClearGoalFail.has(key)) return;          // 连续同一错误，不重复记
  if (lastClearGoalFail.size >= MAX_CLEAR_FAIL_KEYS) {
    // 简单限容：丢掉最早的一条
    const first = lastClearGoalFail.keys().next().value;
    if (first) lastClearGoalFail.delete(first);
  }
  lastClearGoalFail.set(key, Date.now());

  const msg = `Goal 没完成 goalId=${goalId} code=${code || '(none)'} op=${operation} source=${source}`;
  // 权限拒绝是设计行为（warn），意外情况用 error
  const permCodes = ['CONFIRMATION_REQUIRED', 'KIND_MISMATCH', 'NOT_ASKED',
    'NOT_CONFIRMED', 'PROPOSAL_EXPIRED', 'TERMINAL_STATE', 'INVALID_TRANSITION'];
  if (permCodes.includes(code)) warn(msg); else log(msg);
}

function clearClearGoalFailure(goalId) {
  for (const k of [...lastClearGoalFail.keys()]) {
    if (k.startsWith(goalId + ':')) lastClearGoalFail.delete(k);
  }
}

export function settleChatPending() {
  // 4.0 / 2.5：结算分两条分支，互不影响。
  //
  //  ① 迁移来的那条（migrationTag === 'chat-wait-reply'）—— 保留原有兼容结算，
  //     不能为了统一代码把它废掉。
  //  ② 新建的 waiting —— awaiting 一律表示"等老大回应"，
  //     所以结算条件只看【状态 + 时间 + 消息来源】，**不再用文本关键词猜**。
  //     状态本身已经是程序分类过的语义标记了。
  //
  // pending 不结算：它代表"还没开始做的事"（明天查资料），
  // 老大回话不代表它做完了。
  const list = activePending();
  if (!list.length) return false;

  const userAt = lastUserMessageAt();
  if (!userAt) return false;

  let settled = 0;
  // 只有**本轮真的结算成功**的才收进来 —— 不能从原始 list 里收集所有
  // waiting/migrated 的文本：那样会把"因为时间条件没满足而没结算"的也算进去，
  // 导致 goal 被误清（2026-11-01 审查发现的）。
  const settledTexts = [];

  for (const p of list) {
    const at = Date.parse(p.at || '');
    if (!Number.isFinite(at) || at <= 0) continue;
    // 只结算"待办产生之后"的消息 —— 晚于当前用户消息的不动
    if (!(userAt > at)) continue;

    const isMigrated = p.migrationTag === 'chat-wait-reply';
    const isWaiting = p.status === 'waiting';
    if (!isMigrated && !isWaiting) continue;

    // 迁移那条额外保留 90 秒保护期（她自己的 chat 会把时间顶到发送时刻）
    if (isMigrated && !(userAt > at + 90_000)) continue;

    settlePending(p.id, 'done', { source: 'autonomous' });
    settledTexts.push(p.text);
    settled += 1;
  }

  if (!settled) return false;

  // goal 只在"它说的就是同一件事"时清 —— 保守，且**只认本轮真结算的那几条**。
  //
  // 2.6.3：clearGoal 现在会走权限检查。user_directed 的方向没经过老大确认会失败，
  // 按机主的要求「宁可清不掉，也不要绕过确认」—— Pending 已经结算完了，不回滚。
  const cg = readCompanion().goal;
  if (cg && settledTexts.includes(cg.text)) {
    const cres = clearGoal({ source: 'autonomous' });
    if (!cres.ok) logClearGoalFailure(cg.id, cres.code, 'complete', 'autonomous');
    else clearClearGoalFailure(cg.id);
  }

  log(`老大已经回过话，结算了 ${settled} 条待办`);
  return true;
}

/* ── 日记：沿用现有那一套 ─────────────────────────────────────────────── */
// 文件结构与 skills/diary/index.js 的 addDiary 完全一致：`# YYYY-MM-DD 周X` + `## 记录` + 每条一行
// `- 心情：xx｜正文`。这里是独立实现（不 import 技能模块，避免依赖它的 setup 时序），
// 但**格式必须与那边保持一致** —— 以后改格式要两处一起改。

function weekdayOf(day) {
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : w[d.getDay()];
}

function diaryRoot() {
  try {
    const c = getConfig();
    const r = c?.skills?.diary?.root || c?.skills?.diary?.settings?.root;
    if (r) return String(r);
  } catch { /* 配置还没就绪时用默认值 */ }
  return DIARY_ROOT;
}

export function diaryFileFor(day, root = diaryRoot()) {
  return path.join(root, DIARY_SUBDIR, `${day}.md`);
}

/** 读最近 N 天的日记正文（给"写之前先翻一遍"用）。 */
export function readRecentDiary(days = 2, root = diaryRoot(), nowTs = Date.now()) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(nowTs);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      // 4.0：经 Core 的 diary 端口读取原文；readRaw 与旧 fs 读取字节一致。
      const text = companionCore.diary.readRaw(key, path.join(root, DIARY_SUBDIR));
      if (text.trim()) out.push({ day: key, text });
    } catch { /* 那天没写 */ }
  }
  return out;
}

/**
 * 追加一条日记（与 diary 技能同款格式）。
 * 返回 { ok, file } 或 { ok:false, reason }。
 */
const MOOD_PREFIX_RE = /^\s*心情\s*[：:]\s*[^｜|]{0,20}[｜|]\s*/;

/** 正文里自带「心情：xx｜」时先剥掉，避免行首叠两层（2026-10-23 实际发生过）。 */
function stripMoodPrefix(text) {
  let t = String(text ?? '').trim();
  for (let i = 0; i < 3 && MOOD_PREFIX_RE.test(t); i += 1) {
    t = t.replace(MOOD_PREFIX_RE, '').trim();
  }
  return t;
}

/**
 * 一轮的「记忆」：2.1 之后一轮可能有两件事，挑**最值得记**的那件。
 * 成功 > 无产出 > 跳过 > 失败（失败的经过由活动日志记，不进日记）。
 */
export function activityMemory(rec = {}, opts = {}) {
  const list = Array.isArray(rec?.actions) && rec.actions.length ? rec.actions : [rec];
  const score = (a) => (a?.result === 'success' ? 3 : a?.result === 'no_output' ? 2 : a?.result === 'skipped' ? 1 : 0);
  const best = [...list].sort((a, b) => score(b) - score(a))[0] || rec;
  return activityMemoryOf(best, opts);
}

/**
 * 把一轮自主活动整理成「她记得住的一段话」（2026-10-31 按机主的规格重写）。
 *
 * 三条硬要求：
 *   1. 区分**已发生 / 没发成 / 只是计划**——不能把没做的事写成做了；
 *   2. 不额外调模型，全部用已有的结构化字段拼；
 *   3. 同一条既有日记版（完整）又有上下文版（简短）。
 *
 * 返回 { status, diary, mood, summary, hasPlan }；finish 返回 null（空转不算经历）。
 */
function activityMemoryOf(rec = {}, { covered = false } = {}) {
  const action = String(rec.action || '');
  if (!action || action === 'finish') return null;

  const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const stripEnd = (s) => String(s || '').replace(/[。；;，,、\s]+$/, '');
  // why 是 planner 写给系统看的第三人称分析（"她大概会…"），进第一人称前把「她」改成「我」
  const why = stripEnd(clip(String(rec.why || '').replace(/她/g, '我'), 42));
  const next = stripEnd(clip(rec.next, 26));
  const goal = clip(rec.goal, 30);
  const title = clip(String(rec.picked || '').split('（')[0], 22);
  const drawTitle = clip(rec.drawTitle, 20);

  // maybeShare 返回的 mode：live 真发了；dryRun/quiet/capped/failed/invalid 都没发出去
  const mode = String(rec.shareMode || rec.commentMode || rec.publishMode || '').trim();
  const sent = mode === 'live';
  // 一句话说清"为什么没发"，不要后面再补「没发出去」造成重复
  const notSent = {
    dryRun: '演练里没发', quiet: '安静时段没发', capped: '额度到顶没发',
    failed: '发失败了', invalid: '目标不对没发'
  }[mode] || '没发出去';

  let diary = '';
  let summary = '';
  let mood = '闲';
  let status = 'unknown';

  if (action === 'share') {
    status = sent ? 'sent' : 'unsent';
    mood = '好奇';
    const who = title ? `「${title}」` : '一条帖子';
    // 已发 / 没发成，措辞必须分开
    diary = sent ? `把${who}拎给老大看了` : `挑了${who}，${notSent}`;
    if (why) diary += `——${why}`;
    if (next) diary += `；下次想${next}`;
    summary = sent
      ? (covered ? `翻到${who}，已经跟老大说过了${why ? `（${why}）` : ''}` : `翻到${who}，发给老大了${why ? `（${why}）` : ''}`)
      : `翻到${who}，${notSent}${why ? `（${why}）` : ''}`;
  } else if (action === 'chat') {
    status = sent ? 'sent' : 'unsent';
    mood = '想找人说话';
    // 她说了什么由 hotNote 原样补进去，这里只说"说了句话"，避免两处重复
    diary = sent ? '找老大说了句话' : `想找老大说话，${notSent}`;
    if (why) diary += `——${why}`;
    if (next) diary += `；下次想${next}`;
    summary = sent
      ? `主动跟老大说了句话${covered ? '（原文已经补进对话了）' : ''}${why ? `，${clip(why, 22)}` : ''}`
      : `想跟老大说话，${notSent}${why ? `，${clip(why, 22)}` : ''}`;
  } else if (action === 'draw') {
    status = 'drawn';
    mood = '手痒';
    const art = drawTitle ? `《${drawTitle}》` : '画';
    diary = `画了张${art}${sent ? '，发给老大了' : '，存在画廊里'}`;
    if (next) diary += `；下次想${next}`;
    summary = `画了张${art}${sent ? '发给老大了' : '，存在画廊里'}`;
  } else if (action === 'search') {
    // 这是**计划**，不是已发生的事：下次醒来先搜
    status = 'planned';
    mood = '好奇';
    const kw = clip(rec.search || goal, 28);
    diary = `记下想搜${kw}，下次醒来先搜`;
    summary = `记下了要搜${kw}，还没搜（下次醒来先搜）`;
  } else if (action === 'comment') {
    status = sent ? 'sent' : 'unsent';
    mood = '想插一句';
    diary = sent ? `去评论区插了句话${why ? `——${why}` : ''}` : `想评论，${notSent}`;
    if (next) diary += `；下次想${next}`;
    summary = sent ? `去评论区评了一句${why ? `（${why}）` : ''}` : `想评论但${notSent}`;
  } else if (action === 'publish') {
    status = sent ? 'sent' : 'unsent';
    mood = '想说点什么';
    diary = sent ? '发了条帖' : `想发帖，${notSent}`;
    if (next) diary += `；下次想${next}`;
    summary = sent ? '在小黑盒发了条帖' : `想发帖但${notSent}`;
  } else if (action === 'think') {
    // 想事情没有对外动作，但确实是"她自己待着时干的事"，值得记一笔
    status = 'noted';
    mood = '安静';
    const thought = clip(rec.think || rec.message || '', 46);
    diary = thought ? `想了想：${thought}` : '一个人待着想事情';
    summary = diary;
  } else if (action === 'diary') {
    status = 'noted';
    mood = '想记一笔';
    diary = '自己写了条日记';
    summary = '自己写了条日记';
  } else {
    diary = goal || '翻了翻榜单';
    summary = diary;
  }

  return {
    status,
    diary: diary.slice(0, 118),
    mood,
    summary: summary.slice(0, 90),
    hasPlan: Boolean(next) || action === 'search'
  };
}

/** 最近 n 轮她自己的活动（给对话侧注入用，不写文件、不调模型）。 */
export function recentActivity(n = 2) {
  try {
    const st = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    const h = Array.isArray(st.history) ? st.history : [];
    return h.slice(-Math.max(1, n));
  } catch { return []; }
}

/** 这条活动今天是不是已经记过（按 goal 前 12 字查今天日记）。 */
export function isActivityRecorded(rec = {}, recentDiaries = []) {
  const key = String(rec?.goal || '').slice(0, 12);
  if (!key) return false;
  return recentDiaries.some((d) => String(d?.text || d || '').includes(key));
}

/**
 * 把最近的活动拼成一段给对话用的摘要（规格 §2）。
 *
 * @param {Array} acts recentActivity() 的结果
 * @param {object} [opts]
 * @param {number} [opts.since]            只要比这个时间戳新的（防重复注入）
 * @param {number} [opts.hotCoveredUntil]  hotNote 已经覆盖到哪一刻：这轮说过什么就不再重复
 * @param {number} [opts.maxAgeMs]         超过这个时长的活动不再注入（过期计划不无限保留）
 * @returns {{note:string, injectedUpTo:number, count:number, skipped:number}}
 */
export function buildAutonomousNote(acts = [], {
  since = 0, hotCoveredUntil = 0, maxAgeMs = 24 * 3600 * 1000, now = Date.now()
} = {}) {
  const fresh = (acts || []).filter((a) => {
    const at = Number(a?.endedAt || a?.startedAt) || 0;
    return at > since && at > now - maxAgeMs;
  });
  if (!fresh.length) return { note: '', injectedUpTo: 0, count: 0, skipped: 0 };
  const lines = [];
  let skipped = 0;
  for (const a of fresh) {
    const at = Number(a.endedAt || a.startedAt) || 0;
    const covered = at > 0 && at <= hotCoveredUntil;
    const mem = activityMemory(a, { covered });
    if (!mem?.summary) { skipped += 1; continue; }
    lines.push(`- ${mem.summary}${mem.hasPlan ? '（还没做完）' : ''}`);
  }
  if (!lines.length) return { note: '', injectedUpTo: 0, count: 0, skipped };
  // 文案按机主 2026-10-31 的版本：说明用途 + 明确"不必汇报"，但不用"别主动汇报"这种
  // 强负向措辞 —— 手册第 2 节：负向祈使会把注意力吸到限制本身。
  const header = [
    '【你近期的自主活动经历】',
    '以下内容是你自己经历过的事情，用于帮助你保持记忆连续性。',
    '不需要主动汇报，也不要刻意提起。',
    '只有当当前话题自然涉及，或者老大主动询问时，才使用相关信息。',
    '不要把尚未完成的计划当作待办任务反复提醒。'
  ].join('\n');
  return {
    note: `${header}\n${lines.join('\n')}`,
    injectedUpTo: Math.max(...fresh.map((a) => Number(a.endedAt || a.startedAt) || 0)),
    count: lines.length,
    skipped
  };
}

/**
 * 写一条日记（4.0 / 1.5.2 起转发给统一 Writer）。
 *
 * 原来的实现自己拼行、自己写盘，没有幂等也没有去重 —— 同一件事重跑一轮
 * 就会在当天的日记里留两行。现在交给 Writer：去重（前 14 字）+ 幂等键，
 * 格式/分级/心情与原实现逐字一致。
 *
 * 返回形状保持不变（ok/file/line/importance），调用方不用改。
 */
export function appendDiaryLine({ content, mood, day = '', importance, root = diaryRoot() }) {
  const text = stripMoodPrefix(String(content ?? '').replace(/\s+/g, ' ').trim());
  if (!text) return { ok: false, reason: '内容为空' };
  const LEVELS = ['一般', '重要', '非常重要'];
  const imp = LEVELS.includes(String(importance ?? '').trim()) ? String(importance).trim() : '一般';
  const r = companionCore.diary.write({
    source: 'autonomous',
    content: text,
    day: day || undefined,
    mood,
    importance: imp,
    // Writer 的 root 是「每日」这一层；这里传进来的 root 是日记根
    root: path.join(root, DIARY_SUBDIR)
  });
  if (!r?.ok) return { ok: false, reason: r?.error || '写入失败' };
  return { ok: true, file: r.file, line: r.line, importance: imp, skipped: Boolean(r.skipped) };
}

/**
 * 从日记里删掉一条（按原文片段定位）。
 *
 * 为什么需要：她走 DSH 时只有 qq_diary（追加）和 qq_diary_read（读），没有删除；
 * 而 E:\dsh\本子\日记 在 DSH 沙箱 workspace 之外，她自己也改不了文件。结果就是
 * 「你让她删，她回你一句删了，文件一行没动」（2026-10-26 机主准备自己动手才发现）。
 *
 * 安全边界：只删**唯一匹配**的那一行；命中多条就拒绝并列候选，绝不猜。
 * 删之前整文件备份到 <root>\.trash\。
 */
export function removeDiaryLine({ match, day = '', root = diaryRoot() } = {}) {
  // D1-2a：收口到 Writer（文件锁 + 唯一匹配复核 + 备份 + 原子写）
  return companionCore.diary.removeLine({ match, day, root: path.join(root, DIARY_SUBDIR) });
}

/**
 * 改一条日记的等级（一般 / 重要 / 非常重要）。只动标记，正文和心情都不碰。
 *
 * 2026-10-29 机主：「让她可以修改等级，我让她修改一下」——她要能听懂
 * 「这条该算重要」并自己改，而不是重写一遍或删了重记。
 * 和写入/删除一样，必须回到主进程做（DSH 沙箱碰不到 E:\dsh\本子\日记）。
 *
 * 安全边界同删除：只改**唯一匹配**的那一行；命中多条就拒绝并列候选。
 */
export function relevelDiaryLine({ match, importance, day = '', root = diaryRoot() } = {}) {
  // D1-2a：收口到 Writer（文件锁 + 唯一匹配复核 + 备份 + 原子写）
  return companionCore.diary.relevelLine({ match, importance, day, root: path.join(root, DIARY_SUBDIR) });
}

/** 和最近写过的条目太像就不写（前 12 字相同视为重复）。 */
export function isDuplicateDiary(text, recent, { prefixLen = 12 } = {}) {
  const t = String(text ?? '').replace(/\s+/g, '');
  if (!t) return true;
  for (const r of recent) {
    for (const line of String(r.text).split('\n')) {
      const m = line.match(/^- 心情：[^｜]*｜(.+)$/);
      if (!m) continue;
      const prev = m[1].replace(/\s+/g, '');
      if (!prev) continue;
      if (prev.slice(0, prefixLen) === t.slice(0, prefixLen)) return true;
      // 太短的两条也容易撞（"看了看视频"之类）
      if (prev.length < 20 && t.length < 20 && prev.includes(t.slice(0, 8))) return true;
    }
  }
  return false;
}

/* ── 模型的调用与预算 ────────────────────────────────────────────────── */

/**
 * 预算三件套（第一版方案）：单次输入上限、每日调用次数、月度预算。
 * 数值全走配置，代码里只留兜底默认值。
 */
function budgetPolicy(s = settings()) {
  return {
    maxInputTokens: num(s.maxInputTokens, 4000, 500, 32000),
    maxCallsPerDay: num(s.maxCallsPerDay, 0, 0, 500),   // 2.3：0 = 不限制（保留字段做兼容，拦截逻辑已去掉）
    monthlyBudgetYuan: num(s.monthlyBudgetYuan, 5, 0, 1000),
    // 4.0 / 1.2：成本算不准时的 token 兜底（0 = 关）。默认 800 万 tokens/月，
    // 按当前单价约 ¥20，比 5 元预算宽松得多，只在账本口径失效时拦截。
    monthlyTokenCap: num(s.monthlyTokenCap, 8000000, 0, 100000000),
    // 总预算（聊天 + 自主抢同一笔钱）：0 = 关（默认）。要让聊天费用压缩她的额度时再开。
    totalBudgetYuan: num(s.totalBudgetYuan, 0, 0, 10000),
    pricing: {
      inputPerMillion: num(s.priceInputPerMillion, 2, 0, 1000),
      outputPerMillion: num(s.priceOutputPerMillion, 8, 0, 1000)
    }
  };
}

/** 把一次调用的 usage 记进账本（走统一账本，串行 + 原子写）；失败只警告，不影响这一轮。 */
async function noteUsage(res) {
  try {
    const p = budgetPolicy();
    const usage = res?.usage || {};
    const input = promptTokensOf(usage) || 0;
    const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    await recordAutonomousCall({
      inputTokens: input,
      outputTokens: output,
      pricing: p.pricing,
      budgetYuan: p.monthlyBudgetYuan
    });
  } catch (e) {
    warn(`token 记账失败：${e?.message ?? e}`);
  }
}

/**
 * 当前还能不能调模型（2.3 起次数不设上限）。
 *
 * 4.0 / 1.2 的教训（2026-10-31 深夜实测）：一开始直接拿「聊天+自主合计」
 * 去卡 5 元预算，结果聊天侧本月已经花了 ¥20.35 —— 她会被判超支、永久不醒。
 * 那 5 元本来是给自主活动的，聊天从来没被这 5 元约束过。
 *
 * 所以这里分三层，主限制仍是**自主自己的预算**，合计只用于展示和兜底：
 *   1) 自主预算（config.monthlyBudgetYuan）：主限制，行为与 2.x 一致；
 *   2) Token 兜底（monthlyTokenCap，可选）：成本算不准时防止无限调用；
 *   3) 总预算（totalBudgetYuan，可选、默认 0=关）：要让聊天和自主抢额度时才开。
 */
function budgetGate(s = settings()) {
  const p = budgetPolicy(s);
  const own = readUsage(USAGE_FILE, { onWarn: warn });
  own.budgetYuan = p.monthlyBudgetYuan;
  const spent = monthCost(own);          // 自主本月花费
  const budget = p.monthlyBudgetYuan;
  const m = readMonth();                 // 合计（展示 + 兜底）

  // 1) 自主自己的预算
  if (spent >= budget) {
    return {
      ok: false,
      calls: monthCalls(own),
      spent,
      remainingYuan: 0,
      reason: `自主本月已花 ¥${spent.toFixed(2)}，达到预算 ¥${budget}`,
      line: `自主 ¥${spent.toFixed(2)}/${budget}｜本月合计 ¥${Number(m.total.cost ?? 0).toFixed(2)}`
    };
  }

  // 2) Token 兜底：只看**自主自己**的 token。
  //    聊天侧一个月 6000 万 tokens 是常态，拿总量兜底等于把她永久锁死（实测踩过）。
  const tokenCap = Number(p.monthlyTokenCap) || 0;
  const mk = new Date().toISOString().slice(0, 7);
  let ownTokens = 0;
  for (const [k, v] of Object.entries(own.days || {})) {
    if (!k.startsWith(mk)) continue;
    ownTokens += (Number(v.input_tokens) || 0) + (Number(v.output_tokens) || 0);
  }
  const monthTokens = ownTokens;
  if (tokenCap > 0 && monthTokens >= tokenCap) {
    return {
      ok: false,
      calls: m.total.calls,
      spent,
      remainingYuan: Math.max(0, budget - spent),
      reason: `本月 token 已达 ${monthTokens}，超过兜底上限 ${tokenCap}（成本口径不可靠时的保护）`,
      line: `自主 ¥${spent.toFixed(2)}/${budget}｜本月 token ${monthTokens}/${tokenCap}`
    };
  }

  // 3) 总预算（默认关；开了就是聊天和自主抢同一笔钱）
  const totalCap = Number(p.totalBudgetYuan) || 0;
  const totalCost = Number(m.total.cost);
  if (totalCap > 0 && Number.isFinite(totalCost) && totalCost >= totalCap) {
    return {
      ok: false,
      calls: m.total.calls,
      spent: totalCost,
      remainingYuan: 0,
      reason: `本月合计已花 ¥${totalCost.toFixed(2)}（聊天 ¥${(m.chat?.cost || 0).toFixed(2)} + 自主 ¥${(m.autonomous?.cost || 0).toFixed(2)}），达到总预算 ¥${totalCap}`,
      line: `本月合计 ¥${totalCost.toFixed(2)}/${totalCap}`
    };
  }

  const line = `自主 ¥${spent.toFixed(2)}/${budget}`
    + `｜本月合计 ¥${Number.isFinite(totalCost) ? totalCost.toFixed(2) : '未知'}`
    + `（聊天 ¥${(m.chat?.cost || 0).toFixed(2)} + 自主 ¥${(m.autonomous?.cost || 0).toFixed(2)}）`;
  return { ok: true, calls: monthCalls(own), spent, remainingYuan: Math.max(0, budget - spent), reason: '', line };
}

/**
 * 发给模型前的最后一道清洗：去掉孤立代理与控制字符。
 *
 * 代理对（emoji）被 slice 切一半时，JSON.stringify 会生成 `\ud83d` 这种半截转义，
 * 网关解析请求体直接 400「unexpected end of hex escape」，整轮白跑。
 * planner.safeSlice 已经尽量不切，这里是兜底：任何来源的文本都过一遍。
 */
function sanitizeForModel(text) {
  return String(text ?? '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
}

function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => (
    m && typeof m.content === 'string'
      ? { ...m, content: sanitizeForModel(m.content) }
      : m
  ));
}

async function callModel({ messages, maxTokens = 500, temperature = 0.8, purpose = 'other' }) {
  const llm = await import('../../src/llm.js');
  const res = await llm.chatCompletionObserved(purpose, {
    messages: sanitizeMessages(messages),
    temperature,
    maxTokens,
    // 后台"随便看看"不需要深度思考，开着思考会把预算烧在 reasoning 上
    skillContext: { thinkingMode: 'off' }
  });
  const raw = res?.message?.content;
  const text = Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('') : String(raw ?? '');
  await noteUsage(res);
  return { text, usage: res?.usage || null };
}

/**
 * 带硬预算的一次调用：先估、再裁、裁不动就返回 skipped。
 * **这是唯一允许发起模型请求的入口**，其它地方不要直接调 llm。
 */
export async function callModelWithBudget({ build, candidates, limit, target, state, maxTokens, temperature, purpose = 'other' }) {
  const cap = num(limit, 4000, 500, 32000);
  const goal = Math.min(cap, num(target, 3400, 400, 32000));
  const fitted = fitToBudget({ limit: goal, build, candidates, calibration: Number(state?.calibration) || 1 });
  if (!fitted.ok) return { ok: false, skipped: true, reason: fitted.reason };
  const estimated = fitted.tokens;
  const res = await callModel({ messages: fitted.messages, maxTokens, temperature, purpose });
  const actual = promptTokensOf(res.usage);
  if (actual > cap) {
    // 估算漏了（例如模型侧有额外注入）：不重试、不硬发，直接记下来交给下一轮收紧
    warn(`本轮输入实际 ${actual} tokens，超过硬上限 ${cap}；已记为预算异常`);
  }
  if (actual > 0) recordCalibration(state, estimated, actual);
  return { ok: true, ...res, estimated, actual, plan: fitted.plan };
}

/* ── 日记回顾（每天固定两个时间点）──────────────────────────────────
 * 机主要求：中午 11 点和晚上 23 点各想一次「今天有没有值得记进日记的」，
 * 前提是进程在跑。它和自主浏览是两条独立的线：
 *   · 不看榜单、不分享，只回顾今天聊过什么、最近写过什么；
 *   · 有值得记的就写（带重要等级），没有就什么都不做；
 *   · 同一件事写第二遍会被 addDiary 合并，不占两份记忆。
 */

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 读最近 N 条私聊记录（经 Core/ChatStore；只读最后一段）。 */
function readRecentChat(limit = 40) {
  const master = String(getConfig()?.persona?.masterId || settings().shareTarget || '1846383180').replace(/[^0-9]/g, '');
  const r = companionCore.context.readPrivateHistory(`private:${master}`, { limit });
  if (!r.ok) { warn(`私聊历史读取失败（readRecentChat）：${r.error}`); return []; }
  return r.messages.map((m) => ({
    self: Boolean(m.self),
    text: String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    ts: Number(m.ts) || 0
  })).filter((m) => m.text);
}

/** 今天老大提过的话题（只取他的消息），最多 max 条，每条 40 字。 */
function chatTopicsToday(max = 8) {
  const master = String(getConfig()?.persona?.masterId || settings().shareTarget || '1846383180').replace(/[^0-9]/g, '');
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const r = companionCore.context.readPrivateHistory(`private:${master}`, { all: true, since: start.getTime() });
  if (!r.ok) { warn(`私聊历史读取失败（chatTopicsToday）：${r.error}`); return []; }
  const rows = r.messages.filter((m) => !m.self && Number(m.ts) >= start.getTime() && String(m.text ?? '').trim());
  return rows.slice(-max).map((m) => String(m.text).replace(/\s+/g, ' ').trim().slice(0, 40));
}

/** 让模型判断今天有没有值得记的，返回 [{content, mood, importance}]。 */
async function askDiaryReview({ slot, chat, recentDiary }) {
  const system = `你是她的后台习惯：每天中午和睡前各回看一次今天，判断有没有值得写进日记的事。

规则：
1. 只记**具体、有画面**的事，一到两句话，像「那只梨没回来」那样。
2. 分三档，但**默认就是「一般」**：
   - 一般：今天聊了什么、看到什么、觉得好笑或感动——全是一般。
   - 重要：**有明确的后续行动**（答应了要做什么、约好要一起做什么、要买/要去），或者她持续表现出兴趣、下次醒来还想接着看。
   - 非常重要：影响长期目标、关键决定，或者你们长期的相处方式。
   拿不准一律「一般」，不要为了显得认真而升级。
3. 今天已经写过的类似内容不要再写——重复不增加分量。
4. 没有值得记的就返回空数组，不要凑数。
5. 倒苦水、负能量不写。

只输出 JSON，不要代码块：{"entries":[{"content":"...","mood":"开心","importance":"一般|重要|非常重要"}],"note":"<一句话说明为什么写/不写>"}`;
  const chatText = chat.map((m) => `${m.self ? '我' : '老大'}：${m.text}`).join('\n').slice(-4000);
  const diaryText = recentDiary.map((d) => `【${d.day}】\n${d.text.slice(0, 600)}`).join('\n\n').slice(0, 2500);
  const user = [
    `现在是 ${slot}，回看今天。`,
    chatText ? `今天的聊天（从旧到新）：\n${chatText}` : '今天还没怎么聊天。',
    diaryText ? `最近两天写过的日记（别重复）：\n${diaryText}` : '最近两天没写日记。',
    '按约定输出 JSON。'
  ].join('\n\n');

  const builder = (count, summaryChars) => {
    const body = summaryChars > 0 ? user.slice(0, Math.max(600, summaryChars * 12)) : user.slice(0, 1200);
    return [{ role: 'system', content: system }, { role: 'user', content: body }];
  };
  return builder;
}

async function runDiaryReview({ s, st, slot }) {
  const chat = readRecentChat(40);
  const recentDiary = readRecentDiary(2);
  if (!chat.length && !recentDiary.length) {
    log(`日记回顾（${slot}）：今天没有聊天记录，跳过`);
    return { wrote: 0, skipped: 'no-context' };
  }
  const gateRes = budgetGate(s);
  if (!gateRes.ok) {
    log(`日记回顾（${slot}）跳过：${gateRes.reason}`);
    return { wrote: 0, skipped: 'budget' };
  }
  const builder = await askDiaryReview({ slot, chat, recentDiary });
  const limit = num(s.maxInputTokens, 4000, 500, 32000);
  const fitted = fitToBudget({ limit: Math.min(limit, num(s.inputTokenTarget, 3400, 400, 32000)), build: builder, candidates: [], calibration: Number(st.calibration) || 1 });
  if (!fitted.ok) {
    warn(`日记回顾（${slot}）预算不够，跳过：${fitted.reason}`);
    return { wrote: 0, skipped: 'budget' };
  }
  const res = await callModel({ messages: fitted.messages, maxTokens: 700, temperature: 0.7, purpose: 'autonomous.diary_review' });
  const parsed = parseDecision(res.text);
  if (!parsed.ok) {
    warn(`日记回顾（${slot}）输出不可解析：${parsed.error}`);
    return { wrote: 0, skipped: 'parse' };
  }
  const entries = Array.isArray(parsed.decision?.entries) ? parsed.decision.entries : [];
  const note = String(parsed.decision?.note ?? '');
  if (!entries.length) {
    log(`日记回顾（${slot}）：没有值得记的${note ? `（${note.slice(0, 60)}）` : ''}`);
    return { wrote: 0, skipped: 'nothing' };
  }
  let wrote = 0;
  for (const e of entries.slice(0, 3)) {
    const content = String(e?.content ?? '').trim();
    if (!content) continue;
    if (looksGeneric(content)) continue;
    if (isDuplicateDiary(content, readRecentDiary(2))) continue;
    const imp = ['一般', '重要', '非常重要'].includes(String(e?.importance)) ? String(e.importance) : '一般';
    const r = appendDiaryLine({ content, mood: String(e?.mood ?? ''), importance: imp });
    if (r.ok) {
      wrote += 1;
      log(`日记回顾（${slot}）写入：${imp}｜${content.slice(0, 40)}`);
    }
  }
  return { wrote, note };
}

/** 到点就跑一次；同一天同一个时间点只跑一次（状态里记着）。 */
async function maybeDiaryReview(s) {
  if (s.diaryReviewEnabled === false) return;
  const times = String(s.diaryReviewTimes || '11:00,23:00').split(',').map((x) => x.trim()).filter(Boolean);
  if (!times.length) return;
  const now = new Date();
  const key = todayKey(now);
  const st = readState(STORE, { onWarn: warn });
  st.diaryReview = st.diaryReview && typeof st.diaryReview === 'object' ? st.diaryReview : {};
  const done = Array.isArray(st.diaryReview[key]) ? st.diaryReview[key] : [];
  for (const slot of times) {
    const [h, m] = slot.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    const target = h * 60 + m;
    const current = now.getHours() * 60 + now.getMinutes();
    // 只在到点后的 0~9 分钟窗口内触发（tick 是 5 分钟一次，足够覆盖）
    if (current < target || current > target + 9) continue;
    if (done.includes(slot)) continue;
    const r = await runDiaryReview({ s, st, slot });
    st.diaryReview[key] = [...done, slot];
    // 只留最近 7 天，别让状态文件无限长
    const keys = Object.keys(st.diaryReview).sort();
    while (keys.length > 7) delete st.diaryReview[keys.shift()];
    writeState(STORE, st);
    log(`日记回顾（${slot}）完成：写入 ${r.wrote} 条${r.skipped ? `（${r.skipped}）` : ''}`);
  }
}

/* ── 一轮活动 ────────────────────────────────────────────────────────── */

function nextWakeAt(nowTs, intervalHours) {
  return nowTs + Math.max(1, num(intervalHours, 3, 1, 24)) * 3600 * 1000;
}

/**
 * 跑一轮。返回本轮记录（也会写进状态 history）。
 * 不抛异常：任何失败都折成 stopReason 写进状态，下一轮照常。
 */
/**
 * 把「她一个人时在干嘛」写成人能读的 markdown（最新在最上面）。
 * 机主要求能看见她空闲时浏览/搜索/思考什么，所以这里记：来源、翻过哪些条目、
 * 这轮想做什么、挑中哪条、为什么、决定做什么、下次想接着干嘛。
 * 只保留最近 N 轮，文件不会无限长；整个文件可以随时删，删了不影响运行。
 */
function appendActivityLog(rec) {
  const t = new Date(rec.startedAt);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
  const lines = [`## ${stamp}`];
  if (rec.sources?.length) lines.push(`- 来源：${rec.sources.join('、')}`);
  if (rec.candidateTitles?.length) {
    lines.push(`- 翻了 ${rec.candidates} 条：${rec.candidateTitles.slice(0, 8).join('；')}${rec.candidateTitles.length > 8 ? '…' : ''}`);
  }

  // 2.1：一轮最多两件事，逐件记（含无成果的），事实和评价分开写
  const acts = Array.isArray(rec.actions) && rec.actions.length ? rec.actions : null;
  if (acts) {
    for (const [i, a] of acts.entries()) {
      lines.push(`- 第 ${i + 1} 件：${a.action}｜${a.result}${a.resultSummary ? `（${a.resultSummary}）` : ''}`);
      if (a.goal) lines.push(`  想干什么：${a.goal}`);
      if (a.why) lines.push(`  为什么：${a.why}`);
      if (a.picked) lines.push(`  内容：${a.picked}`);
      if (a.share) lines.push(`  说给你听：${a.share}`);
      if (a.chat) lines.push(`  主动找你：${a.chat}`);
      if (a.diary) lines.push(`  日记：${a.diary}`);
      if (a.reflection) lines.push(`  她的评价：${a.reflection}`);
      if (a.next) lines.push(`  下次想接着：${a.next}`);
    }
  } else {
    // 旧记录（没有 actions）：保持原来的写法
    if (rec.goal) lines.push(`- 这轮想干什么：${rec.goal}`);
    if (rec.picked) lines.push(`- 挑中：${rec.picked}`);
    if (rec.why) lines.push(`- 为什么：${rec.why}`);
    if (rec.action) lines.push(`- 决定：${rec.action}`);
    if (rec.share) lines.push(`- 说给你听：${rec.share}`);
    if (rec.chat) lines.push(`- 主动找你：${rec.chat}`);
    if (rec.diary) lines.push(`- 日记：${rec.diary}`);
    if (rec.next) lines.push(`- 下次想接着：${rec.next}`);
  }

  lines.push(`- 结束：${rec.stopReason}${rec.error ? `（${String(rec.error).slice(0, 60)}）` : ''}｜输入 ${rec.inputTokens} tokens`);
  const block = `${lines.join('\n')}\n`;

  const head = '# 她一个人时都在干嘛（自动记录，可随时删）\n';
  let body = '';
  try { body = fs.readFileSync(ACTIVITY_LOG, 'utf8'); } catch { /* 还没有 */ }
  if (body.startsWith(head)) body = body.slice(head.length);
  body = `${block}${body}`;
  const parts = body.split(/\n(?=## )/).filter(Boolean);
  const kept = parts.slice(0, ACTIVITY_LOG_MAX).join('\n');
  fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
  fs.writeFileSync(ACTIVITY_LOG, `${head}${kept}`, 'utf8');
}

/* ── 2.1：一次醒来最多两件事 ─────────────────────────────────────────── */

/** 行动类型（同一轮不能重复）。finish 不参与。 */
function actionTypeOf(action) {
  return String(action || 'explore');
}

/** 行动 id：平台 + 类型（xhh_share / bili_comment / draw…），给跨轮冷却用。 */
function actionIdOf(action, item) {
  const src = String(item?.source || '').toLowerCase();
  const platform = src.startsWith('xhh') ? 'xhh'
    : src.startsWith('bili') ? 'bili'
      : src === 'phone' ? 'phone' : '';
  return platform ? `${platform}_${action}` : String(action || '');
}

/** 把第一件事的字段镜像到 rec 顶层，兼容旧的读法（面板/日志/记忆）。 */
function applyLegacyFields(rec, out) {
  rec.action = out.action;
  rec.goal = out.goal;
  rec.why = out.why;
  rec.next = out.next;
  rec.picked = out.picked;
  rec.share = out.share;
  rec.chat = out.chat;
  rec.draw = out.draw;
  rec.drawFile = out.drawFile;
  rec.drawTitle = out.drawTitle;
  rec.diary = out.diary;
  rec.comment = out.comment;
  rec.publish = out.publish;
  rec.search = out.search;
  if (out.mode) rec.shareMode = out.mode;
}

/** 一轮结束语：优先用循环里已经写好的原因（超时/兜底），否则按做的事生成。 */
function stopReasonOf(rec) {
  if (rec.stopReason) return rec.stopReason;
  const list = Array.isArray(rec.actions) ? rec.actions : [];
  if (!list.length) return '完成：这轮什么都没做';
  const names = list.map((a) => a.action).join(' / ');
  const got = list.filter((a) => a.result === 'success').length;
  if (!got) return `完成：做了 ${list.length} 件，都没结果（${names}）`;
  return `完成：做了 ${list.length} 件（${names}）`;
}

/**
 * 2.3：她自己约下一次醒来的时间。
 *
 * 约束（方案二节）：30 分钟 ~ 24 小时；每天最多 4 次自主预约；新约覆盖旧约；
 * 不预约就沿用 3 小时默认周期。预约只是"多一次决策机会"，不是必须执行原计划。
 */
function applySelfWake(st, minutes, reason) {
  const m = Math.trunc(Number(minutes));
  if (!Number.isFinite(m) || m < 30 || m > 1440) return false;
  const today = new Date().toISOString().slice(0, 10);
  st.selfWakeCount = st.selfWakeCount && typeof st.selfWakeCount === 'object' ? st.selfWakeCount : {};
  st.selfWakeCount[today] = Number(st.selfWakeCount[today] || 0);
  if (st.selfWakeCount[today] >= 4) {
    log(`今天自主预约已经 ${st.selfWakeCount[today]} 次，这次不再改时间`);
    return false;
  }
  st.selfWakeCount[today] += 1;
  st.selfWake = {
    enabled: true,
    wakeAt: Date.now() + m * 60 * 1000,
    reason: String(reason || '').slice(0, 120),
    source: '自主决定'
  };
  log(`她约了自己 ${m} 分钟后醒来（今天第 ${st.selfWakeCount[today]} 次）：${st.selfWake.reason || '—'}`);
  return true;
}

/** 防失控的保险，不是常规限制：一轮最多做这么多件事，正常远用不到。 */
const MAX_ACTIONS_SAFETY = 8;
/**
 * 意图阶段（2.2）：醒来先问「你现在想做什么」，**这一步不给任何候选**。
 *
 * 为什么：2026-10-31 发现 20 轮里 19 轮的 goal 都是"把 X 递给老大"——
 * 先给榜单的话，她的"选择"就只剩"挑哪条"，永远想不起自己想干嘛。
 *
 * 失败时返回 null，主流程按"没意图"走（抓榜单 + 普通决策），不影响可用性。
 */
async function decideIntent({ s, st, rec }) {
  const personaSnippet = String(getConfig()?.persona?.roleText ?? '').slice(0, 500);
  const when = new Date().toLocaleString('zh-CN', { hour12: false });
  // 4.0 / 2.4：改从 Companion State 读。
  //
  // 旧的实现是 [topic, intent].join('｜') —— 查过数据，两者内容 100% 相同，
  // 所以以前拼出来是「A｜A」这种重复文本。新 schema 只有 text，不再拼。
  //
  // 现在允许多条：只传未结算的（pending / waiting），排除 done / cancelled。
  // 过期的照样传，但标出来 —— **过期 ≠ 已完成**。
  // 这是**上下文，不是行动命令**：她知道有几件事没做完，不代表每轮都要逐条处理。
  const pendList = activePending();
  const nowTs = Date.now();
  const pending = pendList.map((p) => {
    const expired = p.expiresAt && Date.parse(p.expiresAt) < nowTs;
    const tag = p.status === 'waiting' ? '（在等）' : '';
    return p.text + tag + (expired ? '（已过期，需重新确认）' : '');
  }).join('；');
  const recentDiary = readRecentDiary(2).map((d) => d.text.slice(0, 400)).join('\n\n').slice(0, 900);
  // 最近几句对话 + 今天聊过的话题：让她知道哪些事已经聊过、对方已经答过，别再追问。
  // 2026-10-31 的「部署进度」被问到第四次，就是因为意图阶段完全看不到聊天。
  const topics = chatTopicsToday(8);
  const recentChat = [
    ...(topics.length ? [`今天老大提过：${topics.join('；')}`] : []),
    ...readRecentChat(6).map((m) => `${m.self ? '我' : '老大'}：${m.text.slice(0, 100)}`)
  ].join('\n');
  const abilities = '翻 B站/小黑盒榜单、搜东西、看帖子详情、评论、发帖、画四种画、写日记、找老大说话、自己想想事';

  const messages = makeIntentMessages({
    personaSnippet, when, abilities, pending, recentDiary, recentChat
  });
  const r = await callModelWithBudget({
    build: () => messages,
    purpose: 'autonomous.intent',
    candidates: [{ title: '(先决定想做什么，这一步没有候选)', source: 'none', url: '' }],
    limit: s.maxInputTokens,
    target: s.inputTokenTarget,
    state: st,
    maxTokens: 220,
    temperature: 0.85
  });
  rec.modelCalls += 1;
  if (!r.ok) {
    rec.error = r.reason;
    return null;
  }
  rec.inputTokens += r.actual || r.estimated || 0;
  rec.outputTokens += Number(r.usage?.completion_tokens) || 0;
  const parsed = parseIntent(r.text);
  if (!parsed.ok) {
    warn(`意图解析失败（按没意图处理）：${parsed.error}`);
    return null;
  }
  return parsed.intent;
}

/** 决策一次（不执行）。第二次调用时带上"已经做过什么"和"上次的真实结果"。 */
async function decideOnce({ s, st, rec, fresh, personaSnippet, usedTypes, prevResult, round, intent = null }) {
  const builder = makeBuilder({
    candidates: fresh,
    personaSnippet,
    state: st,
    usedTypes,
    prevResult,
    round,
    intent
  });
  const r = await callModelWithBudget({
    build: builder,
    purpose: 'autonomous.decision',
    candidates: fresh,
    limit: s.maxInputTokens,
    target: s.inputTokenTarget,
    state: st,
    maxTokens: 500,
    temperature: 0.85
  });
  rec.modelCalls += 1;
  st.consecutiveFailures = 0;
  if (!r.ok) return { ok: false, reason: r.reason };
  rec.inputTokens += r.actual || r.estimated || 0;
  rec.outputTokens += Number(r.usage?.completion_tokens) || 0;
  const parsed = parseDecision(r.text);
  if (!parsed.ok) return { ok: false, reason: parsed.error };
  return { ok: true, decision: validateDecision(parsed.decision, fresh.length) };
}

/**
 * 执行一件事，返回结构化结果。
 *
 * ⚠️ result 是**程序判定**（成功 / 失败 / 跳过 / 无产出），
 * reflection 是**模型自己的话**，两者不能混——面板和日记都按这个分工展示。
 * no_output 不等于 failed：没找到值得分享的、没灵感，都是正常的。
 */
async function executeAction({ s, st, rec, decision, picked, dryRun }) {
  const action = decision.action;
  const nowTs = Date.now();
  const out = {
    at: nowTs,
    action,
    actionType: actionTypeOf(action),
    actionId: actionIdOf(action, picked),
    goal: decision.goal,
    why: decision.why,
    next: decision.next,
    nextStatus: decision.next ? 'pending' : '',
    reflection: decision.reflection || '',
    result: 'no_output',
    resultSummary: '',
    mode: '',
    // 兼容字段：activityMemory / 面板 / 日志都读这些名字
    picked: picked ? `${picked.title}（${picked.url}）` : '',
    share: '', chat: '', draw: '', drawFile: '', drawTitle: '',
    diary: '', comment: '', publish: '', search: ''
  };

  const fromMode = (mode, okText, failText) => {
    if (mode === 'live') { out.result = 'success'; out.resultSummary = okText; return; }
    if (mode === 'failed' || mode === 'invalid') { out.result = 'failed'; out.resultSummary = failText || `发送失败（${mode}）`; return; }
    if (mode) { out.result = 'skipped'; out.resultSummary = `没发出去（${mode}）`; return; }
    out.result = 'no_output';
  };

  try {
    if (action === 'share' && picked) {
      const sent = await maybeShare({ s, st, item: picked, message: decision.message, nowTs, dryRun });
      out.share = sent.text;
      out.mode = sent.mode;
      fromMode(sent.mode, `把「${String(picked.title).slice(0, 30)}」分享出去了`, '分享没发出去');
    } else if (action === 'chat' && decision.message) {
      const sent = await maybeShare({ s, st, item: null, message: decision.message, nowTs, dryRun, kind: 'chat' });
      out.chat = sent.text;
      out.mode = sent.mode;
      fromMode(sent.mode, `主动说了句话：${String(decision.message).slice(0, 30)}`, '主动消息没发出去');
    } else if (action === 'draw' && s.drawEnabled !== false) {
      const drawn = await maybeDraw({ s, st, decision, nowTs, dryRun });
      out.draw = drawn.text;
      out.drawFile = drawn.file || '';
      out.drawTitle = String(decision.draw?.title || '');
      out.mode = drawn.mode || '';
      if (drawn.file) {
        // 画出来了就算成功；分享成没成功另说
        out.result = 'success';
        out.resultSummary = out.mode === 'live'
          ? `画好并发出去了《${out.drawTitle || '未命名'}》`
          : `画好了《${out.drawTitle || '未命名'}》，存在画廊里`;
        if (out.mode && out.mode !== 'live' && out.mode !== 'silent') {
          out.resultSummary += `（分享：${out.mode}）`;
        }
      } else {
        out.result = 'failed';
        out.resultSummary = drawn.text || '画图失败';
      }
    } else if (action === 'comment' && picked) {
      const c = await maybeComment({ s, st, item: picked, comment: decision.comment, nowTs, dryRun });
      out.comment = c.text;
      out.mode = c.mode;
      fromMode(c.mode, '评论发出去了', '评论没发出去');
      if (c.mode === 'skipped') { out.result = 'no_output'; out.resultSummary = '想了想没什么想说的'; }
    } else if (action === 'publish') {
      const p = await maybePublish({ s, st, decision, nowTs, dryRun });
      out.publish = p.text;
      out.mode = p.mode;
      fromMode(p.mode, `发了条帖《${String(decision.publish?.title || '').slice(0, 20)}》`, '发帖没成功');
      if (p.mode === 'skipped') { out.result = 'no_output'; out.resultSummary = '没写够，跳过'; }
    } else if (action === 'search' && decision.search?.keyword) {
      // 这是**计划**，不是已发生的事：下次醒来先搜
      st.pendingSearch = {
        keyword: decision.search.keyword,
        source: decision.search.source,
        at: nowTs
      };
      out.search = `下次醒来先搜：${decision.search.keyword}（${decision.search.source}）`;
      out.result = 'success';
      out.resultSummary = `记下要搜「${decision.search.keyword}」，下次醒来先搜`;
    } else if (action === 'think') {
      // 只是想把一件事想清楚：不对外发。想法存进记录（可能进日记），不打扰老大。
      const thought = String(decision.message || '').trim();
      if (!thought) {
        out.result = 'no_output';
        out.resultSummary = '想了一会儿，没想出什么';
      } else {
        out.think = thought;
        out.result = 'success';
        out.resultSummary = `想清楚了一件事：${thought.slice(0, 40)}`;
      }
    } else if (action === 'diary') {
      const text = String(decision.diary || decision.why || '').trim();
      if (!text) { out.result = 'skipped'; out.resultSummary = '没给出日记正文'; }
      else if (looksGeneric(text)) { out.result = 'no_output'; out.resultSummary = `写太泛，没记：${text.slice(0, 20)}`; }
      else if (dryRun) { out.result = 'skipped'; out.resultSummary = '演练，没写'; }
      else {
        const recent = readRecentDiary(2);
        if (isDuplicateDiary(text, recent)) { out.result = 'skipped'; out.resultSummary = '和最近重复，没写'; }
        else {
          const r = appendDiaryLine({ content: text, mood: decision.mood });
          out.diary = r.ok ? `已写 ${r.file}` : `写失败：${r.reason}`;
          out.result = r.ok ? 'success' : 'failed';
          out.resultSummary = r.ok ? `写了条日记：${text.slice(0, 30)}` : `日记写失败：${r.reason}`;
        }
      }
    } else if (action === 'explore') {
      out.result = 'no_output';
      out.resultSummary = '翻了翻，没有想做的';
    } else {
      out.result = 'no_output';
      out.resultSummary = '没挑中合适的内容';
    }
  } catch (e) {
    out.result = 'failed';
    out.resultSummary = `执行出错：${String(e?.message ?? e).slice(0, 60)}`;
  }
  return out;
}

export async function runSession({ fetchImpl = globalThis.fetch, force = false, nowTs = Date.now(), dryRun = false } = {}) {
  // 4.0 / 2.6-B5c：**同一时刻只允许一轮**。
  // 并发触发时直接跳过 —— 不排队（自主活动有时效性，排队会让旧一轮延迟执行甚至堆积），
  // 也不抛错（那会被当成一次失败记进 consecutiveFailures）。
  if (sessionRunning) return { skipped: 'already-running' };
  sessionRunning = true;

  // 一轮自主活动的起点：意图 / 决策 / 日记回顾都会挂在同一个 roundId 下。
  // 4.0 / 1.5.8.8：这一轮的 roundId 要落进 history，面板才能把模型调用和行动对上。
  const round = enterRound({ kind: 'autonomous' });
  const s = settings();
  const st = readState(STORE, { onWarn: warn });
  // 老大已经回过话的话，这次「等回话」就结束了 —— 不结算会带着旧 goal 再问一遍。
  try { settleChatPending(st); } catch (e) { warn(`待办结算失败：${e?.message ?? e}`); }
  const startedAt = nowTs;
  const windowMs = num(s.windowMinutes, 30, 1, 180) * 60 * 1000;
  const deadline = startedAt + windowMs;
  const maxCalls = num(s.maxModelCalls, 6, 1, 20);

  const rec = {
    roundId: round?.roundId || '',
    startedAt,
    endedAt: 0,
    status: 'ACTIVE',
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    candidates: 0,
    // 以下这些是给机主"看她一个人时在干嘛"用的：来源、候选、为什么挑、下一步想做什么
    sources: [],
    candidateTitles: [],
    // 2026-10-31 2.1：一次醒来最多两件事，每件事一条结构化记录。
    // 顶层的 action/goal/why/picked… 保留成"第一件事"的兼容视图，
    // 旧代码（面板、日志、activityMemory）不用改也能读。
    actions: [],
    action: '',
    goal: '',
    why: '',
    next: '',
    picked: '',
    share: '',
    chat: '',
    shareMode: String(s.shareMode || 'dryRun'),
    diary: '',
    stopReason: '',
    error: ''
  };

  st.status = 'ACTIVE';
  st.lastWakeAt = startedAt;
  st.deadlineAt = deadline;
  st.modelCallsUsed = 0;
  st.itemsExamined = 0;

  /**
   * 判断这一轮之后要不要立一条长期 Goal（4.0 / 2.6-B5b）。
   *
   * **独立模型调用，只通过 createAutonomousGoal 创建。**
   * 任何失败都只 warn，绝不影响本轮的结束流程。
   *
   * @param {object} o
   * @param {object} o.rec     本轮记录
   * @param {object} o.st      当前状态（会被改 goalJudgeLog / goalJudgeCount）
   * @param {Function} o.call  调模型的函数（测试可注入）
   */
  async function judgeGoalCandidate({ rec, st, call }) {
    // 状态快照（每次判断前读一次，判断完再写回）
    const safeLog = Array.isArray(st.goalJudgeLog) ? st.goalJudgeLog : [];
    const safeCount = st.goalJudgeCount && typeof st.goalJudgeCount === 'object' ? st.goalJudgeCount : {};

    const gate = shouldJudge({ rec, digests: st.digests, log: safeLog, count: safeCount });
    if (!gate.ok) {
      // 跳过原因也记一条（便于排查"为什么没判断"），但**不消耗预算**
      st.goalJudgeLog = appendJudgeLog(safeLog, { roundId: rec?.roundId, outcome: 'skipped', code: gate.code });
      return { outcome: 'skipped', code: gate.code };
    }

    // 取窗口内的 digest + 本次给过的 roundId / objective（校验用）
    const digests = Array.isArray(st.digests) ? st.digests : [];
    const built = buildJudgeInput(digests, JUDGE_WINDOW);
    const digestRoundIds = new Set(built.list.map((x) => x.roundId));
    const objectives = built.list.flatMap((x) => (x.actions || []).map((a) => a.objective));

    // 预算先记（不管后面成功失败，这次调用都算用掉了）
    st.goalJudgeCount = bumpJudgeCount(safeCount, gate.dayKey);

    let judgement = null;
    try {
      const text = await call(built.messages);
      const parsed = parseJudgement(text);
      if (!parsed.ok) {
        st.goalJudgeLog = appendJudgeLog(safeLog, { roundId: rec.roundId, outcome: 'failed', code: parsed.code });
        warn(`Goal 判断失败（不影响本轮）：${parsed.reason}`);
        return { outcome: 'failed', code: parsed.code };
      }
      judgement = parsed.judgement;
    } catch (e) {
      st.goalJudgeLog = appendJudgeLog(safeLog, { roundId: rec.roundId, outcome: 'failed', code: 'MODEL_ERROR' });
      warn(`Goal 判断调用失败（不影响本轮）：${e?.message ?? e}`);
      return { outcome: 'failed', code: 'MODEL_ERROR' };
    }

    // 程序校验（八项）
    const v = validateJudgement(judgement, {
      digestRoundIds,
      historyRounds: historyRoundIds(),
      objectives
    });

    if (!v.ok) {
      st.goalJudgeLog = appendJudgeLog(safeLog, { roundId: rec.roundId, outcome: 'rejected', code: v.code });
      warn(`Goal 候选被拒（${v.code}）：${v.reason}`);
      return { outcome: 'rejected', code: v.code };
    }
    if (v.noCandidate) {
      st.goalJudgeLog = appendJudgeLog(safeLog, { roundId: rec.roundId, outcome: 'no-candidate' });
      return { outcome: 'no-candidate' };
    }

    // 创建（**只用 createAutonomousGoal，不传 knownRounds**）
    const created = createAutonomousGoal({ text: v.text, evidence: v.evidence });
    if (!created.ok) {
      st.goalJudgeLog = appendJudgeLog(safeLog, { roundId: rec.roundId, outcome: 'rejected', code: created.code || 'CREATE_FAILED' });
      warn(`自主 Goal 创建失败（不影响本轮）：${created.code || created.error}`);
      return { outcome: 'rejected', code: created.code || 'CREATE_FAILED' };
    }

    st.goalJudgeLog = appendJudgeLog(safeLog, {
      roundId: rec.roundId,
      outcome: 'created',
      goalId: created.goal?.id || ''
    });
    log(`立了一条长期方向：${v.text}（${created.created ? '新建' : '已存在'}）`);
    return { outcome: 'created', goalId: created.goal?.id };
  }

  const finish = (reason) => {
    rec.endedAt = Date.now();
    rec.stopReason = reason;
    rec.status = 'IDLE';
    st.status = 'IDLE';
    st.lastStopReason = reason;
    st.nextWakeAt = nextWakeAt(rec.endedAt, s.intervalHours);
    st.modelCallsUsed = rec.modelCalls;
    st.itemsExamined = rec.candidates;
    // 2.1：记下这轮用过的行动类型，下一轮 planner 能据此避开（跨轮冷却的基础）。
    // 现在只记录、不强制排除 —— 先观察几轮真实选择，再决定要不要硬过滤。
    st.lastActionTypes = (Array.isArray(rec.actions) ? rec.actions : []).map((a) => a.action).filter(Boolean);
    // 2.3：本轮结束时统一处理自主预约（一轮最多一次）。
    // ⚠️ 必须在 writeState 之前 —— 否则 st.selfWake 不会落盘，重启就丢。
    try {
      if (rec.wakeAfterMinutes) applySelfWake(st, rec.wakeAfterMinutes, rec.wakeReason);
    } catch (e) { warn(`自主预约失败：${e?.message ?? e}`); }
    pushHistory(st, rec);
    // 4.0 / 2.6-B5a：把这一轮整理成轻量 digest（幂等：同 roundId 不重复加）。
    // **只做索引，不做判断** —— 不调模型、不建 Goal。
    // buildDigest 在异常轮次 / 无 roundId / 无有效 Action 时返回 null，这里直接跳过。
    try {
      const dg = buildDigest(rec);
      if (dg) {
        const merged = appendDigest(st.digests, dg);
        if (merged.added) st.digests = merged.list;
      }
    } catch (e) { warn(`Round 摘要失败（不影响本轮）：${e?.message ?? e}`); }
    try { writeState(STORE, st); } catch (e) { warn(`状态写入失败：${e?.message ?? e}`); }
    // 4.0 / 2.6-B5b：本轮已落盘，做一次长期方向判断。
    // **不 await** —— finish 是同步的，判断结果自己再写一次状态。
    // 任何异常都只 warn，不影响本轮的结束流程。
    try {
      judgeGoalCandidate({
        rec,
        st,
        call: (msgs) => callModel({ messages: msgs, maxTokens: 400, temperature: 0.3, purpose: 'autonomous.goal_candidate' })
      }).then(() => {
        try { writeState(STORE, st); } catch (e) { warn(`判断记录写入失败：${e?.message ?? e}`); }
      }).catch((e) => warn(`Goal 判断异常（不影响本轮）：${e?.message ?? e}`));
    } catch (e) { warn(`Goal 判断启动失败：${e?.message ?? e}`); }
    try { appendActivityLog(rec); } catch (e) { warn(`活动日志写入失败：${e?.message ?? e}`); }
    // 把这一轮「我自己干了什么」写进日记（第一人称一行，默认「一般」）。
    // 为什么：她空闲时的思考发生在主进程的独立模型调用里，只落 autonomous.json，
    // 不进 DSH 会话 —— 结果 2026-10-31 机主问她「你会自己看东西吗」，她答"不会"。
    // 写进日记她第二天翻得到，才算真的"记得"。
    // finish（看了但没动）不写：那不是经历，是空转。
    // 演练（dryRun）也不写：只验证逻辑，不能往真实日记里塞东西。
    try {
      if (!dryRun) {
        const mem = activityMemory(rec);
        if (mem) {
          // 同一条不重复写：拿 goal 前 12 字在今天日记里查一遍。
          // 进程重启/重跑同一轮时不至于在日记里留两条一模一样的经历。
          const today = readRecentDiary(1);
          if (isActivityRecorded(rec, today)) {
            log(`自述日记跳过（今天已经写过类似的）：${String(rec.goal || '').slice(0, 12)}`);
          } else {
            const w = appendDiaryLine({ content: mem.diary, mood: mem.mood, importance: '一般', root: diaryRoot() });
            if (!w?.ok) warn(`自述日记没写成：${w?.reason}`);
          }
        }
      }
    } catch (e) { warn(`自述日记异常：${e?.message ?? e}`); }
    log(`本轮结束：${reason}（调用 ${rec.modelCalls} 次 / 候选 ${rec.candidates} 条 / 输入约 ${rec.inputTokens} tokens）`);
    return rec;
  };

  try {
    // 0) 意图阶段（2.2）：先想"今天想做什么"，**这一步不给任何候选**。
    //    给了榜单，她的选择就只剩"挑哪条发给他"——20 轮里 19 轮都是这么来的。
    const intent = await decideIntent({ s, st, rec });
    rec.intent = intent || null;
    if (intent) log(`醒来想做：${describeIntent(intent)}`);
    if (intent?.intent === 'finish') return finish('完成：现在没什么想做的');

    // 只有 explore / learn / continue 需要先抓外部内容；
    // 画画、想事情、找人说话都不必先翻榜单。
    const needContent = !intent || INTENT_NEEDS_CONTENT.has(intent.intent);
    let fresh = [];
    const raw = [];
    if (needContent) {
      // 1) 抓候选（不耗 token）
      const { sources, unknown } = resolveSources(s.sources || 'bili');
      if (unknown.length) warn(`未知来源已忽略：${unknown.join(', ')}`);
      const perSource = num(s.maxItemsPerSource, 10, 1, 30);
      for (const src of sources) {
        if (Date.now() > deadline) { rec.stopReason = '超时'; break; }
        let r;
        try {
          r = await src.list({ fetchImpl, limit: perSource, log });
        } catch (e) {
          r = { ok: false, items: [], error: String(e?.message ?? e) };
        }
        recordSourceHealth(st, src.id, r);
        if (!r.ok) {
          warn(`来源 ${src.label} 失败：${r.error}`);
          continue;   // 一个来源失败不影响其它来源
        }
        rec.sources.push(src.label);
        raw.push(...r.items);
      }

      // 1.5) 她上一轮主动要求搜的东西：这次醒来先搜，结果并进候选。
      const pendingSearch = st.pendingSearch;
      if (pendingSearch?.keyword
        && (Date.now() - Number(pendingSearch.at || 0)) < 6 * 3600 * 1000) {
        try {
          const r = pendingSearch.source === 'xhh'
            ? await searchXhh(getXhhClient(), pendingSearch.keyword, { limit: 6 })
            : await searchBili(BILI_CLIENT, pendingSearch.keyword, { limit: 6 });
          if (r.ok && r.items.length) {
            raw.push(...r.items.map((x) => ({
              ...x,
              source: pendingSearch.source === 'xhh' ? 'xhh' : 'bili'
            })));
            log(`按她上轮说的搜了「${pendingSearch.keyword}」，拿到 ${r.items.length} 条`);
          } else {
            warn(`她上轮想搜「${pendingSearch.keyword}」，没搜到（${r.error || '空结果'}）`);
          }
        } catch (e) {
          warn(`搜索失败：${e?.message ?? e}`);
        }
        delete st.pendingSearch;
      }

      // 2) 去重 + 过滤已看过的 + 安全过滤
      let unsafeDropped = 0;
      for (const item of raw) {
        const key = contentKeyOf(item);
        if (isSeen(st, key)) continue;
        if (!isSafeCandidate(item)) { unsafeDropped += 1; continue; }
        fresh.push({ ...item, key });
      }
      if (unsafeDropped) log(`过滤掉 ${unsafeDropped} 条不适合分享的内容`);
      rec.candidates = fresh.length;
      // 没内容不等于这轮失败：她还可以画画、想事情、说话
      if (!fresh.length) log('没有新内容，后面按"能做的事"继续');

      // 2.4) 给前两条补正文 + 热评。这是本地/公开接口，不花 token；
      // 但每条会多占一段详情文本，所以在预算里按 summaryChars 折半给。
      if (fresh.length) {
        try {
          fresh = await enrichItems(fresh, {
            bili: BILI_CLIENT,
            xhh: getXhhClient(),
            limit: 2,
            log
          });
        } catch (e) {
          warn(`补详情失败（不影响本轮）：${e?.message ?? e}`);
        }
      }
    } else {
      log(`意图是 ${intent.intent}，这轮不需要抓榜单`);
    }

    // 2.5) 预算闸门（第一版方案）：今日调用次数或月度费用到顶就不调模型，直接收工。
    // 无新内容时已经在上面 return 了，所以「没新内容不花 token」是天然成立的。
    const budget = budgetGate(s);
    rec.budget = budget.line;
    if (!budget.ok) return finish(budget.reason);

    // 3) 最多两次行动（2026-10-31 2.1）
    //    第一次照旧：看候选、挑一条、做。
    //    第二次要看到第一次的**真实结果**再决定，而且必须换一种行为。
    //    两次都可以没成果 —— 行动次数衡量的是"有几次选择机会"，不是"完成几个任务"。
    // 人设只取一小段控制口吻：后台判断不需要整张人设卡，那会把预算吃掉一大半。
    const personaSnippet = String(getConfig()?.persona?.roleText ?? '').slice(0, 600);
    // 2.3：不再固定"两件事"。能做几件由她自己决定，只保留三个兜底：
    //   30 分钟窗口、连续无产出、以及一个远高于正常用量的安全上限。
    const usedTypes = [];
    let lastOutcome = null;
    let stalls = 0;

    for (let round = 1; round <= MAX_ACTIONS_SAFETY; round += 1) {
      if (Date.now() > deadline) { rec.stopReason = '超时，先到这（进度已保存）'; break; }

      const decided = await decideOnce({
        s, st, rec, fresh, personaSnippet, usedTypes, prevResult: lastOutcome, round, intent
      });
      if (!decided.ok) {
        rec.error = decided.reason;
        if (!rec.actions.length) return finish(`预算跳过：${decided.reason}`);
        warn(`决策失败，结束本轮：${decided.reason}`);
        break;
      }

      const decision = decided.decision;
      // 她可以自己定下次什么时候醒来 —— 但**一轮只定一次**（结束时统一生效）。
      // 早先每个决策都调一次 applySelfWake，于是一轮把当天 4 次额度全用完了。
      if (decision.wakeAfterMinutes) {
        rec.wakeAfterMinutes = decision.wakeAfterMinutes;
        rec.wakeReason = decision.next || decision.goal || '';
      }
      if (decision.action === 'finish') {
        rec.stopReason = rec.actions.length ? '完成：她决定到这里为止' : '模型判断本轮到此为止';
        break;
      }
      // 同一轮不重复同一种行为；think 例外（可以连着想，只是不产生对外动作）
      if (usedTypes.includes(decision.action) && decision.action !== 'think') {
        rec.stopReason = '完成：没有别的想做的了';
        break;
      }

      const picked = fresh[decision.pick - 1];
      rec.candidateTitles = fresh.slice(0, 10).map((x) => x.title);
      // 无论选没选中，本轮看过的都记上，下一轮不再重复打扰
      for (const item of fresh) markSeen(st, item.key, item);

      const outcome = await executeAction({ s, st, rec, decision, picked, dryRun });
      // 4.0 / 1.5.8.8：每条 action 挂上这一轮的 roundId，方便和 model-calls 关联。
      // 只存 ID，**不把模型调用记录复制进来**（面板查询时按 roundId 关联两份数据）。
      if (!outcome.roundId) outcome.roundId = rec.roundId || '';
      rec.actions.push(outcome);
      usedTypes.push(outcome.action);
      if (rec.actions.length === 1) applyLegacyFields(rec, outcome);
      lastOutcome = outcome;

      // 4.0 / 2.6-A：**不再从 decision.goal 创建 Companion Goal**。
      //
      // 原因（2026-11-02 查明）：decision.goal 是「这个动作想干什么」——
      // 和 action / next 并列的**即时意图**，不是长期方向。
      // 以前直接拿它调 setCompanionGoal，导致一轮活动 3 个动作就塞 3 个 Goal，
      // 4 秒填满 3 个 paused，而且失败的动作（comment）也照样建 Goal。
      //
      // 动作目标已经记在 history[].actions[].goal 里（谁做了什么、为什么），
      // 不需要再给它一个长期结构。
      //
      // 长期 Goal 只能由「她明确表达跨轮意图」创建 —— 那个入口在 2.6.6 设计。
      // 跨轮连续性由真正的 Pending 承担（见下面 decision.next 那段）。
      try {
        if (decision.next) {
          // 2.4 不给新待办加 migrationTag —— 那是"从旧数据迁来的等回话"专用标记。
          // 新待办的通用结算规则留给 2.5（机主明确要求现在不要建分类系统）。
          const nextText = String(decision.next).slice(0, 120);
          // 4.0 / 2.5：只有"在等老大回应"才写 waiting，其余一律 pending。
          // 判据是程序分类（isWaitingForReply），不是看到"等"字就算。
          const pr = addCompanionPending({
            text: nextText,
            source: 'autonomous',
            status: isWaitingForReply(nextText) ? 'waiting' : 'pending',
            roundId: rec.roundId          // 4.0 / P0：记下是哪一轮创建的
          });
          // 4.0 / 2.6-A：**必须检查返回值** —— addPending 失败时返回 { ok:false } 不抛异常，
          // 以前那个 try/catch 捕不到（CAPACITY_FULL 静默丢弃就是这么来的）。
          if (!pr || !pr.ok) {
            warn(`Pending 写入失败（本轮继续）：${pr?.error || pr?.code || 'unknown'}`);
          } else if (pr.pending && pr.pending.id) {
            // 4.0 / P0：**只有真的发出去了才记一次询问**（lastAskRoundId 做幂等）。
            //
            // 为什么看 out.mode 而不是 out.result：
            //   out.result === 'success' 里包含 dryRun（演练成功），那不算真问过。
            //   只有 mode === 'live' 才是真的发到对方那里了。
            //
            // 计数失败**不影响已经发出去的消息** —— 只 warn，不回滚、不重发。
            if (outcome.mode === 'live') {
              try {
                const br = bumpAskCount(pr.pending.id, { roundId: rec.roundId });
                if (!br || !br.ok) warn(`询问计数失败（消息已发出，不影响本轮）：${br?.error || 'unknown'}`);
                else if (br.counted === false) log(`这条本轮已经计过数了（同 Round 幂等）：${pr.pending.id}`);
              } catch (e) {
                warn(`询问计数异常（消息已发出，不影响本轮）：${e?.message ?? e}`);
              }
            }
            // 4.0 / 2.6-B1：把真实创建成功的 Pending id 挂到这条 Action 上，方便追溯
            // 「这个 Pending 是从哪一轮、哪个动作来的」。
            //
            // 只记录**确实创建成功**的（addPending 返回的 pending.id）；
            // 失败、被去重（返回的是已有那条）、或者没拿到 id 的，一律不写 ——
            // 不能凭想象补一个 ID。
            //
            // 一对一的依据（2026-11-02 审查）：
            //   · decision.next 是**单个字符串**
            //   · addPending 一次只 push 一条（无循环，同文本还去重）
            //   · addCompanionPending 只有这一个调用点
            // 所以一个 Action 最多关联一个 Pending。
            outcome.pendingId = String(pr.pending.id);
          }
        }
      } catch (e) {
        // 写 Companion State 抛异常时也不能影响这一轮
        warn(`写 Companion State 失败（本轮继续）：${e?.message ?? e}`);
      }

      log(`第 ${round} 件事：${outcome.action} → ${outcome.result}（${outcome.resultSummary || '—'}）`);

      // 无进展保护（方案三节要求保留）：连着几次都没结果就歇着，不硬凑
      if (outcome.result === 'no_output' || outcome.result === 'skipped') stalls += 1;
      else stalls = 0;
      if (stalls >= 3) { rec.stopReason = '完成：连着几次都没结果，先歇着'; break; }
    }

    return finish(stopReasonOf(rec));
  } catch (e) {
    rec.error = String(e?.message ?? e);
    st.consecutiveFailures = (Number(st.consecutiveFailures) || 0) + 1;
    warn(`本轮异常：${rec.error}`);
    return finish(`异常：${rec.error}`);
  } finally {
    running = false;
    // 4.0 / 2.6-B5c：**必须在这里释放** —— 异常也不能让后续调用永久被跳过。
    sessionRunning = false;
  }
}

/** 分享：dryRun 只写日志；live 走核心发送能力，且受安静时段/额度约束。 */
async function maybeShare({ s, st, item, message, nowTs, dryRun = false }) {
  const mode = dryRun ? 'dryRun' : String(s.shareMode || 'dryRun');
  // 链接带不带由她自己决定（2026-10-26 机主原话：「是否分享链接看她自己，
  // 我想要的时候给我就行」）。所以这里**不自动补 URL** —— 有时她只想说句话，
  // 甩一条长链接反而难看。planner 的规则里给了她这个选择。
  const text = String(message ?? '').trim();
  if (!text) return { mode, text: '' };
  if (inQuietRange(nowTs, s.quietRange)) {
    log(`安静时段（${s.quietRange}），本次分享只记录不发送：${text}`);
    return { mode: 'quiet', text: `（安静时段，未发）${text}` };
  }
  const cap = num(s.maxSharePerSession, 2, 0, 5);
  const sentThisSession = st.shares.filter((x) => Number(x.at) >= Number(st.lastWakeAt)).length;
  if (cap <= 0 || sentThisSession >= cap) {
    log(`本轮已达分享上限（${cap}），只记录：${text}`);
    return { mode: 'capped', text: `（达上限，未发）${text}` };
  }
  if (mode !== 'live') {
    log(`[演练] 本来要发：${text}  ${item?.url ?? ''}`);
    return { mode: 'dryRun', text: `[演练] ${text} ${item?.url ?? ''}` };
  }
  // 没配 shareTarget 时兜底机主号（独立脚本读不到 manifest 默认值）
  const chatKey = `private:${String(s.shareTarget || '1846383180').replace(/[^0-9]/g, '')}`;
  if (!/^private:\d+$/.test(chatKey)) {
    warn(`分享目标 QQ 号无效：${s.shareTarget}`);
    return { mode: 'invalid', text: '' };
  }
  let ok = null;
  try {
    const r = await api?.capability?.('chat.send', { chatKey, text });
    ok = r && typeof r.then === 'function' ? await r : r;
  } catch (e) {
    warn(`capability 发送异常：${e?.message ?? e}`);
  }
  // 核心没提供 chat.send 时退回 OneBot HTTP 直发（和 silence-ping 同一套路子）
  if (!ok || !(ok.ok ?? true)) {
    const via = await sendViaOnebot(chatKey, text);
    if (via.ok) ok = via;
    else warn(`OneBot 直发失败：${via.error}`);
  }
  if (ok && (ok.ok ?? true)) {
    // 把自己说过的话写进聊天存档：不写的话，下一轮她看不见自己发过什么（今早"边缘行者"就是这么丢的）
    try {
      if (storeRef?.appendSelf) await storeRef.appendSelf(chatKey, { text, ts: nowTs });
      else warn('发送成功但拿不到 ChatStore，这条不会进聊天记录（下一轮她会忘）');
    } catch (e) {
      warn(`补记聊天记录失败：${e?.message ?? e}`);
    }
    if (item?.key) markShared(st, item.key, item, nowTs);
    log(`已${item ? '分享' : '主动发消息'}：${text}${item ? ` ${item.url}` : ''}`);
    return { mode: 'live', text };
  }
  warn(`分享发送失败：${JSON.stringify(ok)?.slice(0, 160)}`);
  return { mode: 'failed', text };
}

/* ── 发帖 ────────────────────────────────────────────────────────────── */

/**
 * 手机在线时，她自己去小黑盒发一篇。
 *
 * 风险最高的一类动作：**发出去的帖子在 App 里删不掉**（详情页菜单只有
 * 分享/编辑/权限设置/复制链接，没有删除），只能去网页版删或提前设成仅自己可见。
 * 所以护栏：每天最多 1 篇（可调 0~3）、标题+正文都要够（<20 字判水贴）、
 * 默认还要 publishMode=live 才真发。手机没连时 phone_eye 会直接报错，不会卡住。
 */
async function maybePublish({ s, st, decision, nowTs, dryRun }) {
  if (s.publishEnabled === false) return { text: '（发帖已关闭）', mode: 'off' };
  const post = decision.publish || {};
  const title = String(post.title || '').trim();
  const body = String(post.body || '').trim();
  if (!title || body.length < 20) return { text: '（没写够，跳过）', mode: 'skipped' };

  const day = new Date(nowTs).toISOString().slice(0, 10);
  st.posts = Array.isArray(st.posts) ? st.posts : [];
  const usedToday = st.posts.filter((x) => String(x.day) === day).length;
  const cap = num(s.maxPublishPerDay, 1, 0, 3);
  if (cap <= 0) return { text: '（每日发帖额度为 0）', mode: 'off' };
  if (usedToday >= cap) return { text: `（今天已发 ${usedToday} 篇，到上限）`, mode: 'capped' };
  if (dryRun || String(s.publishMode || 'live') !== 'live') {
    return { text: `[演练] 本来要发帖：《${title}》`, mode: 'dryRun' };
  }

  const args = ['-X', 'utf8', PHONE_SCRIPT, 'publish', '--title', title, '--body', body];
  const topics = String(post.topics || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean).slice(0, 6);
  for (const t of topics) args.push('--topic', t);

  let result = null;
  try {
    const { stdout } = await execFileP(PHONE_PYTHON, args, {
      timeout: 300_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8'
    });
    const line = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || '';
    result = JSON.parse(line);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/ETIMEDOUT|timed out/i.test(msg)) return { text: '发帖超时（手机可能卡住了）', mode: 'failed' };
    return { text: `发帖失败：${msg.slice(0, 80)}`, mode: 'failed' };
  }
  if (!result?.ok || result?.published === false) {
    return { text: `发帖失败：${result?.error || (result?.dry_run ? '手机脚本是演练模式' : '原因不明')}`, mode: 'failed' };
  }

  st.posts.push({ at: nowTs, day, title, topics: topics.join(',') });
  log(`在小黑盒发了一篇：《${title}》`);
  try {
    await maybeShare({ s, st, item: null, message: `我在小黑盒发了个帖子：《${title}》`, nowTs, dryRun });
  } catch { /* 通知失败不影响已经发出去的帖子 */ }
  return { text: `已发布：《${title}》`, mode: 'live' };
}

/* ── 评论 ────────────────────────────────────────────────────────────── */

let writerCache = null;
function writers() {
  if (writerCache) return writerCache;
  writerCache = {
    bili: new BiliWriter({ authFile: path.join(DATA_DIR, 'bili-auth.json') }),
    xhh: new XhhWriter({
      authFile: path.join(DATA_DIR, 'xhh-auth.json'),
      outboxFile: path.join(DATA_DIR, 'social-outbox.json')
    })
  };
  return writerCache;
}

/** 机主在该平台的昵称（@ 用），配置在 data/social-config.json。 */
function ownerNameFor(source) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'social-config.json'), 'utf8'));
    return String(j?.owner?.[source]?.name || '').trim();
  } catch { return ''; }
}

/**
 * 她自己去评论区说一句。
 *
 * 这是**写操作**，会真的发到公开社区，所以护栏比分享多一层：
 *   · 总开关 commentEnabled（插件设置里可关）
 *   · 每天最多 maxCommentPerDay 条（默认 3）
 *   · dryRun / commentMode !== 'live' 时只记日志
 *   · 少于 6 个字判「没话说」（planner 已降级，这里再兜一次）
 *
 * 为什么用「每天」而不是「每轮」：每轮上限挡不住她一天醒来八轮、每轮评一条。
 */
async function maybeComment({ s, st, item, comment, nowTs, dryRun }) {
  const text = String(comment?.text || '').trim();
  if (s.commentEnabled === false) return { text: '（评论已关闭）', mode: 'off' };
  if (text.length < 6) return { text: '（没话说，跳过）', mode: 'skipped' };

  const day = new Date(nowTs).toISOString().slice(0, 10);
  st.comments = Array.isArray(st.comments) ? st.comments : [];
  const usedToday = st.comments.filter((x) => String(x.day) === day).length;
  const cap = num(s.maxCommentPerDay, 3, 0, 10);
  if (cap <= 0) return { text: '（每日评论额度为 0）', mode: 'off' };
  if (usedToday >= cap) return { text: `（今天已评 ${usedToday} 条，到上限了）`, mode: 'capped' };

  const source = String(item?.source || '').toLowerCase().startsWith('xhh') ? 'xhh' : 'bili';
  const at = comment?.mention === 'owner' ? ownerNameFor(source) : '';
  if (dryRun || String(s.commentMode || 'live') !== 'live') {
    return { text: `[演练] 本来要评论：${at ? `@${at} ` : ''}${text}`, mode: 'dryRun' };
  }

  let result;
  try {
    if (source === 'bili') {
      const bvid = String(item?.bvid || item?.contentId || '');
      result = await writers().bili.comment(bvid, text, {
        mention: at,
        resolveAid: async (bv) => {
          const v = await BILI_CLIENT.video(bv);
          return Number(v?.aid) || 0;
        }
      });
    } else {
      const linkId = String(item?.linkId || item?.contentId || '');
      result = await writers().xhh.comment({ linkId, text, mention: at });
    }
  } catch (e) {
    result = { ok: false, error: String(e?.message ?? e) };
  }

  if (!result?.ok) {
    warn(`评论失败（${source}）：${result?.error || '原因不明'}`);
    return { text: `评论失败：${String(result?.error || '').slice(0, 80)}`, mode: 'failed' };
  }
  st.comments.push({ at: nowTs, day, source, text, url: item?.url || '' });
  log(`已在${source === 'bili' ? 'B 站' : '小黑盒'}评论：${text.slice(0, 40)}`);

  // 跟他说一声 —— 机主要求：评论不必 @ 他，但得让他知道。
  // 走 maybeShare 是为了共用安静时段/额度；被挡掉时至少上面那行日志和
  // state.comments 还留着，面板和活动日志里能查到。
  try {
    const where = source === 'bili' ? 'B 站' : '小黑盒';
    const note = `我在${where}回了句：${text.slice(0, 60)}`;
    await maybeShare({ s, st, item: null, message: note, nowTs, dryRun });
  } catch (e) {
    warn(`评论通知没发出去：${e?.message ?? e}`);
  }

  return { text: `已评论：${text.slice(0, 60)}`, mode: 'live' };
}

/* ── 画画 ────────────────────────────────────────────────────────────── */

/**
 * 她闲着时画一张：用模板把「画什么」补成场景，渲染、归档，再决定发不发。
 *
 * 为什么用模板而不是让她写完整场景：planner 那一步受 token 预算约束，让它临场
 * 编十几个图形坐标既贵又容易编崩（画出来一坨）。模板保证「能看」，她的创作
 * 体现在选主题、起标题、挑颜色上。
 */
async function maybeDraw({ s, st, decision, nowTs, dryRun }) {
  const spec = decision.draw || {};
  const opts = {};
  if (spec.title) opts.title = spec.title;
  if (spec.main) opts.main = spec.main;
  if (spec.accent) opts.accent = spec.accent;

  let rendered = await renderScene(sceneFromPreset(spec.preset, opts));
  if (!rendered.ok) {
    // 换最简单的那张再试一次：模板本身不该失败，失败多半是渲染器临时问题
    rendered = await renderScene(sceneFromPreset('night', { title: spec.title || '' }));
  }
  if (!rendered.ok) {
    warn(`画图失败：${rendered.error}`);
    return { text: `画失败：${rendered.error}`, mode: 'failed', file: '' };
  }

  const file = path.basename(rendered.path);
  try {
    recordDrawing({
      file,
      title: spec.title,
      note: decision.message,
      style: rendered.style,
      source: 'autonomous',
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.bytes
    });
  } catch (e) {
    warn(`画作索引写入失败：${e?.message ?? e}`);
  }
  log(`画了一张《${spec.title || '未命名'}》（${spec.preset}）：${file}`);

  const text = String(decision.message || '').trim();
  if (!text) return { text: `画好了（没配话）：${file}`, mode: 'silent', file };

  const sent = await maybeShareImage({ s, st, file, title: spec.title, text, nowTs, dryRun });
  return { ...sent, file };
}

/** 发一张画 —— 安静时段 / 每轮额度 / 演练开关，和 maybeShare 同一套规则。 */
async function maybeShareImage({ s, st, file, title, text, nowTs, dryRun }) {
  const mode = dryRun ? 'dryRun' : String(s.shareMode || 'dryRun');
  if (inQuietRange(nowTs, s.quietRange)) {
    log(`安静时段（${s.quietRange}），这张画只存不发：${file}`);
    return { mode: 'quiet', text: '（安静时段，只存不发）' };
  }
  const cap = num(s.maxSharePerSession, 2, 0, 5);
  const sentThisSession = st.shares.filter((x) => Number(x.at) >= Number(st.lastWakeAt)).length;
  if (cap <= 0 || sentThisSession >= cap) {
    log(`本轮已达分享上限（${cap}），画只存不发：${file}`);
    return { mode: 'capped', text: '（达上限，只存不发）' };
  }
  if (mode !== 'live') {
    log(`[演练] 本来要发一张画：${file} ${text}`);
    return { mode: 'dryRun', text: `[演练] 画了《${title || '未命名'}》` };
  }
  const chatKey = `private:${String(s.shareTarget || '1846383180').replace(/[^0-9]/g, '')}`;
  if (!/^private:\d+$/.test(chatKey)) {
    warn(`分享目标 QQ 号无效：${s.shareTarget}`);
    return { mode: 'invalid', text: '' };
  }
  const abs = path.join(DRAW_DIR, file);
  const r = await sendImageViaOnebot(chatKey, abs, text);
  if (r.ok) {
    // 自己发过的话要进聊天存档，否则下一轮她看不见（和 maybeShare 同一个理由）
    try {
      if (storeRef?.appendSelf) await storeRef.appendSelf(chatKey, { text: `[画]《${title || '未命名'}》${text}`, ts: nowTs });
    } catch { /* ignore */ }
    st.shares.push({ at: nowTs, kind: 'draw', file });
    log(`已发出一张画：${file}`);
    return { mode: 'live', text };
  }
  warn(`发画失败：${r.error}`);
  return { mode: 'failed', text: `发画失败：${r.error}` };
}

/** 用 OneBot HTTP 发一张本地图片（可以配一句话）。 */
async function sendImageViaOnebot(chatKey, filePath, text) {
  try {
    const snow = getConfig()?.snowluma || {};
    const base = String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const token = snow.httpAccessToken || snow.accessToken || '';
    const buf = fs.readFileSync(filePath);
    const [type, id] = String(chatKey).split(':');
    const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const segs = [];
    if (text) segs.push({ type: 'text', data: { text } });
    // base64 而不是 file://：OneBot 那边的进程可能没有 E:\ 的读权限
    segs.push({ type: 'image', data: { file: `base64://${buf.toString('base64')}` } });
    const body = type === 'group'
      ? { group_id: Number(id), message: segs }
      : { user_id: Number(id), message: segs };
    const r = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    const j = await r.json().catch(() => null);
    if (j?.status === 'ok' || j?.retcode === 0) return { ok: true, via: 'onebot' };
    return { ok: false, error: `HTTP ${r.status} ${j?.message || j?.wording || j?.retcode || ''}` };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 直接用 OneBot HTTP 发消息（核心没提供 chat.send 时的兜底）。 */
async function sendViaOnebot(chatKey, text) {
  try {
    const snow = getConfig()?.snowluma || {};
    const base = String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const token = snow.httpAccessToken || snow.accessToken || '';
    const [type, id] = String(chatKey).split(':');
    const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const body = type === 'group' ? { group_id: Number(id), message: text } : { user_id: Number(id), message: text };
    const r = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const j = await r.json().catch(() => null);
    if (j?.status === 'ok' || j?.retcode === 0) return { ok: true, via: 'onebot' };
    return { ok: false, error: `HTTP ${r.status} ${j?.message || j?.wording || j?.retcode || ''}` };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/* ── 调度 ────────────────────────────────────────────────────────────── */

async function tick() {
  if (running) return;
  const s = settings();
  if (s.enabled === false) return;
  // 日记回顾和自主浏览是两条独立的线：先看到点没有，再看著不著榜
  try {
    await maybeDiaryReview(s);
  } catch (e) {
    warn(`日记回顾异常：${e?.message ?? e}`);
  }
  // 4.0 / 1.5.3：读-判断-写整体进锁（原来是锁外读、锁外判断、最后才写）。
  // 决策结果用闭包带出来 —— withState 只负责落盘，不负责返回业务值。
  const verdict = {};
  try {
    mutateState(STORE, (st) => {
      const nowTs = Date.now();
      // 2.3：两个闹钟取更早的那个 —— 固定周期（nextWakeAt）和她的自主预约（selfWake）。
      const fixedDue = Number(st.nextWakeAt) || 0;
      const selfDue = st.selfWake?.enabled ? Number(st.selfWake.wakeAt) || 0 : 0;
      const due = [fixedDue, selfDue].filter((x) => x > 0).sort((a, b) => a - b)[0] || 0;
      if (!due) {
        st.nextWakeAt = nextWakeAt(nowTs, s.intervalHours);
        verdict.action = 'init';
        return;
      }
      if (nowTs < due) { verdict.action = 'wait'; return; }
      // 到点是自主预约就把它用掉（不让它一直挡着），并记一笔
      if (selfDue && selfDue <= nowTs) {
        log(`按她自己约的时间醒来（${st.selfWake.reason || '没写原因'}）`);
        st.selfWake = { ...st.selfWake, enabled: false, usedAt: nowTs };
      }
      // 刚醒过十分钟内不要再来一轮（防止重启后连跑）
      if (Number(st.lastWakeAt) && nowTs - Number(st.lastWakeAt) < 10 * 60 * 1000) {
        verdict.action = 'recent';
        return;
      }
      // 用户正在聊就先让位（聊天优先）
      const active = lastChatActivityAt(path.join(DATA_DIR, 'sessions'));
      if (active && nowTs - active < 3 * 60 * 1000) {
        st.nextWakeAt = nowTs + 10 * 60 * 1000;
        verdict.action = 'defer';
        return;
      }
      verdict.action = 'run';
    }, { fallback: emptyState() });
  } catch (e) {
    warn(`调度状态读写失败，本轮跳过：${e?.message ?? e}`);
    return;
  }
  if (verdict.action !== 'run') return;
  running = true;
  try {
    await runSession({});
  } finally {
    running = false;
  }
}

export function startLoop() {
  if (timer) return;
  const s = settings();
  if (s.enabled === false) return;
  // 启动时先算一个"现在该不该醒"，不等 5 分钟
  setTimeout(() => { tick().catch((e) => warn(`调度异常：${e?.message ?? e}`)); }, 15000);
  timer = setInterval(() => {
    tick().catch((e) => warn(`调度异常：${e?.message ?? e}`));
  }, TICK_MS);
  log(`自主活动已启动：每 ${num(s.intervalHours, 3, 1, 24)} 小时一轮，单轮上限 ${num(s.maxModelCalls, 6, 1, 20)} 次调用 / ${num(s.maxInputTokens, 8000, 500, 32000)} tokens，分享模式 ${s.shareMode || 'dryRun'}`);
}

export function stopLoop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* ── 生命周期 ────────────────────────────────────────────────────────── */

export function setup(a) {
  api = a;
  a.log(`自主活动已加载｜存档 ${STORE}`);

  // 对话里能调的工具：老大说「你去看看」时当场抓一次，而不是等下一轮定时醒来。
  // 注意它只返回标题/分区/链接 —— 她没看过视频内容，提示词里也按这个口径写，
  // 免得她拿标题编内容。
  a.registerTool({
    id: 'peek',
    name: '去看看',
    description: '老大说「你去看看」「榜上有什么好玩的」「小黑盒最近聊什么」时用：当场抓一次公开榜单/推荐流，返回几条标题、分区和链接。你只拿到标题和摘要，**等于没看过正文/视频**，别说成看过了。可以按关键词搜，也可以指定来源（B站=bili、小黑盒=xhh，默认两个都看）。',
    category: 'utility',
    icon: '🔭',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选：关键词。给了就真去搜（B站视频 / 小黑盒帖子）。' },
        source: { type: 'string', enum: ['all', 'bili', 'xhh'], description: '看哪个来源，默认 all（B站 + 小黑盒）。' },
        limit: { type: 'number', description: '返回几条，默认 5，最多 10。' }
      }
    },
    async execute(_ctx, args) {
      const kw = String(args?.keyword ?? '').trim();
      const want = String(args?.source ?? 'all').toLowerCase();
      const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5));
      const ids = want === 'bili' ? ['bili'] : want === 'xhh' ? ['xhh'] : ['bili', 'xhh'];
      const lines = [];
      const errors = [];
      for (const id of ids) {
        let r;
        try {
          if (id === 'bili') r = kw ? await biliSource.search({ fetchImpl: globalThis.fetch, keyword: kw, limit: 20 }) : await biliSource.list({ fetchImpl: globalThis.fetch, limit: 20, log: () => {} });
          else r = kw ? await xhhSource.search({ keyword: kw, limit: 20 }) : await xhhSource.list({ limit: 20 });
        } catch (e) {
          errors.push(`${id}：${e?.message ?? e}`);
          continue;
        }
        if (!r.ok) { errors.push(`${id}：${r.error}`); continue; }
        const label = id === 'bili' ? 'B站' : '小黑盒';
        for (const x of r.items.slice(0, limit)) {
          const tag = x.tags?.length ? `（${x.tags[0]}）` : '';
          const extra = x.stats?.view ? ` ${Math.round(x.stats.view / 10000)}万` : (x.stats?.comments ? ` ${x.stats.comments}评论` : '');
          lines.push(`[${label}] ${x.title}${tag}${extra} ${x.url}`);
        }
      }
      if (!lines.length) {
        return { content: `没抓到东西${errors.length ? `（${errors.join('；')}）` : ''}。跟老大照实说，别编。` };
      }
      const head = kw ? `按「${kw}」搜到这些` : '公开榜单上这几条';
      return {
        content: `${head}（只有标题/分区/摘要，你**没看过正文或视频**）：\n${lines.join('\n')}\n\n挑一两条自然地说，别念清单。${errors.length ? `\n（没查成：${errors.join('；')}）` : ''}`
      };
    }
  });
}

export function available() {
  return settings().enabled !== false;
}

export function activate() {
  startLoop();
}

export function deactivate() {
  stopLoop();
}

/** 热重载/被唤醒时兜底拉起定时器（与 silence-ping 同样的自愈思路）。 */
export const hooks = {
  'before-context'(ctx = {}) {
    // 缓存核心的 ChatStore：主动发消息后要往里补一条，否则下一轮上下文里看不到自己说过什么
    if (ctx.store) storeRef = ctx.store;
    startLoop();
  }
};

/** 状态面板。 */
export const providers = {
  'status.autonomous': () => {
    const s = settings();
    const st = readState(STORE, { onWarn: warn });
    const nowTs = Date.now();
    const health = Object.entries(st.sourceHealth || {}).map(([id, h]) => {
      const at = Number(h.lastSuccessAt) || 0;
      return `${id}：${h.lastError ? `失败（${h.lastError.slice(0, 40)}）` : (at ? '正常' : '未测')}`;
    });
    return {
      icon: '🌙',
      title: '自主活动',
      priority: 55,
      lines: [
        ['状态', s.enabled === false ? '已关闭' : (st.status === 'ACTIVE' ? '活动中' : '待机')],
        ['醒来节奏', `每 ${num(s.intervalHours, 3, 1, 24)} 小时一轮，单轮 ≤ ${num(s.windowMinutes, 30, 1, 180)} 分钟 / ${num(s.maxModelCalls, 6, 1, 20)} 次调用`],
        ['上次醒来', st.lastWakeAt ? `${new Date(st.lastWakeAt).toLocaleString('zh-CN', { hour12: false })}（${Math.round((nowTs - st.lastWakeAt) / 60000)} 分钟前）` : '还没醒过'],
        ['下次醒来', st.nextWakeAt ? new Date(st.nextWakeAt).toLocaleString('zh-CN', { hour12: false }) : '待定'],
        ['上次结果', st.lastStopReason || '—'],
        ['最近一轮', (() => {
          const h = (st.history || [])[(st.history || []).length - 1];
          if (!h) return '还没跑过';
          const when = new Date(h.startedAt).toLocaleString('zh-CN', { hour12: false });
          const what = h.picked ? String(h.picked).split('（')[0] : (h.stopReason || '');
          return `${when}｜${h.action || '-'}｜${what}${h.why ? `（${String(h.why).slice(0, 30)}）` : ''}`;
        })()],
        ['活动日志', ACTIVITY_LOG],
        ['预算', `单次输入上限 ${num(s.maxInputTokens, 8000, 500, 32000)} tokens（目标 ${num(s.inputTokenTarget, 7000, 400, 32000)}），校准系数 ${Number(st.calibration || 1).toFixed(2)}`],
        ['分享', `${s.shareMode || 'dryRun'}｜已看过 ${Object.keys(st.seen || {}).length} 条｜历史分享 ${(st.shares || []).length} 条`],
        ['来源', health.join('；') || '—'],
        ...(lastRunError ? [['⚠️ 最近错误', lastRunError.slice(0, 80)]] : [])
      ]
    };
  }
};

/** 自测/调试入口（不在面板暴露）。 */
export const internals = {
  STORE,
  readState: () => readState(STORE, {}),
  writeState: (s) => writeState(STORE, s),
  emptyState,
  runSession,
  tick,
  inQuietRange,
  readRecentDiary,
  appendDiaryLine,
  activityMemory,
  // 2.1/2.3 的核心，导出给测试用（生产代码只在本文件内调用）
  executeAction,
  stopReasonOf,
  applySelfWake,
  MAX_ACTIONS_SAFETY,
  recentActivity,
  isActivityRecorded,
  buildAutonomousNote,
  isDuplicateDiary,
  lastChatActivityAt,
  runDiaryReview,
  maybeDiaryReview,
  readRecentChat,
  get running() { return running; }
};