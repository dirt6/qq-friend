// 单写者状态文件（4.0 · 1.5.3 · 决策 D9）。
//
// ── 为什么需要 ────────────────────────────────────────────────────
// `autonomous.json` 以前是「读 → 改 → 写」三段分散在调用方：
//
//   const st = readState(file);   // ← 锁外读
//   st.xxx = 1;
//   writeState(file, st);         // ← 原子写，但没锁
//
// 原子写只能保证"文件不半截"，保证不了"两个进程各读旧值再互相覆盖"。
// 面板、trim 脚本、自主活动同时动这个文件时，后写的会吃掉先写的。
//
// ── 这一层做什么 ──────────────────────────────────────────────────
// 把「读-改-写」整段放进同一把跨进程锁：
//
//   withState(file, (st) => {
//     st.lastWakeAt = Date.now();      // 读也在锁里
//   });
//
// 并且：
//   · 写用 tmp+rename（原子替换，失败时旧文件仍然完整）；
//   · 文件坏了先备份再给空状态（不静默清空）；
//   · 版本号 `_v` 每次写 +1，供调用方做冲突判断；
//   · 锁超时抛 ELOCKTIMEOUT，**不静默吞掉**。
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from './file-lock.js';
import { blockedResult } from './reset-barrier.js';

/** 纯读（不加锁；给"只看一眼"的场景用）。坏文件 → fallback。 */
export function readStateFile(file, fallback = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('不是对象');
    return j;
  } catch {
    return { ...fallback };
  }
}

/**
 * 锁内读-改-写。
 *
 * @param {string} file
 * @param {(state:object) => void|object} mutator 原地改，或返回新对象
 * @param {{fallback?:object, onWarn?:(msg:string)=>void, lock?:object}} [o]
 *   lock 透传给 withFileLock（测试要改重试/陈旧判定）
 * @returns {{ok:boolean, state?:object, version?:number, error?:string}}
 */
export function withState(file, mutator, { fallback = {}, onWarn = () => {}, lock = {} } = {}) {
  // reset 删除期间阻止状态写入（learned / autonomous / reminders 等共用此入口）。
  const blocked = blockedResult('状态写入');
  if (blocked) return blocked;
  // 锁超时是**暂时性**的（别的进程正持锁、或 Windows 上 rename 被占用）：
  // 自动再来一次，不把「等了一会儿」当成「写失败」。
  // 只对 ELOCKTIMEOUT 重试；别的错误（磁盘满、权限）直接报。
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const got = withStateOnce(file, mutator, { fallback, onWarn, lock });
    if (got.ok || got.code !== 'ELOCKTIMEOUT') return got;
    lastErr = got;
  }
  return lastErr || { ok: false, error: '状态写入失败' };
}

function withStateOnce(file, mutator, { fallback = {}, onWarn = () => {}, lock = {} } = {}) {
  let result = null;
  try {
    result = withFileLock(file, () => {
      let state;
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('不是对象');
      } catch (e) {
        // 坏文件：先备份，再给空状态 —— 绝不静默清空
        if (e?.code !== 'ENOENT') {
          try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
          onWarn(`状态文件损坏，已备份重建：${e?.message ?? e}`);
        }
        state = { ...fallback };
      }

      const ret = mutator(state);
      const next = (ret && typeof ret === 'object' && !Array.isArray(ret)) ? ret : state;
      next._v = (Number(state._v) || 0) + 1;
      next._updatedAt = new Date().toISOString();

      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
      // rename 是原子替换：失败时旧文件仍然完整，tmp 留在原地供排查。
      // Windows 上别的进程刚读完/杀毒在扫时会 EPERM/EBUSY —— 退避重试，别直接放弃。
      for (let i = 0; i < 12; i += 1) {
        try {
          fs.renameSync(tmp, file);
          break;
        } catch (e) {
          if (e?.code !== 'EPERM' && e?.code !== 'EBUSY' && e?.code !== 'EACCES') throw e;
          if (i === 11) throw e;
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + i * 10); } catch { /* ignore */ }
        }
      }
      return { state: next, version: next._v };
    }, lock);
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), code: e?.code || '' };
  }
  return { ok: true, ...result };
}

/** 只改一个字段的便捷写法（内部还是 withState，不绕过锁）。 */
export function patchState(file, patch, opts = {}) {
  return withState(file, (st) => { Object.assign(st, patch); }, opts);
}
