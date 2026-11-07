// 各层适配器（4.0 / 3.0-R4）。
//
// ── 硬约束（机主 2026-11-02）──────────────────────────────────────
//   · **只读** —— 这里所有函数都不写任何文件
//   · **不改底层存储** —— 只调用各层现有的读取接口
//   · 统一返回 `{ type, id, source, content, timestamp, relevance }`
//
// 每层一个函数，失败**返回空数组 + 错误标记**，不抛、不冒充成功。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { listAll as learnedListAll, renderForPrompt as learnedRenderForPrompt, resolveCorrectionState } from '../learned.js';
// 日记根目录以配置为准（唯一的路径解析在 diary/writer）。
import { diaryRoot as configuredDiaryRoot } from '../diary/writer.js';
import { relevanceOf, inTimeRange } from './retrieval.js';

/**
 * chatKey → 会话目录名（R8-B0）。
 *
 * 目录命名与 `src/memory.js` 的 `chatDirName()` 一致：
 *   `group:1`   → `group_1`
 *   `private:2` → `private_2`
 *
 * 只接受**严格**的 `(group|private)[:_]<数字>`：
 *   · 不做前缀/模糊匹配（不允许把 `group:1` 扩成 `group_1`、`group_10` 一起读）；
 *   · 原始 chatKey 不修改；
 *   · 非法输入返回 null，由调用方返回空结果（不猜、不扩大范围）。
 */
const CHAT_KEY_RE = /^(group|private)[:_](\d+)$/;

function normalizeChatDirName(chatKey) {
  const m = CHAT_KEY_RE.exec(String(chatKey ?? '').trim());
  if (!m) return null;
  return `${m[1]}_${m[2]}`;
}

/** 统一结果形状。 */
function makeItem({ type, id, source, content, timestamp, meta = {} }) {
  return {
    type: String(type),
    id: String(id || ''),
    source: String(source || ''),
    content: String(content || '').slice(0, 500),
    timestamp: Number(timestamp) || 0,
    relevance: 0,          // 由调用方填
    // 元数据（可能为空，**不猜**）
    contentType: meta.contentType || 'other',
    epistemicType: meta.epistemicType || 'unknown',
    extra: meta.extra || null
  };
}

/* ── ① 经验 ────────────────────────────────────────────────────────── */

/**
 * 经验层的 prompt 渲染（只读）。
 * 业务方（如 DSH 会话注入）经 Hub 调用，不再直接 import learned.renderForPrompt；
 * 选择和格式仍复用 learned 的既有实现，行为和以前一致。
 */
export function renderLearned({ contextText = '', limit, collect = null } = {}) {
  try {
    return learnedRenderForPrompt({ contextText, limit, collect });
  } catch {
    return '';
  }
}

export function readLearned({ query = '', since = 0, until = 0, limit = 0 } = {}) {
  let list = [];
  try {
    list = learnedListAll();
  } catch (e) {
    return { ok: false, error: String(e?.message || e), items: [] };
  }
  const items = [];
  for (const it of list) {
    const ts = Date.parse(it.createdAt || '') || 0;
    if (!inTimeRange(ts, { since, until })) continue;
    const r = relevanceOf(query, it.text);
    if (query && r <= 0) continue;
    items.push({ ...makeItem({
      type: 'learned',
      id: it.id,
      source: it.sourceDay || '',
      content: it.text,
      timestamp: ts,
      meta: {
        contentType: it.contentType,
        epistemicType: it.epistemicType,
        extra: {
          status: it.status,
          hits: Number(it.hits) || 0,
          corrections: Number(it.corrections) || 0,
          correctionCount: Number(it.correction?.count) || 0,
          // R8-B v2：三态透传（旧字段原样，不再 Boolean(undefined)=false）
          correctionState: resolveCorrectionState(it),
          historicalUnresolved: typeof it.correction?.historicalUnresolved === 'boolean'
            ? it.correction.historicalUnresolved
            : null
        }
      }
    }), relevance: r });
  }
  return { ok: true, items };
}

/* ── ② 聊天印象 ────────────────────────────────────────────────────── */

export function readImpressions({ query = '', since = 0, until = 0, chatKey = '' } = {}) {
  const base = process.env.QQ_AGENT_DATA_DIR
    ? path.resolve(process.env.QQ_AGENT_DATA_DIR)
    : DATA_DIR;
  const root = path.join(base, 'memory');
  const items = [];

  let chats = [];
  try {
    chats = fs.readdirSync(root).filter((d) => {
      try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    return { ok: true, items: [] };   // 目录不存在 = 没有印象，不是错误
  }
  if (chatKey) {
    const dir = normalizeChatDirName(chatKey);
    // 非法/未知 key：不扩大范围，返回空（不猜、不模糊匹配）
    if (!dir) return { ok: true, items: [] };
    chats = chats.filter((c) => c === dir);
  }

  for (const chat of chats) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, chat)).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      let member = null;
      try { member = JSON.parse(fs.readFileSync(path.join(root, chat, f), 'utf8')); } catch { continue; }
      const list = Array.isArray(member?.impressions) ? member.impressions : [];
      for (const imp of list) {
        const content = String(imp?.content ?? '');
        if (!content) continue;
        const ts = Number(imp.createdAt) || 0;
        if (!inTimeRange(ts, { since, until })) continue;
        const r = relevanceOf(query, content);
        if (query && r <= 0) continue;
        items.push({ ...makeItem({
          type: 'impression',
          id: imp.id || '',
          source: `${chat}/${member.userId || ''}`,
          content,
          timestamp: ts,
          meta: {
            contentType: imp.contentType,
            epistemicType: imp.epistemicType,
            extra: {
              name: member.name || '',
              userId: member.userId || '',
              corrections: Number(imp.correction?.count) || 0
            }
          }
        }), relevance: r });
      }
    }
  }
  return { ok: true, items };
}

/* ── ③ 日记 ────────────────────────────────────────────────────────── */

export function readDiary({ query = '', since = 0, until = 0, maxDays = 30, diaryRoot = '' } = {}) {
  // 没显式传 root 时以配置为准（skills.diary.root），避免又读回旧目录。
  const root = diaryRoot || configuredDiaryRoot();
  const dayDir = path.join(root, '每日');
  const items = [];

  let files = [];
  try { files = fs.readdirSync(dayDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)); } catch {
    return { ok: true, items: [] };
  }
  files.sort().reverse();
  files = files.slice(0, Math.max(1, maxDays));

  for (const f of files) {
    const day = f.replace(/\.md$/, '');
    const ts = Date.parse(`${day}T00:00:00`) || 0;
    if (!inTimeRange(ts, { since, until })) continue;

    let raw = '';
    try { raw = fs.readFileSync(path.join(dayDir, f), 'utf8'); } catch { continue; }

    // 不返回整篇，按行筛（一行一条，脱敏由调用方决定）
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/^#{1,6}\s/.test(t)) continue;
      const r = relevanceOf(query, t);
      if (query && r <= 0) continue;
      items.push({ ...makeItem({
        type: 'diary',
        id: `${day}#${t.slice(0, 20)}`,
        source: day,
        content: t,
        timestamp: ts,
        meta: { contentType: 'event', epistemicType: 'direct', extra: { day } }
      }), relevance: r });
    }
  }
  return { ok: true, items };
}

/* ── ④ 活动（autonomous history）─────────────────────────────────── */

export function readActivities({ query = '', since = 0, until = 0, maxRounds = 20 } = {}) {
  const base = process.env.QQ_AGENT_DATA_DIR
    ? path.resolve(process.env.QQ_AGENT_DATA_DIR)
    : DATA_DIR;
  const file = path.join(base, 'autonomous.json');

  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    return { ok: true, items: [] };
  }
  const history = Array.isArray(j?.history) ? j.history : [];
  const items = [];

  for (const r of history.slice(-Math.max(1, maxRounds))) {
    const ts = Number(r?.startedAt) || 0;
    if (!inTimeRange(ts, { since, until })) continue;
    const actions = Array.isArray(r.actions) ? r.actions : [];
    for (const a of actions) {
      const content = [a?.goal, a?.resultSummary].filter(Boolean).join(' — ');
      if (!content) continue;
      const rr = relevanceOf(query, content);
      if (query && rr <= 0) continue;
      items.push({ ...makeItem({
        type: 'activity',
        id: `${r.roundId || ''}#${a?.actionId || a?.action || ''}`,
        source: String(r.roundId || ''),
        content,
        timestamp: ts,
        meta: {
          contentType: 'event',
          epistemicType: 'direct',
          extra: { action: a?.action || '', result: a?.result || '' }
        }
      }), relevance: rr });
    }
  }
  return { ok: true, items };
}

/* ── ⑤ Companion State ────────────────────────────────────────────── */

export function readCompanionItems({ query = '', since = 0, until = 0 } = {}) {
  const base = process.env.QQ_AGENT_DATA_DIR
    ? path.resolve(process.env.QQ_AGENT_DATA_DIR)
    : DATA_DIR;
  const file = path.join(base, 'companion-state.json');

  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    return { ok: true, items: [] };
  }
  const items = [];

  for (const g of (Array.isArray(j?.goals) ? j.goals : [])) {
    const ts = Date.parse(g.since || '') || 0;
    if (!inTimeRange(ts, { since, until })) continue;
    const r = relevanceOf(query, g.text);
    if (query && r <= 0) continue;
    items.push({ ...makeItem({
      type: 'goal',
      id: g.id,
      source: g.source || '',
      content: g.text,
      timestamp: ts,
      meta: {
        contentType: 'plan',
        epistemicType: g.source === 'user_directed' ? 'direct' : 'inferred',
        extra: { status: g.status, reason: g.reason || '' }
      }
    }), relevance: r });
  }

  for (const p of (Array.isArray(j?.pending) ? j.pending : [])) {
    const ts = Date.parse(p.at || '') || 0;
    if (!inTimeRange(ts, { since, until })) continue;
    const r = relevanceOf(query, p.text);
    if (query && r <= 0) continue;
    items.push({ ...makeItem({
      type: 'pending',
      id: p.id,
      source: p.source || '',
      content: p.text,
      timestamp: ts,
      meta: {
        contentType: 'plan',
        epistemicType: 'inferred',
        extra: { status: p.status }
      }
    }), relevance: r });
  }
  return { ok: true, items };
}
