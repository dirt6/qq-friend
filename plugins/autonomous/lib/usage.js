// 自主活动的 token 账本（第一版）。
//
// 为什么要单独一个账本：data/usage-today.json 记的是**全部**调用（包括老大跟
// 她聊天），混在一起就看不出「她闲着的时候花了多少」。这里只记自主活动
// 自己发起的调用，和对话用量互不干扰。
//
// 存 data/token-usage.json，结构：
//   {
//     "version": 1,
//     "monthKey": "2026-10",
//     "budgetYuan": 5,
//     "days": {
//       "2026-10-22": { "calls": 3, "input_tokens": 8123,
//                        "output_tokens": 512, "estimated_cost_yuan": 0.0421 }
//     }
//   }
//
// 三条取向（用户第一版方案，数值可调）：
//   · 每次调用后由**程序**把 API 返回的 usage 累加进来，不靠模型自己报；
//   · 费用按配置单价换算，不把价格写死在代码里；
//   · 到每日调用上限或月度预算就停，没有任何"自动续借"。
//
// 不新增数据库——就是一个 JSON，坏了会重建，不影响机器人启动。

import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const KEEP_DAYS = 90;      // 只留最近 90 天，够算月度账，也不让文件无限长
const DEFAULT_BUDGET = 5;  // 元/月

const pad = (n) => String(n).padStart(2, '0');

export function dayKeyOf(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKeyOf(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

export function emptyUsage(budgetYuan = DEFAULT_BUDGET) {
  return {
    version: VERSION,
    monthKey: monthKeyOf(),
    budgetYuan: Number.isFinite(Number(budgetYuan)) ? Number(budgetYuan) : DEFAULT_BUDGET,
    days: {}
  };
}

function normalize(raw, budgetYuan) {
  const base = emptyUsage(budgetYuan);
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
    monthKey: /^\d{4}-\d{2}$/.test(String(raw.monthKey)) ? String(raw.monthKey) : monthKeyOf(),
    budgetYuan: Number.isFinite(Number(raw.budgetYuan)) ? Number(raw.budgetYuan) : base.budgetYuan,
    days
  };
}

/** 读账本；文件不存在 → 空账本；损坏 → 记一笔警告后重建（不抛）。 */
export function readUsage(file, { onWarn = () => {} } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalize(raw);
  } catch (e) {
    if (e?.code !== 'ENOENT') onWarn?.(`token 账本读取失败，已重建：${e?.message ?? e}`);
    return emptyUsage();
  }
}

/** 原子写：先写 .tmp 再 rename。容量裁剪在这里做，调用方不用管。 */
export function writeUsage(file, usage) {
  const u = normalize(usage);
  const keys = Object.keys(u.days).sort();
  if (keys.length > KEEP_DAYS) {
    for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete u.days[k];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(u, null, 1), 'utf8');
  fs.renameSync(tmp, file);
  return u;
}

/** 按单价算一次调用的费用（元）。pricing 单位是「元/百万 token」。 */
export function costOf({ inputTokens = 0, outputTokens = 0 } = {}, pricing = {}) {
  const pin = Number(pricing?.inputPerMillion) || 0;
  const pout = Number(pricing?.outputPerMillion) || 0;
  return round4((Number(inputTokens) || 0) / 1e6 * pin + (Number(outputTokens) || 0) / 1e6 * pout);
}

/** 记一次调用。原地修改并返回传入的对象。 */
export function recordCall(usage, { inputTokens = 0, outputTokens = 0, ts = Date.now(), pricing = {} } = {}) {
  const u = normalize(usage);
  const dk = dayKeyOf(ts);
  const day = u.days[dk] || { calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost_yuan: 0 };
  day.calls += 1;
  day.input_tokens += Math.max(0, Number(inputTokens) || 0);
  day.output_tokens += Math.max(0, Number(outputTokens) || 0);
  day.estimated_cost_yuan = round4(
    Number(day.estimated_cost_yuan) + costOf({ inputTokens, outputTokens }, pricing)
  );
  u.days[dk] = day;
  u.monthKey = monthKeyOf(ts);
  Object.assign(usage, u);
  return usage;
}

export function todayCalls(usage, ts = Date.now()) {
  return Number(usage?.days?.[dayKeyOf(ts)]?.calls) || 0;
}

export function monthCost(usage, ts = Date.now()) {
  const mk = monthKeyOf(ts);
  let sum = 0;
  for (const [k, v] of Object.entries(usage?.days || {})) {
    if (k.startsWith(mk)) sum += Number(v?.estimated_cost_yuan) || 0;
  }
  return round4(sum);
}

export function monthCalls(usage, ts = Date.now()) {
  const mk = monthKeyOf(ts);
  let sum = 0;
  for (const [k, v] of Object.entries(usage?.days || {})) {
    if (k.startsWith(mk)) sum += Number(v?.calls) || 0;
  }
  return sum;
}

/**
 * 闸门：还能不能继续调用。
 * 返回 { ok, calls, spent, remainingYuan, reason }。
 */
export function gate(usage, { maxCallsPerDay = null, ts = Date.now() } = {}) {
  const calls = todayCalls(usage, ts);
  const spent = monthCost(usage, ts);
  const budget = Number(usage?.budgetYuan) || DEFAULT_BUDGET;
  const remainingYuan = round4(Math.max(0, budget - spent));
  // 2.3：调用次数不再设硬上限（机主要求"让她随意思考"）。
  // 传 null/0 就是不检查次数，只靠月度预算兜底；显式传数字仍然生效。
  if (maxCallsPerDay && calls >= maxCallsPerDay) {
    return { ok: false, calls, spent, remainingYuan, reason: `今日主动调用已达上限 ${calls}/${maxCallsPerDay} 次` };
  }
  if (spent >= budget) {
    return { ok: false, calls, spent, remainingYuan, reason: `本月已花 ¥${spent.toFixed(2)}，达到预算 ¥${budget}` };
  }
  return { ok: true, calls, spent, remainingYuan, reason: '' };
}

/** 给状态页/日志用的一行摘要。 */
export function summaryLine(usage, { maxCallsPerDay = null, ts = Date.now() } = {}) {
  const calls = todayCalls(usage, ts);
  const spent = monthCost(usage, ts);
  const budget = Number(usage?.budgetYuan) || DEFAULT_BUDGET;
  const mc = monthCalls(usage, ts);
  return `今日 ${calls}/${maxCallsPerDay} 次 · 本月 ${mc} 次 ¥${spent.toFixed(2)}/${budget}`;
}
