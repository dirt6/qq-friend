// 日记操作日志（D1-2b）：持久化操作意图，供崩溃恢复与对账。
//
// 定位：**可恢复的多阶段操作，不是跨文件原子事务。**
//   ① prepare（登记意图）→ ② 正文 → ③ meta → ④ complete
//   任何一步崩溃，恢复程序都能从 pending 找到未完成项，按当前正文/meta 状态幂等补偿。
//
// 硬约束：
//   · 不记录日记正文/敏感内容（只存 match 摘要、hash、段落身份）
//   · 自带锁 + 原子写；完成记录有保留策略；**不删未完成/待补偿项**
//   · 幂等键 = op + dateKey + match + importance + expectedSourceHash
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { assertDiaryWritePath } from './test-guard.js';
import { assertWritesAllowed } from '../reset-barrier.js';

export const STAGES = ['prepared', 'body_done', 'meta_done', 'completed'];

/** pending.json 路径（测试可用 QQ_AGENT_DATA_DIR 隔离）。 */
export function outboxFile() {
  const base = process.env.QQ_AGENT_DATA_DIR ? path.resolve(process.env.QQ_AGENT_DATA_DIR) : DATA_DIR;
  return path.join(base, 'diary-meta', 'pending.json');
}

function nowIso() { return new Date().toISOString(); }
function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

/** 幂等键：同一操作重复登记得到同一 id。 */
export function opId(op) {
  return sha1([
    String(op?.op ?? ''),
    String(op?.dateKey ?? ''),
    String(op?.match ?? ''),
    String(op?.importance ?? ''),
    String(op?.expectedSourceHash ?? '')
  ].join('|')).slice(0, 24);
}

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(outboxFile(), 'utf8'));
    if (!j || typeof j !== 'object' || !j.items || typeof j.items !== 'object') return { version: 1, items: {} };
    return { version: 1, items: { ...j.items } };
  } catch {
    return { version: 1, items: {} };
  }
}

function writeAll(data) {
  assertWritesAllowed('日记操作日志写入'); // reset 期间不允许登记/推进/完成操作
  assertDiaryWritePath(outboxFile());
  const file = outboxFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ version: 1, updatedAt: nowIso(), items: data.items }, null, 1));
}

/**
 * 登记操作意图（幂等）。
 * @param {{op:'append'|'remove'|'relevel', dateKey:string, match?:string, importance?:string, expectedSourceHash?:string, paragraphIndex?:number}} op
 */
export function prepareDiaryOp(op) {
  const o = op && typeof op === 'object' ? op : {};
  if (!['append', 'remove', 'relevel'].includes(String(o.op))) return { ok: false, error: 'op 不合法' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.dateKey || ''))) return { ok: false, error: 'dateKey 不合法' };
  const id = opId(o);
  try {
    return withFileLock(outboxFile(), () => {
      const data = readAll();
      if (data.items[id]) {
        return { ok: true, id, existing: true, stage: data.items[id].stage };
      }
      data.items[id] = {
        id,
        op: String(o.op),
        dateKey: String(o.dateKey),
        match: String(o.match ?? '').slice(0, 120),
        importance: String(o.importance ?? ''),
        expectedSourceHash: String(o.expectedSourceHash ?? ''),
        paragraphIndex: Number.isInteger(o.paragraphIndex) ? o.paragraphIndex : null,
        stage: 'prepared',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        attempts: 0,
        lastError: '',
        lastAttemptAt: ''
      };
      writeAll(data);
      return { ok: true, id, existing: false };
    });
  } catch (e) {
    return { ok: false, error: `登记失败：${e?.message ?? e}` };
  }
}

/** 推进阶段（prepared → body_done → meta_done）。 */
export function markDiaryOpStage(id, stage) {
  if (!STAGES.includes(stage) || stage === 'completed') return { ok: false, error: 'stage 不合法' };
  try {
    return withFileLock(outboxFile(), () => {
      const data = readAll();
      const it = data.items[id];
      if (!it) return { ok: false, error: '操作不存在' };
      it.stage = stage;
      it.updatedAt = nowIso();
      writeAll(data);
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: `更新失败：${e?.message ?? e}` };
  }
}

/** 标记完成（保留记录，按策略清理）。metaState 记录 meta 的真实状态。 */
export function completeDiaryOp(id, { metaState = '' } = {}) {
  try {
    return withFileLock(outboxFile(), () => {
      const data = readAll();
      const it = data.items[id];
      if (!it) return { ok: false, error: '操作不存在' };
      it.stage = 'completed';
      it.completedAt = nowIso();
      it.updatedAt = it.completedAt;
      if (metaState) it.metaState = String(metaState).slice(0, 40);
      pruneInPlace(data);
      writeAll(data);
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: `完成失败：${e?.message ?? e}` };
  }
}

/** 记录一次失败（不改变 stage，保留错误与尝试时间）。 */
export function failDiaryOp(id, error) {
  try {
    return withFileLock(outboxFile(), () => {
      const data = readAll();
      const it = data.items[id];
      if (!it) return { ok: false, error: '操作不存在' };
      it.attempts = Number(it.attempts || 0) + 1;
      it.lastError = String(error ?? '').slice(0, 300);
      it.lastAttemptAt = nowIso();
      it.updatedAt = it.lastAttemptAt;
      writeAll(data);
      return { ok: true, attempts: it.attempts };
    });
  } catch (e) {
    return { ok: false, error: `记录失败：${e?.message ?? e}` };
  }
}

/** 未完成操作（恢复/对账用）。 */
export function listUnfinishedDiaryOps() {
  const data = readAll();
  return Object.values(data.items)
    .filter((it) => it && it.stage !== 'completed')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** 全部操作（只读）。 */
export function listDiaryOps() {
  return Object.values(readAll().items);
}

/** 待补偿队列监控：积压数量、最老未完成年龄、失败原因分布。 */
export function outboxStats({ now = Date.now() } = {}) {
  const data = readAll();
  const unfinished = Object.values(data.items).filter((it) => it && it.stage !== 'completed');
  let oldest = 0;
  const stages = {};
  const errors = {};
  for (const it of unfinished) {
    const t = Date.parse(it.createdAt || it.updatedAt || '');
    if (Number.isFinite(t)) oldest = Math.max(oldest, now - t);
    stages[it.stage] = (stages[it.stage] || 0) + 1;
    if (it.lastError) errors[String(it.lastError).slice(0, 80)] = (errors[String(it.lastError).slice(0, 80)] || 0) + 1;
  }
  return { ok: true, unfinished: unfinished.length, oldestAgeMs: oldest, stages, errors };
}

/** 完成记录保留策略：只清理 completed，未完成绝不删。 */
export function pruneCompletedDiaryOps({ keepDays = 7, maxCompleted = 200 } = {}) {
  try {
    return withFileLock(outboxFile(), () => {
      const data = readAll();
      const before = Object.keys(data.items).length;
      pruneInPlace(data, { keepDays, maxCompleted });
      const after = Object.keys(data.items).length;
      writeAll(data);
      return { ok: true, removed: before - after };
    });
  } catch (e) {
    return { ok: false, error: `清理失败：${e?.message ?? e}` };
  }
}

function pruneInPlace(data, { keepDays = 7, maxCompleted = 200 } = {}) {
  const cutoff = Date.now() - keepDays * 86400e3;
  const completed = [];
  for (const it of Object.values(data.items)) {
    if (it?.stage === 'completed') completed.push(it);
  }
  completed.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  const keep = new Set();
  completed.forEach((it, i) => {
    const t = Date.parse(it.completedAt || it.updatedAt || '');
    if (i < maxCompleted && Number.isFinite(t) && t >= cutoff) keep.add(it.id);
  });
  for (const it of completed) {
    if (!keep.has(it.id)) delete data.items[it.id];
  }
}

export const __internals = { readAll, writeAll, pruneInPlace, sha1 };
