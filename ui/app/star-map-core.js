// 星图纯函数核心（5.0 星图 P1/P2）。
//
// 为什么单独一段普通脚本：
//   控制台前端是零框架普通脚本（defer 顺序执行），不能 import ESM；
//   但布局与扩散激活必须可测。这里用 UMD 挂到 window.__starMapCore，
//   Node 测试用 vm 加载同一份文件。
//
// 只做三件事：
//   ① 布局：日期序号 → 半径，同日簇 ±8° 抖散（确定性哈希，不用随机数）
//   ② 扩散激活：种子 → 沿边 1–2 跳，多路径叠加，≤80 节点
//   ③ 关键词种子：与 Memory Hub 同一套 2–4 字切片 + 命中率（不做语义）
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.__starMapCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEG = Math.PI / 180;

  /** FNV-1a → 0..1，稳定、不依赖随机数。 */
  function hash01(str) {
    let h = 2166136261;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
  }

  const SPIRAL = 2.6; // 兼容旧调用；星座布局不再固定螺旋线

  // 星座形状模板：同一话题的星点摆成不同形状（弧 / 锯齿 / 环 / 波 / 螺旋 / V）
  const SHAPES = ['arc', 'zigzag', 'loop', 'wave', 'spiral', 'vee'];
  function shapeOffset(kind, u) {
    switch (kind) {
      case 'arc': return Math.sin(u * Math.PI * 0.9) * 0.30;
      case 'zigzag': return (Math.round(u * 5) % 2 ? 1 : -1) * 0.10;
      case 'loop': return Math.sin(u * Math.PI * 2) * 0.24;
      case 'wave': return Math.sin(u * Math.PI * 3) * 0.18;
      case 'spiral': return (u - 0.5) * 0.55;
      case 'vee': return Math.abs(u - 0.5) * 0.7 - 0.18;
      default: return 0;
    }
  }

  /**
   * 星座布局（2026-11-07 v3）：
   *   · 银心（layer=core）：贴中心小范围，越热越靠内；
   *   · 每个话题一组星：沿不同形状（弧/锯齿/环/波/螺旋/V）铺开，
   *     同话题按 id 排序连成一条星座链，不再固定一条直线；
   *   · 小行星带（layer=belt）：最外圈。
   * 位置全部由 id 哈希决定，确定性、刷新不漂。
   */
  function layout(nodes, topics) {
    const positions = new Map();
    // 手工摆的位置优先（拖到空白处保存的坐标），不参与自动布局
    for (const n of nodes || []) {
      if (Number.isFinite(n.posAngle) && Number.isFinite(n.posRadius)) {
        positions.set(n.id, { angle: n.posAngle, radius: n.posRadius, layer: n.layer, topic: n.topic });
      }
    }
    const armSet = new Set();
    // 手工添加的空旋臂（还没有星）也要有臂线和基准角
    for (const t of topics || []) {
      if (t && t.custom && Number.isFinite(t.index)) armSet.add(t.index);
    }
    for (const n of nodes || []) {
      // core/belt 是固定层（中心 / 外圈），不参与话题旋臂
      if (n.layer === 'core' || n.layer === 'belt') continue;
      if (n.topic != null && n.topic >= -2) armSet.add(n.topic);
    }
    // -2（其他）排在最后
    const arms = [...armSet].sort((a, b) => (a === -2 ? 1 : 0) - (b === -2 ? 1 : 0) || a - b);
    const gap = (Math.PI * 2) / Math.max(1, arms.length);
    const topicMeta = new Map((topics || [])
      .filter((t) => t && Number.isFinite(t.index))
      .map((t) => [t.index, t]));
    const baseOf = new Map(arms.map((t, i) => {
      const meta = topicMeta.get(t);
      return [t, meta && Number.isFinite(meta.angle) ? meta.angle : (i * gap - Math.PI / 2)];
    }));

    // 每个话题：arm 沿旋臂螺旋线，general/活动摆在该旋臂旁的「臂间」星座里
    const byTopic = new Map(arms.map((t) => [t, []]));
    for (const n of nodes || []) {
      if (n.layer === 'core' || n.layer === 'belt') continue;
      if (n.topic == null || !byTopic.has(n.topic)) continue;
      // 无话题的普通星不归组，散落在旋臂之间
      if (n.topic === -2 && n.layer !== 'arm') continue;
      byTopic.get(n.topic).push(n);
    }

    for (const [t, list] of byTopic) {
      const base = baseOf.get(t) ?? 0;
      const armNodes = list.filter((n) => n.layer === 'arm').sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const genNodes = list.filter((n) => n.layer !== 'arm').sort((a, b) => String(a.id).localeCompare(String(b.id)));

      // 旋臂：沿螺旋线排开（越热越靠内）
      armNodes.forEach((n, i) => {
        if (positions.has(n.id)) return;
        const r = 0.14 + i * 0.035 + (1 - (Number(n.heat) || 0)) * 0.03;
        positions.set(n.id, {
          angle: base + SPIRAL * r + (hash01(n.id) - 0.5) * 0.02,
          radius: r,
          layer: 'arm',
          topic: t
        });
      });

      // 臂间星座：一般/活动贴着同话题的旋臂（左右小幅散开），不飞到别的臂间
      const kind = SHAPES[((t % SHAPES.length) + SHAPES.length) % SHAPES.length];
      const m = genNodes.length;
      genNodes.forEach((n, i) => {
        if (positions.has(n.id)) return;
        const u = m > 1 ? i / (m - 1) : 0.5;
        const r = 0.22 + u * 0.33;
        const v = shapeOffset(kind, u);
        const side = i % 2 === 0 ? 1 : -1;
        positions.set(n.id, {
          angle: base + SPIRAL * r + side * 0.10 + v * 0.45 + (hash01(n.id) - 0.5) * 0.02,
          radius: r,
          layer: 'general',
          topic: t
        });
      });
    }

    for (const n of nodes || []) {
      if (positions.has(n.id)) continue;
      const h = hash01(n.id);
      const heat = Number(n.heat) || 0.3;
      if (n.layer === 'core') {
        // 银心星稍微散开，别挤在正中心，方便点
        positions.set(n.id, { angle: h * Math.PI * 2, radius: 0.045 + 0.075 * (1 - heat), layer: 'core', topic: -1 });
      } else if (n.layer === 'belt') {
        positions.set(n.id, { angle: h * Math.PI * 2, radius: 0.94 + h * 0.09, layer: 'belt', topic: -1 });
      } else {
        // 无话题：零星散落在旋臂之间的空白处（半径/角度各用一段哈希）
        const h2 = hash01(`${n.id}:r`);
        positions.set(n.id, {
          angle: h * Math.PI * 2,
          radius: 0.18 + 0.67 * h2,
          layer: 'general',
          topic: n.topic
        });
      }
    }

    return {
      positions,
      arms: arms.map((t) => ({ topic: t, angle: baseOf.get(t) ?? 0, shape: SHAPES[((t % SHAPES.length) + SHAPES.length) % SHAPES.length] })),
      days: []
    };
  }

  /** 无向邻接表（边在两端都可达，扩散不分局）。 */
  function buildAdjacency(nodes, edges) {
    const adj = new Map((nodes || []).map((n) => [n.id, []]));
    for (const e of edges || []) {
      if (!adj.has(e.from) || !adj.has(e.to)) continue;
      adj.get(e.from).push({ to: e.to, w: Number(e.weight) || 0.5 });
      adj.get(e.to).push({ to: e.from, w: Number(e.weight) || 0.5 });
    }
    return adj;
  }

  /**
   * 扩散激活（方案 §5.2.1）。
   *
   * 第 1 跳：a = seed × edge.weight × 0.55
   * 第 2 跳：a = 上一跳 a × edge.weight × 0.55
   * 多路径叠加：total(v) = 1 - Π(1 - a_i)
   *
   * @param {Array} nodes
   * @param {Array} edges
   * @param {Map<string,number>|object} seeds 节点 id → 种子强度（0..1）
   * @param {{maxHops?:number, factor?:number, threshold?:number, maxActive?:number}} [opts]
   * @returns {Map<string,{a:number, hop:number}>}
   */
  function activate(nodes, edges, seeds, { maxHops = 2, factor = 0.55, threshold = 0.12, maxActive = 80 } = {}) {
    const ids = new Set((nodes || []).map((n) => n.id));
    const adj = buildAdjacency(nodes, edges);
    const act = new Map();

    // 不用 instanceof Map：浏览器/vm 跨 realm 时 Map 构造器不是同一个。
    const isIterableMap = seeds && typeof seeds[Symbol.iterator] === 'function';
    const seedEntries = isIterableMap ? [...seeds] : Object.entries(seeds || {});
    let frontier = [];
    for (const [id, raw] of seedEntries) {
      if (!ids.has(id)) continue;
      const a = Math.min(1, Math.max(0, Number(raw) || 0));
      if (a <= 0) continue;
      act.set(id, { a, hop: 0 });
      frontier.push(id);
    }

    for (let hop = 1; hop <= maxHops; hop += 1) {
      if (!frontier.length) break;
      const next = new Map();
      for (const id of frontier) {
        const cur = act.get(id);
        if (!cur) continue;
        for (const { to, w } of adj.get(id) || []) {
          const a = cur.a * w * factor;
          if (a < threshold) continue;
          next.set(to, 1 - (1 - (next.get(to) || 0)) * (1 - a));
        }
      }
      const newly = [];
      for (const [id, a] of next) {
        const prev = act.get(id);
        const merged = prev ? 1 - (1 - prev.a) * (1 - a) : a;
        if (!prev || merged > prev.a + 1e-9) {
          act.set(id, { a: merged, hop });
          newly.push(id);
        }
      }
      frontier = newly;
    }

    if (act.size <= maxActive) return act;
    return new Map([...act.entries()].sort((x, y) => y[1].a - x[1].a).slice(0, maxActive));
  }

  /* ── 关键词种子（与 memory-hub/retrieval 同一口径） ────────────── */

  const STOP = new Set([
    '的了', '是', '在', '我', '你', '他', '她', '它', '这', '那', '和', '与', '就', '也', '都',
    '不', '有', '没', '个', '一', '上', '下', '里', '到', '说', '要', '会', '能', '把', '被',
    'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are'
  ]);

  function tokenize(text) {
    const s = String(text ?? '').toLowerCase();
    const out = new Set();
    for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
    const han = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
    for (const chunk of han.split(/\s+/)) {
      if (!chunk) continue;
      for (let len = 2; len <= 4; len += 1) {
        for (let i = 0; i + len <= chunk.length; i += 1) out.add(chunk.slice(i, i + len));
      }
    }
    return out;
  }

  function relevanceOf(query, content) {
    const q = tokenize(query);
    if (!q.size) return 0;
    const c = tokenize(content);
    if (!c.size) return 0;
    let hit = 0;
    let total = 0;
    for (const w of q) {
      if (STOP.has(w)) continue;
      total += 1;
      if (c.has(w)) hit += 1;
    }
    return total ? Math.min(1, hit / total) : 0;
  }

  /** 搜索命中做种子（≥0.3 才进，方案 §5.2.1）。 */
  function searchSeeds(nodes, query, { minScore = 0.3 } = {}) {
    const q = String(query || '').trim();
    const seeds = new Map();
    if (!q) return seeds;
    for (const n of nodes || []) {
      const r = relevanceOf(q, `${n.content || ''} ${n.mood || ''}`);
      if (r >= minScore) seeds.set(n.id, r);
    }
    return seeds;
  }

  return { hash01, layout, SPIRAL, buildAdjacency, activate, tokenize, relevanceOf, searchSeeds };
});
