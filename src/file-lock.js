// 文件锁（4.0 / 3.0-R5-C 重写）。
//
// ── 为什么要重写 ─────────────────────────────────────────────────
// 旧实现只看**锁文件的 mtime**：超过 staleMs（15 秒）就当陈旧锁删掉。
//
// 问题（机主 2026-11-02 指出）：
//   如果某次合法写入持续超过 15 秒，另一个进程会把**仍在使用的锁**删掉，
//   此后两个进程就可能同时进入临界区 —— 锁失去意义。
//
// ── 新设计的四条规则 ─────────────────────────────────────────────
//   ① **唯一 owner token**：锁文件里写 `{ pid, token, startedAt, host }`
//   ② **释放时验证 owner**：token 不匹配就不删（别人已经接管了）
//   ③ **陈旧判定不看年龄，看持有者是否还活着**：
//      · 有 pid 且进程存活 → **永不判陈旧**（哪怕持了 1 小时）
//      · 进程不存在 → 陈旧，可以回收
//      · 旧格式锁（没有 pid）→ 退回 mtime 判断（兼容）
//   ④ **回收必须原子**：删掉后重新用 `wx` 竞争，只有抢到 `wx` 的那个才进临界区
//
// ── 一个诚实的限制 ───────────────────────────────────────────────
//   PID 存活检查有 **PID 重用** 的理论风险（旧进程死了，PID 被新进程复用）。
//   缓解：token 里带 `startedAt` + 随机串，释放时**先比对 token** 再删 ——
//   即使 PID 被复用，token 也不会撞。
//   **不追求 100% 完美**，因为那需要 OS 级进程启动时间查询，跨平台不可靠。
//
// ── 用法 ────────────────────────────────────────────────────────
//   withFileLock(file, () => {
//     const state = readState();     // ← 读也在锁里
//     const next = update(state);
//     atomicWrite(next);
//   });
//
//   只在写的时候加锁 = 两个进程各读旧值再互相覆盖（D9 原话：原子写 ≠ 并发安全）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 2026-11-01：和 token-ledger 对齐 —— 10 秒预算在高并发下仍偶发超时（实测 99/100）。
// 记账/状态写入是整文件读改写（写放大），慢机器上单次持锁能到几十毫秒。
const DEFAULT_RETRIES = 1500;   // 1500 × 20ms = 30 秒
const DEFAULT_WAIT_MS = 20;
const DEFAULT_STALE_MS = 15000;  // **只在旧格式锁（没有 pid）时用**

/** 同步小睡（锁重试用；不引入异步）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
  }
}

/** 异步小睡（异步锁重试用；不冻结事件循环）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成唯一 owner token。 */
function makeToken() {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

/** 读锁文件里的持有者信息。失败给 null。 */
function readLockHolder(lock) {
  try {
    const raw = fs.readFileSync(lock, 'utf8').trim();
    if (!raw) return null;
    // 新格式：JSON
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw);
      return {
        pid: Number(j.pid) || 0,
        token: String(j.token || ''),
        startedAt: Number(j.startedAt) || 0,
        host: String(j.host || '')
      };
    }
    // 旧格式：只有 pid 数字
    const pid = Number(raw);
    return pid > 0 ? { pid, token: '', startedAt: 0, host: '' } : null;
  } catch {
    return null;   // 文件不存在 / 读失败
  }
}

/** 进程是否还活着（EPERM = 存在但无权限，算活着）。 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM：进程存在，只是没权限发信号
    return e?.code === 'EPERM';
  }
}

/**
 * 判断锁是否陈旧（4.0 / 3.0-R5-C）。
 *
 * @param {string} file **目标文件**（和 withFileLock 一致）；传 `xxx.lock` 也行
 * @param {{staleMs?:number}} [o]
 * @returns {{stale:boolean, reason:string, holder:object|null}}
 */
export function lockState(file, { staleMs = DEFAULT_STALE_MS } = {}) {
  const lock = String(file).endsWith('.lock') ? String(file) : `${file}.lock`;
  let st = null;
  try { st = fs.statSync(lock); } catch { return { stale: false, reason: 'no-lock', holder: null }; }

  const holder = readLockHolder(lock);
  if (holder && holder.pid > 0) {
    // ① 有 pid：**看进程是否存活，不看年龄**
    if (isPidAlive(holder.pid)) {
      return { stale: false, reason: 'holder-alive', holder };
    }
    return { stale: true, reason: 'holder-dead', holder };
  }

  // ② 旧格式锁（没有 pid）：只能按 mtime 判断
  const age = Date.now() - st.mtimeMs;
  if (age > staleMs) {
    return { stale: true, reason: 'legacy-timeout', holder };
  }
  return { stale: false, reason: 'legacy-fresh', holder };
}

/**
 * 在文件锁内执行 fn（同步）。
 *
 * @param {string} file 被保护的目标文件（锁文件是 `${file}.lock`）
 * @param {() => any} fn 临界区；**读和写都要在里面**
 * @param {{retries?:number, waitMs?:number, staleMs?:number}} [o]
 */
export function withFileLock(file, fn, {
  retries = DEFAULT_RETRIES,
  waitMs = DEFAULT_WAIT_MS,
  staleMs = DEFAULT_STALE_MS
} = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const myToken = makeToken();
  const myPayload = JSON.stringify({
    pid: process.pid,
    token: myToken,
    startedAt: Date.now(),
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || ''
  });

  for (let i = 0; i < retries; i += 1) {
    try {
      // **排他创建**：只有一个进程能成功
      fs.writeFileSync(lock, myPayload, { flag: 'wx' });
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;

      // 锁已存在 → 检查是否陈旧
      const st = lockState(lock, { staleMs });
      if (st.stale) {
        // **回收**：删掉后重新竞争（不直接进临界区）
        // 两个进程可能同时删 → 一个成功一个 ENOENT，都 continue 重试
        try { fs.unlinkSync(lock); } catch { /* 别人先删了 */ }
        continue;
      }
      sleepSync(waitMs);
      continue;
    }

    // **抢到锁了** → 进临界区
    try {
      return fn();
    } finally {
      // **释放前验证 owner**：只有自己写的锁才删
      const holder = readLockHolder(lock);
      if (holder && holder.token === myToken) {
        try { fs.unlinkSync(lock); } catch { /* 已被清掉 */ }
      }
      // token 不匹配 → 不删（说明锁已经被别人接管，或我们的锁被误回收过）
    }
  }

  const err = new Error(`文件锁超时：${path.basename(lock)}（等了约 ${Math.round((retries * waitMs) / 1000)} 秒）`);
  err.code = 'ELOCKTIMEOUT';
  throw err;
}

/**
 * 异步版 withFileLock（4.0 / 聊天并发修复）。
 *
 * 与同步版的区别只有一个：**等待锁时让出事件循环**（setTimeout 而不是
 * Atomics.wait）。Electron 主进程里同步等锁会冻住整个 UI，最坏 30 秒；
 * 异步等锁只影响这一个写操作。
 *
 * 临界区 fn 仍然必须**同步完成**（它的返回值可以是 promise，但持锁期间
 * await 会延长持锁时间，调用方要自己保证不这么做）。
 *
 * 锁文件格式与同步版完全一致，两者可以互斥（一个进程用同步版、另一个用
 * 异步版也安全）。
 */
export async function withFileLockAsync(file, fn, {
  retries = DEFAULT_RETRIES,
  waitMs = DEFAULT_WAIT_MS,
  staleMs = DEFAULT_STALE_MS
} = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const myToken = makeToken();
  const myPayload = JSON.stringify({
    pid: process.pid,
    token: myToken,
    startedAt: Date.now(),
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || ''
  });

  for (let i = 0; i < retries; i += 1) {
    try {
      fs.writeFileSync(lock, myPayload, { flag: 'wx' });
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;

      const st = lockState(lock, { staleMs });
      if (st.stale) {
        try { fs.unlinkSync(lock); } catch { /* 别人先删了 */ }
        continue;
      }
      await sleep(waitMs);
      continue;
    }

    try {
      return await fn();
    } finally {
      const holder = readLockHolder(lock);
      if (holder && holder.token === myToken) {
        try { fs.unlinkSync(lock); } catch { /* 已被清掉 */ }
      }
    }
  }

  const err = new Error(`文件锁超时：${path.basename(lock)}（等了约 ${Math.round((retries * waitMs) / 1000)} 秒）`);
  err.code = 'ELOCKTIMEOUT';
  throw err;
}

/**
 * 原子替换：同目录临时文件 + rename。
 *
 * 为什么要重试 rename：Windows 上如果一个进程刚好在读目标文件（或杀毒软件在扫），
 * rename 会抛 EPERM/EBUSY。这不是我们写错了，是系统暂时不让替换 ——
 * 退避几十毫秒再来一次就行（2026-11-01 经验库并发测试实测撞到过）。
 *
 * 4.0 / 3.0-R5-A：失败时清理本次的临时文件（清理失败不掩盖原始错误）。
 *
 * D1-2c-2g：可选 `deps` 仅用于测试注入（默认 fs），生产调用行为不变。
 */
export function writeFileAtomic(file, content, deps = {}) {
  const W = {
    mkdirSync: deps.mkdirSync || fs.mkdirSync,
    writeFileSync: deps.writeFileSync || fs.writeFileSync,
    renameSync: deps.renameSync || fs.renameSync,
    existsSync: deps.existsSync || fs.existsSync,
    unlinkSync: deps.unlinkSync || fs.unlinkSync
  };
  W.mkdirSync(path.dirname(file), { recursive: true });
  // 临时文件用**唯一名**（pid + 时间 + 随机），避免并发互相覆盖。
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  W.writeFileSync(tmp, content, 'utf8');

  try {
    for (let i = 0; i < 12; i += 1) {
      try {
        W.renameSync(tmp, file);
        return;
      } catch (e) {
        if (e?.code !== 'EPERM' && e?.code !== 'EBUSY' && e?.code !== 'EACCES') throw e;
        sleepSync(15 + i * 10);
      }
    }
    // 最后一次：还不行就抛（让调用方看到真实失败，不静默）
    W.renameSync(tmp, file);
  } finally {
    // 失败时清理本次的临时文件。
    // · rename 成功后 tmp 已经被移走（existsSync 为 false）→ 这里不会误删目标文件
    // · 清理失败**不抛**（否则会掩盖真正的写入错误）
    try {
      if (W.existsSync(tmp)) W.unlinkSync(tmp);
    } catch { /* 清理失败不掩盖原始错误 */ }
  }
}

export const __internals = { makeToken, readLockHolder, DEFAULT_RETRIES, DEFAULT_WAIT_MS, DEFAULT_STALE_MS };
