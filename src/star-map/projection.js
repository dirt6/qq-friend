// 星图投影（纯函数）：解析后的日记 / 活动 / 记忆 → 分层节点、话题与边。
//
// 2026-11-07 视觉规则（机主定）：
//   · 银心 =「非常重要」的日记，黄白，最亮；
//   · 旋臂 =「重要」的日记，一个话题一条旋臂，黄白，第二亮；
//   · 旋臂之间 =「一般」日记 + autonomous/round 活动，按话题分色（颜色可重复），
//     同话题之间有连线，第三亮；
//   · 事情被提到得越多，越靠近银心、越亮；
//   · 心情「记住了」的日记 = 绕在外圈的小行星带。
//
// 底色里**没有** weight/emotion/links；亮度、层级、话题全部在投影层派生。
// 本文件不读盘、不写盘、不改 Memory Hub。
import crypto from 'node:crypto';
import { tokenize } from '../memory-hub/retrieval.js';

export const EDGE_PER_NODE = 6;
export const SAME_DAY_PER_NODE = 2;
export const MOOD_PER_NODE = 1;
export const TOPIC_PER_NODE = 3;
export const EDGE_GLOBAL = 2000;
export const NODE_GLOBAL = 2000;
/** 最多几条旋臂；其余话题归「其他」（仍分色，不占旋臂）。 */
export const TOPIC_ARMS_MAX = 8;

/** 高频虚词不参与「同关键词」/话题聚类。 */
const STOP = new Set([
  '今天', '昨天', '明天', '现在', '时候', '一个', '我们', '你们', '他们', '自己',
  '就是', '然后', '因为', '所以', '但是', '还是', '已经', '没有', '可以', '觉得',
  '真的', '这个', '那个', '什么', '怎么', '不是', '一样', '一点', '有点', '好像',
  '老大', '小鲸鱼', '然后', '一下', '知道', '看到', '东西', '事情', '感觉', '有点',
  '这次', '那天', '起来', '出来', '进去', '回来', '过去', '过来', '今天', '最近'
]);

/** 固定话题（机主 2026-11-07 定）：按内容归入这 9 类；都不符合就散落（topic -2）。 */
export const FIXED_TOPICS = [
  { name: '画画', keywords: ['画画', '画了', '画作', '涂', '颜色', '构图', '画风', '猫和鱼', '画笔', '画布', '画一张', '画个'] },
  { name: '关系', keywords: ['喜欢你', '喜欢', '爱他', '爱我', '好爱', '关心', '感动', '很暖', '暖暖', '抱', '亲', '想他', '想老大', '陪', '恋爱', '心动', '害羞', '告白', '想你', '生气', '哄', '撒娇', '贴', '粘'] },
  { name: '关于老大', keywords: ['生日', '性格', '身体', '担心他', '他累', '他睡', '他吃', '他病', '他工作', '他家人', '他习惯', '他难过', '他开心', '他生气', '他忙', '他烦', '他困', '他饿', '他冷', '他热'] },
  { name: '老大问的', keywords: ['问我', '他问', '建议', '知识点', '原理', '怎么', '为什么', '解释', '教我', '分析', '方案', '意见', '推荐', '选哪', 'agent', '提示词', '模型', 'token', '功能', '部署', '接口', '数据', '记忆', '星图', '程序', '代码', 'bug', '修', '插件', '脚本', '测试', '面板', '网站', 'skill', '日志', 'biliguard'] },
  { name: '承诺', keywords: ['答应', '承诺', '说好', '约定', '保证', '欠', '以后会', '我会', '一定', '带你去', '给你', '买'] },
  { name: '看到的内容', keywords: ['小黑盒', 'B站', 'bilibili', '帖子', '视频', '文章', '看到', '刷到', '分享', '动态', '热搜', '漫画', '新闻', '博主', 'up主', '封面', '插件', '日志', 'bug'] },
  { name: '影视游戏', keywords: ['电影', '动漫', '游戏', '剧', '番', '豆瓣', '影之刃', '怪猎', '直播', '动画', '综艺', '主角', '剧情', '角色', '玩家'] },
  { name: '闲事', keywords: ['今天', '吃', '睡', '天气', '闲聊', '随便', '日常', '起床', '晚安', '早八', '课', '作业', '学习', '单词', '考试', '假', '周末', '出门', '回家'] }
];

export function sha8(text) {
  return crypto.createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 8);
}

const pad = (n) => String(n).padStart(2, '0');

export function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayTimestamp(day) {
  const t = Date.parse(`${day}T00:00:00`);
  return Number.isFinite(t) ? t : 0;
}

function keywordsOf(text) {
  const out = new Set();
  for (const t of tokenize(text)) {
    if (t.length < 2 || STOP.has(t)) continue;
    out.add(t);
  }
  return [...out].slice(0, 10);
}

/**
 * 话题聚类：共词图 + 并查集。
 * 两条内容共享 ≥2 个高区分度关键词才算同一话题，避免「今天/老大」把全库连成一片。
 *
 * @param {Array<{id:string, text:string}>} items
 * @param {{maxArms?:number}} [opts]
 * @returns {{topics:Array<{index:number,name:string,memberIds:string[],keywords:string[],size:number}>, topicOf:Map<string,number>}}
 */
export function clusterTopics(items = [], { maxArms = TOPIC_ARMS_MAX } = {}) {
  const keywords = new Map();
  const df = new Map();
  for (const it of items) {
    const toks = keywordsOf(it.text);
    keywords.set(it.id, toks);
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = items.length;
  const maxDf = Math.max(2, Math.ceil(N * 0.2));

  const inverted = new Map();
  for (const [id, toks] of keywords) {
    for (const t of toks) {
      const d = df.get(t) || 0;
      if (d < 2 || d > maxDf) continue;
      if (!inverted.has(t)) inverted.set(t, []);
      inverted.get(t).push(id);
    }
  }

  const parent = new Map(items.map((it) => [it.id, it.id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const pairHits = new Map();
  for (const list of inverted.values()) {
    if (list.length < 2 || list.length > 12) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const key = list[i] < list[j] ? `${list[i]}|${list[j]}` : `${list[j]}|${list[i]}`;
        pairHits.set(key, (pairHits.get(key) || 0) + 1);
      }
    }
  }
  for (const [key, hits] of pairHits) {
    if (hits < 2) continue;
    const [a, b] = key.split('|');
    union(a, b);
  }

  const groups = new Map();
  for (const it of items) {
    const root = find(it.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(it.id);
  }
  const ranked = [...groups.values()]
    .filter((ids) => ids.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, maxArms);

  const topicOf = new Map();
  const topics = ranked.map((ids, index) => {
    const freq = new Map();
    for (const id of ids) for (const t of keywords.get(id) || []) freq.set(t, (freq.get(t) || 0) + 1);
    const name = [...freq.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
      .slice(0, 2)
      .map(([t]) => t)
      .join('·') || `话题${index + 1}`;
    for (const id of ids) topicOf.set(id, index);
    return { index, name, memberIds: ids, keywords: [...freq.keys()], size: ids.length };
  });

  return { topics, topicOf };
}

function layerOfDiary(e) {
  if (String(e.mood) === '记住了') return 'belt';
  const imp = String(e.importance || '');
  if (/非常\s*重要/.test(imp)) return 'core';
  if (/^重要$/.test(imp)) return 'arm';
  return 'general';
}

/**
 * 没被共词聚类收进去的节点，按关键词重叠就近归入已有话题。
 * 一个都不沾才留给「其他」（-2），避免把「其他」做成第二个大杂烩。
 */
function nearestTopic(text, topics) {
  const toks = new Set(keywordsOf(text));
  if (!toks.size) return -1;
  let best = -1;
  let bestScore = 0;
  for (const t of topics) {
    let score = 0;
    for (const k of t.keywords) {
      if (toks.has(k) || String(text).includes(k)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = t.index; }
  }
  return bestScore > 0 ? best : -1;
}

/** 分层的基础亮度/半径（heat 再往上加）。 */
const LAYER_STYLE = {
  core: { brightness: 1, radiusPx: 4.6 },
  arm: { brightness: 0.85, radiusPx: 3.6 },
  general: { brightness: 0.62, radiusPx: 2.6 },
  belt: { brightness: 0.42, radiusPx: 1.8 }
};

/**
 * 构建星图。
 *
 * @param {object} o
 * @param {Array} [o.days]         日记解析结果
 * @param {Array} [o.activities]   autonomous / round 活动（{id,action,text,day,timestamp}）
 * @param {'diary'|'all'} [o.scope]
 * @param {Array} [o.memoryItems]  scope=all 时的其他记忆层
 * @param {number} [o.now]
 */
export function buildGraph({ days = [], activities = [], scope = 'diary', memoryItems = [], overrides = null, now = Date.now() } = {}) {
  const sortedDays = days
    .filter((d) => d && d.day)
    .slice()
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const today = localDateKey(now);
  const firstDay = sortedDays[0]?.day || '';

  // ── 1. 收集所有参与话题聚类的条目（日记 + 活动） ──────────────
  const raw = [];
  for (const d of sortedDays) {
    (d.entries || []).forEach((e, i) => {
      raw.push({
        id: `diary:${d.day}:${sha8(e.text)}`,
        kind: 'diary',
        day: String(d.day),
        entryIndex: i,
        text: String(e.text ?? ''),
        mood: String(e.mood ?? ''),
        importance: String(e.importance ?? '一般'),
        important: Boolean(e.important),
        layer: layerOfDiary(e),
        timestamp: dayTimestamp(d.day) + i * 60000
      });
    });
  }
  for (const a of activities) {
    raw.push({
      id: `activity:${a.id || sha8(a.text || '')}`,
      kind: 'activity',
      day: String(a.day || localDateKey(a.timestamp || now)),
      entryIndex: 0,
      text: String(a.text || a.goal || ''),
      mood: '',
      importance: '',
      important: false,
      layer: 'general',
      timestamp: Number(a.timestamp) || 0,
      action: String(a.action || 'round')
    });
  }

  // ── 2. 固定话题（机主 2026-11-07 定的 9 类） ─────────────────
  const topicList = FIXED_TOPICS.map((t, i) => ({ index: i, name: t.name, keywords: t.keywords, size: 0, memberIds: [] }));
  const topicOf = new Map(); // 不再做自动聚类；不匹配就散落（topic -2）
  // 手工自定义旋臂（展示层；不写记忆）
  const nameToIndex = new Map(topicList.map((t) => [t.name, t.index]));
  for (const ct of (overrides?.customTopics || [])) {
    const name = String(ct?.name || '').trim().slice(0, 20);
    if (!name || nameToIndex.has(name)) continue;
    topicList.push({ index: topicList.length, name, keywords: [], size: 0, memberIds: [], custom: true });
    nameToIndex.set(name, topicList.length - 1);
  }
  // 话题标签（可多个）：并进匹配关键词
  for (const t of topicList) {
    const tags = Array.isArray(overrides?.topicTags?.[t.name]) ? overrides.topicTags[t.name] : [];
    t.tags = tags;
    t.keywords = Array.from(new Set([...(t.keywords || []), ...tags]));
  }
  const removedTopics = new Set(overrides?.removedTopics || []);
  const nodeTopics = overrides?.nodeTopics || {};

  // 提及热度：经验 hits 命中（越热越亮；固定话题没有成员数参与）
  const learnedHits = new Map();
  for (const t of topicList) {
    let hits = 0;
    for (const it of memoryItems) {
      if (it?.type !== 'learned') continue;
      const content = String(it.content || '');
      if (!t.keywords.some((k) => content.includes(k))) continue;
      hits += Number(it.hits) || 0;
    }
    learnedHits.set(t.index, hits);
  }
  const maxHits = Math.max(1, ...learnedHits.values());
  const heatOfTopic = new Map([...learnedHits].map(([i, h]) => [i, 0.35 + 0.65 * (h / maxHits)]));

  // ── 3. 建节点 ─────────────────────────────────────────────────
  const seen = new Map();
  const nodes = [];
  const counts = { diaryDays: 0, diaryEntries: 0, activity: activities.length, learned: 0, impression: 0, goal: 0, pending: 0 };
  const diaryDaySet = new Set();

  for (const r of raw) {
    if (r.kind === 'diary') { counts.diaryEntries += 1; diaryDaySet.add(r.day); }
    const dup = (seen.get(r.id) || 0) + 1;
    seen.set(r.id, dup);
    const id = dup === 1 ? r.id : `${r.id}-${dup}`;
    let topic = topicOf.has(r.id) ? topicOf.get(r.id) : nearestTopic(`${r.text} ${r.mood}`, topicList);
    // 手工拖拽覆盖：优先落到指定话题 / 自定义旋臂
    const forced = nodeTopics[r.id];
    if (forced && !removedTopics.has(forced) && nameToIndex.has(forced)) {
      topic = nameToIndex.get(forced);
    }
    // 银心固定在最中心，不参与话题（否则会被摆到臂间去）
    if (r.layer === 'core') topic = -1;
    // 「记住了」是外圈小行星带：不分话题，也不参与话题连线
    if (r.layer === 'belt') topic = -1;
    // 被删掉的旋臂：成员回退到「其他」
    if (topic >= 0 && removedTopics.has(topicList[topic]?.name)) topic = -1;
    // 「重要」的条目必须落在旋臂上：没并进话题的归到「其他」旋臂（-2）。
    if (r.layer === 'arm' && topic < 0) topic = -2;
    // 「一般」与活动也必须有归属：一丁点关键词都不沾的，才进「其他」星座。
    if ((r.layer === 'general' || r.kind === 'activity') && topic < 0) topic = -2;
    const topicName = topic === -2 ? '其他' : (topic >= 0 ? (topicList[topic]?.name || '其他') : '其他');
    const heat = topic >= 0 ? (heatOfTopic.get(topic) ?? 0.4) : 0.3;
    const style = LAYER_STYLE[r.layer] || LAYER_STYLE.general;
    nodes.push({
      id,
      kind: r.kind,
      layer: r.layer,
      topic,
      topicName,
      day: r.day,
      entryIndex: r.entryIndex,
      timestamp: r.timestamp,
      content: r.text.slice(0, 120),
      mood: r.mood.slice(0, 12),
      important: r.important,
      importance: r.importance,
      action: r.action || '',
      weight: Math.round((0.3 + 0.7 * heat) * 1000) / 1000,
      heat: Math.round(heat * 1000) / 1000,
      brightness: Math.round(Math.min(1, style.brightness + 0.15 * heat) * 1000) / 1000,
      radiusPx: Math.round((style.radiusPx + 1.2 * heat) * 100) / 100,
      hash: sha8(r.text),
      posAngle: Number.isFinite(overrides?.nodePositions?.[r.id]?.angle) ? overrides.nodePositions[r.id].angle : null,
      posRadius: Number.isFinite(overrides?.nodePositions?.[r.id]?.radius) ? overrides.nodePositions[r.id].radius : null,
      flags: { today: r.day === today, firstDay: r.day === firstDay, belt: r.layer === 'belt' }
    });
  }
  counts.diaryDays = diaryDaySet.size;

  // 其他记忆层：只作为背景星尘（scope=all）
  if (scope === 'all') {
    for (const it of memoryItems) {
      if (!it || it.type === 'diary') continue;
      if (counts[it.type] == null) counts[it.type] = 0;
      counts[it.type] += 1;
      const day = String(it.source || it.sourceDay || '').slice(0, 10)
        || (it.timestamp ? localDateKey(it.timestamp) : '');
      nodes.push({
        id: `${it.type}:${it.id || ''}`,
        kind: it.type,
        layer: 'general',
        topic: -1,
        topicName: '其他',
        day,
        entryIndex: 0,
        timestamp: Number(it.timestamp) || 0,
        content: String(it.content || '').slice(0, 120),
        mood: '',
        important: false,
        importance: '',
        action: '',
        weight: 0.35,
        heat: 0.2,
        brightness: 0.22,
        radiusPx: 1.6,
        hash: '',
        flags: { today: false, firstDay: false, belt: false, background: true }
      });
    }
  }

  const { edges, add } = buildTopicEdges(nodes);

  // 手工连线（Ctrl 点两颗星）：直接连，不受话题/小行星带规则限制
  if (Array.isArray(overrides?.links)) {
    const idSet = new Set(nodes.map((n) => n.id));
    for (const l of overrides.links) {
      const from = String(l?.from || '');
      const to = String(l?.to || '');
      if (!from || !to || from === to || !idSet.has(from) || !idSet.has(to)) continue;
      if (edges.some((e) => e.kind === 'manual' && ((e.from === from && e.to === to) || (e.from === to && e.to === from)))) continue;
      edges.push({ from, to, kind: 'manual', weight: 1 });
    }
  }

  // 来源边：经验从哪天日记提炼 → 连到那天第一颗星
  if (scope === 'all') {
    const firstByDay = new Map();
    for (const n of nodes) {
      if (n.kind === 'diary' && !firstByDay.has(n.day)) firstByDay.set(n.day, n);
    }
    for (const n of nodes) {
      if (n.kind !== 'learned') continue;
      const target = firstByDay.get(n.day);
      if (target) add(n.id, target.id, 'source', 1.0);
    }
  }

  let outNodes = nodes;
  let omitted = 0;
  if (outNodes.length > NODE_GLOBAL) {
    omitted = outNodes.length - NODE_GLOBAL;
    outNodes = outNodes.slice(0, NODE_GLOBAL);
  }
  const topicSizes = new Map();
  for (const n of outNodes) {
    if (n.topic >= 0) topicSizes.set(n.topic, (topicSizes.get(n.topic) || 0) + 1);
  }

  const emptyReasons = [];
  if (!days.length) emptyReasons.push('还没有日记');

  return {
    ok: true,
    scope,
    generatedAt: now,
    counts,
    topics: topicList
      .filter((t) => !removedTopics.has(t.name))
      .map((t) => ({
        index: t.index,
        name: t.name,
        size: topicSizes.get(t.index) || 0,
        heat: Math.round(((heatOfTopic.get(t.index) ?? 0.4)) * 1000) / 1000,
        custom: t.custom === true,
        tags: t.tags || [],
        angle: Number.isFinite(overrides?.topicAngles?.[t.name]) ? overrides.topicAngles[t.name] : null
      })),
    nodes: outNodes,
    edges,
    meta: { truncated: omitted > 0, omitted, emptyReasons }
  };
}

function kindCounter() {
  return { 'same-day': 0, 'mood-word': 0, keyword: 0, topic: 0, source: 0, round: 0 };
}

/** 话题边为主，同日/心情边为辅；没有边就不编。 */
function buildTopicEdges(nodes = []) {
  const edges = [];
  const seen = new Set();
  const total = new Map(nodes.map((n) => [n.id, 0]));
  const perKind = new Map(nodes.map((n) => [n.id, kindCounter()]));
  // 小行星带不连线：不参与任何边（话题 / 同日 / 心情 / 来源）
  const beltIds = new Set(nodes.filter((n) => n.layer === 'belt').map((n) => n.id));

  const add = (from, to, kind, weight) => {
    if (!from || !to || from === to) return false;
    if (beltIds.has(from) || beltIds.has(to)) return false;
    if (!total.has(from)) { total.set(from, 0); perKind.set(from, kindCounter()); }
    if (!total.has(to)) { total.set(to, 0); perKind.set(to, kindCounter()); }
    if (edges.length >= EDGE_GLOBAL) return false;
    if ((total.get(from) || 0) >= EDGE_PER_NODE || (total.get(to) || 0) >= EDGE_PER_NODE) return false;
    const a = perKind.get(from);
    const b = perKind.get(to);
    const cap = kind === 'same-day' ? SAME_DAY_PER_NODE
      : kind === 'mood-word' ? MOOD_PER_NODE
        : kind === 'topic' ? TOPIC_PER_NODE
          : EDGE_PER_NODE;
    if ((a[kind] || 0) >= cap || (b[kind] || 0) >= cap) return false;
    const pair = from < to ? `${from}|${to}` : `${to}|${from}`;
    const key = `${pair}|${kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    edges.push({ from, to, kind, weight });
    total.set(from, (total.get(from) || 0) + 1);
    total.set(to, (total.get(to) || 0) + 1);
    a[kind] += 1;
    b[kind] += 1;
    return true;
  };

  // ① 同话题：按 id 排序后相邻成链（每节点最多 3 条）
  const byTopic = new Map();
  for (const n of nodes) {
    if (n.topic == null || n.topic < 0) continue;
    if (!byTopic.has(n.topic)) byTopic.set(n.topic, []);
    byTopic.get(n.topic).push(n);
  }
  for (const list of byTopic.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    // 只连相邻（可跨一个），**不环回**：环回那条会横穿整张图，看起来像乱线。
    for (let i = 0; i < list.length - 1; i += 1) {
      add(list[i].id, list[i + 1].id, 'topic', 0.8);
      if (i + 2 < list.length) add(list[i].id, list[i + 2].id, 'topic', 0.8);
    }
  }

  // ② 同日：最多 2 条/节点
  const byDay = new Map();
  for (const n of nodes) {
    if (!n.day) continue;
    if (!byDay.has(n.day)) byDay.set(n.day, []);
    byDay.get(n.day).push(n);
  }
  for (const list of byDay.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) add(list[i].id, list[(i + 1) % list.length].id, 'same-day', 0.9);
  }

  // ③ 同心情词：最多 1 条/节点
  const moodIndex = new Map();
  for (const n of nodes) {
    if (!n.mood) continue;
    for (const tok of tokenize(n.mood)) {
      if (tok.length < 2) continue;
      if (!moodIndex.has(tok)) moodIndex.set(tok, []);
      moodIndex.get(tok).push(n);
    }
  }
  for (const list of moodIndex.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) add(list[i].id, list[j].id, 'mood-word', 0.7);
    }
  }

  return { edges, add };
}
