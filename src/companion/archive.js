// 事件可靠性 + 存储归档（4.0 · 阶段 1.3 · 决策 D5）。
//
// ── D5 的原文要求 ──────────────────────────────────────────────────
//   · 未处理事件永久保留，直到成功消费；
//   · 已处理事件保留 90 天，超过按月归档（gzip，.ndjson.gz），归档长期保留不自动删；
//   · 按 processedAt 判断归档资格，不按创建时间；
//   · 归档前校验完整性（事件 ID 不丢、不重复）；
//   · 启动只读当前状态快照与必要未处理事件，不加载全部历史；
//   · 磁盘保护：>500 MB 提醒，>1 GB 暂停归档扩张；
//   · 核心原则：**永久保留原始事件，不永久加载原始事件**。
//
// ── 这一层做什么 ──────────────────────────────────────────────────
//   1. listUnprocessed：给消费器拿"还没处理的事件"（重启后恢复靠它）；
//   2. markProcessed：幂等地打上 processed/processedAt（重复标记不产生新变化）；
//   3. archiveProcessed：已处理且超过 N 天的搬进按月 gzip，从 active 里移除；
//   4. storage：磁盘占用统计 + 阈值提醒；
//   5. health：一眼看明白事件系统的状态。
//
// ── 边界 ──────────────────────────────────────────────────────────
//   · 所有写操作都走 events.js 的同一把跨进程锁；
//   · active.ndjson 重写用 tmp+rename（原子）；
//   · 任何失败都返回结果对象，不抛——事件坏了不能拖垮聊天。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ACTIVE_FILE, ARCHIVE_DIR, EVENTS_DIR, withEventsLock } from './events.js';

const DAY_MS = 86400e3;
const DEFAULT_KEEP_DAYS = 90;
/** 磁盘保护阈值（D5 初始建议值，可被调用方覆盖）。 */
export const DISK_WARN_BYTES = 500 * 1024 * 1024;
export const DISK_STOP_BYTES = 1024 * 1024 * 1024;

/** 读 active.ndjson 全部事件（逐行解析，坏行跳过并计数）。 */
function readActive() {
  let text = '';
  try {
    text = fs.readFileSync(ACTIVE_FILE, 'utf8');
  } catch {
    return { events: [], badLines: 0, missing: true };
  }
  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (ev && ev.eventId) events.push(ev);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { events, badLines, missing: false };
}

function writeActiveAtomic(events) {
  const tmp = `${ACTIVE_FILE}.${process.pid}.tmp`;
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  fs.renameSync(tmp, ACTIVE_FILE);
}

/**
 * 列出还没处理的事件（消费器的入口，重启恢复也用它）。
 * @param {{limit?:number, type?:string, since?:number}} [o]
 */
export function listUnprocessed({ limit = 500, type = '', since = 0 } = {}) {
  const { events, badLines } = readActive();
  const out = events
    .filter((e) => !e.processed)
    .filter((e) => (type ? e.type === type : true))
    .filter((e) => {
      if (!since) return true;
      const ts = Date.parse(e.ts);
      return Number.isFinite(ts) ? ts >= since : true;
    })
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(0, Math.max(1, limit));
  return { ok: true, events: out, badLines, total: events.length };
}

/**
 * 幂等标记已处理。
 *
 * 幂等语义：已在 processed 里的再标一次，不改变 processedAt、不写文件。
 * 返回 {ok, marked, skipped}；失败给 error，不抛。
 */
export function markProcessed(eventIds, { at = Date.now(), reason = 'consumed' } = {}) {
  const ids = new Set((Array.isArray(eventIds) ? eventIds : [eventIds]).filter(Boolean).map(String));
  if (!ids.size) return { ok: true, marked: 0, skipped: 0 };
  return withEventsLock(() => {
    const { events, badLines } = readActive();
    if (!events.length) return { ok: true, marked: 0, skipped: 0, badLines };
    let marked = 0;
    let skipped = 0;
    for (const ev of events) {
      if (!ids.has(String(ev.eventId))) continue;
      if (ev.processed) { skipped += 1; continue; }
      ev.processed = true;
      ev.processedAt = new Date(at).toISOString();
      ev.consumedBy = reason;
      marked += 1;
    }
    if (marked) writeActiveAtomic(events);
    return { ok: true, marked, skipped, badLines };
  });
}

/** 归档文件的月份键：按 processedAt 落在哪个月。 */
function monthOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function archiveFile(month) {
  return path.join(ARCHIVE_DIR, `${month}.ndjson.gz`);
}

/** 读一个归档月（解压 + 逐行解析）。 */
function readArchive(month) {
  try {
    const buf = fs.readFileSync(archiveFile(month));
    const text = zlib.gunzipSync(buf).toString('utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 把「已处理且超过 keepDays」的事件搬进按月 gzip。
 *
 * 完整性校验（D5 要求）：归档后 active 里不能再出现这些 eventId，
 * 且归档里不能有重复 eventId —— 校验不过就**不删 active**，保留原样报错。
 */
export function archiveProcessed({ keepDays = DEFAULT_KEEP_DAYS, now = Date.now(), dryRun = false } = {}) {
  const cutoff = now - keepDays * DAY_MS;
  return withEventsLock(() => {
    const { events, badLines } = readActive();
    if (!events.length) return { ok: true, archived: 0, kept: 0, badLines };

    const eligible = [];
    const kept = [];
    for (const ev of events) {
      const t = ev.processed ? Date.parse(ev.processedAt || '') : NaN;
      if (ev.processed && Number.isFinite(t) && t < cutoff) eligible.push(ev);
      else kept.push(ev);
    }
    if (!eligible.length) return { ok: true, archived: 0, kept: kept.length, badLines };

    // 按月分组
    const byMonth = new Map();
    for (const ev of eligible) {
      const m = monthOf(ev.processedAt) || monthOf(ev.ts) || 'unknown';
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(ev);
    }

    if (dryRun) {
      return { ok: true, dryRun: true, archived: eligible.length, kept: kept.length, months: [...byMonth.keys()] };
    }

    const stats = {};
    for (const [month, list] of byMonth) {
      const existing = readArchive(month);
      const seen = new Set(existing.map((e) => String(e.eventId)));
      const merged = [...existing];
      let added = 0;
      for (const ev of list) {
        if (seen.has(String(ev.eventId))) continue;   // 归档里已有，不重复写
        merged.push(ev);
        seen.add(String(ev.eventId));
        added += 1;
      }
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const body = merged.map((e) => JSON.stringify(e)).join('\n');
      const gz = zlib.gzipSync(Buffer.from(`${body}\n`, 'utf8'));
      const tmp = `${archiveFile(month)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, gz);
      fs.renameSync(tmp, archiveFile(month));
      // 完整性：重新解压读一遍，确认条数与去重都符合
      const check = readArchive(month);
      const checkIds = new Set(check.map((e) => String(e.eventId)));
      if (checkIds.size !== merged.length) {
        return { ok: false, error: `归档校验失败（${month}）：期望 ${merged.length} 条，实际唯一 ${checkIds.size} 条`, archived: 0, kept: events.length };
      }
      stats[month] = { added, total: merged.length, bytes: gz.length };
    }

    writeActiveAtomic(kept);
    return { ok: true, archived: eligible.length, kept: kept.length, months: stats, badLines };
  });
}

/** 目录占用（active + archive 总和）。 */
export function storage() {
  const sizeOf = (p) => {
    try { return fs.statSync(p).size; } catch { return 0; }
  };
  let archiveBytes = 0;
  let archiveFiles = 0;
  try {
    for (const f of fs.readdirSync(ARCHIVE_DIR)) {
      if (!f.endsWith('.ndjson.gz')) continue;
      archiveFiles += 1;
      archiveBytes += sizeOf(path.join(ARCHIVE_DIR, f));
    }
  } catch { /* 还没归档过 */ }
  const activeBytes = sizeOf(ACTIVE_FILE);
  const totalBytes = activeBytes + archiveBytes;
  let level = 'ok';
  if (totalBytes >= DISK_STOP_BYTES) level = 'stop';
  else if (totalBytes >= DISK_WARN_BYTES) level = 'warn';
  return {
    activeBytes,
    archiveBytes,
    archiveFiles,
    totalBytes,
    level,
    warnBytes: DISK_WARN_BYTES,
    stopBytes: DISK_STOP_BYTES
  };
}

/** 事件系统健康（给面板/日志用）。 */
export function health({ now = Date.now() } = {}) {
  const { events, badLines, missing } = readActive();
  const unprocessed = events.filter((e) => !e.processed);
  const processed = events.filter((e) => e.processed);
  const oldestUnprocessed = unprocessed
    .map((e) => Date.parse(e.ts))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0] || 0;
  const store = storage();
  const issues = [];
  if (missing) issues.push({ level: 'info', code: 'no-events', message: '还没有事件文件（还没重启过？）' });
  if (badLines) issues.push({ level: 'warn', code: 'bad-lines', message: `${badLines} 行无法解析（半截写入或被外部改过）` });
  if (oldestUnprocessed && now - oldestUnprocessed > 7 * DAY_MS) {
    issues.push({ level: 'warn', code: 'stale-unprocessed', message: `最老的未处理事件已 ${Math.floor((now - oldestUnprocessed) / DAY_MS)} 天没被消费` });
  }
  if (store.level === 'warn') issues.push({ level: 'warn', code: 'disk-warn', message: `事件存储 ${(store.totalBytes / 1048576).toFixed(1)} MB，超过 500 MB 提醒线` });
  if (store.level === 'stop') issues.push({ level: 'error', code: 'disk-stop', message: `事件存储 ${(store.totalBytes / 1048576).toFixed(1)} MB，超过 1 GB，暂停归档扩张` });

  return {
    ok: issues.every((i) => i.level !== 'error'),
    checkedAt: now,
    total: events.length,
    unprocessed: unprocessed.length,
    processed: processed.length,
    oldestUnprocessedAt: oldestUnprocessed,
    badLines,
    storage: store,
    issues
  };
}

export const __paths = { EVENTS_DIR, ARCHIVE_DIR, ACTIVE_FILE };
