// 日记页星图（5.0 P1/P2，只读）。
//
// 左星图 / 右日记：Canvas 2D、零框架、不引入 Three.js / ECharts。
// 交互：拖动旋转、滚轮缩放、双击复位、悬停、点击定位；
// 搜索命中做种子，沿边亮 1–2 跳（扩散激活）。
//
// 边界（写进 UI 文案，不只在文档里）：
//   · 星图永远不写：不写日记、不写记忆、不改索引；
//   · 图上联想 ≠ 聊天召回：这里只是“照一下”，不改变 Memory Hub 的检索。
(function () {
  const $ = (id) => document.getElementById(id);
  const CORE = window.__starMapCore || {};
  const hash01 = CORE.hash01 || (() => 0.5);
  const SPIRAL = Number(CORE.SPIRAL) || 2.6;
  const LS_RATIO = 'qqagent.diarySplitRatio';
  const LS_COLLAPSE = 'qqagent.diaryCollapsed';

  const state = {
    scope: 'diary',
    graph: null,
    layout: null,
    view: { rot: 0, zoom: 1, panX: 0, panY: 0 },
    selected: null,
    hover: null,
    activation: null,
    activationNote: '',
    filters: { important: false, today: false },
    query: '',
    collapsed: false,
    ratio: 0.55,
    w: 0,
    h: 0,
    ctx: null,
    drag: null,
    loading: false,
    statsOpen: false,
    editing: false,
    selectedTopic: null,
    selectedLink: null,
    linkSeed: null,
    dropTarget: null,
    draft: null,
    dirty: false
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function todayKey() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function api(path) {
    const r = await fetch(path, { cache: 'no-store' });
    return r.json();
  }

  const isDiaryViewActive = () => Boolean($('view-diary')?.classList.contains('active'));

  // ══════════════════════════════════════════════════════════
  // 数据
  // ══════════════════════════════════════════════════════════
  async function loadGraph({ keepView = true } = {}) {
    if (state.loading) return;
    state.loading = true;
    try {
      const g = await api(`/api/star-map/graph?scope=${state.scope}&days=all`);
      if (!g.ok) { showLoadError(g.error || '读取失败'); return; }
      state.graph = g;
      state.nodeById = new Map((g.nodes || []).map((n) => [n.id, n]));
      state.armTopics = new Set((g.nodes || []).filter((n) => n.layer === 'arm').map((n) => n.topic));
      state.customTopics = new Set((g.topics || []).filter((t) => t.custom).map((t) => t.index));
      state.layout = CORE.layout ? CORE.layout(g.nodes, g.topics) : { positions: new Map(), days: [], arms: [] };
      pruneFarLinks();
      if (!keepView) state.view = { rot: 0, zoom: 1, panX: 0, panY: 0 };
      state.selected = null;
      state.selectedTopic = null;
      state.linkSeed = null;
      state.hover = null;
      state.activation = null;
      state.activationNote = '';
      applyQuerySeed();
      updateSummary();
      updateEmpty();
      resize();
    } catch (e) {
      showLoadError(String(e?.message || e));
    } finally {
      state.loading = false;
    }
  }

  function showLoadError(msg) {
    const box = $('star-empty');
    if (box) { box.hidden = false; box.textContent = '星图读取失败：' + msg; }
  }

  function updateEmpty() {
    const box = $('star-empty');
    if (!box) return;
    const n = state.graph?.nodes?.length || 0;
    box.hidden = n > 0;
    if (!n) box.textContent = state.graph?.note || '还没有第一颗星';
  }

  function updateSummary() {
    const el = $('star-summary');
    if (!el) return;
    if (!state.graph) { el.textContent = '…'; return; }
    const c = state.graph.counts || {};
    const layers = { core: 0, arm: 0, general: 0, belt: 0 };
    for (const n of state.graph.nodes || []) if (layers[n.layer] != null) layers[n.layer] += 1;
    const parts = [
      `银心 ${layers.core}`,
      `旋臂 ${layers.arm}`,
      `旋臂间 ${layers.general}`,
      `小行星带 ${layers.belt}`
    ];
    if (c.activity) parts.push(`活动 ${c.activity}`);
    if (state.scope === 'all') parts.push(`记忆 ${(c.learned || 0) + (c.impression || 0)}`);
    el.textContent = parts.join(' · ');
  }

  // ══════════════════════════════════════════════════════════
  // 激活
  // ══════════════════════════════════════════════════════════
  function clearActivation() {
    state.activation = null;
    state.activationNote = '';
    const note = $('star-note');
    if (note) note.textContent = '';
  }

  function applyQuerySeed() {
    if (!state.graph) return;
    const q = state.query.trim();
    if (!q) { clearActivation(); return; }
    const seeds = CORE.searchSeeds(state.graph.nodes, q);
    if (!seeds.size) {
      clearActivation();
      state.activationNote = `没有找到「${q}」`;
      const note = $('star-note');
      if (note) note.textContent = state.activationNote;
      return;
    }
    state.activation = CORE.activate(state.graph.nodes, state.graph.edges, seeds);
    state.activationNote = `「${q}」命中 ${seeds.size} 颗，沿边亮了 ${state.activation.size} 颗`;
    const note = $('star-note');
    if (note) note.textContent = state.activationNote;
  }

  function selectNode(node) {
    state.selected = node || null;
    if (!node) { clearActivation(); draw(); return; }
    state.activation = CORE.activate(state.graph.nodes, state.graph.edges, new Map([[node.id, 1]]));
    const hops = state.activation.size ? Math.max(...[...state.activation.values()].map((x) => x.hop)) : 0;
    state.activationNote = `从「${node.day}${node.mood ? ' · ' + node.mood : ''}」亮了 ${state.activation.size} 颗（${hops} 跳）`;
    const note = $('star-note');
    if (note) note.textContent = state.activationNote;
    draw();
    focusEntry(node);
  }

  function focusEntry(node) {
    if (!node || node.kind !== 'diary' || !Number.isFinite(node.entryIndex)) return;
    const sel = `#diary-body .diary-entry[data-day="${node.day}"][data-entry-index="${node.entryIndex}"]`;
    const el = document.querySelector(sel);
    if (!el) return;
    const details = el.closest('details');
    if (details) details.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('diary-entry-highlight');
    clearTimeout(el._starHighlight);
    el._starHighlight = setTimeout(() => el.classList.remove('diary-entry-highlight'), 1500);
  }

  // ══════════════════════════════════════════════════════════
  // 布局 / 投影
  // ══════════════════════════════════════════════════════════
  function project(p, w = state.w, h = state.h) {
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.46;
    const ang = p.angle + state.view.rot;
    const r = p.radius * R * state.view.zoom;
    return {
      x: cx + Math.cos(ang) * r + state.view.panX,
      y: cy + Math.sin(ang) * r * 0.92 + state.view.panY
    };
  }

  function resize() {
    const wrap = $('star-canvas-wrap');
    const canvas = $('star-map-canvas');
    if (!wrap || !canvas) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, Math.round(rect.width || 0));
    const h = Math.max(240, Math.round(rect.height || 0));
    state.w = w;
    state.h = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    state.ctx = canvas.getContext('2d');
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // ══════════════════════════════════════════════════════════
  // 绘制
  // ══════════════════════════════════════════════════════════
  // 话题色（颜色可重复：超出调色板就循环）
  const TOPIC_COLORS = ['#7fb2ff', '#8fd0a8', '#e6a0c8', '#c9a6ff', '#f0b36b', '#6fd6d0', '#d98f8f', '#a8c86a', '#b0a8ff', '#e0b0ff'];
  function topicColor(topic) {
    if (topic == null || topic < 0) return '#8a93a8';
    return TOPIC_COLORS[topic % TOPIC_COLORS.length];
  }

  function starColor(n) {
    if (n.layer === 'core') return '#fff6d5';      // 银心：黄白
    if (n.layer === 'arm') return '#ffd479';       // 旋臂：黄
    if (n.layer === 'belt') return '#9fb0c8';      // 小行星带：冷灰蓝
    return topicColor(n.topic);                    // 旋臂之间：按话题
  }

  function matchesFilter(n) {
    if (state.filters.important && !(n.kind === 'diary' && n.important)) return false;
    if (state.filters.today && !(n.kind === 'diary' && n.flags?.today)) return false;
    return true;
  }

  function drawStar(ctx, s, n, alpha, radius, selected, hover) {
    const color = starColor(n);
    const a = Math.max(0.05, Math.min(1, alpha));

    if (a > 0.45 || selected) {
      ctx.globalAlpha = a * 0.13;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius * 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = a;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (n.kind === 'diary' && n.important) {
      ctx.globalAlpha = Math.min(1, a + 0.2);
      ctx.strokeStyle = 'rgba(255,212,121,.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius + 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (selected || hover) {
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = 'rgba(255,255,255,.8)';
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius + (selected ? 5 : 3), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawEdges(ctx, act) {
    for (const e of state.graph.edges) {
      if (e.hidden) continue;
      const a1 = act.get(e.from);
      const a2 = act.get(e.to);
      if (!a1 && !a2) continue;
      const p1 = state.layout.positions.get(e.from);
      const p2 = state.layout.positions.get(e.to);
      if (!p1 || !p2) continue;
      const s1 = project(p1);
      const s2 = project(p2);
      const hop = Math.min(a1?.hop ?? 9, a2?.hop ?? 9);
      ctx.globalAlpha = hop === 0 ? 0.55 : hop === 1 ? 0.4 : 0.28;
      const fromNode = state.nodeById?.get(e.from);
      ctx.strokeStyle = fromNode && fromNode.topic >= 0
        ? topicColor(fromNode.topic)
        : 'rgba(255,214,130,.85)';
      ctx.lineWidth = hop === 0 ? 1.2 : 0.9;
      ctx.setLineDash(hop >= 2 ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function renderScene(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.72);
    bg.addColorStop(0, '#181e2e');
    bg.addColorStop(0.55, '#0c111c');
    bg.addColorStop(1, '#07090e');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    if (!state.graph || !state.graph.nodes.length) return;

    const act = state.activation;
    const hasFilter = state.filters.important || state.filters.today;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.46;

    // 银心光晕（黄白，第一亮）——跟随平移
    const gx = cx + state.view.panX;
    const gy = cy + state.view.panY;
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(40, R * 0.22));
    glow.addColorStop(0, 'rgba(255,236,170,.20)');
    glow.addColorStop(0.45, 'rgba(255,210,120,.07)');
    glow.addColorStop(1, 'rgba(255,210,120,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(gx, gy, Math.max(40, R * 0.22), 0, Math.PI * 2);
    ctx.fill();

    // 旋臂线（螺旋；只画真的有「重要」星的臂，以及手动添加的空旋臂）
    for (const arm of state.layout.arms || []) {
      if (state.armTopics && !state.armTopics.has(arm.topic) && !state.customTopics?.has(arm.topic)) continue;
      const active = state.selectedTopic === arm.topic;
      ctx.beginPath();
      let started = false;
      for (let rr = 0.1; rr <= 0.56; rr += 0.01) {
        const ang = arm.angle + SPIRAL * rr + state.view.rot;
        const x = cx + state.view.panX + Math.cos(ang) * rr * R * state.view.zoom;
        const y = cy + state.view.panY + Math.sin(ang) * rr * R * 0.92 * state.view.zoom;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = active ? 'rgba(255,214,130,.38)' : 'rgba(255,214,130,.10)';
      ctx.lineWidth = active ? 1.6 : 1;
      ctx.stroke();

      // 旋臂旁的白点星海：随机散落（不是等距两点），稍亮
      for (let rr = 0.1; rr <= 0.56; rr += 0.01) {
        const i = Math.round(rr * 1000);
        const h = hash01(`sea:${arm.topic}:${i}`);
        const h2 = hash01(`sea2:${arm.topic}:${i}`);
        const ang = arm.angle + SPIRAL * rr + state.view.rot + (h - 0.5) * 0.20;
        const rad = rr + (h2 - 0.5) * 0.02;
        const x = cx + state.view.panX + Math.cos(ang) * rad * R * state.view.zoom;
        const y = cy + state.view.panY + Math.sin(ang) * rad * R * 0.92 * state.view.zoom;
        ctx.globalAlpha = 0.30;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, 0.6 + h2 * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // 星座连线：平时就能看见同话题的星串在一起；激活时换成高亮边。
    if (act && act.size) drawEdges(ctx, act);
    else drawTopicLinks(ctx);

    for (const n of state.graph.nodes) {
      const p = state.layout.positions.get(n.id);
      if (!p) continue;
      const s = project(p, w, h);
      const a = act?.get(n.id);
      let alpha = Number(n.brightness) || 0.5;
      let radius = Number(n.radiusPx) || 2.5;
      if (n.kind === 'activity') alpha *= 0.85;
      if (hasFilter && !matchesFilter(n)) alpha = Math.min(alpha, 0.12);
      if (act && act.size) {
        if (a) {
          alpha = Math.min(1, alpha * (a.hop === 0 ? 1.9 : a.hop === 1 ? 1.6 : 1.3));
          radius *= a.hop === 0 ? 1.6 : 1.15;
        } else {
          alpha = Math.min(alpha, 0.18);
        }
      }
      drawStar(ctx, s, n, alpha, radius, state.selected?.id === n.id, state.hover?.id === n.id);
    }

    if (state.linkSeed) {
      const seedNode = (state.graph.nodes || []).find((x) => x.id === state.linkSeed);
      const sp = seedNode && state.layout.positions.get(seedNode.id);
      if (sp) {
        const s = project(sp);
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#ffd479';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // 编辑模式：正在拖的星 + 落点提示
    if (state.drag?.kind === 'star' && state.drag.moved && state.drag.node) {
      const x = state.drag.mx;
      const y = state.drag.my;
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#ffd479';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,240,200,.95)';
      ctx.font = '12px sans-serif';
      let tag = '拖到旋臂 / 银心 / 话题';
      if (state.dropTarget?.kind === 'core') {
        tag = '放入银心 → 非常重要';
      } else if (state.dropTarget) {
        const t = (state.graph.topics || []).find((x2) => x2.index === state.dropTarget.topic);
        if (t) tag = '归入「' + t.name + '」';
      }
      ctx.fillText(tag, x + 12, y - 10);
      ctx.globalAlpha = 1;
    }
  }

  function handleLinkClick(node) {
    if (!state.editing || !state.draft) return;
    if (!state.linkSeed) { state.linkSeed = node.id; draw(); return; }
    if (state.linkSeed === node.id) { state.linkSeed = null; draw(); return; }
    const from = state.linkSeed;
    const to = node.id;
    state.linkSeed = null;
    const pair = (l) => (l.from === from && l.to === to) || (l.from === to && l.to === from);
    const draftIdx = (state.draft.links || []).findIndex(pair);
    if (draftIdx >= 0) {
      // 本次草稿刚连的：直接从草稿和画面移除
      state.draft.links.splice(draftIdx, 1);
      state.graph.edges = (state.graph.edges || []).filter((e) => !(e.kind === 'manual' && pair(e)));
      state.dirty = true;
      draw();
      return;
    }
    const existing = (state.graph.edges || []).find((e) => e.kind === 'manual' && pair(e));
    if (existing) {
      // 已保存过的连线：记一条待删除
      state.draft.unlinks.push({ from, to });
      state.graph.edges = state.graph.edges.filter((e) => e !== existing);
      state.dirty = true;
      draw();
      return;
    }
    // 两颗都还没有话题：连起来就自动归入同一个新话题（同色）
    const nodeA = (state.graph.nodes || []).find((x) => x.id === from);
    const nodeB = node;
    if (nodeA && nodeB && nodeA.topic < 0 && nodeB.topic < 0) {
      const toks = new Set(String(nodeA.content || '').match(/[\u4e00-\u9fa5]{2,4}/g) || []);
      let name = (String(nodeB.content || '').match(/[\u4e00-\u9fa5]{2,4}/g) || []).find((t) => toks.has(t)) || '关联';
      const base = name;
      let n = 2;
      while ((state.graph.topics || []).some((t) => t.name === name)) name = `${base}${n++}`;
      const idx = Math.max(-1, ...(state.graph.topics || []).map((t) => t.index)) + 1;
      state.graph.topics.push({ index: idx, name, size: 0, heat: 0.4, custom: true, angle: null, tags: [] });
      state.draft.customTopics.push(name);
      for (const nn of [nodeA, nodeB]) {
        nn.topic = idx;
        nn.topicName = name;
        state.draft.nodeTopics[nn.id] = name;
      }
      state.dirty = true;
    }
    state.draft.links.push({ from, to });
    state.graph.edges.push({ from, to, kind: 'manual', weight: 1 });
    state.dirty = true;
    // 刚连的线先保留，不立刻按距离过滤
    rebuildLayout({ prune: false });
    draw();
  }

  function hitLink(mx, my, tol = 8) {
    if (!state.graph) return null;
    let best = null;
    let bestD = tol * tol;
    for (const e of state.graph.edges || []) {
      if (e.kind !== 'manual' || e.hidden) continue;
      const p1 = state.layout.positions.get(e.from);
      const p2 = state.layout.positions.get(e.to);
      if (!p1 || !p2) continue;
      const a = project(p1);
      const b = project(p2);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / len2));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const d = (mx - px) ** 2 + (my - py) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  function drawTopicLinks(ctx) {
    for (const e of state.graph.edges) {
      if (e.kind !== 'topic' && e.kind !== 'manual') continue;
      if (e.hidden) continue;
      const p1 = state.layout.positions.get(e.from);
      const p2 = state.layout.positions.get(e.to);
      if (!p1 || !p2) continue;
      const s1 = project(p1);
      const s2 = project(p2);
      if (e.kind === 'manual') {
        const selected = state.selectedLink
          && ((e.from === state.selectedLink.from && e.to === state.selectedLink.to)
            || (e.from === state.selectedLink.to && e.to === state.selectedLink.from));
        ctx.globalAlpha = selected ? 0.85 : 0.30;
        ctx.strokeStyle = selected ? '#ffd479' : '#e8e2c8';
        ctx.lineWidth = selected ? 2 : 1;
      } else {
        const from = state.nodeById?.get(e.from);
        ctx.globalAlpha = 0.16;
        ctx.strokeStyle = from && from.topic >= 0 ? topicColor(from.topic) : 'rgba(255,214,130,.55)';
        ctx.lineWidth = 0.8;
      }
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (!state.ctx) return;
    renderScene(state.ctx, state.w, state.h);
  }

  // ══════════════════════════════════════════════════════════
  // 命中 / 悬停
  // ══════════════════════════════════════════════════════════
  function hitTest(ev) {
    if (!state.graph) return null;
    const rect = ev.target.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    let best = null;
    let bestD = 14 * 14;
    for (const n of state.graph.nodes) {
      const p = state.layout.positions.get(n.id);
      if (!p) continue;
      const s = project(p);
      const d = (s.x - mx) ** 2 + (s.y - my) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  let tipNodeId = null;
  let tipTimer = 0;

  function showTip(node, mx, my) {
    const tip = $('star-tip');
    const wrap = $('star-canvas-wrap');
    if (!tip || !wrap) return;
    clearTimeout(tipTimer);
    if (tipNodeId !== node.id) {
      tipNodeId = node.id;
      const mood = node.mood ? ' · ' + esc(node.mood) : '';
      const imp = node.importance === '非常重要'
        ? ' · <span style="color:#ffd479">非常重要</span>'
        : (node.important ? ' · <span style="color:#ffd479">重要</span>' : '');
      tip.innerHTML = `<div style="font-weight:600;margin-bottom:2px">${esc(node.day)}${mood}${imp}</div>`
        + `<div style="color:var(--tx2)">${esc((node.content || '').slice(0, 70))}</div>`;
    }
    tip.hidden = false;
    const rect = wrap.getBoundingClientRect();
    let left = mx + 14;
    let top = my + 14;
    if (left + 250 > rect.width) left = Math.max(6, mx - 250);
    if (top + 90 > rect.height) top = Math.max(6, my - 90);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function showTopicTip(topic, mx, my) {
    const tip = $('star-tip');
    const wrap = $('star-canvas-wrap');
    if (!tip || !wrap) return;
    clearTimeout(tipTimer);
    const key = `topic:${topic.name}`;
    if (tipNodeId !== key) {
      tipNodeId = key;
      tip.innerHTML = `<div style="font-weight:600">话题「${esc(topic.name)}」</div>`
        + `<div style="color:var(--tx2)">${topic.size || 0} 颗 · 点旋臂按 E 编辑</div>`;
    }
    tip.hidden = false;
    const rect = wrap.getBoundingClientRect();
    let left = mx + 14;
    let top = my + 14;
    if (left + 250 > rect.width) left = Math.max(6, mx - 250);
    if (top + 70 > rect.height) top = Math.max(6, my - 70);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip() {
    clearTimeout(tipTimer);
    const tip = $('star-tip');
    if (tip) tip.hidden = true;
    tipNodeId = null;
  }

  function scheduleHideTip() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 260);
  }

  // ══════════════════════════════════════════════════════════
  // 交互
  // ══════════════════════════════════════════════════════════
  function armPoint(arm, rr) {
    const cx = state.w / 2 + state.view.panX;
    const cy = state.h / 2 + state.view.panY;
    const R = Math.min(state.w, state.h) * 0.46;
    const ang = arm.angle + SPIRAL * rr + state.view.rot;
    return {
      x: cx + Math.cos(ang) * rr * R * state.view.zoom,
      y: cy + Math.sin(ang) * rr * R * 0.92 * state.view.zoom
    };
  }

  function hitArm(mx, my, tol = 12) {
    if (!state.layout?.arms) return null;
    let best = null;
    let bestD = tol * tol;
    for (const arm of state.layout.arms) {
      for (let rr = 0.1; rr <= 0.56; rr += 0.02) {
        const p = armPoint(arm, rr);
        const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
        if (d < bestD) { bestD = d; best = arm; }
      }
    }
    return best;
  }

  function topicAt(mx, my, tol = 60) {
    if (!state.graph) return null;
    const byTopic = new Map();
    for (const n of state.graph.nodes) {
      if (n.topic == null || n.topic < 0) continue;
      const pos = state.layout.positions.get(n.id);
      if (!pos) continue;
      const s = project(pos);
      const o = byTopic.get(n.topic) || { x: 0, y: 0, c: 0 };
      o.x += s.x; o.y += s.y; o.c += 1;
      byTopic.set(n.topic, o);
    }
    let best = null;
    let bestD = tol * tol;
    for (const [topic, o] of byTopic) {
      const d = (o.x / o.c - mx) ** 2 + (o.y / o.c - my) ** 2;
      if (d < bestD) { bestD = d; best = topic; }
    }
    return best;
  }

  function dropTarget(mx, my) {
    if (!state.graph) return null;
    const cx = state.w / 2 + state.view.panX;
    const cy = state.h / 2 + state.view.panY;
    if (Math.hypot(mx - cx, my - cy) < Math.min(48, state.w * 0.1)) return { kind: 'core' };
    const arm = hitArm(mx, my, 16);
    if (arm) return { kind: 'arm', topic: arm.topic };
    const topic = topicAt(mx, my, 60);
    if (topic != null) return { kind: 'topic', topic };
    return null;
  }

  async function postOverride(body) {
    const r = await fetch('/api/star-map/override', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || j.code || '保存失败');
    return j;
  }

  function pruneFarLinks() {
    if (!state.graph || !state.layout) return;
    const pos = (id) => state.layout.positions.get(id);
    // 只标记 hidden，不删边：已保存的线仍然能被 Ctrl 点同一对取消
    for (const e of state.graph.edges || []) {
      if (e.kind !== 'manual') continue;
      const a = pos(e.from);
      const b = pos(e.to);
      e.hidden = Boolean(a && b
        && Math.hypot(a.radius - b.radius, (a.angle - b.angle) * ((a.radius + b.radius) / 2)) > 1.1);
    }
  }

  function emptyDraft() {
    return { customTopics: [], removedTopics: [], nodeTopics: {}, importances: {}, topicAngles: {}, topicEdits: {}, links: [], unlinks: [], nodePositions: {}, clearPositions: [] };
  }

  function rebuildLayout({ prune = true } = {}) {
    if (!state.graph) return;
    state.layout = CORE.layout(state.graph.nodes, state.graph.topics || []);
    state.armTopics = new Set(state.graph.nodes.filter((n) => n.layer === 'arm').map((n) => n.topic));
    state.customTopics = new Set((state.graph.topics || []).filter((t) => t.custom).map((t) => t.index));
    // 草稿改了话题归属：同话题连线也要马上重算
    const base = (state.graph.edges || []).filter((e) => e.kind !== 'topic');
    const byTopic = new Map();
    for (const n of state.graph.nodes) {
      if (n.topic == null || n.topic < 0) continue;
      if (!byTopic.has(n.topic)) byTopic.set(n.topic, []);
      byTopic.get(n.topic).push(n);
    }
    const topicEdges = [];
    for (const list of byTopic.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      for (let i = 0; i < list.length - 1; i += 1) {
        topicEdges.push({ from: list[i].id, to: list[i + 1].id, kind: 'topic', weight: 0.8 });
        if (i + 2 < list.length) topicEdges.push({ from: list[i].id, to: list[i + 2].id, kind: 'topic', weight: 0.8 });
      }
    }
    state.graph.edges = base.concat(topicEdges);
    if (prune) pruneFarLinks();
  }

  async function saveDraft() {
    const d = state.draft;
    if (!d) return;
    try {
      for (const name of d.customTopics) await postOverride({ action: 'add-topic', name });
      // 改名先做：同步 move-topic 里的旧话题名
      for (const [name, edit] of Object.entries(d.topicEdits || {})) {
        if (edit.newName && edit.newName !== name) {
          for (const k of Object.keys(d.nodeTopics)) if (d.nodeTopics[k] === name) d.nodeTopics[k] = edit.newName;
        }
      }
      for (const [name, edit] of Object.entries(d.topicEdits || {})) {
        if (edit.newName || (edit.tags && edit.tags.length)) {
          await postOverride({ action: 'set-topic', name, newName: edit.newName, tags: edit.tags });
        }
      }
      for (const [nodeId, imp] of Object.entries(d.importances)) {
        await postOverride({ action: 'set-importance', nodeId, importance: imp });
      }
      for (const [nodeId, name] of Object.entries(d.nodeTopics)) {
        await postOverride({ action: 'move-topic', nodeId, topicName: name });
      }
      for (const [name, angle] of Object.entries(d.topicAngles)) {
        await postOverride({ action: 'set-topic-angle', name, angle });
      }
      for (const l of d.links || []) await postOverride({ action: 'add-link', from: l.from, to: l.to });
      for (const l of d.unlinks || []) await postOverride({ action: 'remove-link', from: l.from, to: l.to });
      for (const [nodeId, pos] of Object.entries(d.nodePositions || {})) {
        await postOverride({ action: 'set-node-position', nodeId, angle: pos.angle, radius: pos.radius });
      }
      for (const nodeId of d.clearPositions || []) {
        await postOverride({ action: 'clear-node-position', nodeId });
      }
      for (const name of d.removedTopics) await postOverride({ action: 'remove-topic', name });
      state.draft = emptyDraft();
      state.dirty = false;
      await loadGraph({ keepView: true });
      window.dispatchEvent(new CustomEvent('diary-changed'));
    } catch (e) {
      alert('保存失败：' + (e?.message || e));
    }
  }

  function applyDrop(node, target, dropPos) {
    if (!node || !state.draft) { state.dropTarget = null; draw(); return; }
    // 拖到空白：只改坐标（自由摆放），不动重要性和话题
    if (!target && dropPos) {
      const cx = state.w / 2 + state.view.panX;
      const cy = state.h / 2 + state.view.panY;
      const R = Math.min(state.w, state.h) * 0.46;
      const dx = dropPos.mx - cx;
      const dy = (dropPos.my - cy) / 0.92;
      const radius = Math.max(0.03, Math.min(1.05, Math.hypot(dx, dy) / (R * state.view.zoom)));
      const angle = Math.atan2(dy, dx) - state.view.rot;
      node.posAngle = angle;
      node.posRadius = radius;
      state.draft.nodePositions[node.id] = { angle, radius };
      state.dirty = true;
      rebuildLayout();
      draw();
      return;
    }
    if (!target) { state.dropTarget = null; draw(); return; }
    // 拖到旋臂/银心/话题：回到自动布局，并改属性
    if (node.posAngle != null) {
      delete node.posAngle;
      delete node.posRadius;
      if (!state.draft.clearPositions.includes(node.id)) state.draft.clearPositions.push(node.id);
    }
    const topic = target.topic != null
      ? (state.graph.topics || []).find((t) => t.index === target.topic)
      : null;
    if (target.kind === 'core') {
      if (node.kind !== 'diary') { alert('只有日记条目能改重要级'); return; }
      node.importance = '非常重要';
      state.draft.importances[node.id] = '非常重要';
      if (node.layer !== 'belt') {
        node.layer = 'core';
        node.topic = -1;
        node.topicName = '其他';
        node.brightness = 1;
        node.radiusPx = 4.6;
      }
    } else if (target.kind === 'arm') {
      if (node.kind === 'diary' && node.layer !== 'belt') {
        node.importance = '重要';
        node.layer = 'arm';
        node.brightness = 0.85;
        node.radiusPx = 3.6;
        state.draft.importances[node.id] = '重要';
      }
      if (topic) {
        node.topic = topic.index;
        node.topicName = topic.name;
        state.draft.nodeTopics[node.id] = topic.name;
      }
    } else if (target.kind === 'topic' && topic) {
      node.topic = topic.index;
      node.topicName = topic.name;
      state.draft.nodeTopics[node.id] = topic.name;
    }
    state.selected = node;
    state.dirty = true;
    rebuildLayout();
    draw();
  }

  function bindCanvas() {
    const canvas = $('star-map-canvas');
    if (!canvas) return;

    canvas.addEventListener('pointerdown', (e) => {
      hideTip();
      const node = hitTest(e);
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // 编辑模式：拖旋臂线（以银心为轴转），不动整体视图
      if (state.editing && !node) {
        const arm = hitArm(mx, my, 14);
        if (arm) {
          // 拖臂时让该话题的普通星一起动（临时忽略它们的自由位置，松手再决定去留）
          const affected = (state.graph.nodes || []).filter((n) => n.topic === arm.topic && n.posAngle != null);
          for (const n of affected) {
            n._posBackup = { angle: n.posAngle, radius: n.posRadius };
          }
          state.drag = {
            kind: 'arm',
            topic: arm.topic,
            affectedPos: affected.map((n) => n.id),
            beforeAngle: arm.angle,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            mx,
            my
          };
          try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          return;
        }
      }
      state.drag = {
        // 编辑模式空白拖动 = 平移视角；只读模式空白拖动 = 绕银心旋转
        kind: node && state.editing ? 'star' : (state.editing ? 'pan' : 'rotate'),
        node: node || null,
        ctrl: e.ctrlKey || e.metaKey,
        startX: e.clientX,
        startY: e.clientY,
        rot: state.view.rot,
        panX: state.view.panX,
        panY: state.view.panY,
        moved: false,
        mx,
        my
      };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (state.drag) {
        const dx = e.clientX - state.drag.startX;
        const dy = e.clientY - state.drag.startY;
        if (Math.hypot(dx, dy) > 4) state.drag.moved = true;
        state.drag.mx = mx;
        state.drag.my = my;
        if (state.drag.kind === 'arm') {
          // 还没明显拖动就只是点选，不转臂
          if (Math.hypot(dx, dy) < 8) return;
          const ang = Math.atan2(my - state.h / 2, mx - state.w / 2);
          const delta = ang - (state.drag.beforeAngle ?? ang);
          // 自由摆放过的星跟着臂旋转，保持和臂的相对位置
          const affected = (state.graph.nodes || []).filter((n) => (state.drag.affectedPos || []).includes(n.id));
          for (const n of affected) {
            const b = n._posBackup;
            if (!b) continue;
            n.posAngle = b.angle + delta;
            n.posRadius = b.radius;
          }
          state.drag.angle = ang;
          const topics = (state.graph.topics || []).map((t) => (t.index === state.drag.topic ? { ...t, angle: ang } : t));
          state.layout = CORE.layout(state.graph.nodes, topics);
          draw();
          return;
        }
        if (state.drag.kind === 'star') {
          if (state.drag.moved) {
            let dt = dropTarget(mx, my);
            const dn = state.drag.node;
            // 落点话题和星本身同话题就当作无目标：方便自由挪位置
            if (dt && dn) {
              if (dt.kind === 'core' && dn.importance === '非常重要') dt = null;
              else if (dt.topic != null && dt.topic === dn.topic) dt = null;
            }
            state.dropTarget = dt;
            draw();
          }
          return;
        }
        if (state.drag.kind === 'pan') {
          state.view.panX = state.drag.panX + dx;
          state.view.panY = state.drag.panY + dy;
          draw();
          return;
        }
        if (Math.abs(dx) > 3) {
          state.drag.moved = true;
          state.view.rot = state.drag.rot + dx * 0.006;
          draw();
        }
        return;
      }
      const node = hitTest(e);
      if (node !== state.hover) {
        state.hover = node;
        draw();
      }
      // 移动中不弹提示：停下 220ms 后才显示
      clearTimeout(tipTimer);
      hideTip();
      let tipTarget = null;
      if (node) {
        tipTarget = { kind: 'node', node };
      } else {
        const arm = hitArm(mx, my, 12);
        const topicIdx = arm ? arm.topic : topicAt(mx, my, 46);
        if (topicIdx != null) {
          const t = (state.graph.topics || []).find((x) => x.index === topicIdx);
          if (t) tipTarget = { kind: 'topic', topic: t };
          else if (topicIdx === -2) {
            const cnt = (state.graph.nodes || []).filter((n) => n.topic === -2).length;
            tipTarget = { kind: 'topic', topic: { name: '其他', size: cnt } };
          }
        }
      }
      if (tipTarget) {
        tipTimer = setTimeout(() => {
          if (state.drag) return;
          if (tipTarget.kind === 'node') {
            if (state.hover && state.hover.id === tipTarget.node.id) showTip(tipTarget.node, mx, my);
          } else {
            showTopicTip(tipTarget.topic, mx, my);
          }
        }, 220);
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      const d = state.drag;
      state.drag = null;
      // Ctrl 点星优先当连线，不要求“没移动”（手抖超过 4px 也照样连）
      if (d && d.ctrl) {
        const cn = hitTest(e);
        if (cn) { handleLinkClick(cn); return; }
      }
      if (d && d.kind === 'arm') {
        const far = Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 8;
        const affected = (state.graph.nodes || []).filter((n) => (d.affectedPos || []).includes(n.id));
        if (far) {
          const t = (state.graph.topics || []).find((x) => x.index === d.topic);
          if (t && state.draft) {
            const delta = d.angle - d.beforeAngle;
            t.angle = d.angle;
            state.draft.topicAngles[t.name] = d.angle;
            // 自由摆放过的星：旋转同样的角度，和旋臂的相对位置不变
            for (const n of affected) {
              const b = n._posBackup;
              if (!b) continue;
              const angle = b.angle + delta;
              n.posAngle = angle;
              n.posRadius = b.radius;
              state.draft.nodePositions[n.id] = { angle, radius: b.radius };
              delete n._posBackup;
            }
            state.dirty = true;
            rebuildLayout();
            draw();
          }
          return;
        }
        // 没明显拖动 = 点选旋臂；恢复被临时清掉的自由位置
        for (const n of affected) {
          if (n._posBackup) {
            n.posAngle = n._posBackup.angle;
            n.posRadius = n._posBackup.radius;
            delete n._posBackup;
          }
        }
        state.selectedTopic = d.topic;
        state.selected = null;
        state.selectedLink = null;
        clearActivation();
        rebuildLayout();
        draw();
        return;
      }
      if (d && d.kind === 'star' && d.moved) {
        const target = state.dropTarget;
        state.dropTarget = null;
        applyDrop(d.node, target, { mx: d.mx, my: d.my });
        return;
      }
      if (d && d.moved) return;
      const node = hitTest(e);
      if (node) {
        selectNode(node);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mxx = e.clientX - rect.left;
      const myy = e.clientY - rect.top;
      const link = hitLink(mxx, myy, 8);
      if (link) {
        state.selectedLink = link;
        state.selected = null;
        state.selectedTopic = null;
        clearActivation();
        draw();
        return;
      }
      const arm = hitArm(mxx, myy, 12);
      if (arm) {
        state.selectedLink = null;
        state.selectedTopic = arm.topic;
        state.selected = null;
        clearActivation();
        draw();
        return;
      }
      state.selected = null;
      state.selectedTopic = null;
      state.selectedLink = null;
      clearActivation();
      hideTip();
      draw();
    });

    canvas.addEventListener('pointerleave', () => {
      if (state.drag) return;
      state.hover = null;
      hideTip();
      draw();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.1 : 0.9;
      state.view.zoom = clamp(state.view.zoom * f, 0.35, 3);
      draw();
    }, { passive: false });

    canvas.addEventListener('dblclick', () => {
      state.view = { rot: 0, zoom: 1, panX: 0, panY: 0 };
      draw();
    });
  }

  function bindToolbar() {
    const search = $('star-search');
    if (search) {
      let timer = 0;
      search.addEventListener('input', () => {
        state.query = search.value;
        clearTimeout(timer);
        timer = setTimeout(() => { applyQuerySeed(); draw(); }, 120);
      });
    }

    const imp = $('star-filter-important');
    if (imp) imp.addEventListener('click', () => {
      state.filters.important = !state.filters.important;
      imp.classList.toggle('active', state.filters.important);
      imp.style.color = state.filters.important ? 'var(--ac)' : '';
      updateSummary();
      draw();
    });

    const today = $('star-filter-today');
    if (today) today.addEventListener('click', () => {
      state.filters.today = !state.filters.today;
      today.classList.toggle('active', state.filters.today);
      today.style.color = state.filters.today ? 'var(--ac)' : '';
      updateSummary();
      draw();
    });

    document.querySelectorAll('#diary-scope .scope-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const scope = b.dataset.scope === 'all' ? 'all' : 'diary';
        if (scope === state.scope) return;
        state.scope = scope;
        document.querySelectorAll('#diary-scope .scope-btn').forEach((x) => x.classList.toggle('active', x === b));
        loadGraph();
      });
    });

    const exportBtn = $('star-export');
    if (exportBtn) exportBtn.addEventListener('click', exportPng);

    const statsBtn = $('star-stats-btn');
    if (statsBtn) statsBtn.addEventListener('click', toggleStats);

    const editBtn = $('star-edit-toggle');
    if (editBtn) editBtn.addEventListener('click', () => setEditing(!state.editing));

    const addTopicBtn = $('star-add-topic');
    if (addTopicBtn) addTopicBtn.addEventListener('click', async () => {
      if (!state.editing) setEditing(true);
      const name = await uiPrompt('新旋臂的名字（最多 20 字）', '');
      const clean = String(name || '').trim().slice(0, 20);
      if (!clean) return;
      try {
        const idx = Math.max(-1, ...(state.graph.topics || []).map((t) => t.index)) + 1;
        state.graph.topics.push({ index: idx, name: clean, size: 0, heat: 0.4, custom: true, angle: null });
        state.draft.customTopics.push(clean);
        state.dirty = true;
        rebuildLayout();
        draw();
      } catch (err) {
        alert('添加失败：' + (err?.message || err));
      }
    });

    const saveBtn = $('star-save');
    if (saveBtn) saveBtn.addEventListener('click', saveDraft);

    document.addEventListener('keydown', (e) => {
      if ((e.key === 'e' || e.key === 'E') && state.editing) {
        if (state.selectedTopic != null) { e.preventDefault(); editTopic(); return; }
        if (state.selected && state.selected.topic >= 0) {
          e.preventDefault();
          state.selectedTopic = state.selected.topic;
          editTopic();
          return;
        }
      }
      if (state.editing && state.selected && (e.key === '1' || e.key === '2' || e.key === '3')) {
        e.preventDefault();
        setImportance(state.selected, e.key === '1' ? '一般' : e.key === '2' ? '重要' : '非常重要');
        return;
      }
      if (e.key === 'Delete' && state.editing && state.selectedLink) {
        const l = state.selectedLink;
        state.selectedLink = null;
        const dIdx = (state.draft.links || []).findIndex((x) => (x.from === l.from && x.to === l.to) || (x.from === l.to && x.to === l.from));
        if (dIdx >= 0) state.draft.links.splice(dIdx, 1);
        else state.draft.unlinks.push({ from: l.from, to: l.to });
        state.graph.edges = (state.graph.edges || []).filter((x) => x !== l);
        state.dirty = true;
        draw();
        return;
      }
      if (e.key === 'Delete' && state.editing && state.selectedTopic != null) {
        const t = (state.graph?.topics || []).find((x) => x.index === state.selectedTopic);
        if (!t) return;
        (async () => {
          if (!(await uiConfirm(`删除旋臂「${t.name}」？\n\n成员会回到「其他」，日记本身不会删。`))) return;
          state.graph.topics = (state.graph.topics || []).filter((x) => x.index !== t.index);
          for (const n of state.graph.nodes) {
            if (n.topic === t.index) { n.topic = -2; n.topicName = '其他'; }
          }
          const ci = state.draft.customTopics.indexOf(t.name);
          if (ci >= 0) state.draft.customTopics.splice(ci, 1);
          else state.draft.removedTopics.push(t.name);
          delete state.draft.topicAngles[t.name];
          delete state.draft.topicEdits[t.name];
          state.selectedTopic = null;
          state.dirty = true;
          rebuildLayout();
          draw();
        })();
        return;
      }
      if (e.key !== 'Escape') return;
      state.selected = null;
      state.selectedTopic = null;
      state.hover = null;
      state.query = '';
      if (search) search.value = '';
      clearActivation();
      hideTip();
      draw();
    });
  }

  function setImportance(node, importance) {
    if (!state.editing || !state.draft || !node || node.kind !== 'diary') return;
    if (node.layer === 'belt') {
      node.importance = importance;
      state.draft.importances[node.id] = importance;
      state.dirty = true;
      draw();
      return;
    }
    node.importance = importance;
    state.draft.importances[node.id] = importance;
    if (importance === '非常重要') {
      node.layer = 'core';
      node.topic = -1;
      node.topicName = '其他';
      node.brightness = 1;
      node.radiusPx = 4.6;
    } else if (importance === '重要') {
      node.layer = 'arm';
      node.brightness = 0.85;
      node.radiusPx = 3.6;
    } else {
      node.layer = 'general';
      node.brightness = 0.62;
      node.radiusPx = 2.6;
      if (node.topic == null || node.topic < 0) { node.topic = -2; node.topicName = '其他'; }
    }
    if (node.posAngle != null) {
      delete node.posAngle;
      delete node.posRadius;
      if (!state.draft.clearPositions.includes(node.id)) state.draft.clearPositions.push(node.id);
    }
    state.dirty = true;
    rebuildLayout();
    draw();
  }

  async function editTopic() {
    const t = (state.graph?.topics || []).find((x) => x.index === state.selectedTopic);
    if (!t || !state.editing) return;
    const name = await uiPrompt(`话题「${t.name}」改名（留空不改）`, '');
    if (name === null) return;
    const tagsStr = await uiPrompt('标签（逗号分隔，可多个）', (t.tags || []).join(','));
    if (tagsStr === null) return;
    const newName = String(name).trim().slice(0, 20);
    const tags = String(tagsStr).split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
    const oldName = t.name;
    state.draft.topicEdits[oldName] = { newName: newName || '', tags };
    if (newName && newName !== oldName) {
      for (const n of state.graph.nodes) {
        if (n.topic !== t.index) continue;
        n.topicName = newName;
        // 成员一起迁到新话题名，否则保存后旧话题被隐藏、星星还挂在旧索引上
        state.draft.nodeTopics[n.id] = newName;
      }
      t.name = newName;
    }
    t.tags = tags;
    state.dirty = true;
    rebuildLayout();
    draw();
  }

  async function setEditing(on) {
    if (!on && state.dirty) {
      const ok = await uiConfirm('有未保存的星图修改，放弃吗？');
      if (!ok) return;
      state.draft = emptyDraft();
      state.dirty = false;
      await loadGraph({ keepView: true });
    }
    state.editing = Boolean(on);
    // 退出编辑：视角自动回正（旋转/缩放/平移复位）
    if (!on) state.view = { rot: 0, zoom: 1, panX: 0, panY: 0 };
    if (state.editing && !state.draft) state.draft = emptyDraft();
    const btn = $('star-edit-toggle');
    if (btn) {
      btn.classList.toggle('active', state.editing);
      btn.textContent = state.editing ? '退出编辑' : '编辑';
      btn.style.color = state.editing ? 'var(--ac)' : '';
    }
    const saveBtn = $('star-save');
    if (saveBtn) saveBtn.style.display = state.editing ? '' : 'none';
    const note = $('star-note');
    if (note && state.editing) {
      note.textContent = '编辑模式：拖星改归属/位置；选中星 1/2/3 改一般/重要/非常重要；点旋臂 E 编辑话题、Delete 删除；Ctrl 连星；改完点「保存」';
    } else if (note && !state.activationNote) {
      note.textContent = '';
    }
    draw();
  }

  // ══════════════════════════════════════════════════════════
  // 导出
  // ══════════════════════════════════════════════════════════
  function exportPng() {
    if (!state.graph || !state.graph.nodes.length) return;
    if (!confirm('这张图里会有日记原文摘要，确定导出吗？')) return;
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    c.width = Math.round(state.w * dpr);
    c.height = Math.round(state.h * dpr);
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    renderScene(ctx, state.w, state.h);
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.font = '12px sans-serif';
    const cts = state.graph.counts || {};
    ctx.fillText(`小鲸鱼的星空 · ${todayKey()} · ${cts.diaryEntries ?? 0} 条 · ${String(state.graph.fingerprint || '').slice(0, 8)}`, 14, state.h - 14);
    const a = document.createElement('a');
    a.download = `star-map-${todayKey()}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
  }

  // ══════════════════════════════════════════════════════════
  // 体检
  // ══════════════════════════════════════════════════════════
  async function toggleStats() {
    const box = $('star-stats');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; state.statsOpen = false; return; }
    try {
      const s = await api('/api/star-map/stats');
      if (!s.ok) { box.textContent = '体检失败：' + (s.error || s.code || ''); box.hidden = false; return; }
      const moods = (s.moodFrequency || []).map((x) => `${esc(x.mood)}×${x.count}`).join('、') || '—';
      const gap = s.gaps?.maxGap ? `${s.gaps.maxGap} 天（${esc(s.gaps.from)} → ${esc(s.gaps.to)}）` : '没有断档';
      const empty = (s.emptyDays || []).length;
      box.innerHTML = `<h4>日记体检</h4>
        <div>天数 ${s.days} · 条目 ${s.entries} · 平均 ${s.avgEntries} 条/天</div>
        <div>最长断档：${gap}</div>
        <div>空白天：${empty}${empty ? `（${esc(s.emptyDays.slice(-3).join('、'))}）` : ''}</div>
        <div>重要占比：${Math.round((s.importantRatio || 0) * 100)}%</div>
        <div>心情词频：${moods}</div>`;
      box.hidden = false;
      state.statsOpen = true;
    } catch (e) {
      box.textContent = '体检失败：' + String(e?.message || e);
      box.hidden = false;
    }
  }

  // ══════════════════════════════════════════════════════════
  // 左右分栏：拖动 / 收起
  // ══════════════════════════════════════════════════════════
  function applySplit() {
    const pane = $('diary-map-pane');
    const list = $('diary-list-pane');
    const btn = $('diary-collapse');
    if (!pane || !list) return;
    if (state.collapsed) {
      list.classList.add('collapsed');
      if (btn) btn.textContent = '‹';
      return;
    }
    list.classList.remove('collapsed');
    if (btn) btn.textContent = '›';
    pane.style.flexBasis = `${state.ratio * 100}%`;
    list.style.flexBasis = `${(1 - state.ratio) * 100}%`;
  }

  function bindSplit() {
    try {
      const r = Number(localStorage.getItem(LS_RATIO));
      if (r >= 0.3 && r <= 0.75) state.ratio = r;
      state.collapsed = localStorage.getItem(LS_COLLAPSE) === '1';
    } catch { /* ignore */ }
    applySplit();

    const resizer = $('diary-resizer');
    if (resizer) {
      resizer.addEventListener('pointerdown', (e) => {
        const split = $('diary-split');
        if (!split) return;
        const rect = split.getBoundingClientRect();
        const move = (ev) => {
          state.ratio = clamp((ev.clientX - rect.left) / rect.width, 0.3, 0.75);
          applySplit();
          resize();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          try { localStorage.setItem(LS_RATIO, String(state.ratio)); } catch { /* ignore */ }
          resize();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        e.preventDefault();
      });
      resizer.addEventListener('dblclick', () => {
        state.ratio = 0.55;
        applySplit();
        try { localStorage.setItem(LS_RATIO, '0.55'); } catch { /* ignore */ }
        resize();
      });
    }

    const btn = $('diary-collapse');
    if (btn) btn.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      try { localStorage.setItem(LS_COLLAPSE, state.collapsed ? '1' : '0'); } catch { /* ignore */ }
      applySplit();
      setTimeout(resize, 30);
    });
  }

  // ══════════════════════════════════════════════════════════
  // 生命周期
  // ══════════════════════════════════════════════════════════
  function init() {
    if (!$('star-map-canvas')) return;
    bindCanvas();
    bindToolbar();
    bindSplit();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (!isDiaryViewActive()) return;
        resize();
      });
      ro.observe($('star-canvas-wrap'));
    }

    // 切到日记 tab 时重新拉图：外部改过日记文件也能看到（服务端按指纹缓存，未变很快）
    document.addEventListener('click', (e) => {
      const tab = e.target?.closest?.('.tab');
      if (tab?.dataset?.tab === 'diary') {
        setTimeout(() => {
          resize();
          loadGraph({ keepView: true });
        }, 60);
      }
    });

    // 右栏保存/删除后刷新星图（服务端按指纹缓存，不会重复读盘）
    window.addEventListener('diary-changed', () => {
      setTimeout(() => loadGraph({ keepView: true }), 150);
    });

    // 右栏悬停 → 星图临时高亮
    document.addEventListener('mouseover', (e) => {
      const el = e.target?.closest?.('.diary-entry');
      if (!el || !state.graph) return;
      const day = el.dataset.day;
      const idx = Number(el.dataset.entryIndex);
      const node = state.graph.nodes.find((n) => n.kind === 'diary' && n.day === day && n.entryIndex === idx);
      if (!node || state.hover?.id === node.id) return;
      state.hover = node;
      draw();
    });
    document.addEventListener('mouseout', (e) => {
      if (e.target?.closest?.('.diary-entry')) {
        state.hover = null;
        draw();
      }
    });

    window.addEventListener('resize', () => { if (isDiaryViewActive()) resize(); });
    startAutoRotate();
  }

  // 缓慢自转：约 1 圈 / 5 分钟；拖动时暂停，松手继续。
  let autoRaf = null;
  function startAutoRotate() {
    if (autoRaf || typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
      autoRaf = requestAnimationFrame(tick);
      if (document.hidden || !isDiaryViewActive()) return;
      // 编辑模式不自动转，避免拖着星/臂时画面还在跑
      if (state.editing || !state.graph || state.drag) return;
      state.view.rot += 0.00035;
      draw();
    };
    autoRaf = requestAnimationFrame(tick);
  }

  window.__starMap = { loadGraph, state, applyDrop };
  init();
})();
