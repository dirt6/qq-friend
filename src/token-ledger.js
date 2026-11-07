// 统一 Token 账本（4.0 · 阶段 1.2 · 决策 D2「模型调用统计 → 统一 Token 账本」）。
//
// ── 为什么要有这一层 ──────────────────────────────────────────────────
// 原来有两套账，互相看不见：
//   · 聊天侧：session.usage → data/sessions/*.json → data/usage-days/YYYY-MM-DD.json
//     （还有 data/usage-today.json 存今天的实时数）
//   · 自主活动：data/token-usage.json（plugins/autonomous/lib/usage.js 读写）
// 结果是主账本的月度预算看不到自主活动的花费 —— 而自主活动每 3 小时一轮、
// 每轮 2~6 次调用，占比不低（阶段 0 审计第 4 节）。
//
// ── 这一层做什么 ──────────────────────────────────────────────────────
// 1. 自主活动的记账走这里（串行队列 + 原子写），不再各模块自己 读-改-写；
// 2. 提供**合并视图**：聊天 + 自主 = 当天/当月总量，供预算闸门和面板使用；
// 3. 分列保留（bySource），面板能看出钱花在哪边。
//
// ── 这一层不做什么 ────────────────────────────────────────────────────
// · 不改主账本的聚合逻辑（usage-days 仍由 app.js 按会话重算）；
// · 不把自主活动伪装成聊天 session —— 它没有 chatKey，硬塞进 sessions 会污染会话索引；
// · 不删除现有文件，旧字段只读兼容。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { assertWritesAllowed } from './reset-barrier.js';

/** 自主活动账本（格式沿用 usage.js：{version, monthKey, budgetYuan, days:{...}}）。 */
const AUTONOMOUS_FILE = path.join(DATA_DIR, 'token-usage.json');
const USAGE_DAYS_DIR = path.join(DATA_DIR, 'usage-days');
const USAGE_TODAY_FILE = path.join(DATA_DIR, 'usage-today.json');
const VERSION = 1;

const pad = (n) => String(n).padStart(2, '0');
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

export function dayKeyOf(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKeyOf(ts = Date.now()) {
  return dayKeyOf(ts).slice(0, 7);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写：先写同目录临时文件再 rename，避免半截文件。 */
function writeJsonAtomic(file, value) {
  assertWritesAllowed('用量账本写入'); // reset 删除期间不重建 data 用量文件
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  // Windows 上别的进程刚读完 / 杀毒在扫时 rename 会 EPERM/EBUSY —— 退避重试。
  // 不重试的话这次记账就白丢了（2026-11-01 并发测试偶发 99/100 查到的直接原因之一）。
  for (let i = 0; i < 12; i += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (e?.code !== 'EPERM' && e?.code !== 'EBUSY' && e?.code !== 'EACCES') throw e;
      if (i === 11) throw e;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + i * 10); } catch { /* ignore */ }
    }
  }
}

/**
 * 跨进程互斥（独占创建 .lock 文件）。
 *
 * 原子写只能保证"文件不半截"，保证不了"两个进程各读旧值再写回"——
 * 后写的会覆盖先写的（D9 的原话：原子写 ≠ 并发安全）。
 * 这里补上单写者：拿不到锁就退避重试；锁文件超过 5 秒视为崩溃残留，清掉重来。
 * 重试上限给到 500×20ms≈10 秒：记账是整文件读改写（写放大），Windows 上
 * 100 次连续写入可能把单次持锁拉到几十毫秒，3 秒预算会偶发超时（实测 99/100）。
 *
 * 同步实现是有意的：记账只有几毫秒，用异步会把它和调用链搅在一起。
 */
function withFileLock(file, fn, { retries = 1500, waitMs = 20, staleMs = 15000 } = {}) {
  const lock = `${file}.lock`;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < retries; i += 1) {
    try {
      fs.writeFileSync(lock, `${process.pid}`, { flag: 'wx' });
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      // 陈旧锁（进程崩了没删）：按修改时间判定
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.unlinkSync(lock); continue; }
      } catch { /* 锁刚被删，直接重试 */ }
      Atomics.wait(sleeper, 0, 0, waitMs);
      continue;
    }
    try {
      return fn();
    } finally {
      try { fs.unlinkSync(lock); } catch { /* 已删 */ }
    }
  }
  throw new Error(`账本锁超时：${path.basename(lock)}`);
}

/** 空自主账本。 */
export function emptyAutonomous(budgetYuan = 5) {
  return {
    version: VERSION,
    monthKey: monthKeyOf(),
    budgetYuan: Number(budgetYuan) || 5,
    days: {}
  };
}

function normalizeAutonomous(raw) {
  const base = emptyAutonomous(raw?.budgetYuan);
  if (!raw || typeof raw !== 'object') return base;
  const days = {};
  for (const [k, v] of Object.entries(raw.days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') continue;
    days[k] = {
      calls: Math.max(0, Number(v.calls) || 0),
      input_tokens: Math.max(0, Number(v.input_tokens) || 0),
      output_tokens: Math.max(0, Number(v.output_tokens) || 0),
      estimated_cost_yuan: Math.max(0, Number(v.estimated_cost_yuan) || 0)
    };
  }
  return {
    version: VERSION,
    monthKey: /^\d{4}-\d{2}$/.test(String(raw.monthKey)) ? String(raw.monthKey) : base.monthKey,
    budgetYuan: Number.isFinite(Number(raw.budgetYuan)) ? Number(raw.budgetYuan) : base.budgetYuan,
    days
  };
}

/** 读自主账本；不存在/损坏 → 空账本（不抛）。 */
export function readAutonomous() {
  return normalizeAutonomous(readJson(AUTONOMOUS_FILE));
}

/* ── 记账（同一进程内串行）────────────────────────────────────────────
 * 记账是"读-改-写"，两个调用并发时后写的会覆盖先写的。
 * 这里用一条 Promise 队列把同进程的记账串起来；跨进程由 autonomous
 * 的单实例约束保证（同一时刻只有一个插件实例在跑）。
 * 失败只打日志，绝不让记账影响聊天或自主活动。
 */
let writeQueue = Promise.resolve();

export function recordAutonomousCall({
  inputTokens = 0,
  outputTokens = 0,
  ts = Date.now(),
  pricing = {},
  budgetYuan
} = {}) {
  const task = writeQueue.then(() => {
    // ⚠️ 读-改-写整体必须在锁内：只锁写会让两个进程各读旧值再互相覆盖
    //（D9 的原话：原子写 ≠ 并发安全）。同步执行只有几毫秒。
    return withFileLock(AUTONOMOUS_FILE, () => {
      const u = readAutonomous();
      if (Number.isFinite(Number(budgetYuan))) u.budgetYuan = Number(budgetYuan);
      const dk = dayKeyOf(ts);
      const day = u.days[dk] || { calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost_yuan: 0 };
      day.calls += 1;
      day.input_tokens += Math.max(0, Number(inputTokens) || 0);
      day.output_tokens += Math.max(0, Number(outputTokens) || 0);
      const pin = Number(pricing?.inputPerMillion) || 0;
      const pout = Number(pricing?.outputPerMillion) || 0;
      day.estimated_cost_yuan = round4(
        Number(day.estimated_cost_yuan)
        + (Math.max(0, Number(inputTokens) || 0) / 1e6) * pin
        + (Math.max(0, Number(outputTokens) || 0) / 1e6) * pout
      );
      u.days[dk] = day;
      u.monthKey = monthKeyOf(ts);
      writeJsonAtomic(AUTONOMOUS_FILE, u);
      return u;
    });
  }).catch((error) => {
    // 记账失败不能静默：会表现为"用了模型但账本没涨"。
    // 但也不能抛给调用方（记账是旁路，不能因为账本坏了让这一轮失败）。
    try {
      console.warn(`[token-ledger] 记账失败（这一笔没进账本）：${error?.message ?? error}`);
    } catch { /* ignore */ }
    return null;
  });
  writeQueue = task.catch(() => null);
  return task;
}

/* ── 读取（合并视图）────────────────────────────────────────────────── */

/** 聊天侧当天用量：优先已聚合的日文件，其次今天的实时数。 */
export function readChatDay(ts = Date.now()) {
  const dk = dayKeyOf(ts);
  const agg = readJson(path.join(USAGE_DAYS_DIR, `${dk}.json`))?.aggregates;
  if (agg?.totals) {
    const t = agg.totals;
    return {
      calls: Number(t.runs) || 0,
      inputTokens: Number(t.promptTokens) || 0,
      outputTokens: Number(t.completionTokens) || 0,
      cost: Number(t.cost) || 0,
      source: 'usage-days'
    };
  }
  const today = readJson(USAGE_TODAY_FILE);
  if (today && today.dayKey === dk) {
    return {
      calls: Number(today.runs) || 0,
      inputTokens: Number(today.promptTokens) || 0,
      outputTokens: Number(today.completionTokens) || 0,
      cost: null,   // 实时文件不含成本，只能等日聚合
      source: 'usage-today'
    };
  }
  return { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, source: 'none' };
}

/** 当天：聊天 + 自主，分开也给合计。 */
export function readDay(ts = Date.now()) {
  const dk = dayKeyOf(ts);
  const chat = readChatDay(ts);
  const auto = readAutonomous();
  const a = auto.days[dk] || { calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost_yuan: 0 };
  const autonomous = {
    calls: a.calls,
    inputTokens: a.input_tokens,
    outputTokens: a.output_tokens,
    cost: a.estimated_cost_yuan
  };
  return {
    day: dk,
    chat,
    autonomous,
    total: {
      calls: chat.calls + autonomous.calls,
      inputTokens: chat.inputTokens + autonomous.inputTokens,
      outputTokens: chat.outputTokens + autonomous.outputTokens,
      // 聊天侧实时文件没有成本时，合计成本只能是"至少"：标记出来，别假装精确
      cost: chat.cost == null ? null : round4(chat.cost + autonomous.cost),
      costAccurate: chat.cost != null
    }
  };
}

/** 当月：按天累加，聊天 + 自主。 */
export function readMonth(ts = Date.now()) {
  const mk = monthKeyOf(ts);
  const auto = readAutonomous();
  let aCalls = 0; let aIn = 0; let aOut = 0; let aCost = 0;
  for (const [k, v] of Object.entries(auto.days)) {
    if (!k.startsWith(mk)) continue;
    aCalls += v.calls; aIn += v.input_tokens; aOut += v.output_tokens; aCost += v.estimated_cost_yuan;
  }
  // 聊天侧：日文件累加（缺日文件的日子只能跳过，宁可少算也不编）
  let cCalls = 0; let cIn = 0; let cOut = 0; let cCost = 0; let days = 0;
  try {
    for (const f of fs.readdirSync(USAGE_DAYS_DIR)) {
      if (!f.startsWith(mk) || !f.endsWith('.json')) continue;
      const agg = readJson(path.join(USAGE_DAYS_DIR, f))?.aggregates?.totals;
      if (!agg) continue;
      days += 1;
      cCalls += Number(agg.runs) || 0;
      cIn += Number(agg.promptTokens) || 0;
      cOut += Number(agg.completionTokens) || 0;
      cCost += Number(agg.cost) || 0;
    }
  } catch { /* 目录还没建 */ }

  return {
    month: mk,
    chat: { calls: cCalls, inputTokens: cIn, outputTokens: cOut, cost: round4(cCost), days },
    autonomous: { calls: aCalls, inputTokens: aIn, outputTokens: aOut, cost: round4(aCost) },
    total: {
      calls: cCalls + aCalls,
      inputTokens: cIn + aIn,
      outputTokens: cOut + aOut,
      cost: round4(cCost + aCost),
      budgetYuan: auto.budgetYuan
    }
  };
}

/* ── 账本健康检查（4.0 / 1.2，2026-11-01）───────────────────────────
 * 机主要求：最后更新时间、缺失日期、重复记录、两边成本、成本准确性、
 * 未完成的重算任务 —— 一次查完，写日志也供面板展示。
 * 只读：不修任何文件，发现问题交给补账/人工处理。
 */
export function health({ days = 14, now = Date.now() } = {}) {
  const issues = [];
  const dk = dayKeyOf(now);
  const mk = monthKeyOf(now);

  // 最近 N 天该有哪些日文件
  const want = [];
  for (let i = days - 1; i >= 0; i -= 1) want.push(dayKeyOf(now - i * 86400e3));

  let present = [];
  try {
    present = fs.readdirSync(USAGE_DAYS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, ''));
  } catch { /* 目录还没建 */ }

  const presentSet = new Set(present);
  // 今天不算缺失（当天还在累加，不落盘是正常的）
  const missingDays = want.filter((d) => d !== dk && !presentSet.has(d));

  let lastDay = '';
  for (const d of present.slice().sort()) lastDay = d;

  // 重复记录：同名日文件不可能重复，这里查"同一天既在日文件又在 usage-daily 快照"
  // 是否给出两份不同的 aggregates（会让人不知道信哪个）
  let duplicates = [];
  try {
    const daily = readJson(path.join(DATA_DIR, 'usage-daily.json'))?.days || {};
    for (const [k, v] of Object.entries(daily)) {
      const fileAgg = readJson(path.join(USAGE_DAYS_DIR, `${k}.json`))?.aggregates?.totals;
      if (!fileAgg || !v?.aggregates?.totals) continue;
      if (Number(fileAgg.runs) !== Number(v.aggregates.totals.runs)) duplicates.push(k);
    }
  } catch { /* 快照不存在 */ }

  // 自主账本
  const auto = readAutonomous();
  let aCost = 0; let aCalls = 0; let aTokens = 0; let autoLastDay = '';
  for (const [k, v] of Object.entries(auto.days)) {
    if (!autoLastDay || k > autoLastDay) autoLastDay = k;
    if (!k.startsWith(mk)) continue;
    aCost += v.estimated_cost_yuan;
    aCalls += v.calls;
    aTokens += v.input_tokens + v.output_tokens;
  }

  // 聊天账本
  const month = readMonth(now);
  const day = readDay(now);

  // 未完成的重算任务：补账状态文件
  const backfill = readJson(path.join(DATA_DIR, 'usage-backfill-state.json')) || {};

  if (missingDays.length) {
    issues.push({ level: 'warn', code: 'missing-days', message: `最近 ${days} 天缺 ${missingDays.length} 个日文件：${missingDays.slice(0, 5).join(',')}${missingDays.length > 5 ? '…' : ''}` });
  }
  if (duplicates.length) {
    issues.push({ level: 'warn', code: 'duplicate-days', message: `日文件与 usage-daily 快照不一致：${duplicates.slice(0, 5).join(',')}` });
  }
  if (backfill.lastError) {
    issues.push({ level: 'error', code: 'backfill-failed', message: `上次补账失败（${backfill.lastReason || '?'}）：${backfill.lastError}` });
  }
  if (!backfill.lastOkAt) {
    issues.push({ level: 'info', code: 'backfill-never', message: '还没成功补过账' });
  }
  if (day.total.costAccurate === false) {
    issues.push({ level: 'info', code: 'cost-unknown-today', message: '今天的聊天成本还没固化（日文件未生成），合计成本显示为未知' });
  }

  return {
    ok: issues.every((i) => i.level !== 'error'),
    checkedAt: now,
    windowDays: days,
    usageDays: {
      lastDay,
      presentCount: present.length,
      missingDays,
      stale: lastDay && lastDay < dayKeyOf(now - 86400e3) ? true : false
    },
    duplicateDays: duplicates,
    chat: { monthCost: month.chat.cost, days: month.chat.days, todayCost: day.chat.cost, costAccurate: day.chat.cost !== null },
    autonomous: { monthCost: round4(aCost), monthCalls: aCalls, monthTokens: aTokens, lastDay: autoLastDay, budgetYuan: auto.budgetYuan },
    total: { monthCost: month.total.cost, todayCost: day.total.cost, costAccurate: day.total.costAccurate },
    backfill: {
      lastRunAt: Number(backfill.lastRunAt) || 0,
      lastOkAt: Number(backfill.lastOkAt) || 0,
      lastReason: backfill.lastReason || '',
      lastError: backfill.lastError || '',
      days: Number(backfill.days) || 0
    },
    issues
  };
}

/** 只给测试用：清掉队列（避免测试之间互相等）。 */
export function __resetQueue() {
  writeQueue = Promise.resolve();
}
