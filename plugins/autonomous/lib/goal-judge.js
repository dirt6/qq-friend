// 自主 Goal 候选判断（4.0 / 2.6-B5b）。
//
// 这一层负责三件事：
//   ① 从 digest 构造给模型的输入
//   ② 解析模型的输出
//   ③ **用程序规则校验**模型的判断
//
// **它不直接调模型** —— 调用在 index.js 里（这样测试可以不联模型）。
//
// ── 一个必须说清的边界 ──────────────────────────────────────────────
// 程序能证明的只有：
//   · 这些 Round 真实存在（读 autonomous.json 的 history）
//   · 至少跨了两个不同的 Round
//   · 模型引用的 Round 都在本次给过的范围内
//   · text 不是 objective 的明显复述
//
// **程序不能证明**：
//   · 这个方向值不值得长期关注（价值性）
//   · 它是不是真的"长期方向"而不是语义改写（方向性）
// 这两项**永远属于模型判断**，不能说成"程序已验证"。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';

/** 每次判断取最近几轮 digest。 */
export const JUDGE_WINDOW = 5;

/** 每日最多判断几次（机主 2026-11-02 定：初始 3 次）。 */
export const JUDGE_DAILY_LIMIT = 3;

/** 判断记录 / 计数只保留最近多少天。 */
const KEEP_DAYS = 7;

/** 文本裁剪。 */
const MAX_TEXT = 200;

function pad(n) { return String(n).padStart(2, '0'); }

/** 按**本地时区**算日期键（和 token-ledger 的 dayKeyOf 保持一致）。 */
export function dayKeyOf(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function safeText(v, max = MAX_TEXT) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 宽松归一：去空白、去标点，用来做复述比较。 */
function normalizeForCompare(s) {
  return String(s ?? '').replace(/[\s，。；：、,.!?！？;:'"「」『』（）()《》【】\-—…]/g, '');
}

/**
 * 读真实 autonomous.json 里的 roundId 集合（**证据的唯一来源**）。
 * 读失败给空集合 —— 调用方会因此跳过判断（宁可跳过，也不要凭空放行）。
 */
export function historyRoundIds(file = path.join(DATA_DIR, 'autonomous.json')) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = new Set();
    for (const r of j.history || []) if (r && r.roundId) out.add(String(r.roundId));
    return out;
  } catch {
    return new Set();
  }
}

/* ── ① 该不该判断 ──────────────────────────────────────────────────── */

/**
 * 判断这一轮要不要调模型。
 *
 * @param {object} o
 * @param {object} o.rec            本轮记录
 * @param {Array}  o.digests        现有 digest
 * @param {Array}  o.log            现有 goalJudgeLog
 * @param {object} o.count          { 'YYYY-MM-DD': n }
 * @param {number} [o.now]
 * @returns {{ok:boolean, code?:string, reason?:string, dayKey?:string, used?:number}}
 */
export function shouldJudge({ rec, digests = [], log = [], count = {}, now = Date.now() } = {}) {
  // ① 异常轮次跳过（B5a 的 buildDigest 已经挡过，这里再兜一层）
  if (!rec || String(rec.error ?? '') !== '') {
    return { ok: false, code: 'ROUND_ERROR', reason: '这一轮有错误，不可信' };
  }
  const roundId = String(rec.roundId || '').trim();
  if (!roundId) return { ok: false, code: 'NO_ROUND_ID', reason: '没有 roundId，无法做幂等' };

  // ② 幂等：这一轮已经判断过
  if (Array.isArray(log) && log.some((x) => x && x.roundId === roundId)) {
    return { ok: false, code: 'ALREADY_JUDGED', reason: '这一轮已经判断过了' };
  }

  // ③ 跨轮证据不足（至少 2 条 digest）
  const valid = (Array.isArray(digests) ? digests : []).filter((d) => d && d.roundId);
  if (valid.length < 2) {
    return { ok: false, code: 'NOT_ENOUGH_ROUNDS', reason: '有效 Round 不足 2 条' };
  }

  // ④ 每日预算
  const dayKey = dayKeyOf(now);
  const used = Number((count || {})[dayKey]) || 0;
  if (used >= JUDGE_DAILY_LIMIT) {
    return { ok: false, code: 'BUDGET_EXCEEDED', reason: `今天已经判断了 ${used} 次（上限 ${JUDGE_DAILY_LIMIT}）`, dayKey, used };
  }

  // ⑤ 原始 history 读不到 → 证据来源不可信，跳过
  if (historyRoundIds().size === 0) {
    return { ok: false, code: 'HISTORY_UNREADABLE', reason: '读不到原始 history，无法验证证据' };
  }

  return { ok: true, dayKey, used };
}

/* ── ② 构造输入 ────────────────────────────────────────────────────── */

/** 判断用的 system prompt（**很短**，只放规则）。 */
export const JUDGE_SYSTEM = `你在看小鲸鱼最近几轮自主活动的记录，判断有没有值得作为**长期方向**持续关注的东西。

规则：
1. 只有「跨越多轮、值得长期关注的方向」才算候选。一次性动作、具体某件事、失败重试都不算。
2. 不要复述某一轮做了什么，要提炼出**背后的方向**。
3. **没有就老实说没有** —— candidate 填 false，这很正常，不要硬凑。
4. roundIds 只能从给你的轮次里选，至少 2 个不同的轮。
5. reason 写你怎么判断的；evidenceSummary 写每轮具体支持了什么。

只输出 JSON：
{"candidate":false}
或
{"candidate":true,"text":"<长期方向，一句话>","roundIds":["<轮次ID>"],"reason":"<判断理由>","evidenceSummary":[{"roundId":"<轮次ID>","support":"<这一轮支持了什么>"}]}`;

/** 把 digest 压成给模型看的简短文本。 */
export function buildJudgeInput(digests = [], window = JUDGE_WINDOW) {
  const list = (Array.isArray(digests) ? digests : [])
    .filter((d) => d && d.roundId)
    .slice(-Math.max(1, window))
    .map((d) => ({
      roundId: String(d.roundId),
      at: String(d.createdAt || ''),
      intent: d.intent ? {
        intent: safeText(d.intent.intent, 40),
        goal: safeText(d.intent.goal, 120),
        why: safeText(d.intent.why, 120)
      } : null,
      actions: (Array.isArray(d.actions) ? d.actions : []).slice(0, 12).map((a) => ({
        action: safeText(a.action, 40),
        objective: safeText(a.objective, 120),
        result: safeText(a.result, 40)
      })),
      stopReason: safeText(d.stopReason, 150)
    }));
  return {
    list,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: '最近这几轮：\n' + JSON.stringify({ rounds: list }) }
    ]
  };
}

/* ── ③ 解析输出 ────────────────────────────────────────────────────── */

/** 从模型返回里抽 JSON（容忍 ```json 包裹 / 前后废话）。 */
export function parseJudgement(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, code: 'BAD_FORMAT', reason: '模型返回空' };

  const candidates = [raw];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j === 'object' && !Array.isArray(j)) return { ok: true, judgement: j };
    } catch { /* 试下一个 */ }
  }
  return { ok: false, code: 'BAD_FORMAT', reason: '不是合法 JSON：' + raw.slice(0, 120) };
}

/* ── ④ 程序校验 ────────────────────────────────────────────────────── */

/**
 * `text` 是不是某个 objective 的明显复述 / 拼接。
 *
 * ⚠️ **这只是弱过滤器**，只能挡：
 *   · 完全相同
 *   · 明显包含（长度比 ≥ 0.7）
 *   · 两个 objective 直接拼接
 *
 * **语义改写挡不住**（"发给老大" → "持续维护信息分享"）。
 */
export function looksLikeObjective(text, objectives = []) {
  const t = normalizeForCompare(text);
  if (!t) return true;
  const objs = (Array.isArray(objectives) ? objectives : [])
    .map((x) => normalizeForCompare(x))
    .filter(Boolean);

  for (const o of objs) {
    if (t === o) return true;                       // 完全相同
    if (t.includes(o) || o.includes(t)) {
      const ratio = Math.min(t.length, o.length) / Math.max(t.length, o.length);
      // 包含关系本身就是强信号 —— 阈值用 0.5（而不是 0.7）。
      // 0.7 会漏掉「我想问老大回来没这件事」这种只加了几个字的复述。
      // 不包含的（比如「持续关注 CSP」vs「准备 CSP」）根本走不到这里，不会被误伤。
      if (ratio >= 0.5) return true;
    }
  }
  // 两个 objective 直接拼接
  for (let i = 0; i < objs.length; i += 1) {
    for (let j = i + 1; j < objs.length; j += 1) {
      if (t === objs[i] + objs[j] || t === objs[j] + objs[i]) return true;
    }
  }
  return false;
}

/**
 * 校验模型的判断（八项，见设计文档第四节）。
 *
 * @param {object} j        解析后的 judgement
 * @param {object} ctx
 * @param {Set<string>} ctx.digestRoundIds  本次给过模型的 roundId
 * @param {Set<string>} ctx.historyRounds   真实 history 里的 roundId
 * @param {string[]}    ctx.objectives      本次给过的所有 action objective
 * @returns {{ok:boolean, code?:string, reason?:string, text?:string, roundIds?:string[], evidence?:object}}
 */
export function validateJudgement(j, ctx = {}) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { ok: false, code: 'BAD_FORMAT', reason: '不是一个对象' };
  }
  if (typeof j.candidate !== 'boolean') {
    return { ok: false, code: 'BAD_FORMAT', reason: 'candidate 必须是 boolean' };
  }
  if (j.candidate === false) {
    return { ok: true, noCandidate: true };
  }

  // ── 有候选：逐项校验 ──
  const text = safeText(j.text);
  if (!text) return { ok: false, code: 'BAD_FORMAT', reason: 'text 为空' };

  if (!Array.isArray(j.roundIds) || j.roundIds.length === 0) {
    return { ok: false, code: 'BAD_FORMAT', reason: 'roundIds 不是非空数组' };
  }
  const ids = [...new Set(j.roundIds.map((x) => String(x || '')).filter(Boolean))];

  // ① 必须来自本次给过的 digest
  const digestRounds = ctx.digestRoundIds instanceof Set ? ctx.digestRoundIds : new Set();
  const foreign = ids.filter((id) => !digestRounds.has(id));
  if (foreign.length) {
    return { ok: false, code: 'ROUND_ID_FOREIGN', reason: '引用了本次没给过的 Round：' + foreign.join(', ') };
  }

  // ② 至少两个不同 Round
  if (ids.length < 2) {
    return { ok: false, code: 'TOO_FEW_ROUNDS', reason: '至少要有 2 个不同的 Round' };
  }

  // ③ 必须真实存在于 history（**证据唯一来源**）
  const hist = ctx.historyRounds instanceof Set ? ctx.historyRounds : new Set();
  const missing = ids.filter((id) => !hist.has(id));
  if (missing.length) {
    return { ok: false, code: 'ROUND_ID_MISSING', reason: '真实 history 里没有：' + missing.join(', ') };
  }

  // ④ text 不能是 objective 的明显复述
  if (looksLikeObjective(text, ctx.objectives || [])) {
    return { ok: false, code: 'TEXT_IS_OBJECTIVE', reason: 'text 看起来只是某个 Action 目标的复述' };
  }

  // ⑤ evidenceSummary 结构
  if (!Array.isArray(j.evidenceSummary) || j.evidenceSummary.length === 0) {
    return { ok: false, code: 'SUMMARY_MISMATCH', reason: 'evidenceSummary 不是非空数组' };
  }
  const seen = new Set();
  for (const e of j.evidenceSummary) {
    if (!e || typeof e !== 'object') {
      return { ok: false, code: 'SUMMARY_MISMATCH', reason: 'evidenceSummary 里有非对象' };
    }
    const rid = String(e.roundId || '');
    if (!ids.includes(rid)) {
      return { ok: false, code: 'SUMMARY_MISMATCH', reason: 'summary 引用了不在 roundIds 里的轮次：' + rid };
    }
    if (!safeText(e.support)) {
      return { ok: false, code: 'SUMMARY_MISMATCH', reason: 'summary 的 support 为空：' + rid };
    }
    if (seen.has(rid)) {
      return { ok: false, code: 'SUMMARY_MISMATCH', reason: 'summary 里同一轮出现两次：' + rid };
    }
    seen.add(rid);
  }

  // ⑥ reason 必须有（但**它不是证据**，只是判断说明）
  const reason = safeText(j.reason);
  if (!reason) return { ok: false, code: 'BAD_FORMAT', reason: 'reason 为空' };

  return {
    ok: true,
    text,
    roundIds: ids,
    reason,
    // ⚠️ 只把 type/roundIds/reason 交给 B3 —— reason 只是说明，不是证据
    evidence: { type: 'cross_round_continuity', roundIds: ids, reason }
  };
}

/* ── ⑤ 记录与计数 ──────────────────────────────────────────────────── */

/** 追加一条判断记录（幂等：同 roundId 覆盖），只留最近 KEEP_DAYS 天。 */
export function appendJudgeLog(log = [], entry = {}) {
  const now = Date.now();
  const cutoff = now - KEEP_DAYS * 86400e3;
  const arr = (Array.isArray(log) ? log : [])
    .filter((x) => x && x.roundId && Date.parse(x.at || 0) >= cutoff)
    .filter((x) => x.roundId !== entry.roundId);
  arr.push({
    roundId: String(entry.roundId || ''),
    at: new Date(now).toISOString(),
    outcome: String(entry.outcome || ''),
    code: String(entry.code || ''),
    goalId: String(entry.goalId || '')
  });
  return arr;
}

/** 累加当日计数（只留最近 KEEP_DAYS 天）。 */
export function bumpJudgeCount(count = {}, dayKey, now = Date.now()) {
  const cutoff = dayKeyOf(now - KEEP_DAYS * 86400e3);
  const out = {};
  for (const [k, v] of Object.entries(count || {})) {
    if (String(k) >= cutoff) out[k] = Number(v) || 0;
  }
  out[dayKey] = (Number(out[dayKey]) || 0) + 1;
  return out;
}

export const __internals = { normalizeForCompare, pad, KEEP_DAYS };
