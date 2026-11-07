// 检索评分（4.0 / 3.0-R4）。
//
// ⚠️ **这只是检索评分，不是可信度。**
//    · relevance 高 = 和查询词更相关
//    · relevance 高 **不代表** 这条记忆更可信
//
// 可信度看 `epistemicType`（direct / inferred / unknown）和 `contentType`。

/** 中文/英文混合的简单分词：按非字母数字汉字切，再取 2-4 字的片段。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  // 英文/数字词
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  // 汉字片段（2~4 字）
  const han = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const chunk of han.split(/\s+/)) {
    if (!chunk) continue;
    for (let len = 2; len <= 4; len += 1) {
      for (let i = 0; i + len <= chunk.length; i += 1) {
        out.add(chunk.slice(i, i + len));
      }
    }
  }
  return out;
}

/** 停用词（不参与评分）。 */
const STOP = new Set([
  '的了', '是', '在', '我', '你', '他', '她', '它', '这', '那', '和', '与', '就', '也', '都',
  '不', '有', '没', '个', '一', '上', '下', '里', '到', '说', '要', '会', '能', '把', '被',
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are'
]);

/**
 * 算一条内容和查询的相关度（0~1）。
 *
 * 算法：查询词命中数 / 查询词总数的加权。
 * **故意做得简单** —— 这一层只负责"粗筛"，不做语义检索。
 *
 * @param {string} query
 * @param {string} content
 * @returns {number} 0~1
 */
export function relevanceOf(query, content) {
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const c = tokenize(content);
  if (c.size === 0) return 0;

  let hit = 0;
  let total = 0;
  for (const w of q) {
    if (STOP.has(w)) continue;
    total += 1;
    if (c.has(w)) hit += 1;
  }
  if (total === 0) return 0;
  return Math.min(1, hit / total);
}

/** 时间过滤：`since` / `until` 都是毫秒时间戳（可选）。 */
export function inTimeRange(ts, { since = 0, until = 0 } = {}) {
  const t = Number(ts) || 0;
  if (since && t < Number(since)) return false;
  if (until && t > Number(until)) return false;
  return true;
}

/** 按 relevance 降序，同分按时间降序。 */
export function sortResults(list) {
  return list.slice().sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
  });
}
