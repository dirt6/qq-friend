// 群友印象记忆：每个会话一个文件夹，每个群友一个以 QQ 号命名的 JSON 文件。
// 目录结构：
//   data/memory/group_<群号>/<QQ>.json
//   data/memory/private_<QQ>/<QQ>.json
// 每个成员文件：{ userId, name, impressions: [{ content, createdAt }], updatedAt, lastConsolidatedAt }
// 旧版单文件 data/memory/group_<群号>.json 会在首次访问时自动迁移。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';
import { resolveCorrectionState } from './learned.js';
import { withMemoryPortLock } from './memory-port-lock.js';
import { assertWritesAllowed } from './reset-barrier.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function legacyFile(chatKey) {
  return path.join(MEMORY_DIR, `${chatDirName(chatKey)}.json`);
}

function chatDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey));
}

function metaFile(chatKey) {
  return path.join(chatDir(chatKey), '_meta.json');
}

function memberFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

function memberFile(chatKey, userId, name = '') {
  return path.join(chatDir(chatKey), memberFileName(userId, name));
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

// ── 删除备份（D1-3b-B3）───────────────────────────────────────────────
// 备份目录：data/memory/backups/<chatDir>/<stamp>-<opId>/
// 每次删除前复制目标并逐文件 SHA256 校验；校验失败拒绝删除。
const BACKUP_DIR = path.join(MEMORY_DIR, 'backups');
const BACKUP_AUDIT = path.join(BACKUP_DIR, 'audit.jsonl');

function newOpId() {
  return crypto.randomBytes(8).toString('hex');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 解析真实路径：不存在的尾段拼到最近存在祖先的 realpath 上。 */
function realish(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const rest = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const rp = fs.realpathSync.native(cur);
      return rest.length ? path.join(rp, ...rest.reverse()) : rp;
    } catch (e) {
      const code = e?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new Error(`路径解析失败（${code ?? 'UNKNOWN'}）：${cur}`);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  throw new Error(`无法可靠解析路径：${abs}`);
}

/** 目标必须严格位于 MEMORY_DIR 内（真实路径比较，不做字符串前缀）。 */
function assertMemoryPath(p) {
  const root = realish(MEMORY_DIR).toLowerCase();
  const target = realish(p).toLowerCase();
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error(`路径越界（不在记忆目录内）：${p}`);
  }
}

function auditMemoryDelete(record) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.appendFileSync(BACKUP_AUDIT, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8');
  } catch { /* 审计失败不阻塞删除 */ }
}

/**
 * 复制目标到唯一备份目录并逐文件校验。
 * @param {{chatKey:string, kind:'member'|'chat', files:{abs:string,rel:string}[]}} args
 */
function backupMemoryTarget({ chatKey, kind, files }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const opId = newOpId();
  const dir = path.join(BACKUP_DIR, chatDirName(chatKey), `${stamp}-${opId}`);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const f of files) {
    const dst = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f.abs, dst);
    const srcHash = sha256File(f.abs);
    const dstHash = sha256File(dst);
    if (srcHash !== dstHash) throw new Error(`备份校验失败：${f.rel}`);
    entries.push({ rel: f.rel, sha256: srcHash, size: fs.statSync(f.abs).size });
  }
  const manifest = { schema: 1, opId, chatKey, kind, createdAt: new Date().toISOString(), source: MEMORY_DIR, backupDir: dir, files: entries };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
  auditMemoryDelete({ opId, op: kind === 'member' ? 'removeMember' : 'removeChat', chatKey, backupDir: dir, files: entries.length, result: 'prepared' });
  return { opId, dir, files: entries };
}

/** 列出可识别的备份（读 audit.jsonl，只含 prepared 记录）。 */
export function listMemoryBackups() {
  try {
    return fs.readFileSync(BACKUP_AUDIT, 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * 从备份恢复（内部函数，不暴露路由）。
 * 拒绝：备份损坏、原目标已有新数据、路径越界。
 */
export function restoreMemoryBackup(backupDir) {
  const manifestPath = path.join(backupDir, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
    return { ok: false, error: `备份不可读：${String(e?.message ?? e)}` };
  }
  if (!manifest || !Array.isArray(manifest.files) || !manifest.chatKey) return { ok: false, error: '备份清单不完整' };
  // 校验备份完整性
  for (const f of manifest.files) {
    const file = path.join(backupDir, f.rel);
    let hash = 'missing';
    try { hash = sha256File(file); } catch { /* missing */ }
    if (hash !== f.sha256) return { ok: false, error: `备份损坏：${f.rel}` };
  }
  // 目标根与路径校验
  const rootDir = path.join(MEMORY_DIR, chatDirName(manifest.chatKey));
  const restored = [];
  for (const f of manifest.files) {
    const dest = f.rel === '_legacy.json' ? legacyFile(manifest.chatKey) : path.join(rootDir, f.rel);
    try { assertMemoryPath(dest); } catch (e) { return { ok: false, error: String(e.message) }; }
    if (fs.existsSync(dest)) return { ok: false, error: `目标已存在，拒绝覆盖：${f.rel}` };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(backupDir, f.rel), dest);
    restored.push(f.rel);
  }
  auditMemoryDelete({ opId: manifest.opId, op: 'restore', chatKey: manifest.chatKey, backupDir, files: restored.length, result: 'ok' });
  return { ok: true, restored, opId: manifest.opId };
}

function loadMember(chatKey, userId, name = '') {
  const file = memberFile(chatKey, userId, name);
  const raw = readJson(file, null);
  return {
    userId: String(raw?.userId ?? userId ?? ''),
    name: String(raw?.name ?? name ?? ''),
    impressions: Array.isArray(raw?.impressions) ? raw.impressions : [],
    updatedAt: Number(raw?.updatedAt) || 0,
    lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0
  };
}

function loadMeta(chatKey) {
  const raw = readJson(metaFile(chatKey), null);
  return { lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0 };
}

/* ── 印象元数据（4.0 / 3.0-R2）──────────────────────────────────── */
//
// 机主 2026-11-02 定的两个正交维度（和 learned 一致）：
//   · contentType   ：fact / preference / event / plan / other
//   · epistemicType ：direct / inferred / unknown
//
// 实测：生产数据里 impressions 已经是对象数组 {content, createdAt}，
// 所以**直接加字段**，不外挂 impressionMeta。

export const IMPRESSION_CONTENT_TYPES = ['fact', 'preference', 'event', 'plan', 'other'];
export const IMPRESSION_EPISTEMIC_TYPES = ['direct', 'inferred', 'unknown'];

const IMPRESSION_ID_PREFIX = 'imp-';

/**
 * 基于内容算稳定 ID（同内容 → 同 ID，天然幂等）。
 *
 * 4.0 / 3.0-R3 修正（机主 2026-11-02 提出）：
 *   原来是 SHA-1 前 6 位 = **24 bit**，按生日界限约 4096 条就有 50% 碰撞概率。
 *   现在改成 **SHA-256 前 16 位 = 64 bit**（约 42 亿条才 50%）。
 *
 * ⚠️ 但**截断哈希永远不能当作"不会碰撞"** —— 所以还有 resolveImpressionId 做冲突检测。
 */
export function impressionIdOf(content) {
  const t = String(content ?? '').trim();
  if (!t) return '';
  return IMPRESSION_ID_PREFIX + crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
}

/**
 * 解决 ID 冲突（4.0 / 3.0-R3）。
 *
 * 规则：
 *   · base ID 没被占用 → 直接用
 *   · base ID 被**同一内容**占用 → 也是 base（幂等）
 *   · base ID 被**不同内容**占用 → 加后缀 -2 / -3 …
 *   · 极端情况（100 个都撞）→ 用完整 sha256
 *
 * **绝不静默覆盖**：碰撞时换 ID，不换内容。
 */
export function resolveImpressionId(content, existing = []) {
  const t = String(content ?? '').trim();
  if (!t) return '';
  const base = impressionIdOf(t);
  if (!base) return '';

  const owners = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (e && e.id) owners.set(String(e.id), String(e.content ?? ''));
  }
  if (!owners.has(base) || owners.get(base) === t) return base;

  for (let i = 2; i < 100; i += 1) {
    const cand = base + '-' + i;
    if (!owners.has(cand) || owners.get(cand) === t) return cand;
  }
  return IMPRESSION_ID_PREFIX + crypto.createHash('sha256').update(t).digest('hex');
}

function pickImpEnum(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

/**
 * 给一条印象补元数据默认值（**只读，不写盘**）。
 * 旧数据不认识就老实说 unknown —— 不从 content 里猜。
 */
export function withImpressionMeta(imp) {
  if (!imp || typeof imp !== 'object') return imp;
  const content = String(imp.content ?? '');
  return {
    ...imp,
    id: String(imp.id || '') || impressionIdOf(content),
    contentType: pickImpEnum(imp.contentType, IMPRESSION_CONTENT_TYPES, 'other'),
    epistemicType: pickImpEnum(imp.epistemicType, IMPRESSION_EPISTEMIC_TYPES, 'unknown'),
    origin: imp.origin && typeof imp.origin === 'object'
      ? {
        kind: String(imp.origin.kind || 'unknown'),
        ref: String(imp.origin.ref || ''),
        at: String(imp.origin.at || ''),
        quote: String(imp.origin.quote || '').slice(0, 200)
      }
      : { kind: 'unknown', ref: '', at: '', quote: '' }
  };
}

export class MemoryStore {
  constructor({ impressionReader = null } = {}) {
    this.cache = new Map(); // chatKey -> Map(userId|_n_xx, member)
    // 4.0：统一读入口。生产 app 注入 Memory Hub 的 readImpressions；
    // 不注入时保持旧行为，避免测试/离线工具被强制改变。
    this.impressionReader = typeof impressionReader === 'function' ? impressionReader : null;
  }

  /** 扫描所有有记忆的会话（文件夹或旧版单文件）。 */
  listChats() {
    const out = new Set();
    try {
      for (const f of fs.readdirSync(MEMORY_DIR)) {
        if (fs.statSync(path.join(MEMORY_DIR, f)).isDirectory()) {
          const m = /^(group|private)_(\d+)$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        } else {
          const m = /^(group|private)_(\d+)\.json$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        }
      }
    } catch { /* 目录不存在 */ }
    return [...out];
  }

  /** 旧版单文件 → 新版每成员文件。迁移后旧文件移到 backups/。 */
  #migrateLegacy(chatKey) {
    const legacy = legacyFile(chatKey);
    if (!fs.existsSync(legacy)) return;
    try {
      if (fs.statSync(legacy).isDirectory()) return;
      const old = readJson(legacy, null);
      if (!old) return;
      const notes = getConfig().memberNotes || {};
      const nameToQq = {};
      for (const [qq, name] of Object.entries(notes)) {
        if (name) nameToQq[String(name)] = String(qq);
      }
      const migrated = [];
      for (const e of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
        if (!e?.content) continue;
        const target = String(e.target || '').trim();
        let userId = /^\d{5,15}$/.test(target) ? target : (nameToQq[target] || '');
        migrated.push({
          userId,
          name: target,
          content: String(e.content).slice(0, 300),
          createdAt: Number(e.createdAt) || Date.now()
        });
      }
      // 旧的 activeTopic/pendingThought 直接丢弃（本版只保留群友印象）
      for (const m of migrated) this.#appendRawSync(chatKey, m.userId, m.name, m.content, m.createdAt);
      const backupDir = path.join(MEMORY_DIR, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, path.basename(legacy));
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(legacy, backup);
    } catch (error) {
      console.error('[memory] 旧记忆迁移失败:', error?.message ?? error);
    }
  }

  #ensureChat(chatKey) {
    this.#migrateLegacy(chatKey);
    if (!this.cache.has(chatKey)) {
      const map = new Map();
      try {
        for (const f of fs.readdirSync(chatDir(chatKey))) {
          if (!f.endsWith('.json') || f === '_meta.json') continue;
          const raw = readJson(path.join(chatDir(chatKey), f), null);
          if (!raw) continue;
          const key = raw.userId ? String(raw.userId) : `_n_${f}`;
          map.set(key, loadMember(chatKey, raw.userId, raw.name));
        }
      } catch { /* 尚无文件夹 */ }
      this.#mergeNameDuplicates(chatKey, map);
      this.cache.set(chatKey, map);
    }
    return this.cache.get(chatKey);
  }

  /**
   * 合并"同一个人被存成两份"的历史数据。
   *
   * 背景：早期没有 QQ 号时会按名字落文件（_n_xxx.json）。后来拿到 QQ 号再次写入时，
   * 会新建 <QQ>.json，但旧的 _n_ 文件不会被清理 → 同一个人在记忆里出现两次，
   * 印象重复、整理时互相干扰，也让"印象总数"虚高。
   *
   * 规则：无 QQ 号的条目，只要有同名（且该名字对应的条目有 QQ 号），
   * 就把它的印象并入该 QQ 号条目，然后删除 _n_ 文件。
   */
  #mergeNameDuplicates(chatKey, map) {
    const nameToId = new Map();
    for (const m of map.values()) {
      const uid = String(m.userId || '').trim();
      const nm = String(m.name || '').trim();
      if (uid && nm) nameToId.set(nm, uid);
    }
    const toDelete = [];
    for (const [key, m] of map.entries()) {
      const uid = String(m.userId || '').trim();
      if (uid) continue;                       // 已有 QQ 号，不是兜底条目
      const nm = String(m.name || '').trim();
      const targetId = nameToId.get(nm);
      if (!targetId) continue;
      const target = map.get(targetId);
      if (!target) continue;

      const seen = new Set(target.impressions.map((e) => e.content));
      let added = 0;
      for (const e of m.impressions) {
        if (seen.has(e.content)) continue;
        seen.add(e.content);
        target.impressions.push({ ...e });
        added += 1;
      }
      if (added) {
        target.impressions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(m.updatedAt) || 0);
        writeJson(memberFile(chatKey, targetId, target.name), target);
      }
      // 删除已被并入的兜底文件
      try { fs.rmSync(memberFile(chatKey, '', nm), { force: true }); } catch { /* ignore */ }
      toDelete.push(key);
      console.log(`[memory] 合并重复记忆：${nm}（无 QQ 号）→ ${targetId}，并入 ${added} 条`);
    }
    for (const k of toDelete) map.delete(k);
  }

  /** 会话级写锁：同一 chatKey 的写事务串行（进程内队列 + 跨进程端口锁）。 */
  #withChatLock(chatKey, fn) {
    // reset 删除期间阻止记忆写入（协作式屏障）。
    assertWritesAllowed('记忆写入');
    return withMemoryPortLock(chatDir(chatKey), fn, { timeoutMs: 5000 });
  }

  async #appendRaw(chatKey, userId, name, content, createdAt = Date.now()) {
    return this.#withChatLock(chatKey, () => {
      this.cache.delete(chatKey);
      return this.#appendRawSync(chatKey, userId, name, content, createdAt);
    });
  }

  /** 同步版：调用方必须已持有 chatKey 锁。 */
  #appendRawSync(chatKey, userId, name, content, createdAt = Date.now()) {
    const map = this.#ensureChat(chatKey);
    const key = userId ? String(userId) : `_n_${memberFileName('', name)}`;
    const member = map.get(key) || loadMember(chatKey, userId, name);
    const entry = {
      content: String(content ?? '').slice(0, 300),
      createdAt: Number(createdAt) || Date.now()
    };
    if (!member.impressions.some((e) => e.content === entry.content)) {
      member.impressions.push(entry);
    }
    member.userId = String(userId ?? member.userId ?? '');
    member.name = String(name || member.name || '');
    member.updatedAt = Date.now();
    writeJson(memberFile(chatKey, userId, name), member);
    map.set(key, member);
    return entry;
  }

  /** 记一条对群友的印象。extra: { userId, target } */
  async append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    const userId = String(extra.userId ?? '').trim();
    const target = String(extra.target ?? '').trim().slice(0, 60);
    if (!userId && !target) return null;
    return this.#appendRaw(chatKey, userId, target || userId, content);
  }

  /** 所有成员的印象（扁平列表，兼容旧消费方）。 */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    // 4.0：有 Hub 读取器时统一走 Hub；失败才回退本层。
    if (this.impressionReader) {
      try {
        const hub = this.impressionReader({ chatKey });
        if (hub?.ok) {
          const memberImpression = (hub.items || []).map((it) => ({
            userId: String(it?.extra?.userId || ''),
            target: String(it?.extra?.name || it?.extra?.userId || '某人'),
            content: String(it?.content || ''),
            createdAt: Number(it?.timestamp) || 0
          })).filter((e) => e.content);
          memberImpression.sort((a, b) => b.createdAt - a.createdAt);
          return { memberImpression };
        }
      } catch { /* fallback below */ }
    }
    const map = this.#ensureChat(chatKey);
    const memberImpression = [];
    for (const m of map.values()) {
      for (const e of m.impressions) {
        memberImpression.push({
          userId: String(m.userId || ''),
          target: String(m.name || m.userId || '某人'),
          content: e.content,
          createdAt: e.createdAt
        });
      }
    }
    memberImpression.sort((a, b) => b.createdAt - a.createdAt);
    return { memberImpression };
  }

  /** 成员级视图（记忆页签用）。 */
  members(chatKey) {
    const map = this.#ensureChat(chatKey);
    const list = [];
    for (const m of map.values()) {
      if (!m.impressions.length) continue;
      list.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || '某人'),
        impressions: m.impressions.map((e) => ({ ...e })),
        updatedAt: m.updatedAt,
        lastConsolidatedAt: m.lastConsolidatedAt
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** 单个成员的印象（含空成员）。 */
  getMember(chatKey, userId) {
    const map = this.#ensureChat(chatKey);
    const m = map.get(String(userId)) || loadMember(chatKey, String(userId));
    return {
      userId: String(m.userId || userId || ''),
      name: String(m.name || ''),
      impressions: (m.impressions || []).map((e) => ({ ...e })),
      updatedAt: Number(m.updatedAt) || 0
    };
  }

  /** 编辑群友印象（管理端）：QQ 号由调用方提供，自动回填名字，保存备注到配置。 */
  /**
   * 编辑成员印象（4.0 / 3.0-R3-A 重写）。
   *
   * 支持两种输入形态：
   *   · 字符串 `'她喜欢猫'`        → 按 content 匹配（兼容旧调用方）
   *   · 对象 `{ id, content }`     → 按 id 匹配（**能识别「内容被纠正」**）
   *
   * 元数据继承规则：
   *   · 匹配上了、内容没变 → 沿用 id / contentType / epistemicType / origin / correction
   *   · 匹配上了、**内容变了** → 沿用 id 和元数据，**追加一条 correction.events**
   *     （correctedFrom = 真实旧文本，correctedTo = 真实新文本）
   *   · 没匹配上 → 新增，元数据默认值（不猜）
   *
   * 为什么必须支持对象输入：字符串输入下，「改了一句话」和「删掉旧的加条新的」
   * 在数据上分不出来 —— 那就没法记纠正。
   */
  async editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [] }) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    return this.#withChatLock(chatKey, () => {
    this.cache.delete(chatKey);
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(impressions) ? impressions : [impressions];
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const oldList = Array.isArray(old.impressions) ? old.impressions : [];
    const oldById = new Map();
    const oldByContent = new Map();
    for (const o of oldList) {
      if (!o || typeof o !== 'object') continue;
      if (o.id) oldById.set(String(o.id), o);
      if (o.content) oldByContent.set(String(o.content), o);
    }

    const entries = list
      .map((raw) => {
        const isObj = raw && typeof raw === 'object';
        const content = String(isObj ? raw.content : raw ?? '').trim().slice(0, 300);
        return {
          content,
          explicitId: isObj ? String(raw.id || '') : '',
          explicitMeta: isObj ? raw : null
        };
      })
      .filter((x) => x.content)
      .slice(0, 20)
      .map(({ content, explicitId, explicitMeta }) => {
        // ① 按 id 匹配优先（能识别纠正）
        const prev = (explicitId && oldById.get(explicitId)) || oldByContent.get(content) || null;

        if (!prev) {
          // 新增：元数据默认值（不从内容里猜）
          const meta = explicitMeta || {};
          return {
            id: resolveImpressionId(content, oldList),
            content,
            createdAt: now,
            contentType: pickImpEnum(meta.contentType, IMPRESSION_CONTENT_TYPES, 'other'),
            epistemicType: pickImpEnum(meta.epistemicType, IMPRESSION_EPISTEMIC_TYPES, 'unknown'),
            origin: meta.origin && typeof meta.origin === 'object'
              ? {
                kind: String(meta.origin.kind || 'unknown'),
                ref: String(meta.origin.ref || ''),
                at: String(meta.origin.at || ''),
                quote: String(meta.origin.quote || '').slice(0, 200)
              }
              : { kind: 'unknown', ref: '', at: '', quote: '' },
            // 新建印象没有纠正历史 → 显式 clear（R8-B v2）
            correction: { state: 'clear', count: 0, events: [] }
          };
        }

        // ② 匹配上了：沿用元数据
        const prevCorrection = prev.correction && typeof prev.correction === 'object'
          ? prev.correction
          : { count: 0, events: [] };   // 缺 state → resolveCorrectionState 给 unknown
        const events = Array.isArray(prevCorrection.events) ? prevCorrection.events.slice() : [];
        const changed = String(prev.content ?? '') !== content;

        if (changed) {
          // **内容变了 = 一次纠正** —— 记真实的前后文本
          events.push({
            at: nowIso,
            correctedFrom: String(prev.content ?? ''),
            correctedTo: content,
            by: 'user_directed',
            quote: ''
          });
          if (events.length > 20) events.splice(0, events.length - 20);
        }

        return {
          id: String(prev.id || '') || resolveImpressionId(content, oldList),
          content,
          createdAt: Number(prev.createdAt) || now,
          contentType: pickImpEnum(
            explicitMeta?.contentType ?? prev.contentType,
            IMPRESSION_CONTENT_TYPES,
            'other'
          ),
          epistemicType: pickImpEnum(
            explicitMeta?.epistemicType ?? prev.epistemicType,
            IMPRESSION_EPISTEMIC_TYPES,
            'unknown'
          ),
          origin: explicitMeta?.origin && typeof explicitMeta.origin === 'object'
            ? {
              kind: String(explicitMeta.origin.kind || 'unknown'),
              ref: String(explicitMeta.origin.ref || ''),
              at: String(explicitMeta.origin.at || ''),
              quote: String(explicitMeta.origin.quote || '').slice(0, 200)
            }
            : (prev.origin || { kind: 'unknown', ref: '', at: '', quote: '' }),
          correction: {
            count: changed ? events.length : (Number(prevCorrection.count) || 0),
            events,
            // 内容变了 = 发生了一次纠正，新版本尚未确认 → unresolved；
            // 没变 = 沿用旧状态（缺状态就是 unknown，不猜 clear）。
            state: changed ? 'unresolved' : resolveCorrectionState({ correction: prevCorrection }),
            ...(typeof prevCorrection.historicalUnresolved === 'boolean' && !changed
              ? { historicalUnresolved: prevCorrection.historicalUnresolved }
              : {})
          }
        };
      });

    const member = {
      userId: uid,
      name: finalName,
      impressions: entries,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    // 备注写入配置 memberNotes
    if (note !== undefined && note !== null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      const n = String(note ?? '').trim();
      if (n) notes[uid] = n;
      else delete notes[uid];
      updateConfig({ memberNotes: notes });
    }
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt,
      note: String(note ?? '').trim()
    };
    });
  }

  /** 手动替换某成员的全部印象（管理端编辑用）。返回更新后的成员。 */
  async replaceMember(chatKey, userId, name, contents) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    return this.#withChatLock(chatKey, () => {
    this.cache.delete(chatKey);
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(contents) ? contents : [contents];
    const now = Date.now();
    const impressions = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => ({ content: content.slice(0, 300), createdAt: now }));
    const member = {
      userId: uid,
      name: finalName,
      impressions,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    // 单个成员替换也备份原文件（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.mkdirSync(backupDir, { recursive: true });
      const src = memberFile(chatKey, uid, finalName);
      if (fs.existsSync(src)) {
        const dst = path.join(backupDir, path.basename(src));
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.copyFileSync(src, dst);
      }
    } catch { /* 备份失败不阻塞 */ }
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt
    };
    });
  }

  /** 删除某成员的印象文件（先备份 + 校验，失败拒绝删除）。 */
  async removeMember(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) return { ok: false, opId: newOpId(), error: 'userId 不合法' };
    return this.#withChatLock(chatKey, () => {
    this.cache.delete(chatKey);
    const map = this.#ensureChat(chatKey);
    const m = map.get(uid) || loadMember(chatKey, uid);
    const file = memberFile(chatKey, uid, m.name);
    if (!fs.existsSync(file)) return { ok: false, opId: newOpId(), error: '成员文件不存在' };
    try { assertMemoryPath(file); } catch (e) { return { ok: false, opId: newOpId(), error: String(e.message) }; }
    let backup;
    try {
      backup = backupMemoryTarget({ chatKey, kind: 'member', files: [{ abs: file, rel: path.basename(file) }] });
    } catch (e) {
      return { ok: false, opId: newOpId(), error: `备份失败，拒绝删除：${String(e?.message ?? e)}` };
    }
    try {
      fs.unlinkSync(file);
    } catch (e) {
      return { ok: false, opId: backup.opId, backupDir: backup.dir, files: backup.files.length, verified: true, error: `删除失败：${String(e?.message ?? e)}` };
    }
    map.delete(uid);
    auditMemoryDelete({ opId: backup.opId, op: 'removeMember', chatKey, target: path.basename(file), backupDir: backup.dir, files: backup.files.length, result: 'ok' });
    return { ok: true, opId: backup.opId, target: `${chatKey}/${path.basename(file)}`, backupDir: backup.dir, files: backup.files.length, verified: true, removed: true };
    });
  }

  /**
   * 删除一个会话的**全部**记忆（记忆页「删除本会话记忆」按钮）。
   * 成员文件、_meta.json、旧版单文件与备份一并清掉；目录本身保留
   * （可能是挂载点/被占用，删不掉也无妨——里面已空）。
   * @returns {boolean} 是否删掉了东西
   */
  async removeChat(chatKey) {
    return this.#withChatLock(chatKey, () => {
    this.cache.delete(chatKey);
    const dir = chatDir(chatKey);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    // 未识别文件保护：只允许 .json（成员文件 / _meta.json）；其他一律拒绝
    const unknown = names.filter((n) => !/\.json$/.test(n));
    if (unknown.length) return { ok: false, opId: newOpId(), error: '目录含未识别文件，拒绝删除', files: unknown };
    const files = names.map((n) => ({ abs: path.join(dir, n), rel: n }));
    const legacy = legacyFile(chatKey);
    if (fs.existsSync(legacy)) files.push({ abs: legacy, rel: '_legacy.json' });
    if (!files.length) return { ok: false, opId: newOpId(), error: '没有可删除的记忆' };
    try { files.forEach((f) => assertMemoryPath(f.abs)); } catch (e) { return { ok: false, opId: newOpId(), error: String(e.message) }; }
    let backup;
    try {
      backup = backupMemoryTarget({ chatKey, kind: 'chat', files });
    } catch (e) {
      return { ok: false, opId: newOpId(), error: `备份失败，拒绝删除：${String(e?.message ?? e)}` };
    }
    try {
      for (const f of files) fs.rmSync(f.abs, { force: true });
    } catch (e) {
      return { ok: false, opId: backup.opId, backupDir: backup.dir, files: backup.files.length, verified: true, error: `删除失败：${String(e?.message ?? e)}` };
    }
    // 内存缓存同步清掉，否则同进程内 members() 还能读到旧数据
    this.#ensureChat(chatKey).clear();
    auditMemoryDelete({ opId: backup.opId, op: 'removeChat', chatKey, target: chatKey, backupDir: backup.dir, files: backup.files.length, result: 'ok' });
    return { ok: true, opId: backup.opId, target: chatKey, backupDir: backup.dir, files: backup.files.length, verified: true, removed: true };
    });
  }

  /**
   * 删除当前会话的印象。
   *   { userId }            → 删这个人的全部印象
   *   { target }            → 按名字删那个人的全部印象
   *   { userId, content }   → 只删匹配内容的那一条
   *   {} / 两个都不传        → 清空本会话的**全部**印象（走 clear()）
   *
   * ⚠️ 2026-10-12 修：以前没有最后那条分支 —— userId/target 都为空时，
   * 下面那个 for 循环里没有任何条件会命中，于是"清空记忆"静默返回 false、
   * 一条都没删（工具描述却写着"两者都不传则删全部印象"，文档与实现不符）。
   * 现在委托给 clear()：清成员文件 + 清内存缓存 + 重置 _meta.json，三处一致。
   */
  async remove(chatKey, category, { userId = '', target = '', content = '' } = {}) {
    if (category !== 'memberImpression') return false;

    return this.#withChatLock(chatKey, () => {
    this.cache.delete(chatKey);
    // 无任何筛选条件 = 清空本会话全部印象
    if (!userId && !target) {
      this.#clearSync(chatKey);
      return true;
    }

    const map = this.#ensureChat(chatKey);
    let removed = false;
    for (const [key, m] of [...map.entries()]) {
      if (userId) {
        if (String(m.userId) === String(userId)) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      } else if (target) {
        const matchName = String(target).trim();
        if (String(m.name || m.userId) === matchName) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      }
    }
    return removed;
    });
  }

  /**
   * 清空一个会话的全部印象：成员文件删掉、内存缓存清掉、_meta.json 重置
   * （只写 lastConsolidatedAt，不删文件 —— 保留"整理过"的时间线，也避免
   * 目录被删后 mtime 抖动）。
   */
  async clear(chatKey) {
    return this.#withChatLock(chatKey, () => {
      this.cache.delete(chatKey);
      return this.#clearSync(chatKey);
    });
  }

  /** 同步清空：调用方必须已持有 chatKey 锁。 */
  #clearSync(chatKey) {
    const map = this.#ensureChat(chatKey);
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    writeJson(metaFile(chatKey), { lastConsolidatedAt: Date.now() });
  }

  /**
   * 生成提示词里的【对群友的印象】摘要。
   * opts.userIds 提供时只包含这些成员（相关成员注入，控制 token）。
   */
  formatForPrompt(chatKey, { userIds = null } = {}) {
    // 4.0：有 Hub 读取器时优先走统一入口；失败才回退本层，避免 prompt 空掉。
    if (this.impressionReader) {
      try {
        const hub = this.impressionReader({ chatKey });
        if (hub?.ok) return this.#formatHubImpressions(hub.items || [], { userIds });
      } catch { /* fallback below */ }
    }
    const notes = getConfig().memberNotes || {};
    const all = this.members(chatKey);
    if (!all.length) return '';
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const picked = filter
      ? all.filter((m) => !m.userId || filter.has(String(m.userId)))  // 无 QQ 号的旧数据始终带上
      : all.slice(0, 15);
    if (!picked.length) return '';
    const lines = ['【对群友的印象】'];
    for (const m of picked) {
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      for (const e of m.impressions.slice(-3)) lines.push(`- ${who}：${e.content}`);
    }
    return lines.join('\n');
  }

  /** 把 Hub 的扁平 impression 结果还原成与 formatForPrompt 相同的文本形状。 */
  #formatHubImpressions(items, { userIds = null } = {}) {
    if (!Array.isArray(items) || !items.length) return '';
    const notes = getConfig().memberNotes || {};
    const groups = new Map();
    for (const it of items) {
      const userId = String(it?.extra?.userId || '');
      const name = String(it?.extra?.name || '');
      const key = userId || `name:${name}`;
      if (!groups.has(key)) groups.set(key, { userId, name, impressions: [] });
      const content = String(it?.content || '');
      if (content) groups.get(key).impressions.push({ content, createdAt: Number(it?.timestamp) || 0 });
    }
    const all = [...groups.values()].filter((m) => m.impressions.length);
    if (!all.length) return '';
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const picked = filter
      ? all.filter((m) => !m.userId || filter.has(String(m.userId)))
      : all.slice(0, 15);
    if (!picked.length) return '';
    const lines = ['【对群友的印象】'];
    for (const m of picked) {
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      for (const e of m.impressions.slice(-3)) lines.push(`- ${who}：${e.content}`);
    }
    return lines.join('\n');
  }

  // ── 自动整理（consolidation）──

  consolidationState(chatKey) {
    const map = this.#ensureChat(chatKey);
    let total = 0;
    let lastConsolidatedAt = 0;
    const members = [];
    for (const m of map.values()) {
      total += m.impressions.length;
      lastConsolidatedAt = Math.max(lastConsolidatedAt, m.lastConsolidatedAt || 0);
      members.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || ''),
        count: m.impressions.length,
        lastConsolidatedAt: m.lastConsolidatedAt || 0
      });
    }
    return {
      lastConsolidatedAt: loadMeta(chatKey).lastConsolidatedAt || lastConsolidatedAt,
      counts: { memberImpression: total },
      members
    };
  }

  /**
   * 记录一次整理完成的时间。
   * 同时写会话级 _meta.json（供冷却判断）与各成员文件的 lastConsolidatedAt。
   * userIds 为空时只更新会话级时间。
   */
  async markConsolidated(chatKey, at = Date.now(), userIds = []) {
    return this.#withChatLock(chatKey, () => {
    this.cache.delete(chatKey);
    try {
      fs.mkdirSync(chatDir(chatKey), { recursive: true });
      const prev = readJson(metaFile(chatKey), {}) || {};
      writeJson(metaFile(chatKey), { ...prev, lastConsolidatedAt: Number(at) || Date.now() });
    } catch (error) {
      console.warn('[memory] 写整理时间失败:', error?.message ?? error);
    }
    const map = this.#ensureChat(chatKey);
    for (const uid of userIds || []) {
      const key = String(uid ?? '').trim();
      if (!key) continue;
      const m = map.get(key);
      if (!m) continue;
      m.lastConsolidatedAt = Number(at) || Date.now();
      try { writeJson(memberFile(chatKey, m.userId, m.name), m); } catch { /* ignore */ }
    }
    });
  }

  /**
   * 用整理结果整体替换本会话的印象（按成员写回各自文件）。
   * next.memberImpression: [{ userId?, target?, content }]
   */
  async replaceConsolidated(chatKey, next) {
    return this.#withChatLock(chatKey, () => {
    this.cache.delete(chatKey);
    const cut = (s, n) => String(s ?? '').trim().slice(0, n);
    const now = Date.now();
    const groups = new Map(); // key -> { userId, name, contents }
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      const content = cut(item?.content, 300);
      if (!content) continue;
      const userId = cut(item?.userId, 40) || '';
      const name = cut(item?.target, 60) || userId;
      const key = userId || `_n_${memberFileName('', name)}`;
      if (!groups.has(key)) groups.set(key, { userId, name, contents: [] });
      groups.get(key).contents.push(content);
    }
    const map = this.#ensureChat(chatKey);
    // 整理前把整个会话文件夹备份到 data/memory/backups/<会话>/（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.mkdirSync(backupDir, { recursive: true });
      for (const m of map.values()) {
        const src = memberFile(chatKey, m.userId, m.name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
      }
      const metaSrc = metaFile(chatKey);
      if (fs.existsSync(metaSrc)) fs.copyFileSync(metaSrc, path.join(backupDir, '_meta.json'));
    } catch { /* 备份失败不阻塞整理 */ }
    // 删除所有现有成员文件（整理结果会重建）
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    for (const g of groups.values()) {
      for (const content of g.contents) {
        this.#appendRawSync(chatKey, g.userId, g.name, content, now);
      }
      const file = memberFile(chatKey, g.userId, g.name);
      const member = loadMember(chatKey, g.userId, g.name);
      member.lastConsolidatedAt = now;
      member.updatedAt = now;
      writeJson(file, member);
      map.set(g.userId || `_n_${memberFileName('', g.name)}`, member);
    }
    writeJson(metaFile(chatKey), { lastConsolidatedAt: now });
    const totalAfter = [...map.values()].reduce((n, m) => n + m.impressions.length, 0);
    return { memberImpression: groups.size ? this.query(chatKey).memberImpression : [], count: totalAfter };
    });
  }
}
