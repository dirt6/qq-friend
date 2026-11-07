// 星图数据入口（5.0 星图 P0 · 只读）。
//
// 读路径：
//   /api/star-map/graph  → 本文件 buildGraphCached() → projection.js
//   /api/star-map/node   → getNode()
//   /api/star-map/stats  → stats()
//
// 三条纪律：
//   · 只读：不写日记、不写记忆、不改 Memory Hub；
//   · 日记解析只走 diary/parse.js（与 /api/diary 同一份）；
//   · 缓存按「文件指纹」失效，不做定时刷新。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig, DATA_DIR } from '../config.js';
import { readDiaryFiles, parseDiaryText } from '../diary/parse.js';
import { buildGraph, sha8, localDateKey } from './projection.js';
import { search } from '../memory-hub/index.js';

const CACHE = new Map();
const CACHE_MAX = 6;

/** 展示层编辑覆盖：话题归属 / 自定义旋臂 / 被删旋臂。不改 Memory Hub 的记忆内容。 */
const OVERRIDES_FILE = path.join(DATA_DIR, 'star-map-overrides.json');

export function readOverrides() {
  try {
    const j = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    return {
      version: 1,
      customTopics: Array.isArray(j.customTopics) ? j.customTopics : [],
      nodeTopics: j.nodeTopics && typeof j.nodeTopics === 'object' ? j.nodeTopics : {},
      removedTopics: Array.isArray(j.removedTopics) ? j.removedTopics : [],
      topicAngles: j.topicAngles && typeof j.topicAngles === 'object' ? j.topicAngles : {},
      topicTags: j.topicTags && typeof j.topicTags === 'object' ? j.topicTags : {},
      links: Array.isArray(j.links) ? j.links : [],
      nodePositions: j.nodePositions && typeof j.nodePositions === 'object' ? j.nodePositions : {}
    };
  } catch {
    return { version: 1, customTopics: [], nodeTopics: {}, removedTopics: [], topicAngles: {}, topicTags: {}, links: [], nodePositions: {} };
  }
}

export function writeOverrides(next = {}) {
  const data = {
    version: 1,
    customTopics: Array.isArray(next.customTopics) ? next.customTopics : [],
    nodeTopics: next.nodeTopics && typeof next.nodeTopics === 'object' ? next.nodeTopics : {},
    removedTopics: Array.isArray(next.removedTopics) ? next.removedTopics : [],
    topicAngles: next.topicAngles && typeof next.topicAngles === 'object' ? next.topicAngles : {},
    topicTags: next.topicTags && typeof next.topicTags === 'object' ? next.topicTags : {},
    links: Array.isArray(next.links) ? next.links : [],
    nodePositions: next.nodePositions && typeof next.nodePositions === 'object' ? next.nodePositions : {}
  };
  fs.mkdirSync(path.dirname(OVERRIDES_FILE), { recursive: true });
  const tmp = `${OVERRIDES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, OVERRIDES_FILE);
  return data;
}

/** 日记根目录（与 skills/diary、diary/writer 同一份配置）。 */
export function diaryRoot() {
  try {
    const c = getConfig();
    const r = c?.skills?.diary?.root || c?.skills?.diary?.settings?.root;
    if (r) return String(r);
  } catch { /* 配置未就绪 */ }
  return 'E:\\dsh\\本子\\日记';
}

export function diaryDir() {
  return path.join(diaryRoot(), '每日');
}

/**
 * 自主活动（autonomous / round）→ 星图节点。
 * 只取有内容的轮次；goal/why/标题拼成话题文本。
 */
export function readActivities() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'autonomous.json'), 'utf8'));
    const history = Array.isArray(j.history) ? j.history : [];
    const out = [];
    for (let i = 0; i < history.length; i += 1) {
      const r = history[i] || {};
      const text = [
        r.goal,
        r.why,
        ...(Array.isArray(r.candidateTitles) ? r.candidateTitles.slice(0, 2) : []),
        r.picked
      ].filter(Boolean).join(' ').trim();
      if (!text) continue;
      const ts = Number(r.endedAt || r.startedAt) || 0;
      out.push({
        id: String(r.roundId || `round-${r.startedAt || i}`),
        action: String(r.action || 'round'),
        text: text.slice(0, 300),
        timestamp: ts,
        day: ts ? localDateKey(ts) : ''
      });
    }
    return out;
  } catch {
    return [];
  }
}

function walkFiles(dir, out = []) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of names) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (ent.isFile() && full.endsWith('.json')) out.push(full);
  }
  return out;
}

/** 指纹：内容变了才重算 graph（不含时间，避免每次刷新都重算）。 */
function fingerprint(dir, scope) {
  const parts = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(dir, f));
        parts.push(`${f}:${st.size}:${st.mtimeMs}`);
      } catch { parts.push(`${f}:stat-failed`); }
    }
    if (!files.length) parts.push('empty-diary-dir');
  } catch {
    parts.push('no-diary-dir');
  }
  if (scope === 'all') {
    for (const rel of ['learned.json', 'companion-state.json']) {
      try {
        const st = fs.statSync(path.join(DATA_DIR, rel));
        parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
      } catch { parts.push(`${rel}:absent`); }
    }
    const memDir = path.join(DATA_DIR, 'memory');
    for (const f of walkFiles(memDir).sort()) {
      try {
        const st = fs.statSync(f);
        parts.push(`memory:${path.basename(f)}:${st.size}:${st.mtimeMs}`);
      } catch { /* ignore */ }
    }
  }
  // 自主活动两种 scope 都会画（旋臂之间的星），所以指纹始终包含它。
  try {
    const st = fs.statSync(path.join(DATA_DIR, 'autonomous.json'));
    parts.push(`autonomous:${st.size}:${st.mtimeMs}`);
  } catch { parts.push('autonomous:absent'); }
  // 手工编辑覆盖（话题归属 / 自定义旋臂）变了也要重算
  try {
    const st = fs.statSync(OVERRIDES_FILE);
    parts.push(`overrides:${st.size}:${st.mtimeMs}`);
  } catch { parts.push('overrides:absent'); }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

/**
 * 构建（或取缓存的）星图。
 *
 * @param {{scope?:'diary'|'all'}} [o]
 */
export function buildGraphCached({ scope = 'diary' } = {}) {
  const sc = scope === 'all' ? 'all' : 'diary';
  const dir = diaryDir();
  const fp = fingerprint(dir, sc);
  const key = `${sc}:${dir}`;
  const hit = CACHE.get(key);
  if (hit && hit.fingerprint === fp) return hit.graph;

  const rd = readDiaryFiles({ dir });
  let memoryItems = [];
  if (sc === 'all') {
    const r = search({ layers: ['learned', 'impression', 'activity', 'goal', 'pending'], limit: 0 });
    memoryItems = Array.isArray(r.items) ? r.items : [];
  }
  const activities = readActivities();
  const overrides = readOverrides();

  const graph = buildGraph({ days: rd.days || [], activities, scope: sc, memoryItems, overrides, now: Date.now() });
  graph.fingerprint = fp;
  graph.root = diaryRoot();
  if (!rd.ok) graph.note = rd.error;

  CACHE.set(key, { fingerprint: fp, graph });
  while (CACHE.size > CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    CACHE.delete(oldest);
  }
  return graph;
}

const NODE_ID_RE = /^diary:(\d{4}-\d{2}-\d{2}):([0-9a-f]{8})(?:-(\d+))?$/;

/**
 * 单个节点详情（只支持日记节点；其他层请走各自管理页）。
 *
 * @param {string} id `diary:2026-11-04:ab12cd34`
 */
export function getNode(id) {
  const m = NODE_ID_RE.exec(String(id || ''));
  if (!m) return { ok: false, error: '不是日记节点' };
  const [, day, , dupStr] = m;
  const wantDup = dupStr ? Number(dupStr) : 1;
  const file = path.join(diaryDir(), `${day}.md`);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    return { ok: false, error: '这一天没有日记' };
  }
  const parsed = parseDiaryText(text, day);
  const seen = new Map();
  for (let i = 0; i < parsed.entries.length; i += 1) {
    const e = parsed.entries[i];
    const base = `diary:${day}:${sha8(e.text)}`;
    const dup = (seen.get(base) || 0) + 1;
    seen.set(base, dup);
    const nid = dup === 1 ? base : `${base}-${dup}`;
    if (nid !== id || dup !== wantDup) continue;
    return {
      ok: true,
      node: {
        id: nid,
        kind: 'diary',
        day,
        entryIndex: i,
        content: e.text.slice(0, 120),
        mood: e.mood,
        important: e.important,
        importance: e.importance
      },
      detail: { fullText: e.text, mood: e.mood, important: e.important, day, index: i }
    };
  }
  return { ok: false, error: '这条日记已经不在了' };
}

const DAY_MS = 86400000;

/**
 * 体检（日记版）：断档 / 空白天 / 条数 / 重要占比 / 心情词频。
 * 只报告，不自动修。
 */
export function stats() {
  const dir = diaryDir();
  const rd = readDiaryFiles({ dir });
  const days = rd.days || [];
  const entries = days.reduce((n, d) => n + (d.entries || []).length, 0);
  const important = days.reduce((n, d) => n + (d.entries || []).filter((e) => e.important).length, 0);
  const emptyDays = days.filter((d) => !(d.entries || []).length).map((d) => d.day);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const todayEntries = days.find((d) => d.day === todayKey)?.entries?.length || 0;

  let maxGap = 0;
  let maxGapFrom = '';
  let maxGapTo = '';
  // 断档只按“有内容的日记天”算：有文件但 0 条属于「空白天」，单独报告。
  const written = days.filter((d) => (d.entries || []).length > 0);
  for (let i = 1; i < written.length; i += 1) {
    const prev = Date.parse(`${written[i - 1].day}T00:00:00`);
    const cur = Date.parse(`${written[i].day}T00:00:00`);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    const gap = Math.max(0, Math.round((cur - prev) / DAY_MS) - 1);
    if (gap > maxGap) {
      maxGap = gap;
      maxGapFrom = written[i - 1].day;
      maxGapTo = written[i].day;
    }
  }

  const moodFreq = new Map();
  for (const d of days) {
    for (const e of d.entries || []) {
      const m = String(e.mood || '').trim();
      if (!m) continue;
      moodFreq.set(m, (moodFreq.get(m) || 0) + 1);
    }
  }
  const moodFrequency = [...moodFreq.entries()]
    .map(([mood, count]) => ({ mood, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    ok: true,
    days: days.length,
    entries,
    firstDay: days[0]?.day || '',
    lastDay: days[days.length - 1]?.day || '',
    todayEntries,
    gaps: { maxGap, from: maxGapFrom, to: maxGapTo },
    emptyDays,
    important,
    importantRatio: entries ? Math.round((important / entries) * 1000) / 1000 : 0,
    avgEntries: days.length ? Math.round((entries / days.length) * 100) / 100 : 0,
    maxDayEntries: Math.max(0, ...days.map((d) => (d.entries || []).length)),
    moodFrequency,
    note: rd.ok ? '' : (rd.error || '')
  };
}
