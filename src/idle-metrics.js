// R10：空闲运行指标（只读聚合）。
//
// 只回答“这段时间她做了什么、花了多少”，不评价人格、不建指标库。
// 数据源：data/5.0-goal-cycle.json（运行账本）+ data/token-usage.json（既有用量）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const dayKey = (at) => new Date(at).toLocaleDateString('en-CA');
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function sumUsage(days = {}, fromKey = '') {
  let calls = 0; let inputTokens = 0; let outputTokens = 0; let yuan = 0;
  for (const [k, v] of Object.entries(days || {})) {
    if (fromKey && k < fromKey) continue;
    calls += Number(v?.calls) || 0;
    inputTokens += Number(v?.input_tokens) || 0;
    outputTokens += Number(v?.output_tokens) || 0;
    yuan += Number(v?.estimated_cost_yuan) || 0;
  }
  return { calls, inputTokens, outputTokens, yuan: Math.round(yuan * 10000) / 10000 };
}

/**
 * @param {object} o
 * @param {Array} [o.entries]        账本原始条目（idleGoalLog.recent）
 * @param {object} [o.usageDays]     token-usage.json 的 days
 * @param {number} [o.now]
 * @param {number} [o.windowDays]
 * @param {number} [o.pendingActive] 未结算待办数
 * @param {number} [o.pendingAsked]  待办被问次数合计
 */
export function buildIdleMetrics({ entries = [], usageDays = {}, now = Date.now(), windowDays = 7, pendingActive = 0, pendingAsked = 0 } = {}) {
  const days = Math.max(1, Number(windowDays) || 7);
  const since = now - days * 86400e3;
  const inWindow = entries.filter((e) => Number(e?.at) >= since);
  const actions = {};
  let rounds = 0; let done = 0; let failed = 0; let quiet = 0;
  let activeMessages = 0; let shares = 0; let comments = 0; let replies = 0; let writes = 0;
  for (const e of inWindow) {
    rounds += 1;
    const a = String(e.action || e.type || '');
    if (a) actions[a] = (actions[a] || 0) + 1;
    if (e.done === true) done += 1;
    if (e.ok === false) failed += 1;
    if (a === 'sleep' || a === 'none' || a === 'skip') quiet += 1;
    if (a === 'chat' && e.ok === true && e.done === true) activeMessages += 1;
    if (a === 'share' && e.ok === true && e.done === true) shares += 1;
    if (a === 'comment' && e.ok === true && e.done === true) comments += 1;
    if (a === 'reply' && e.ok === true && e.done === true) replies += 1;
    if (['write_diary', 'write_notebook'].includes(a) && e.done === true) writes += 1;
  }
  const fromKey = dayKey(since);
  const cost = sumUsage(usageDays, fromKey);
  return {
    ok: true,
    windowDays: days,
    from: new Date(since).toISOString(),
    to: new Date(now).toISOString(),
    rounds,
    done,
    failed,
    quietSkips: quiet,
    activeMessages,
    shares,
    comments,
    replies,
    writes,
    actions,
    cost,
    pending: { active: Math.max(0, Number(pendingActive) || 0), askedTotal: Math.max(0, Number(pendingAsked) || 0) },
    last: inWindow.length ? clip(inWindow[inWindow.length - 1].title || inWindow[inWindow.length - 1].action, 80) : ''
  };
}

export function readUsageDays({ file = path.join(DATA_DIR, 'token-usage.json') } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j.days === 'object' ? j.days : {};
  } catch { return {}; }
}

export default buildIdleMetrics;
