#!/usr/bin/env node
// R8-C：四维可信度（2026-11-03）
import fs from 'node:fs';

const p = 'src/learned.js';
let s = fs.readFileSync(p, 'utf8');

const anchor = '/**\n * ══ R8-B：晋升候选（2026-11-03）';

const code = String.raw`/**
 * ══ R8-C：四维可信度（2026-11-03）══════════════════════════════════
 *
 * **机主的硬要求**：
 *   · 四个维度**独立保存**，不合成一个总分
 *   · 「第一版不计算加权总分，不把定性等级解释为概率」
 *   · assessment 只允许 high / medium / low / unknown
 *   · credibility 与 relevance **完全正交**
 *   · **不调用模型** —— 全部确定性规则
 *
 * ── 为什么不分总分 ────────────────────────────────────────
 * 四个维度回答的是四个不同的问题：
 *   source     —— 谁说的？
 *   evidence   —— 是直接看到的还是推断的？
 *   correction —— 被纠正过吗？解决了吗？
 *   conflict   —— 有冲突的内容吗？
 *
 * 把它们加权相加，等于用一个数字掩盖四个独立的判断。
 */

/** 允许的定性等级（**没有数值**）。 */
export const CREDIBILITY_LEVELS = ['high', 'medium', 'low', 'unknown'];

/** 规则版本：改规则要 +1。 */
export const CREDIBILITY_RULE_VERSION = 1;

/**
 * 来源等级。
 *
 * 实际的 ORIGIN_KINDS 是
 *   ['chat', 'autonomous', 'diary', 'user_stated', 'inferred', 'unknown']
 * **没有** owner。
 */
function sourceLevel(item) {
  const kind = String(item?.origin?.kind || 'unknown').toLowerCase();
  switch (kind) {
    case 'user_stated': return 'high';     // 用户本人直接说的
    case 'diary':       return 'high';     // 她自己写的日记（有出处）
    case 'chat':        return 'medium';   // 聊天中得到的
    case 'autonomous':  return 'medium';   // 自主活动观察到的
    case 'inferred':    return 'low';      // 推断
    default:            return 'unknown';
  }
}

/**
 * 证据类型等级。
 * direct = 直接观察到 / inferred = 推断 / unknown = 不知道
 */
function evidenceLevel(item) {
  const et = String(item?.epistemicType || 'unknown').toLowerCase();
  switch (et) {
    case 'direct':   return 'high';
    case 'inferred': return 'low';
    default:         return 'unknown';
  }
}

/**
 * 纠正历史等级。
 *
 * **只有 events 非空才算有真实纠正**（和 R8-B 的口径一致）。
 * 空 events + historicalUnresolved=true 是 DEFAULT_META 的占位，按"无纠正"处理。
 */
function correctionLevel(item) {
  const c = item?.correction;
  if (!c || typeof c !== 'object') return 'high';    // 从未被纠正
  const events = Array.isArray(c.events) ? c.events : [];
  if (events.length === 0) return 'high';            // 占位，等同"无纠正"
  if (c.historicalUnresolved === true) return 'low'; // 有纠正且没解决
  return 'medium';                                    // 纠正过但已解决
}

/**
 * 冲突情况等级。
 *
 * 只读 item.conflicts 字段（R8-C 不自己制造冲突标记）。
 */
function conflictLevel(item) {
  const list = Array.isArray(item?.conflicts) ? item.conflicts : [];
  if (list.length === 0) return 'high';
  const unresolved = list.filter((c) => !c || c.resolved !== true);
  if (unresolved.length === 0) return 'medium';       // 有冲突但都已解决
  return 'low';                                        // 有未解决冲突
}

/**
 * 产出一个条目的四维评估。
 *
 * **不合成总分。** 调用方拿到的是四个独立的等级。
 *
 * @param {object} item
 * @returns {{source: string, evidence: string, correction: string, conflict: string, ruleVersion: number, at: string}}
 */
export function assessCredibility(item, { now = Date.now() } = {}) {
  return {
    source: sourceLevel(item),
    evidence: evidenceLevel(item),
    correction: correctionLevel(item),
    conflict: conflictLevel(item),
    ruleVersion: CREDIBILITY_RULE_VERSION,
    at: new Date(now).toISOString()
  };
}

/**
 * 给一批条目算四维评估（不写回 store）。
 *
 * @param {object[]} items
 * @returns {{items: object[], byLevel: object}}
 */
export function assessMany(items, { now = Date.now() } = {}) {
  const out = [];
  const byLevel = { source: {}, evidence: {}, correction: {}, conflict: {} };
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.id) continue;
    const a = assessCredibility(it, { now });
    out.push({ id: it.id, assessment: a });
    for (const dim of ['source', 'evidence', 'correction', 'conflict']) {
      const v = a[dim];
      byLevel[dim][v] = (byLevel[dim][v] || 0) + 1;
    }
  }
  return { items: out, byLevel };
}

`;

if (s.includes('assessCredibility')) { console.log('· 已在'); }
else if (s.includes(anchor)) { s = s.replace(anchor, code + anchor); console.log('✓ 四维评估已插入'); }
else console.log('⚠ 锚点没找到');

fs.writeFileSync(p, s, 'utf8');
