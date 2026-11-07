// Round 摘要（4.0 / 2.6-B5a）。
//
// **这一层只做"索引"，不做判断。**
//
// 目的：把每一轮自主活动整理成一个很小的 digest，供后续（B5b）做长期方向判断。
// 它**不调模型、不创建 Goal、不做语义总结** —— 只是把原始历史里最有用的几个字段挑出来。
//
// 为什么需要它：`autonomous.json` 的 history 一条就有几 KB（含 chat/draw/comment 全量内容、
// token 统计、各种扁平化兼容字段）。做"跨轮判断"时不需要这些，只需要
// 「这一轮想干什么、做了几件事、每件事什么结果」。
//
// **digest 是历史的索引，不是模型总结出的长期记忆。** 原始记录永远以 history 为准。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';

/** digest 里最多保留几轮（超出的丢最老的）。 */
export const MAX_DIGESTS = 50;

/** 每轮最多保留几个 Action（防异常膨胀）。 */
const MAX_ACTIONS = 12;

/** 文本裁剪长度。 */
const MAX_TEXT = 120;

function nowIso() {
  return new Date().toISOString();
}

function safeText(v, max = MAX_TEXT) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 从一轮的 rec 构造 digest（4.0 / 2.6-B5a）。
 *
 * **返回 null 表示这一轮不该被汇总。** 机主 2026-11-02 定的跳过条件：
 *   · rec.error 非空（异常轮次没有可信的 Action 记录）
 *   · 没有 roundId（无法做幂等，也没法引用）
 *   · actions 不是数组 / 结构异常
 *   · 一个有效 Action 都没有（空轮次没有判断价值）
 *
 * @param {object} rec
 * @returns {object|null}
 */
export function buildDigest(rec) {
  if (!rec || typeof rec !== 'object') return null;
  // ① 异常轮次跳过。
  // 注意：**不 trim** —— error 只要是「非空字符串」就算异常，
  // 哪怕它只有空白（那种情况说明错误信息被吞了，同样不可信）。
  const errText = rec.error == null ? '' : String(rec.error);
  if (errText !== '') return null;
  // ② 没有 roundId 跳过（幂等和证据引用都靠它）
  const roundId = String(rec.roundId || '').trim();
  if (!roundId) return null;
  // ③ actions 结构异常跳过
  if (!Array.isArray(rec.actions)) return null;

  // ④ 只收真正执行过的 Action（有 action 名字）
  const actions = [];
  for (const a of rec.actions) {
    if (!a || typeof a !== 'object') continue;
    const name = safeText(a.action || a.actionType, 40);
    if (!name) continue;
    actions.push({
      action: name,
      // objective 对应 history 里的 actions[].goal —— 只是换个更清楚的名字，**不改原字段**
      objective: safeText(a.goal, MAX_TEXT),
      result: safeText(a.result, 40)
    });
    if (actions.length >= MAX_ACTIONS) break;
  }
  // ⑤ 一个有效 Action 都没有 → 空轮次
  if (!actions.length) return null;

  const it = rec.intent && typeof rec.intent === 'object' ? rec.intent : null;

  return {
    roundId,
    createdAt: new Date(Number(rec.startedAt) || Date.now()).toISOString(),
    status: safeText(rec.status, 20),
    intent: it
      ? {
        intent: safeText(it.intent, 40),
        goal: safeText(it.goal, MAX_TEXT),
        why: safeText(it.why, MAX_TEXT)
      }
      : null,
    actions,
    // 结束原因也留一份（判断"这轮是不是空转"有用）
    stopReason: safeText(rec.stopReason, 150)
  };
}

/**
 * 把 digest 追加到数组里（幂等：同 roundId 不重复加）。
 *
 * @param {Array} list  现有 digests
 * @param {object} digest
 * @returns {{list:Array, added:boolean}}
 */
export function appendDigest(list, digest) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!digest || !digest.roundId) return { list: arr, added: false };
  if (arr.some((d) => d && d.roundId === digest.roundId)) {
    return { list: arr, added: false };   // 幂等
  }
  arr.push(digest);
  // 超上限丢最老的
  while (arr.length > MAX_DIGESTS) arr.shift();
  return { list: arr, added: true };
}

/**
 * 读现有的 digests（只读）。
 * 读失败给空数组 —— 调用方不用处理异常。
 */
export function readDigests(file = path.join(DATA_DIR, 'autonomous.json')) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.digests) ? j.digests : [];
  } catch {
    return [];
  }
}

/**
 * 取最近 N 轮 digest（按 createdAt 正序）。
 *
 * @param {number} n
 * @param {Array} [list] 测试可以注入
 */
export function recentDigests(n = 5, list = null) {
  const arr = Array.isArray(list) ? list : readDigests();
  const sorted = arr
    .filter((d) => d && d.roundId)
    .slice()
    .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  return sorted.slice(Math.max(0, sorted.length - Math.max(1, n)));
}

/** 这一轮已经汇总过了吗（幂等检查用）。 */
export function hasDigest(roundId, list = null) {
  const arr = Array.isArray(list) ? list : readDigests();
  const id = String(roundId || '');
  return Boolean(id) && arr.some((d) => d && d.roundId === id);
}

export const __internals = { safeText, MAX_ACTIONS, MAX_TEXT, nowIso };
