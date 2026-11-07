// 日记记忆的写入入口（4.0 / 3.0-R5-D）。
//
// ── 定位 ────────────────────────────────────────────────────────
//   Memory Hub 的**写入**统一入口。读取走 memory-hub/index.js 的 search/get。
//
// ── 生产启用开关（机主 2026-11-02 明确要求）──────────────────────
//   **默认关闭。** 必须显式打开才写：
//     · 环境变量 QQ_DIARY_META_WRITE=1，或
//     · config.skills.diary.metaWrite === true
//
//   关闭时 appendDiaryMemory 返回 `{ ok:false, code:'DISABLED' }` —— **不静默丢弃**。
//
// ── 回退方案 ────────────────────────────────────────────────────
//   1. 关开关 → 不再写新元数据（已有的元数据还能读）
//   2. 删 data/diary-meta/ 目录 → 完全回到无元数据状态
//   **日记原文从头到尾没被碰过**，所以回退不影响原文。
//
// ── 硬约束 ──────────────────────────────────────────────────────
//   · 日记原文不变（只读，从不写）
//   · 空日记不允许写入（没有段落就没有引用对象）
//   · 不猜测 stale 引用的新位置
//   · 旧数据读取兼容

import fs from 'node:fs';
import { getConfig } from '../config.js';
import {
  appendDiaryEntry,
  readDiaryMeta,
  locateEntry,
  checkDiaryMeta,
  splitParagraphs,
  sourceFile
} from '../diary/meta.js';

/** 写入开关现在开着吗？ */
export function diaryWriteEnabled() {
  // ① 环境变量优先（便于脚本/测试显式打开）
  if (String(process.env.QQ_DIARY_META_WRITE || '') === '1') return true;
  // ② config
  try {
    const c = getConfig();
    return c?.skills?.diary?.metaWrite === true;
  } catch {
    return false;
  }
}

/**
 * 给日记追加一条记忆（**统一写入入口**）。
 *
 * @param {object} o
 * @param {string} o.dateKey
 * @param {number} o.paragraphIndex
 * @param {string} [o.contentType]
 * @param {string} [o.epistemicType]
 * @param {object} [o.origin]
 * @param {string} [o.roundId]
 * @returns {{ok:boolean, added?:boolean, code?:string, error?:string}}
 */
export function appendDiaryMemory({
  dateKey,
  paragraphIndex,
  contentType = 'other',
  epistemicType = 'unknown',
  origin = null,
  roundId = ''
} = {}) {
  if (!diaryWriteEnabled()) {
    return { ok: false, code: 'DISABLED', error: '日记元数据写入未启用（QQ_DIARY_META_WRITE=1 或 config.skills.diary.metaWrite）' };
  }
  const r = appendDiaryEntry(dateKey, {
    paragraphIndex,
    contentType,
    epistemicType,
    origin,
    roundId
  });
  if (!r.ok) return { ok: false, code: 'APPEND_FAILED', error: r.error };
  return { ok: true, added: r.added === true };
}

/**
 * 读某天的日记记忆（**统一读取入口**，不受开关影响）。
 */
export function readDayDiaryMemory(dateKey) {
  const meta = readDiaryMeta(dateKey);
  if (!meta.ok) return { ok: false, error: meta.error };
  const chk = checkDiaryMeta(dateKey);
  if (!chk.ok) return { ok: false, error: chk.error };
  return {
    ok: true,
    dateKey,
    sourceExists: chk.sourceExists,
    sourceChanged: chk.sourceChanged,
    entries: chk.entries
  };
}

/**
 * 定位一条日记记忆（**统一定位入口**）。
 *
 * **定位失败标 stale，绝不猜新位置。**
 */
export function locateDiaryMemory(dateKey, entry) {
  return locateEntry(dateKey, entry);
}

/** 列出某天日记的段落（只读，供调用方决定要引用哪一段）。 */
export function listDiaryParagraphs(dateKey) {
  try {
    // 复用 meta.js 的切分规则，保证 index 一致
    return { ok: true, paragraphs: splitParagraphs(fs.readFileSync(sourceFile(dateKey), 'utf8')) };
  } catch {
    return { ok: true, paragraphs: [] };
  }
}

export const __internals = { diaryWriteEnabled };
