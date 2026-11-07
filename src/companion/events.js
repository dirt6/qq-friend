// 统一事件日志（4.0 阶段 1.1）。
//
// 设计边界（见 docs/小鲸鱼4.0/决策记录.md D5/D9/D10）：
//   · 追加写 NDJSON，事件 ID 幂等；
//   · 单写者：进程内短锁 + 跨进程 .events.lock，避免交错；
//   · 失败绝不抛出：事件系统坏了，聊天/自主活动/日记必须继续可用；
//   · 未处理事件永久保留（processed 字段留给消费器）。
//
// 这里不做归档/压缩（阶段 1.3）；只保证"不重复、不丢失、不阻塞旧系统"。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { isResetBarrierActive } from '../reset-barrier.js';

export const EVENTS_DIR = path.join(DATA_DIR, 'companion-events');
export const ARCHIVE_DIR = path.join(EVENTS_DIR, 'archive');
export const ACTIVE_FILE = path.join(EVENTS_DIR, 'active.ndjson');
const LOCK_FILE = path.join(EVENTS_DIR, '.events.lock');
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY = 20;
const LOCK_WAIT_MS = 10;
const RECENT_SCAN_BYTES = 64 * 1024;

/** 同步小睡（锁重试用；不引入计时器）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
  }
}

function ensureDir() {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
}

/** 读 active.ndjson 尾部，收集最近的事件 ID（用于幂等）。 */
function recentEventIds() {
  const ids = new Set();
  try {
    const size = fs.statSync(ACTIVE_FILE).size;
    const start = Math.max(0, size - RECENT_SCAN_BYTES);
    const fd = fs.openSync(ACTIVE_FILE, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      for (const line of buf.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev?.eventId) ids.add(String(ev.eventId));
        } catch { /* 半截行跳过 */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* 文件还不存在 */ }
  return ids;
}

/** 拿跨进程锁；拿不到返回 null（调用方记失败，不阻塞业务）。 */
function acquireLock() {
  ensureDir();
  for (let i = 0; i < LOCK_RETRY; i += 1) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      try { fs.writeSync(fd, `${process.pid}\n`); } catch { /* ignore */ }
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch { /* 锁刚好被释放 */ }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

/** 给归档/消费模块复用的锁（同一把锁，避免并发重写 active.ndjson）。 */
export function withEventsLock(fn) {
  const locked = acquireLock();
  try {
    return fn(locked);
  } finally {
    if (locked) releaseLock();
  }
}

/** 生成稳定事件 ID；同一业务键永远得到同一 ID。 */
export function makeEventId(scope, key) {
  const raw = `${scope}:${key}`;
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  return `evt-${hash}`;
}

/** 归一化摘要：去换行、截断。 */
export function summaryOf(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 追加一条事件。
 * @param {object} event 至少含 eventId/type/source；其余字段原样保留
 * @returns {{ok:boolean, skipped?:boolean, error?:string}}
 */
export function appendEvent(event) {
  if (isResetBarrierActive()) return { ok: false, code: 'ERESETBARRIER', error: 'reset 进行中，事件未写入' };
  try {
    if (!event || !event.eventId || !event.type) return { ok: false, error: 'invalid event' };
    const locked = acquireLock();
    try {
      // 锁内做幂等检查；拿不到锁就降级为"直接追加"——宁可在极端并发下多写一条，
      // 也不能丢事件（事件消费器按 eventId 二次去重）。
      if (locked && recentEventIds().has(String(event.eventId))) return { ok: true, skipped: true };
      const record = {
        eventId: String(event.eventId),
        type: String(event.type),
        ts: event.ts || new Date().toISOString(),
        source: String(event.source || 'unknown'),
        processed: false,
        processedAt: null,
        ...event,
      };
      delete record.ok;
      fs.appendFileSync(ACTIVE_FILE, `${JSON.stringify(record)}\n`, 'utf8');
      return { ok: true, skipped: false, locked };
    } finally {
      if (locked) releaseLock();
    }
  } catch (error) {
    // 事件系统故障绝不能影响聊天/自主活动/日记
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 记录一条聊天消息事件（入站或出站）。
 * 用 chatKey + mid（或本地 id / 时间戳）做幂等键。
 * @param {object} o
 * @param {'incoming'|'outgoing'} o.kind
 * @param {string} o.chatKey
 * @param {number|string|null} o.mid QQ 消息 id
 * @param {number|string|null} o.localId 本地 id
 * @param {number} [o.ts]
 * @param {string} o.text
 * @returns {{ok:boolean, skipped?:boolean, error?:string}}
 */
export function recordMessageEvent({ kind, chatKey, mid = null, localId = null, ts = Date.now(), text = '' }) {
  const scope = kind === 'incoming' ? 'chat.received' : 'chat.sent';
  const key = mid !== null && mid !== undefined && String(mid) !== ''
    ? `mid:${String(mid)}`
    : `local:${String(localId ?? '')}:${String(ts)}`;
  return appendEvent({
    eventId: makeEventId(scope, `${chatKey}:${key}`),
    type: kind === 'incoming' ? 'chat.message_received' : 'chat.reply_sent',
    source: 'chat',
    chatKey: String(chatKey),
    messageId: mid === null || mid === undefined ? null : String(mid),
    ts: new Date(Number(ts) || Date.now()).toISOString(),
    summary: summaryOf(text),
  });
}

/**
 * 记录一次工具执行结果。
 * @param {object} o
 * @param {string} o.chatKey
 * @param {string} o.tool
 * @param {boolean} o.ok
 * @param {string} [o.summary]
 * @param {string} [o.callId]
 * @returns {{ok:boolean, skipped?:boolean, error?:string}}
 */
export function recordToolEvent({ chatKey, tool, ok, summary = '', callId = '' }) {
  const key = callId || `${chatKey}:${tool}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
  return appendEvent({
    eventId: makeEventId('chat.tool', key),
    type: 'chat.tool_executed',
    source: 'chat',
    chatKey: String(chatKey),
    tool: String(tool),
    ok: Boolean(ok),
    summary: summaryOf(summary),
  });
}
