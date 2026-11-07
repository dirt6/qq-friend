// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"已读信息"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
//
// ── 并发安全（2026-11-03，W2）─────────────────────────────────────────────
// 所有写操作都走 `#update()`：**跨进程锁内重读磁盘 → 施加动作 → 原子写**。
// 调用方不再提交"内存快照"——那是旧实现丢消息的根因（原子写 ≠ 并发安全，
// 两个进程各读旧值再互相覆盖）。写方法因此全部是 async；读方法仍是同步
// （读缓存，不参与写入协议）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { recordMessageEvent } from './companion/events.js';
import { logger } from './logger.js';
import { withFileLockAsync, writeFileAtomic } from './file-lock.js';
import { assertWritesAllowed } from './reset-barrier.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
// D1-3b-B5：聊天存档删除前的备份（唯一目录、逐文件 hash；失败则拒绝删除）。
const CHAT_BACKUP_DIR = path.join(DATA_DIR, 'backups', 'chats');
const CHAT_BACKUP_AUDIT = path.join(CHAT_BACKUP_DIR, 'audit.jsonl');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function auditChatBackup(record) {
  try {
    fs.mkdirSync(CHAT_BACKUP_DIR, { recursive: true });
    fs.appendFileSync(CHAT_BACKUP_AUDIT, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8');
  } catch { /* 审计失败不阻塞删除 */ }
}

/**
 * 备份某会话的 messages 文件到唯一目录并校验 hash。
 * **必须在 #update 的锁内调用**，保证备份与删除看到同一份数据。
 */
function backupChatFile(chatKey, reason) {
  const file = chatFile(chatKey);
  if (!fs.existsSync(file)) return { ok: true, skipped: true, backupDir: '' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const opId = crypto.randomBytes(4).toString('hex');
  const dir = path.join(CHAT_BACKUP_DIR, String(chatKey).replace(/[^a-z0-9_]/gi, '_'), `${stamp}-${opId}`);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'messages.json');
  fs.copyFileSync(file, dst);
  const srcHash = sha256File(file);
  const dstHash = sha256File(dst);
  if (srcHash !== dstHash) throw new Error(`聊天存档备份校验失败：${chatKey}`);
  const size = fs.statSync(file).size;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 1,
    chatKey,
    reason,
    createdAt: new Date().toISOString(),
    source: file,
    backupDir: dir,
    file: { rel: 'messages.json', sha256: srcHash, size }
  }, null, 1), 'utf8');
  auditChatBackup({ chatKey, reason, backupDir: dir, sha256: srcHash, size, result: 'prepared' });
  return { ok: true, backupDir: dir, sha256: srcHash };
}

// 锁等待预算：2 秒（100 × 20ms）。正常单进程 0 等待；双进程偶发冲突足够。
// 不照搬经验库的 30 秒 —— 聊天写频率更高，主线程冻结代价太大（异步锁只
// 冻结这一个写操作，但 30 秒的"写不进去"本身也不可接受）。
const LOCK_OPTS = { retries: 100, waitMs: 20 };

// 判重（2026-11-03 P1）：
//   · 主判据 = mid + senderId + self + 完整内容（text/media/reply/isPoke）；
//   · 时间窗**不再是唯一依据**，只作为"同一次投递"的辅助保护：
//     防止 OneBot 重连复用 mid 且内容恰好相同的极端情况被误判为重复。
//   · 同 mid 但身份/内容不同 → 两条都保留，并写一条冲突记录（不静默丢弃）。
const DUP_WINDOW_MS = 2 * 60 * 1000;
const MAX_CONFLICTS = 50;

function chatFile(chatKey) {
  // chatKey 形如 group:123 / private:456
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

/** 空会话（文件不存在）。 */
function emptyChat(chatKey) {
  return { chatKey, nextLocalId: 1, messages: [] };
}

/** 稳定序列化（键排序），用于内容指纹。 */
function stableStringify(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/** 消息内容指纹：文本 + 媒体段 + 引用 + 拍一拍标记（完整比较，含非文本消息）。 */
function contentFingerprint(msg) {
  return stableStringify({
    text: String(msg?.text ?? ''),
    media: Array.isArray(msg?.media) ? msg.media : [],
    reply: msg?.reply ?? null,
    isPoke: Boolean(msg?.isPoke)
  });
}

function sameContent(a, b) {
  return contentFingerprint(a) === contentFingerprint(b);
}

/** 同 mid 的全部历史条目（mid 为 null/0 不参与判重）。 */
function findMidRecords(state, mid) {
  if (mid === null || mid === undefined || String(mid) === '' || Number(mid) === 0) return [];
  const target = String(mid);
  return state.messages.filter((m) => m && m.mid !== null && m.mid !== undefined && String(m.mid) === target);
}

/**
 * 判重结论：
 *   `identical` —— 同一事件的重复投递（mid + senderId + self + 内容 + 短窗都一致）→ 幂等跳过；
 *   `conflict`  —— 同 mid 但身份/内容不同（或时间差超出短窗）→ 两条都保留 + 冲突记录；
 *   null        —— 没有同 mid 历史 / null mid → 正常追加。
 */
function classifyDuplicate(state, incoming) {
  const records = findMidRecords(state, incoming.mid);
  if (!records.length) return null;
  const t = Number(incoming.ts) || 0;
  const identical = records.find((m) => (
    String(m.senderId) === String(incoming.senderId) &&
    Boolean(m.self) === Boolean(incoming.self) &&
    sameContent(m, incoming) &&
    Math.abs((Number(m.ts) || 0) - t) <= DUP_WINDOW_MS
  ));
  if (identical) return { type: 'identical', entry: identical };
  return { type: 'conflict', entry: records[records.length - 1] };
}

function conflictReason(existing, incoming) {
  if (Boolean(existing?.self) !== Boolean(incoming?.self)) return 'different-self';
  if (String(existing?.senderId) !== String(incoming?.senderId)) return 'different-sender';
  if (!sameContent(existing, incoming)) return 'different-content';
  return 'time-gap';
}

function summarizeConflictEntry(m) {
  return {
    senderId: String(m?.senderId ?? ''),
    self: Boolean(m?.self),
    ts: Number(m?.ts) || 0,
    text: String(m?.text ?? '').slice(0, 200),
    mediaCount: Array.isArray(m?.media) ? m.media.length : 0,
    mediaKinds: Array.isArray(m?.media) ? m.media.map((x) => x?.kind ?? '?').slice(0, 5) : []
  };
}

/**
 * 冲突记录：有界容量（MAX_CONFLICTS），滚动挤掉最老的诊断信息。
 * **正式消息不受容量影响** —— 冲突消息本身照常进 messages。
 */
function recordConflict(state, incomingEntry, existingEntry) {
  if (!Array.isArray(state.conflicts)) state.conflicts = [];
  state.conflicts.push({
    at: Date.now(),
    mid: incomingEntry.mid ?? null,
    existingId: existingEntry?.id ?? null,
    incomingId: incomingEntry.id,
    reason: conflictReason(existingEntry, incomingEntry),
    existing: summarizeConflictEntry(existingEntry),
    incoming: summarizeConflictEntry(incomingEntry)
  });
  while (state.conflicts.length > MAX_CONFLICTS) state.conflicts.shift();
}

/** 文件指纹是否相同（缓存失效检测用）。 */
function sameStamp(a, b) {
  if (a === null && b === null) return true;
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * 损坏存档：**复制**备份，不移动原文件。
 *
 * 为什么用 copy 而不是 rename：rename 走之后原文件就不存在了，下一次
 * loadChat 会按"新会话"给空状态，再写盘就把空文件落上去 —— 等于清空。
 * 原文件原地不动，才能保证"损坏时禁止写入"是真的禁止。
 *
 * 备份名带原文件 mtime，同一份损坏内容只备份一次（不产生垃圾）。
 */
function backupCorruptChat(chatKey) {
  const file = chatFile(chatKey);
  let st;
  try { st = fs.statSync(file); } catch { return null; }   // 文件已经不在了：无需备份
  const bak = `${file}.broken-${Math.round(st.mtimeMs)}`;
  if (fs.existsSync(bak)) return bak;
  try {
    fs.copyFileSync(file, bak);
  } catch (e) {
    const err = new Error(`聊天存档损坏且备份失败，禁止写入：${path.basename(file)} —— ${e?.message ?? e}`);
    err.code = 'ECHAT_BACKUP_FAILED';
    err.cause = e;
    throw err;
  }
  return bak;
}

function corruptError(chatKey, reason, bak) {
  const err = new Error(
    `聊天存档损坏（${reason}）：${path.basename(chatFile(chatKey))}` +
    (bak ? `，已备份为 ${path.basename(bak)}` : '')
  );
  err.code = 'ECHAT_CORRUPTED';
  return err;
}

/**
 * 读聊天存档。
 *
 * @param {string} chatKey
 * @param {{onCorrupt?: 'empty'|'throw'}} [opts]
 *   - `empty`（读路径默认）：损坏 → 备份 + 记 warn + 返回空状态（**不写盘**）
 *   - `throw`（写路径必须用 loadChatForWrite）：损坏 → 备份 + 抛 ECHAT_CORRUPTED
 *
 * 文件不存在（ENOENT）与文件损坏是两回事：
 *   ENOENT   = 新会话，返回空状态，正常
 *   其他错误 = 真实错误（权限 / 损坏 / 备份失败），一律不吞
 */
export function loadChat(chatKey, { onCorrupt = 'empty' } = {}) {
  const file = chatFile(chatKey);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return emptyChat(chatKey);
    throw e;
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  let parsed = null;
  let reason = '';
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    reason = `JSON 解析失败：${e?.message ?? e}`;
  }
  if (!reason && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.messages))) {
    reason = '结构不是 { messages: [...] }';
  }
  if (reason) {
    const bak = backupCorruptChat(chatKey);
    if (onCorrupt === 'throw') throw corruptError(chatKey, reason, bak);
    logger.warn('store', `聊天存档损坏，已备份并当空会话展示（不写盘）：${path.basename(file)} —— ${reason}`);
    return emptyChat(chatKey);
  }
  return parsed;
}

/**
 * 写路径专用读：损坏时抛错，**绝不**返回空状态。
 * 任何"读-改-写"都必须在锁内用它读，否则空状态会覆盖磁盘。
 */
export function loadChatForWrite(chatKey) {
  return loadChat(chatKey, { onCorrupt: 'throw' });
}

export class ChatStore {
  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map();  // chatKey -> state
    this.stamps = new Map(); // chatKey -> { mtimeMs, size } | null（文件不存在）
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  /** 文件当前指纹（用于判定外部写入/删除）。失败给 null。 */
  #statOf(chatKey) {
    try {
      const st = fs.statSync(chatFile(chatKey));
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  /**
   * 取会话状态（读路径）。
   *
   * 每次读都 stat 一次目标文件：指纹没变就用缓存，变了就重读。
   * 这是**缓存失效检测**，不是并发控制 —— 写仍然只能走 #update 的锁。
   * 没有它，另一个进程写入/删除的消息在本进程里永远看不见（展示与上下文都是旧的）。
   */
  #state(chatKey) {
    const cached = this.chats.get(chatKey);
    const stamp = this.stamps.get(chatKey);
    const now = this.#statOf(chatKey);
    if (cached !== undefined && stamp !== undefined && sameStamp(stamp, now)) return cached;
    const state = loadChat(chatKey);
    this.chats.set(chatKey, state);
    this.stamps.set(chatKey, now);
    return state;
  }

  /**
   * 唯一的写入口：跨进程锁内读-改-写。
   *
   * mutator 拿到的 `fresh` 是**磁盘最新状态**（不是调用方手里的缓存）；
   * 返回 `{ value, write }`：`write:false` 表示无变化、不落盘（幂等命中）。
   * 写成功后把 fresh 放进缓存，保证本进程后续读路径一致。
   */
  async #update(chatKey, mutator, opts = {}) {
    // reset 删除期间阻止聊天历史写入（协作式屏障，见 reset-barrier.js）。
    assertWritesAllowed('聊天历史写入');
    const file = chatFile(chatKey);
    return withFileLockAsync(file, () => {
      const fresh = loadChatForWrite(chatKey);
      const ret = mutator(fresh);
      if (!ret || typeof ret !== 'object') throw new Error('store mutator 必须返回 { value, write }');
      const { value, write = true } = ret;
      if (write) writeFileAtomic(file, JSON.stringify(fresh, null, 1));
      this.chats.set(chatKey, fresh);
      this.stamps.set(chatKey, this.#statOf(chatKey));
      return value;
    }, { ...LOCK_OPTS, ...opts });
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json -> group:123），已加载的直接带上
    try {
      const files = fs.readdirSync(MESSAGES_DIR).filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) this.#state(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()];
  }

  /**
   * 只读检查存档是否存在/结构有效（不加载、不备份、不写盘）。
   * 供 Core 区分“缺失=正常空”和“损坏=明确失败”。
   */
  chatStatus(chatKey) {
    const file = chatFile(chatKey);
    if (!fs.existsSync(file)) return { exists: false, valid: true };
    try {
      let text = fs.readFileSync(file, 'utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.messages)) {
        return { exists: true, valid: false, error: '结构不是 { messages: [...] }' };
      }
      return { exists: true, valid: true };
    } catch (e) {
      return { exists: true, valid: false, error: String(e?.message ?? e) };
    }
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    // 未读只计他人消息（与 unreadCount / peekUnread 口径一致）——
    // 曾经用 !m.read 把 self 也算进去，机器人自己的发言会把角标顶大。
    const unread = st.messages.filter((m) => !m.read && !m.self).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /**
   * 追加一条收到的消息（未读）。
   *
   * 判重：同 mid + 同 senderId + 同 self + 同内容 + 短时间窗 → 幂等返回已有条目；
   * 同 mid 但身份/内容不同 → 两条都保留，并写一条冲突记录（不静默丢弃）。
   */
  async appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, atMe = null, atNames = [] }) {
    let created = null;
    const entry = await this.#update(chatKey, (st) => {
      const incoming = {
        mid: mid ?? null,
        ts: ts || Date.now(),
        senderId: String(senderId ?? ''),
        self: false,
        text: String(text ?? ''),
        reply: reply || null,
        media: Array.isArray(media) ? media : [],
        isPoke: Boolean(isPoke)
      };
      const verdict = classifyDuplicate(st, incoming);
      if (verdict?.type === 'identical') return { value: verdict.entry, write: false };
      const e = {
        id: st.nextLocalId++,
        mid: incoming.mid,
        ts: incoming.ts,
        senderId: incoming.senderId,
        senderName: String(senderName ?? ''),
        text: incoming.text,
        self: false,
        read: false,
        reply: incoming.reply,
        media: incoming.media,
        // 拍一拍事件：可作触发批（resolveContextTier 按 1 档响应），但不进【已读信息】
        isPoke: incoming.isPoke,
        // @ 判定标记（2026-09-26）：atMe 以 @ 段的 QQ 号为准 —— 文本包含匹配
        // 分不清"同名不同人"（群友 @ 的人与机器人重名时被误判为 @机器人）。
        // null = 老存档未标，判定层回落文本匹配。
        atMe: atMe === null || atMe === undefined ? null : Boolean(atMe),
        // 渲染进 text 的 @片段原文（含 @ 前缀）：关键词判定据此剔除，
        // 防"@ 别人的名字里带关键词"误触发。空数组 = 该消息没有 @ 段。
        atNames: (Array.isArray(atNames) ? atNames : []).map((n) => String(n ?? '')).filter(Boolean).slice(0, 20)
      };
      if (verdict?.type === 'conflict') recordConflict(st, e, verdict.entry);
      st.messages.push(e);
      this.#trim(st);
      created = e;
      return { value: e };
    });
    // 4.0 阶段 1.1：统一事件日志。事件系统故障不影响聊天（recordMessageEvent 内部吞错）。
    // 幂等命中不记事件 —— 同一条消息只应该有一条事件。
    if (created) {
      try {
        recordMessageEvent({ kind: 'incoming', chatKey, mid: entry.mid, localId: entry.id, ts: entry.ts, text: entry.text });
      } catch { /* 事件失败不影响消息 */ }
    }
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。判重规则同 appendIncoming。 */
  async appendSelf(chatKey, { text, ts, mid = null }) {
    let created = null;
    const entry = await this.#update(chatKey, (st) => {
      const incoming = {
        mid: mid ?? null,
        ts: ts || Date.now(),
        senderId: 'self',
        self: true,
        text: String(text ?? ''),
        reply: null,
        media: [],
        isPoke: false
      };
      const verdict = classifyDuplicate(st, incoming);
      if (verdict?.type === 'identical') return { value: verdict.entry, write: false };
      const e = {
        id: st.nextLocalId++,
        mid: incoming.mid,
        ts: incoming.ts,
        senderId: 'self',
        senderName: '我',
        text: incoming.text,
        self: true,
        read: true,
        reply: null,
        media: []
      };
      if (verdict?.type === 'conflict') recordConflict(st, e, verdict.entry);
      st.messages.push(e);
      this.#trim(st);
      created = e;
      return { value: e };
    });
    if (created) {
      try {
        recordMessageEvent({ kind: 'outgoing', chatKey, mid: entry.mid, localId: entry.id, ts: entry.ts, text: entry.text });
      } catch { /* 事件失败不影响消息 */ }
    }
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  async drainUnread(chatKey) {
    return this.#update(chatKey, (st) => {
      const unread = st.messages.filter((m) => !m.read && !m.self);
      for (const m of st.messages) m.read = true;
      return { value: unread };
    });
  }

  /**
   * 只 drain「从某条消息起**之后**」的未读：取走触发批，之前的旧积压单独标已读。
   *
   * 为什么需要它（2026-09-25 触发链路重做的补丁）：磁盘上可能遗留旧进程/
   * 暂停期间攒下的积压未读。它们从未经过 onIncoming 的逐条判定，如果一次
   * 触发的 drain 把它们全部吃进触发批，模型会看到一大坨"未读信息"——用户
   * 看到的就是"积压消息被整批塞进唤醒"。正确语义：
   *   · 触发消息 X 之后的未读 = 本批的聚批对象（X 也在内）；
   *   · X 之前的旧未读 = 触发前就该已读的历史 → 标已读沉入【已读信息】。
   *
   * @param {string} chatKey
   * @param {number} fromTs 批的起点（触发消息的 ts，含）；早于它的未读标已读
   * @returns {{ batch: object[], archived: number }} batch = 触发批，archived = 被归档的旧未读条数
   */
  async drainUnreadFrom(chatKey, fromTs) {
    return this.#update(chatKey, (st) => {
      const unread = st.messages.filter((m) => !m.read && !m.self);
      const batch = [];
      let archived = 0;
      for (const m of unread) {
        if (m.ts >= fromTs) batch.push(m);
        else { m.read = true; archived++; }   // 触发点之前的旧积压：沉入历史
      }
      for (const m of st.messages) m.read = true;   // batch 里的也置已读（作为触发批取走）
      return { value: { batch, archived } };
    });
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  async markAllRead(chatKey) {
    return this.#update(chatKey, (st) => {
      let n = 0;
      for (const m of st.messages) {
        if (!m.read && !m.self) { m.read = true; n++; }
      }
      return { value: n, write: n > 0 };
    });
  }

  /**
   * 把**单条**消息标记为已读（不取走）。
   *
   * 逐条触发判定（onIncoming）用：该条不触发会话时当场标已读、沉入历史，
   * 不动其它未读 —— 那些是"倒计时窗口内追加的"或"上一批遗留的"，
   * 各有自己的归宿（前者等 drain，后者等兜底或下一次触发）。
   *
   * @param {string} chatKey
   * @param {number} id 消息条目的本地 id（appendIncoming 返回的 entry.id）
   * @returns {boolean} 是否真的标记了（false = 没找到/本来就是已读）
   */
  async markEntryRead(chatKey, id) {
    return this.#update(chatKey, (st) => {
      const m = st.messages.find((x) => x.id === id);
      if (!m || m.read || m.self) return { value: false, write: false };
      m.read = true;
      return { value: true };
    });
  }

  /**
   * 把时间窗内的**已读**消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束 —— 窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  async markUnreadInWindow(chatKey, startedAt, endedAt) {
    return this.#update(chatKey, (st) => {
      const winStart = Number(startedAt) - 5 * 60 * 1000;
      const winEnd = Number(endedAt || startedAt) + 1000;
      let n = 0;
      for (const m of st.messages) {
        if (m.self) continue;
        if (m.read && m.ts >= winStart && m.ts <= winEnd) { m.read = false; n++; }
      }
      return { value: n, write: n > 0 };
    });
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true, mine = false } = {}) {
    const st = this.#state(chatKey);
    // mine：只返回自己发的（撤回/引用自己的发言时用）。
    // ⚠️ 2026-10-17 修：签名原先没有 mine，调用方传了会被静默忽略 ——
    //   recall_message 以为拿到的是"自己最近发的消息"，其实是全部消息；
    //   群聊里 lastN=1 撞上别人刚说的、而 recallOthers=true 时，就会误撤群友的消息。
    let all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    if (mine) all = all.filter((m) => m.self === true);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  /**
   * 标记一条消息已被用户撤回（按 QQ 消息 id）。
   * 撤回的消息后续不再发给大模型（buildPastState 会过滤 recalled）。
   * @returns {boolean} 是否找到并标记了
   */
  async markRecalled(chatKey, mid) {
    return this.#update(chatKey, (st) => {
      const target = String(mid);
      const m = st.messages.find((x) => String(x.mid) === target);
      if (!m) return { value: false, write: false };
      m.recalled = true;
      m.read = true;   // 撤回的消息也算"已读"，不再触发回复
      return { value: true };
    });
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  async updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    return this.#update(chatKey, (st) => {
      const target = String(mid);
      const m = st.messages.find((x) => String(x.mid) === target);
      if (!m) return { value: false, write: false };
      if (text != null) m.text = String(text);
      if (appendMedia.length) {
        m.media = Array.isArray(m.media) ? m.media : [];
        const seen = new Set(m.media.map((x) => x && x.url));
        for (const x of appendMedia) {
          if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
        }
      }
      return { value: true };
    });
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  async removeByLocalIds(chatKey, localIds = [], info = null) {
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number));
    if (!ids.size) return 0;
    const removed = await this.#update(chatKey, (st) => {
      const toRemove = st.messages.filter((m) => ids.has(m.id)).length;
      if (!toRemove) return { value: 0, write: false };
      // 锁内先备份（失败则抛错 → 不删除），再删。
      const backup = backupChatFile(chatKey, 'delete-messages');
      if (info && typeof info === 'object') Object.assign(info, { removed: toRemove, backupDir: backup.backupDir, backedUp: !backup.skipped });
      st.messages = st.messages.filter((m) => !ids.has(m.id));
      return { value: toRemove, write: true };
    });
    if (info && info.backupDir) {
      auditChatBackup({ chatKey, reason: 'delete-messages', backupDir: info.backupDir, removed, result: 'ok' });
    }
    return removed;
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * 会话文件保留（空 messages），下次来消息继续往里写。
   */
  async clearChat(chatKey, info = null) {
    const removed = await this.#update(chatKey, (st) => {
      const n = st.messages.length;
      if (!n) return { value: 0, write: false };
      // 锁内先备份（失败则抛错 → 不删除），再清空。
      const backup = backupChatFile(chatKey, 'clear');
      if (info && typeof info === 'object') Object.assign(info, { removed: n, backupDir: backup.backupDir, backedUp: !backup.skipped });
      st.messages = [];
      return { value: n, write: true };
    });
    if (info && info.backupDir) {
      auditChatBackup({ chatKey, reason: 'clear', backupDir: info.backupDir, removed, result: 'ok' });
    }
    return removed;
  }

  /**
   * 仅屏蔽（不删除）：把某会话的全部未读标记为已读。
   * 与 markAllRead 相同语义，这里显式命名供"仅屏蔽、不再发送"场景调用。
   * 返回标记的条数。
   */
  muteUnread(chatKey) {
    return this.markAllRead(chatKey);
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }
}
