// Memory Hub 统一入口（4.0 / 3.0-R4）。
//
// ── 定位（机主 2026-11-02 明确）──────────────────────────────────
//   **统一视图 + 统一操作，不是统一存储。**
//   五层的底层文件路径和格式**完全不变**。
//
// ── 这一批只做只读 ────────────────────────────────────────────────
//   R4 不接入任何写入，不改变现有写入行为。
//   日记元数据的写入要等 R5 修完 W1/W2 之后才接。
//
// ── 一个必须说清的点 ──────────────────────────────────────────────
//   `relevance` 只是**检索评分**，不是可信度。
//   可信度看 `epistemicType`（direct / inferred / unknown）。

import {
  readLearned,
  readImpressions,
  readDiary,
  readActivities,
  readCompanionItems,
  renderLearned
} from './adapters.js';
import { sortResults } from './retrieval.js';

// 业务方只经 Hub 拿“经验 prompt 段”，不直接读 learned。
export { renderLearned };

/** 支持的层。 */
export const LAYERS = ['learned', 'impression', 'diary', 'activity', 'goal', 'pending'];

/**
 * 统一检索（**只读**）。
 *
 * @param {object} o
 * @param {string} [o.query]        关键词（空 = 不按内容筛，只按时间）
 * @param {string[]} [o.layers]     只查这几层（空 = 全部）
 * @param {number} [o.since]        起始时间戳（毫秒）
 * @param {number} [o.until]        截止时间戳
 * @param {number} [o.limit]        最多返回几条（0 = 不限）
 * @returns {{ok:boolean, items:Array, errors:Array}}
 */
export function search({
  query = '',
  layers = [],
  since = 0,
  until = 0,
  limit = 50,
  // 各层自己的参数
  chatKey = '',
  maxDays = 30,
  maxRounds = 20,
  diaryRoot = ''
} = {}) {
  const want = new Set(layers.length ? layers : LAYERS);
  const items = [];
  const errors = [];

  const take = (r, name) => {
    if (!r.ok) { errors.push({ layer: name, error: r.error }); return; }
    for (const it of r.items) items.push(it);
  };

  if (want.has('learned')) take(readLearned({ query, since, until }), 'learned');
  if (want.has('impression')) take(readImpressions({ query, since, until, chatKey }), 'impression');
  if (want.has('diary')) take(readDiary({ query, since, until, maxDays, diaryRoot }), 'diary');
  if (want.has('activity')) take(readActivities({ query, since, until, maxRounds }), 'activity');
  if (want.has('goal') || want.has('pending')) {
    const c = readCompanionItems({ query, since, until });
    if (!c.ok) errors.push({ layer: 'companion', error: c.error });
    for (const it of c.items) {
      if (want.has(it.type)) items.push(it);
    }
  }

  const sorted = sortResults(items);
  const capped = limit > 0 ? sorted.slice(0, limit) : sorted;
  return { ok: true, items: capped, errors };
}

/**
 * 按 id 取一条（**只读**）。
 *
 * @param {string} type
 * @param {string} id
 * @returns {{ok:boolean, item?:object, error?:string}}
 */
export function get(type, id) {
  const t = String(type || '');
  const want = String(id || '');
  if (!t || !want) return { ok: false, error: 'type 和 id 都不能为空' };
  const r = search({ layers: [t], limit: 0 });
  if (!r.ok) return { ok: false, error: '检索失败' };
  const item = r.items.find((x) => x.id === want);
  if (!item) return { ok: false, error: '没找到' };
  return { ok: true, item };
}

/**
 * 统计各层有多少条（**只读**）。
 *
 * @returns {{ok:boolean, counts:object, errors:Array}}
 */
export function stats() {
  const counts = {};
  const errors = [];
  for (const layer of LAYERS) {
    const r = search({ layers: [layer], limit: 0 });
    if (!r.ok) { errors.push({ layer, error: r.error }); counts[layer] = null; continue; }
    counts[layer] = r.items.length;
  }
  return { ok: true, counts, errors };
}

export const __internals = { LAYERS };
