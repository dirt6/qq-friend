// 日记操作编排（D1-2b-2）：持久化意图 + Saga 式恢复。
//
// 不是数据库事务：pending.json 与正文是两个文件，没有跨文件原子性。
// 流程：prepare → body → meta → complete；任一步崩溃，恢复按**当前正文状态**幂等补偿。
//
// 锁顺序（固定，禁止反向）：正文文件锁 → pending 锁 → meta 锁。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { getConfig } from '../config.js';
import {
  prepareDiaryOp, markDiaryOpStage, completeDiaryOp, failDiaryOp, listUnfinishedDiaryOps
} from './outbox.js';
import {
  appendDiaryEntry, appendDiaryEntryWithIdentity, splitParagraphs, sourceFile, readDiaryMeta, writeDiaryMeta
} from './meta.js';
import { diaryRootFromDayDir } from './paths.js';

/** 故障注入：子进程里用它验证"每个节点被强杀"的行为。 */
export function maybeFault(stage) {
  if (String(process.env.DIARY_FAULT || '') === String(stage)) {
    process.kill(process.pid, 'SIGKILL');
  }
}

/** meta 写入开关（默认关闭；沿用 memory-hub/diary-write 的开关语义）。 */
export function metaWriteEnabled() {
  if (String(process.env.QQ_DIARY_META_WRITE || '') === '1') return true;
  try { return getConfig()?.skills?.diary?.metaWrite === true; } catch { return false; }
}

/** ① 登记意图；失败必须阻止正文修改。 */
export function beginOp({ op, dateKey, match = '', importance = '', expectedSourceHash = '', paragraphIndex = null }) {
  maybeFault('before-prepare');
  const r = prepareDiaryOp({ op, dateKey, match, importance, expectedSourceHash, paragraphIndex });
  if (!r.ok) return { ok: false, code: 'PREPARE_FAILED', error: r.error };
  maybeFault('after-prepare');
  return r;
}

/** ② 正文完成。 */
export function bodyDone(id) {
  const r = markDiaryOpStage(id, 'body_done');
  maybeFault('after-body');
  return r;
}

/** ③ meta 完成。 */
export function metaDone(id) {
  const r = markDiaryOpStage(id, 'meta_done');
  maybeFault('after-meta');
  return r;
}

/** ④ 完成。metaState: synced / skipped_disabled / skipped_no_entry / failed */
export function finishOp(id, metaState = '') {
  maybeFault('before-complete');
  return completeDiaryOp(id, { metaState });
}

/** 失败时保留 pending，记录错误。 */
export function failOp(id, error) {
  return failDiaryOp(id, error);
}

/** 读正文（可注入 root，测试用）。 */
function readSource(dateKey, root = '') {
  const file = root ? path.join(root, `${dateKey}.md`) : sourceFile(dateKey);
  return fs.readFileSync(file, 'utf8');
}

/**
 * 追加后的 meta 同步：按正文重新切段，找到新段落 index。
 * 找不到 → 返回失败（调用方保留 pending，恢复时重试）。
 */
export function syncAppendMeta({ dateKey, text = '', root = '', identity = null }) {
  if (!metaWriteEnabled()) return { ok: true, skipped: true, metaState: 'skipped_disabled' };
  const diaryRoot = root ? diaryRootFromDayDir(root) : '';
  // writer 必须提供段落身份；没有身份就拒绝猜测
  if (!identity) return { ok: false, error: '缺少段落身份，拒绝猜测', metaState: 'failed' };
  try {
    const r = appendDiaryEntryWithIdentity(identity, { contentType: 'diary', epistemicType: 'unknown', root: diaryRoot });
    return { ...r, metaState: r.ok ? 'synced' : 'failed' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), metaState: 'failed' };
  }
}

/**
 * 改级后的 meta 同步：按新正文找到对应段落，更新该段落的 quoteHash/quote。
 * 只更新能按旧 quoteHash 或 match 唯一确认的条目；不猜。
 */
export function syncRelevelMeta({ dateKey, match, importance, root = '' }) {
  if (!metaWriteEnabled()) return { ok: true, skipped: true, metaState: 'skipped_disabled' };
  const diaryRoot = root ? diaryRootFromDayDir(root) : '';
  try {
    const raw = readSource(dateKey, root);
    const paras = splitParagraphs(raw);
    const needle = String(match ?? '').trim().slice(0, 20);
    const hits = paras.filter((p) => String(p.text).includes(needle));
    if (hits.length !== 1) return { ok: false, error: '正文匹配不唯一，拒绝更新 meta' };
    const p = hits[0];
    const cur = readDiaryMeta(dateKey, diaryRoot);
    if (!cur.ok) return { ok: false, error: cur.error };
    const meta = cur.meta || { version: 1, dateKey, entries: [] };
    meta.entries = Array.isArray(meta.entries) ? meta.entries.slice() : [];
    const entry = meta.entries.find((e) => String(e.quote || '').includes(needle) || Number(e.paragraphIndex) === p.index);
    if (!entry) return { ok: true, skipped: true, reason: '没有对应 meta 条目', metaState: 'skipped_no_entry' };
    entry.paragraphIndex = p.index;
    entry.quoteHash = p.hash;
    entry.quote = String(p.text).slice(0, 60);
    entry.stale = false;
    entry.staleReason = '';
    if (raw) meta.sourceHash = 'sha256:' + crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    const w = writeDiaryMeta(dateKey, meta, diaryRoot);
    return { ...w, metaState: w.ok ? 'synced' : 'failed' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), metaState: 'failed' };
  }
}

/**
 * 删除后的 meta 同步：把删除段落及之后受影响的条目标 stale（不重排、不猜）。
 */
export function syncRemoveMeta({ dateKey, match, beforeIndex = null, root = '' }) {
  if (!metaWriteEnabled()) return { ok: true, skipped: true, metaState: 'skipped_disabled' };
  const diaryRoot = root ? diaryRootFromDayDir(root) : '';
  try {
    const cur = readDiaryMeta(dateKey, diaryRoot);
    if (!cur.ok) return { ok: false, error: cur.error };
    const meta = cur.meta;
    if (!meta || !Array.isArray(meta.entries) || !meta.entries.length) return { ok: true, skipped: true, metaState: 'skipped_no_entry' };
    let raw = '';
    try { raw = readSource(dateKey, root); } catch { raw = ''; }
    const paras = splitParagraphs(raw);
    const needle = String(match ?? '').trim().slice(0, 20);
    // 优先用删除前记录的段落起点；删除后索引已前移，事后找不到原段落
    const before = Number.isInteger(beforeIndex) && beforeIndex >= 0
      ? beforeIndex
      : paras.findIndex((p) => String(p.text).includes(needle));
    let changed = 0;
    for (const e of meta.entries) {
      if (before >= 0 && Number(e.paragraphIndex) >= before) {
        e.stale = true;
        e.staleReason = 'index_shifted_after_remove';
        changed += 1;
      }
    }
    if (raw) meta.sourceHash = 'sha256:' + crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    const w = writeDiaryMeta(dateKey, meta, diaryRoot);
    return { ...w, changed, metaState: w.ok ? 'synced' : 'failed' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), metaState: 'failed' };
  }
}

/**
 * 恢复未完成操作（幂等）。
 *
 * 只信**当前正文状态**，不信 stage 字段：
 *   · remove：目标行不存在 → 视作已完成
 *   · relevel：目标等级已是 → 视作已完成
 *   · append：正文已含该内容 → 视作已完成（不再追加）
 * 完成 meta 同步后才标 completed；meta 失败保留 pending。
 *
 * @param {{dryRun?:boolean}} [o]
 */
export function recoverDiaryOps({ dryRun = false, root = '' } = {}) {
  const items = listUnfinishedDiaryOps();
  const report = [];
  for (const it of items) {
    const step = { id: it.id, op: it.op, stage: it.stage, action: '', ok: true, dryRun };
    try {
      const dateKey = String(it.dateKey || '');
      let text = '';
      try { text = readSource(dateKey, root); } catch { text = ''; }
      const exists = text !== '';
      const curHash = exists
        ? 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex')
        : 'absent';
      const expected = String(it.expectedSourceHash || '');
      const hasExpectation = expected !== '';
      const unchanged = hasExpectation && expected === curHash;
      const needle = String(it.match || '').slice(0, 40);
      const hasLine = needle ? text.includes(needle) : false;

      if (!hasExpectation) {
        // 旧记录没有 hash：不自动认领
        step.action = 'needs_manual_replay';
        step.ok = false;
      } else if (unchanged) {
        // 正文未变 = 操作未发生；阶段必须还是 prepared，否则记录矛盾
        if (it.stage !== 'prepared') {
          step.action = 'stage_hash_mismatch_needs_manual';
          step.ok = false;
        } else {
          step.action = 'not_executed';
        }
      } else if (it.op === 'append') {
        const n = needle ? text.split(needle).length - 1 : 0;
        if (n === 1) step.action = 'already_appended';
        else if (n === 0) { step.action = 'content_changed_without_target_needs_manual'; step.ok = false; }
        else { step.action = 'duplicate_target_needs_manual'; step.ok = false; }
      } else if (it.op === 'remove') {
        if (!hasLine) step.action = 'already_removed';
        else { step.action = 'target_still_present_needs_manual'; step.ok = false; }
      } else if (it.op === 'relevel') {
        const wanted = String(it.importance || '');
        const line = text.split('\n').find((l) => needle && l.includes(needle) && l.trim().startsWith('- 心情：'));
        const already = Boolean(line) && (wanted === '一般' ? !/\[(重要|非常重要)\]/.test(line) : line.includes(`[${wanted}]`));
        if (already) step.action = 'already_releveled';
        else { step.action = 'relevel_not_applied_needs_manual'; step.ok = false; }
      }

      if (step.action.startsWith('already_') && !dryRun) {
        finishOp(it.id, 'recovered');
        step.action += '_completed';
      }
      report.push(step);
    } catch (e) {
      step.ok = false;
      step.error = String(e?.message ?? e);
      report.push(step);
    }
  }
  return { ok: true, dryRun, total: items.length, report };
}

export const __internals = { readSource };
