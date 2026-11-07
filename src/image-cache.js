// 消息图片留存（"老图还能不能看"的根治手段）
//
// ── 为什么需要它（实测 2026-10-12，NapCat v4.18.37 + QQ 9.9.36）──────────────
// 一条图片消息在存档里只留下两样东西，**两样都会过期**：
//   ① media[].url  —— 腾讯 CDN 直链，约 1 小时后失效（19 小时前的图直接 HTTP 400）；
//   ② media[].file —— 协议端缓存的 file key，NapCat 的 get_image 认它，但
//      QQ 自己会清理缓存：实测同一批 19 小时前的图，3 张里只有 1 张还能
//      取回本地文件，另外 2 张 get_image 直接回 `file not found`。
// 于是"引用较早消息里的图片"必然失败 —— 除非我们在**收到消息的那一刻**
// 就把字节留下来（那一刻 url 是新鲜的、NapCat 缓存也一定在）。
//
// ── 取舍 ──────────────────────────────────────────────────────────────────
// 这是**主动占盘**的功能，所以：默认只收图片/表情（不收视频、语音），
// 有体积上限（config.media.imageCache.maxMb，超了按最久未用的删），
// 并且可以整个关掉（enabled=false）。命中次数会记录，便于判断值不值得留。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { getConfig, DATA_DIR } from './config.js';
import { isResetBarrierActive } from './reset-barrier.js';

/** 索引文件名：记录体积/时间/命中次数，用于淘汰与统计。 */
const INDEX_FILE = 'index.json';
/** 低于这个字节数的图不值得占盘（多为 1x1 占位/失败图）。 */
const MIN_BYTES = 1024;
/** 单张上限：与下载路径保持一致（15MB）。 */
const MAX_BYTES = 15 * 1024 * 1024;
/** 待写队列上限：刷屏时宁可丢几张，也不让内存无限涨。 */
const QUEUE_LIMIT = 64;

export function imageCacheDir() {
  // 用 config 的 DATA_DIR（而不是 process.cwd()）：它带 profile 后缀、也认
  // QQ_AGENT_DATA_DIR 环境变量 —— 第二实例/自定义数据目录下缓存才不会串味。
  return path.join(DATA_DIR, 'image-cache');
}

function indexPath() {
  return path.join(imageCacheDir(), INDEX_FILE);
}

/**
 * 缓存 key：mid + file 的 sha1 前 20 位。
 *
 * 刻意**不用** mid 单独做 key：同一条消息可能带多张图（media 数组），
 * 只用 mid 会互相覆盖。file 缺失时退回 mid + 序号（由调用方保证唯一）。
 */
export function cacheKeyOf({ mid, file = '' } = {}) {
  const basis = `${String(mid ?? '')}|${String(file || '')}`;
  if (!basis.replace('|', '')) return '';
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 20);
}

/**
 * 从消息条目取"缓存标识"。
 *
 * 必须**唯一一处**决定：写侧（ingest 留底）与读侧（get_message_images）用不同的
 * 表达式取 id，就会出现"存了但永远读不到"的静默失效。这里兼容两种 id：
 * 有 QQ 消息 id 用 mid（最稳，跨重启一致），没有的（拍一拍之类）退回本地自增 id。
 */
export function mediaIdOf(entry) {
  if (!entry) return '';
  return String(entry.mid ?? entry.id ?? entry.localId ?? '');
}

/** 读索引。文件损坏/不存在都当空索引（自愈，不让缓存把功能搞崩）。 */
function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') return raw;
  } catch { /* 空索引 */ }
  return { entries: {} };
}

function saveIndex(index) {
  if (isResetBarrierActive()) return; // reset 期间不重建 image-cache
  try {
    const dir = imageCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    // 先写临时文件再改名：避免进程被杀时留下半个 JSON（下次启动读不动）
    const tmp = `${indexPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, indexPath());
  } catch { /* 索引写不了不影响图片本身 */ }
}

function extOf(buffer) {
  if (!buffer || buffer.length < 12) return '.bin';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
  if (buffer.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp';
  return '.bin';
}

/** 体积上限（字节）。0 或负数 = 不限（由调用方显式选择）。 */
function quotaBytes() {
  const mb = Number(getConfig().media?.imageCache?.maxMb);
  const v = Number.isFinite(mb) && mb >= 0 ? mb : 512;
  return v * 1024 * 1024;
}
/**
 * 写一张图进缓存。
 * @returns {string} 落盘路径；未缓存（未开启/过小/过大/写失败）返回 ''
 */
export function archiveImage({ mid, file = '', buffer, chatKey = '' } = {}) {
  if (isResetBarrierActive()) return ''; // reset 期间不写图片缓存
  if (getConfig().media?.imageCache?.enabled !== true) return '';
  if (!buffer || buffer.length < MIN_BYTES || buffer.length > MAX_BYTES) return '';
  const key = cacheKeyOf({ mid, file });
  if (!key) return '';
  try {
    const dir = imageCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${key}${extOf(buffer)}`);
    fs.writeFileSync(dest, buffer);
    const index = loadIndex();
    index.entries[key] = {
      file: path.basename(dest),
      bytes: buffer.length,
      ts: Date.now(),
      mid: String(mid ?? ''),
      chatKey: String(chatKey || ''),
      hits: Number(index.entries[key]?.hits) || 0
    };
    index.bytes = Object.values(index.entries).reduce((n, e) => n + (Number(e?.bytes) || 0), 0);
    saveIndex(index);
    prune(index);
    return dest;
  } catch {
    return '';
  }
}

/**
 * 按体积上限淘汰：先删"最久没用过"的（hits 为 0 的优先，其次最老的）。
 * @param {object} [index]      索引（缺省读盘）
 * @param {number} [quotaOverride] 显式体积上限（字节），用于测试/调用方自带配额
 * @returns {number} 删掉的条数
 */
export function prune(index = loadIndex(), quotaOverride = null) {
  const quota = Number.isFinite(quotaOverride) ? Math.max(0, Number(quotaOverride)) : quotaBytes();
  if (!quota) return 0;
  const entries = Object.entries(index.entries);
  let total = entries.reduce((n, [, e]) => n + (Number(e?.bytes) || 0), 0);
  if (total <= quota) return 0;
  // 排序键：命中次数少的先删；同命中次数按时间老的先删
  const order = entries
    .map(([key, e]) => ({ key, e, hits: Number(e?.hits) || 0, ts: Number(e?.ts) || 0 }))
    .sort((a, b) => (a.hits - b.hits) || (a.ts - b.ts));
  let removed = 0;
  for (const item of order) {
    if (total <= quota) break;
    try { fs.rmSync(path.join(imageCacheDir(), String(item.e.file || '')), { force: true }); } catch { /* 文件可能已不在 */ }
    total -= Number(item.e?.bytes) || 0;
    delete index.entries[item.key];
    removed++;
  }
  index.bytes = total;
  saveIndex(index);
  return removed;
}

/**
 * 取一张图的字节。
 * @returns {{buffer: Buffer, path: string}|null} 未命中返回 null
 */
export function readCachedImage({ mid, file = '' } = {}) {
  const key = cacheKeyOf({ mid, file });
  if (!key) return null;
  const index = loadIndex();
  const entry = index.entries[key];
  if (!entry?.file) return null;
  const full = path.join(imageCacheDir(), String(entry.file));
  try {
    const buffer = fs.readFileSync(full);
    if (!buffer.length) return null;
    // 记录命中：淘汰策略据此判断"这张图到底有没有人看"
    entry.hits = (Number(entry.hits) || 0) + 1;
    entry.lastHit = Date.now();
    index.entries[key] = entry;
    saveIndex(index);
    return { buffer, path: full };
  } catch {
    // 索引有、文件没了（被手工删/被清理）→ 顺手修正索引，下次不再白找
    delete index.entries[key];
    saveIndex(index);
    return null;
  }
}

/** 统计（给控制台/排障用）。 */
export function imageCacheStats() {
  const index = loadIndex();
  const entries = Object.values(index.entries);
  return {
    enabled: getConfig().media?.imageCache?.enabled === true,
    count: entries.length,
    bytes: entries.reduce((n, e) => n + (Number(e?.bytes) || 0), 0),
    quotaMb: Math.round(quotaBytes() / 1024 / 1024),
    hits: entries.reduce((n, e) => n + (Number(e?.hits) || 0), 0)
  };
}

/**
 * 清掉"文件在、索引里没有"的孤儿文件，返回删除个数。
 *
 * 为什么需要：索引是"先写图片、再写索引"，中间被杀进程（任务管理器结束、
 * 断电）就会留下一个永远不被引用、也永远不会被 prune 看到的文件 —— 纯占盘。
 * 启动时扫一次足够（正常运行中不会产生孤儿）。
 */
export function cleanupOrphans() {
  if (getConfig().media?.imageCache?.enabled !== true) return 0;
  try {
    const dir = imageCacheDir();
    const index = loadIndex();
    const known = new Set(
      Object.values(index.entries).map((e) => String(e?.file || '')).filter(Boolean)
    );
    const names = fs.readdirSync(dir).filter((n) => n !== INDEX_FILE && n !== `${INDEX_FILE}.tmp`);
    // ⚠️ 安全阀：索引为空（被删/损坏/首次运行）时，目录里的文件**全都**像孤儿。
    // 这时删下去等于把整个库存清空 —— 宁可留下垃圾，也不能让一次索引损坏
    // 变成"用户的图全没了"。有明确误删风险的方向，默认选不删。
    if (!known.size && names.length > 1) return 0;
    let removed = 0;
    for (const name of names) {
      if (known.has(name)) continue;
      try { fs.rmSync(path.join(dir, name), { force: true }); removed++; } catch { /* 删不掉就留着 */ }
    }
    return removed;
  } catch {
    return 0;   // 目录还不存在（首次运行）等任何异常都无害
  }
}

// 写入队列 ──────────────────────────────────────────────────────────────
// ingest 是热路径：下载/读盘不能同步卡在上面（同 app.js 里 forwardLinkedMedia 的
// 定位）。这里串行跑；队列满了丢**最老**的那条（它对应的消息最可能已经被刷过去），
// 保新不保旧 —— 宁可少留一张，也不要让队列在内存里无上限堆积。

let running = 0;
const queue = [];

/**
 * 把"给某条消息的图片留个底"排进队列（不 await、不抛错）。
 * @param {Function} loader 返回 Promise<{mid, file, buffer, chatKey}|null> 的取字节函数
 */
export function queueImageArchive(loader) {
  if (getConfig().media?.imageCache?.enabled !== true) return;
  if (typeof loader !== 'function') return;
  while (queue.length >= QUEUE_LIMIT) queue.shift();
  queue.push(loader);
  pump();
}

function pump() {
  while (running < 2 && queue.length) {
    const loader = queue.shift();
    running++;
    Promise.resolve()
      .then(loader)
      .then((r) => {
        if (!r) return;
        // loader 约定：返回 { mid, file, buffer, chatKey } 或 null
        if (r.buffer?.length) archiveImage(r);
      })
      .catch(() => { /* 留底失败不影响任何主流程 */ })
      .finally(() => { running--; pump(); });
  }
}
