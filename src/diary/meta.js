// 日记元数据（4.0 / 3.0-R3-B）。
//
// ── 硬约束（机主 2026-11-02 定）────────────────────────────────────
//   ① 日记原文**一个字节不能改**
//   ② 元数据与原文**分离保存**（data/diary-meta/<dateKey>.json）
//   ③ append 幂等
//   ④ 并发写入有保护（文件锁）
//   ⑤ 写入失败不能留半写入状态（原子替换）
//   ⑥ sourceHash 变化**只触发复核**，不直接让所有引用失效
//   ⑦ 定位失败标 stale，**绝不用内容相似猜新位置**
//
// ── 设计要点 ──────────────────────────────────────────────────────
//   · 三重定位：paragraphIndex（快）+ quoteHash（准）+ quote（人可读）
//   · 段在但 hash 变 → stale / hash_mismatch
//   · 段不在 → stale / index_out_of_range
//   · 文件没了 → stale / source_missing
//   · **只有 quoteHash 对得上才返回有效位置**

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { diaryRoot, dateKey as diaryDateKey } from './writer.js';
import { dayFileOf } from './paths.js';
import { assertDiaryWritePath } from './test-guard.js';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { blockedResult } from '../reset-barrier.js';

/** 元数据目录（可用环境变量覆盖，测试用隔离目录）。 */
export function metaDir() {
  const base = process.env.QQ_AGENT_DATA_DIR
    ? path.resolve(process.env.QQ_AGENT_DATA_DIR)
    : DATA_DIR;
  return path.join(base, 'diary-meta');
}

export function metaFile(dateKey) {
  return path.join(metaDir(), `${String(dateKey)}.json`);
}

/** 日记原文文件（统一走 paths.dayFileOf；root = 日记根）。 */
export function sourceFile(dateKey, root = '') {
  return dayFileOf(root || diaryRoot(), dateKey);
}

function sha256(s) {
  return 'sha256:' + crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function sha1(s) {
  return 'sha1:' + crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

/* ── 段落切分 ──────────────────────────────────────────────────────── */

/**
 * 把日记正文切成段落（**规则一旦定了就不能改**）。
 *
 * 规则：
 *   · 按空行切
 *   · 跳过纯标题行（`# xxx`）和纯分隔线（`---` / `***` / `___`）
 *   · 只 trim 首尾，**不动内部**
 *   · 只保留非空段落
 *
 * ⚠️ 改规则会让所有旧的 paragraphIndex 失效。
 *    如果将来必须改 → 升 version，旧元数据整体标 stale。
 *
 * @param {string} text
 * @returns {Array<{index:number, text:string, hash:string}>}
 */
export function splitParagraphs(text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  if (!raw.trim()) return [];
  const chunks = raw.split(/\n{2,}/);
  const out = [];
  for (const c of chunks) {
    // 块内逐行剔除标题/分隔线：真实日记是 `## 记录` 紧贴 `- 心情` 行，
    // 若按整块判断会把正文一起吞掉（2026-11-03 发现）。
    const kept = c.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^(-{3,}|\*{3,}|_{3,})$/.test(l));
    if (!kept.length) continue;
    const t = kept.join('\n').trim();
    if (!t) continue;
    out.push({ index: out.length, text: t, hash: sha1(t) });
  }
  return out;
}

/* ── 读写元数据 ────────────────────────────────────────────────────── */

/**
 * 读某天的元数据（**只读，不写盘**）。
 *
 * @returns {{ok:true, meta:object|null, sourceExists:boolean, sourceHash:string|null}}
 *       或 {{ok:false, error:string}}
 */
export function readDiaryMeta(dateKey, root = '') {
  const key = String(dateKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { ok: false, error: 'dateKey 格式不合法' };

  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile(key), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 文件存在但读不出来 → 明确报错（**不返回空对象冒充成功**）
      return { ok: false, error: e instanceof SyntaxError ? '元数据 JSON 损坏' : String(e.message || e) };
    }
  }

  // 原文的状态（只读）
  const src = sourceFile(key, root);
  let sourceExists = false;
  let sourceHash = null;
  try {
    const raw = fs.readFileSync(src, 'utf8');
    sourceExists = true;
    sourceHash = sha256(raw);
  } catch { /* 原文不存在 */ }

  return { ok: true, meta, sourceExists, sourceHash };
}

/**
 * 写某天的元数据（原子替换 + 文件锁）。
 *
 * @param {string} dateKey
 * @param {object} meta  会被补上 version / dateKey / updatedAt
 * @returns {{ok:boolean, error?:string}}
 */
export function writeDiaryMeta(dateKey, meta, root = '') {
  const blocked = blockedResult('日记 meta 写入');
  if (blocked) return blocked;
  const key = String(dateKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { ok: false, error: 'dateKey 格式不合法' };
  if (!meta || typeof meta !== 'object') return { ok: false, error: 'meta 必须是对象' };

  const file = metaFile(key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return { ok: false, error: `建目录失败：${e.message}` };
  }

  // 4.0 / 3.0-R5-B：整体加锁（同进程/跨进程串行）
  try {
    withFileLock(file, () => writeMetaUnlocked(key, meta, root));
  } catch (e) {
    return { ok: false, error: `写入失败：${e?.message ?? e}` };
  }
  return { ok: true };
}

/**
 * **内部**：真正写元数据，**不加锁**。
 *
 * ⚠️ 调用方必须已经持有 `metaFile(dateKey)` 的锁。
 * 这么拆是为了避免 `appendDiaryEntry` 持锁后又调 `writeDiaryMeta` 重复获取同一把锁（自锁）。
 */
function writeMetaUnlocked(dateKey, meta, root = '') {
  assertDiaryWritePath(metaFile(dateKey));
  const file = metaFile(dateKey);
  const payload = {
    ...meta,
    version: 1,
    dateKey,
    sourceFile: sourceFile(dateKey, root),
    updatedAt: nowIso()
  };
  writeFileAtomic(file, JSON.stringify(payload, null, 1));
}

/* ── 定位 ──────────────────────────────────────────────────────────── */

/**
 * 定位一条元数据对应的段落（4.0 / 3.0-R3-C）。
 *
 * **只有 quoteHash 对得上才返回有效位置。**
 *
 * @param {string} dateKey
 * @param {{paragraphIndex:number, quoteHash:string}} entry
 * @returns {{ok:true, text:string, index:number}}
 *       或 {{ok:false, stale:true, reason:string}}
 */
export function locateEntry(dateKey, entry, root = '') {
  const key = String(dateKey || '');
  let raw = null;
  try {
    raw = fs.readFileSync(sourceFile(key, root), 'utf8');
  } catch {
    return { ok: false, stale: true, reason: 'source_missing' };
  }

  const paras = splitParagraphs(raw);
  const idx = Number(entry?.paragraphIndex);
  const wantHash = String(entry?.quoteHash || '');

  if (!Number.isInteger(idx) || idx < 0 || idx >= paras.length) {
    return { ok: false, stale: true, reason: 'index_out_of_range' };
  }

  const p = paras[idx];
  if (!wantHash || p.hash !== wantHash) {
    return { ok: false, stale: true, reason: 'hash_mismatch' };
  }
  return { ok: true, text: p.text, index: idx };
}

/* ── 追加 ──────────────────────────────────────────────────────────── */

/**
 * 给某天的日记追加一条元数据（4.0 / 3.0-R3-C）。
 *
 * 幂等键：`paragraphIndex` + `quoteHash`（同一段同内容不重复加）。
 *
 * @param {string} dateKey
 * @param {object} o
 * @param {number} o.paragraphIndex
 * @param {string} o.contentType
 * @param {string} o.epistemicType
 * @param {object} [o.origin]
 * @param {string} [o.roundId]
 * @returns {{ok:boolean, added?:boolean, error?:string}}
 */
export function appendDiaryEntry(dateKey, {
  paragraphIndex,
  contentType = 'other',
  epistemicType = 'unknown',
  origin = null,
  roundId = '',
  root = ''
} = {}) {
  const key = String(dateKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { ok: false, error: 'dateKey 格式不合法' };

  // 4.0 / 3.0-R5-B：**整个「读 → 去重 → 追加 → 写」在一个锁里**。
  // 之前读在锁外：两个进程并发 append 会各读旧值、各自追加、后写的覆盖前写的（丢更新）。
  //
  // 注意：这里**不调 writeDiaryMeta**（它会再取同一把锁 → 自锁），
  // 而是调内部的 writeMetaUnlocked。
  try {
    return withFileLock(metaFile(key), () => {
      // ① 读原文（在锁内，保证和元数据的判断基于同一时刻）
      let raw = null;
      try {
        raw = fs.readFileSync(sourceFile(key, root), 'utf8');
      } catch {
        return { ok: false, error: '日记原文不存在' };
      }
      const paras = splitParagraphs(raw);
      const idx = Number(paragraphIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= paras.length) {
        return { ok: false, error: 'paragraphIndex 越界' };
      }
      const p = paras[idx];

      // ② 读元数据（**直接用文件读，不走会加锁的 writeDiaryMeta**）
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaFile(key), 'utf8')); } catch { meta = null; }
      const base = meta && typeof meta === 'object'
        ? { ...meta }
        : { version: 1, dateKey: key, sourceFile: sourceFile(key, root), entries: [] };
      base.entries = Array.isArray(base.entries) ? base.entries.slice() : [];
      base.sourceHash = sha256(raw);
      base.sourceMtime = nowIso();

      // ③ 幂等判断
      const dup = base.entries.find((e) => e && Number(e.paragraphIndex) === idx && e.quoteHash === p.hash);
      if (dup) return { ok: true, added: false };

      // ④ 追加
      base.entries.push({
        paragraphIndex: idx,
        quoteHash: p.hash,
        quote: String(p.text).slice(0, 60),
        contentType: String(contentType || 'other'),
        epistemicType: String(epistemicType || 'unknown'),
        origin: origin && typeof origin === 'object'
          ? {
            kind: String(origin.kind || 'unknown'),
            ref: String(origin.ref || ''),
            at: String(origin.at || ''),
            quote: String(origin.quote || '').slice(0, 200)
          }
          : { kind: 'unknown', ref: '', at: '', quote: '' },
        roundId: String(roundId || ''),
        stale: false
      });

      // ⑤ 写入（**不加锁的内部函数**）
      writeMetaUnlocked(key, base);
      return { ok: true, added: true };
    });
  } catch (e) {
    return { ok: false, error: `append 失败：${e?.message ?? e}` };
  }
}

/**
 * 用 writer 传入的段落身份写 meta（**不读正文、不猜段落**）。
 *
 * identity: { dateKey, paragraphIndex, quoteHash, quote, sourceHashAfter, operationId }
 */
export function appendDiaryEntryWithIdentity(identity, {
  contentType = 'other',
  epistemicType = 'unknown',
  origin = null,
  roundId = '',
  root = ''
} = {}) {
  const dateKey = String(identity?.dateKey || '');
  const idx = Number(identity?.paragraphIndex);
  const quoteHash = String(identity?.quoteHash || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return { ok: false, error: 'dateKey 不合法' };
  if (!Number.isInteger(idx) || idx < 0) return { ok: false, error: 'paragraphIndex 不合法' };
  if (!quoteHash) return { ok: false, error: 'quoteHash 不能为空' };

  try {
    return withFileLock(metaFile(dateKey), () => {
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaFile(dateKey), 'utf8')); } catch { meta = null; }
      const base = meta && typeof meta === 'object'
        ? { ...meta }
        : { version: 1, dateKey, sourceFile: sourceFile(dateKey, root), entries: [] };
      base.entries = Array.isArray(base.entries) ? base.entries.slice() : [];
      const dup = base.entries.find((e) => Number(e.paragraphIndex) === idx && e.quoteHash === quoteHash);
      if (dup) return { ok: true, added: false };
      base.entries.push({
        paragraphIndex: idx,
        quoteHash,
        quote: String(identity?.quote || '').slice(0, 60),
        contentType: String(contentType || 'other'),
        epistemicType: String(epistemicType || 'unknown'),
        origin: origin && typeof origin === 'object'
          ? {
            kind: String(origin.kind || 'unknown'),
            ref: String(origin.ref || ''),
            at: String(origin.at || ''),
            quote: String(origin.quote || '').slice(0, 200)
          }
          : { kind: 'unknown', ref: '', at: '', quote: '' },
        roundId: String(roundId || ''),
        stale: false,
        sourceHashAfter: String(identity?.sourceHashAfter || ''),
        operationId: String(identity?.operationId || '')
      });
      if (identity?.sourceHashAfter) base.sourceHash = String(identity.sourceHashAfter);
      base.sourceMtime = nowIso();
      writeMetaUnlocked(dateKey, base, root);
      return { ok: true, added: true };
    });
  } catch (e) {
    return { ok: false, error: `append 失败：${e?.message ?? e}` };
  }
}

/**
 * 检查整份元数据的健康度（4.0 / 3.0-R3-C）。
 *
 * **sourceHash 变化只标记「需要复核」，不直接判所有条目失效** ——
 * 逐条 quoteHash 校验才是准的。
 *
 * @returns {{ok:boolean, sourceExists:boolean, sourceChanged:boolean, entries:Array}}
 */
export function checkDiaryMeta(dateKey, root = '') {
  const key = String(dateKey || '');
  const cur = readDiaryMeta(key, root);
  if (!cur.ok) return { ok: false, error: cur.error };

  const meta = cur.meta;
  if (!meta || !Array.isArray(meta.entries)) {
    return { ok: true, sourceExists: cur.sourceExists, sourceChanged: false, entries: [] };
  }
  const sourceChanged = Boolean(meta.sourceHash && cur.sourceHash && meta.sourceHash !== cur.sourceHash);

  const entries = meta.entries.map((e) => {
    const loc = locateEntry(key, e, root);
    return {
      ...e,
      ok: loc.ok === true,
      stale: loc.ok !== true,
      staleReason: loc.ok === true ? '' : loc.reason
    };
  });

  return { ok: true, sourceExists: cur.sourceExists, sourceChanged, entries };
}

export const __internals = { sha256, sha1, nowIso, diaryDateKey };
