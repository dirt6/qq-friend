// 模型调用记录器（4.0 · 1.5.8.3）。
//
// 只做记录器本身，**不接入任何调用入口**（DSH / API / 自主活动的接入在 1.5.8.4~1.5.8.6）。
//
// ── 它回答什么问题 ────────────────────────────────────────────────
//   · 这一轮到底走的 DSH 还是 API
//   · 如果是回落，为什么回落（fallbackFrom + failureCode）
//   · 失败是在模型调用、工具执行还是消息发送
//   · 一轮处理总共调了几次模型
//
// ── 设计约束（机主 2026-11-01 定）────────────────────────────────
//   · 文件：data/model-calls.ndjson；2 MB 上限 + 一代历史（最多 4 MB，约 45 天）
//   · **轮转失败不删除旧文件**
//   · **写失败绝不影响调用**（永不抛错；磁盘满只记告警）
//   · 不存完整 Prompt、聊天正文、API Key
//   · 失败且没拿到用量时 tokens = null，不填 0
//   · fallback 的两次调用都记（不覆盖第一次失败）
//
// ── roundId 怎么传 ────────────────────────────────────────────────
//   AsyncLocalStorage 只在**本进程内**传播（跨 spawn 不会传）。
//   DSH 子进程不写日志 —— 父进程 spawn 后等结果，成功/失败/耗时都是它观测到的。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DATA_DIR } from './config.js';
import { isResetBarrierActive } from './reset-barrier.js';

// 测试可以用 QQ_MODEL_CALLS_FILE 指到临时目录，避免污染生产日志
export const CALLS_FILE = process.env.QQ_MODEL_CALLS_FILE
  || path.join(DATA_DIR, 'model-calls.ndjson');
export const MAX_BYTES = 2 * 1024 * 1024;     // 2 MB
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY = 20;
const LOCK_WAIT_MS = 5;

/** 允许的 purpose（不在表里的一律归 other）。 */
export const PURPOSES = new Set([
  'chat.reply',
  'chat.proactive',
  'autonomous.intent',
  'autonomous.decision',
  'autonomous.diary_review',
  'autonomous.goal_candidate',
  'memory.consolidate',
  'memory.impression',
  'memory.retrieve',
  'diagnostic.route_test',
  'chat.aux',
  'other'
]);

/** 允许的 failureCode。 */
export const FAILURE_CODES = new Set([
  'DSH_SPAWN_FAILED',
  'DSH_TIMEOUT',
  'DSH_NONZERO_EXIT',
  'DSH_EMPTY_REPLY',
  'DSH_BAD_JSON',
  'API_HTTP_4XX',
  'API_429',
  'API_TIMEOUT',
  'API_EMPTY',
  'API_BAD_TOOLCALL',
  'ABORTED',
  'UNKNOWN'
]);

const ctx = new AsyncLocalStorage();

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

function lockFile() { return `${CALLS_FILE}.lock`; }

function acquireLock() {
  try { fs.mkdirSync(path.dirname(CALLS_FILE), { recursive: true }); } catch { return false; }
  for (let i = 0; i < LOCK_RETRY; i += 1) {
    try {
      const fd = fs.openSync(lockFile(), 'wx');
      try { fs.writeSync(fd, `${process.pid}\n`); } catch { /* ignore */ }
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(lockFile()).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile());
          continue;
        }
      } catch { /* 锁刚释放 */ }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(lockFile()); } catch { /* ignore */ }
}

/* ── roundId ──────────────────────────────────────────────────────── */

/** 一轮处理的上下文。 */
export function beginRound({ kind = 'unknown', chatKey = '' } = {}) {
  return {
    roundId: `round-${crypto.randomBytes(4).toString('hex')}`,
    kind: String(kind),
    chatKey: String(chatKey),
    startedAt: Date.now()
  };
}

/**
 * 在某一轮的上下文里执行 fn。
 * ALS 自动覆盖 fn 里所有 await；**不覆盖 spawn 出去的子进程**（那边不写日志）。
 */
export function withRound(meta, fn) {
  const round = beginRound(meta);
  return ctx.run(round, () => fn(round));
}

/**
 * 为**当前异步执行上下文**设置一个轮次（不改调用链签名）。
 *
 * 和 withRound 的区别：
 *   · withRound(fn) 把 fn 包起来，退出后自动恢复 —— 最安全，但要包整个函数体；
 *   · enterRound(meta) 直接设置当前上下文，适合在长函数的开头写一行。
 *
 * 注意：async 函数里的 enterWith 只影响该函数内部的后续执行（async 有自己的上下文），
 * 不会污染调用者。并发安全靠测试验证（两个自主轮次同时跑 ID 不串）。
 */
export function enterRound(meta = {}) {
  const round = beginRound(meta);
  ctx.enterWith(round);
  return round;
}

/** 当前轮的上下文（没有就是 null）。 */
export function currentRound() {
  return ctx.getStore() || null;
}

/** 显式指定 round（给"父进程观测子进程"这类场景兜底）。 */
export function runWithRound(round, fn) {
  return ctx.run(round, fn);
}

/* ── 记录 ─────────────────────────────────────────────────────────── */

/**
 * 记一次模型调用。
 *
 * **永不抛错**：记录是旁路，坏了也不能影响聊天。
 *
 * @param {object} o
 * @param {string} [o.purpose] 见 PURPOSES，不在表里归 other
 * @param {'dsh'|'api'} o.backend 实际用的入口
 * @param {'success'|'failed'} o.status
 * @param {number} [o.durationMs]
 * @param {boolean} [o.fallback]
 * @param {'dsh'|null} [o.fallbackFrom]
 * @param {string|null} [o.failureCode]
 * @param {string|null} [o.failureDetail]
 * @param {string|null} [o.model]
 * @param {{prompt:number, completion:number, cached:number}|null} [o.tokens]
 * @param {object} [o.round] 显式传当前轮（默认从 ALS 取）
 * @param {string} [o.file] 测试用：覆盖文件路径
 * @param {number} [o.maxBytes] 测试用：覆盖轮转上限
 */
export function recordCall(o = {}) {
  try {
    const round = o.round || currentRound();
    const purpose = PURPOSES.has(String(o.purpose)) ? String(o.purpose) : 'other';
    const status = o.status === 'success' ? 'success' : 'failed';

    // 失败必须有 code；成功时清空
    let failureCode = null;
    let failureDetail = null;
    if (status === 'failed') {
      failureCode = FAILURE_CODES.has(String(o.failureCode)) ? String(o.failureCode) : 'UNKNOWN';
      failureDetail = o.failureDetail ? String(o.failureDetail).slice(0, 200) : null;
      if (failureCode === 'UNKNOWN' && !failureDetail) failureDetail = '未提供失败原因';
    }

    // tokens：失败且没拿到就是 null，**不填 0**
    //
    // 4.0 / R6-C：这里原来只保留 prompt / completion / cached 三个字段，
    // 把 dsh-gateway 新增的 cacheRead / cacheWrite / total 全裁掉了 ——
    // 于是即使上游解析对了，落盘的记录里也看不到真实总量。
    //
    // 现在：**原样保留上游给的字段**（缺失保持 null），并保留旧的三个名字，
    // 旧消费者（只读 prompt/completion/cached）完全不受影响。
    //
    // 判定"有没有拿到"的标准也改了：不再用 (p || c)，因为**全 0 也是合法值**；
    // 改成"至少有一个有限数值"。
    let tokens = null;
    if (o.tokens && typeof o.tokens === 'object') {
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
      const prompt = num(o.tokens.prompt);
      const completion = num(o.tokens.completion);
      const cached = num(o.tokens.cached);
      const cacheRead = num(o.tokens.cacheRead);
      const cacheWrite = num(o.tokens.cacheWrite);
      const total = num(o.tokens.total);
      const any = [prompt, completion, cached, cacheRead, cacheWrite, total].some((v) => v !== null);
      if (any) tokens = { prompt, completion, cached, cacheRead, cacheWrite, total };
    }

    const rec = {
      id: `call-${crypto.randomBytes(4).toString('hex')}`,
      roundId: round?.roundId || `round-lone-${crypto.randomBytes(3).toString('hex')}`,
      at: new Date().toISOString(),
      purpose,
      backend: o.backend === 'dsh' ? 'dsh' : 'api',
      status,
      durationMs: Math.max(0, Number(o.durationMs) || 0),
      fallback: Boolean(o.fallback),
      fallbackFrom: o.fallback ? (o.fallbackFrom === 'dsh' ? 'dsh' : null) : null,
      failureCode,
      failureDetail,
      model: o.model ? String(o.model).slice(0, 60) : null,
      tokens
    };

    const file = o.file || CALLS_FILE;
    const maxBytes = Number(o.maxBytes) || MAX_BYTES;

    // reset 期间不写调用日志（避免删除后重建 model-calls.ndjson）。
    if (isResetBarrierActive()) return rec;

    // 写：拿不到锁就降级直接追加（宁可多一条，不丢记录）
    const locked = acquireLock();
    try {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
      rotateIfNeeded(file, maxBytes);
      fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    } finally {
      if (locked) releaseLock();
    }
    return { ok: true, record: rec };
  } catch (error) {
    // 记录失败：只告警，不影响调用方
    try { console.warn(`[model-calls] 记录失败（不影响调用）：${error?.message ?? error}`); } catch { /* ignore */ }
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 超上限就轮转成 `.1`（覆盖上一代）。
 *
 * **轮转失败不删除旧文件**：rename 抛错就保持原样继续追加，
 * 最多是这个文件超过 2 MB，不会丢记录。
 */
function rotateIfNeeded(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // 文件不存在（正常）或 rename 失败（不删旧的，继续往当前文件追加）
  }
}

/* ── 读（给面板和测试）─────────────────────────────────────────── */

/** 读记录（当前 + 上一代，按时间顺序）。坏行跳过。 */
export function readCalls({ file = CALLS_FILE, limit = 0 } = {}) {
  const out = [];
  const files = [`${file}.1`, file];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
    }
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/**
 * 按 roundId 分组（面板"这一轮发生了什么"用）。
 * 同一轮里失败的 DSH 和成功的 API 会出现在同一组。
 */
export function groupByRound(calls) {
  const map = new Map();
  for (const c of calls) {
    if (!map.has(c.roundId)) map.set(c.roundId, []);
    map.get(c.roundId).push(c);
  }
  return map;
}

/** 统计（面板用）。 */
export function stats({ file = CALLS_FILE, excludeDiagnostic = true } = {}) {
  const calls = readCalls({ file });
  const used = excludeDiagnostic ? calls.filter((c) => c.purpose !== 'diagnostic.route_test') : calls;
  const byBackend = {};
  const byPurpose = {};
  const byFailure = {};
  let fallbacks = 0;
  let totalMs = 0;
  for (const c of used) {
    byBackend[c.backend] = (byBackend[c.backend] || 0) + 1;
    byPurpose[c.purpose] = (byPurpose[c.purpose] || 0) + 1;
    if (c.status === 'failed' && c.failureCode) byFailure[c.failureCode] = (byFailure[c.failureCode] || 0) + 1;
    if (c.fallback) fallbacks += 1;
    totalMs += Number(c.durationMs) || 0;
  }
  // 4.0 / 1.5.8.7：回退观测（机主要求的三个数，现算不落盘）
  const lastFallback = [...used].reverse().find((c) => c.fallback);
  return {
    total: used.length,
    byBackend,
    byPurpose,
    byFailure,
    fallbacks,
    fallbackCount: fallbacks,
    fallbackRate: used.length ? Number((fallbacks / used.length).toFixed(3)) : 0,
    lastFallbackAt: lastFallback?.at || null,
    avgDurationMs: used.length ? Math.round(totalMs / used.length) : 0
  };
}

/** 文件占用（给容量监控用）。 */
export function storage() {
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const cur = size(CALLS_FILE);
  const old = size(`${CALLS_FILE}.1`);
  return { currentBytes: cur, archiveBytes: old, totalBytes: cur + old, maxBytes: MAX_BYTES };
}

export const __test = { rotateIfNeeded, lockFile };
