// 「已学经验」库 —— 三层记忆的中间层。
//
// 三层分工（2026-10-27 机主定的）：
//   核心规则：稳定人设、行为原则  → 写进 persona，每轮都带
//   已学经验：从纠正里提炼的规则  → 这份库，按相关性检索（3~8 条）
//   原始日记：当时犯了什么错、怎么纠正 → 留在 每日/*.md，必要时回溯
//
// 为什么不能直接从日记抽：日记是流水账（「老大纠正我说话的主语」），
// 但真正该带进上下文的是提炼后的规则（「说自己的打算时别把事说到他头上」）。
// 而且日记越写越长，全塞进去会把上下文撑爆。
//
// 关键设计：
//   · 状态机 pending → verified → stable，**不允许她自己拍板晋升**（见 setStatus 注释）
//   · 选取不是「最近 N 条」，而是 相关性 + 状态 + 时效 打分后取 top（默认 6，硬上限 15）
//   · 入库时做合并：同义/重复的更新旧条目并把状态打回 pending，不新增

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DATA_DIR } from './config.js';
// 4.0 / 1.5.4：经验库单写者。读-改-写整体进跨进程锁（见 src/state-store.js）。
import { withState } from './state-store.js';

export const LEARNED_FILE = path.join(DATA_DIR, 'learned.json');

// D1-3b-B5：删除前的唯一备份（逐文件 hash；失败则拒绝删除）。
const LEARNED_BACKUP_DIR = path.join(DATA_DIR, 'backups', 'learned');
const LEARNED_BACKUP_AUDIT = path.join(LEARNED_BACKUP_DIR, 'audit.jsonl');
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function backupLearnedFile(id) {
  if (!fs.existsSync(LEARNED_FILE)) return { ok: true, skipped: true, backupDir: '' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(LEARNED_BACKUP_DIR, `${stamp}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'learned.json');
  fs.copyFileSync(LEARNED_FILE, dst);
  const srcHash = sha256File(LEARNED_FILE);
  const dstHash = sha256File(dst);
  if (srcHash !== dstHash) throw new Error('经验库备份校验失败');
  const size = fs.statSync(LEARNED_FILE).size;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 1, kind: 'learned-delete', targetId: String(id), createdAt: new Date().toISOString(),
    source: LEARNED_FILE, backupDir: dir, file: { rel: 'learned.json', sha256: srcHash, size }
  }, null, 1), 'utf8');
  try {
    fs.appendFileSync(LEARNED_BACKUP_AUDIT, JSON.stringify({
      at: new Date().toISOString(), op: 'learned.delete', id: String(id), backupDir: dir, sha256: srcHash, result: 'prepared'
    }) + '\n', 'utf8');
  } catch { /* 审计失败不阻塞 */ }
  return { ok: true, backupDir: dir, sha256: srcHash };
}
/** 每次带进上下文的最大条数（硬上限）。 */
export const HARD_CAP = 15;
/** 默认带几条：3~8 之间就够，不必填满。 */
export const DEFAULT_PICK = 6;

/** 状态权重：待验证的最需要提醒；归档的压到最低，但只要相关性够强还能捞回来。 */
const STATUS_WEIGHT = { pending: 40, verified: 20, stable: 0, archived: -60 };

/**
 * 同义词组：每组第一个是「归一化后的词」。
 *
 * 为什么需要：纯关键词匹配会漏掉语义相近但字面不同的表达 ——
 * 「我好难受」和「今天心情很差」一个词都不重合，可说的是同一件事。
 * 不上向量库，先用这个表做文本级归一化（把变体替换成组内第一个词），
 * 两条都会被归到「难受」，关键词就能对上了。
 *
 * 注意：只收 2 字以上的词。单字（累/气/乐）误伤太大（累积、气候、快乐）。
 */
const SYNONYM_GROUPS = [
  ['难受', '难过', '不开心', '郁闷', '心情差', '心情很差', '心情不好', '心情糟糕', '憋屈', '烦躁', '低落'],
  ['疲惫', '好累', '很累', '太累', '没力气', '困了', '乏了'],
  ['夸', '表扬', '称赞', '夸我'],
  ['生气', '火大', '恼火', '来气'],
  ['开心', '高兴', '愉快', '快乐', '开森'],
  ['紧张', '焦虑', '慌', '不安', '忐忑'],
  ['孤独', '孤单', '寂寞', '没人陪'],
  ['道歉', '对不起', '抱歉', '不好意思'],
  ['感谢', '谢谢', '谢了', '多谢'],
  ['建议', '方案', '解决办法', '主意', '支招'],
  ['倾诉', '吐槽', '倒苦水', '诉苦', '抱怨'],
  ['称呼', '叫法', '喊法'],
  ['表情包', '表情', '梗图', '贴图'],
  ['长回复', '长篇', '啰嗦', '一大堆', '太长'],
  ['沉默', '不说话', '没声', '安静']
];

const SYNONYM_CANON = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) SYNONYM_CANON.set(word, group[0]);
}
// 长词优先，否则「心情不好」会被更短的「心情」类词先吃掉
const SYNONYM_ORDER = [...SYNONYM_CANON.keys()].sort((a, b) => b.length - a.length);

/** 把同义变体替换成归一化词，再提取关键词。 */
export function normalizeSynonyms(text) {
  let s = String(text ?? '');
  if (!s) return s;
  for (const word of SYNONYM_ORDER) {
    if (word.length < 2) continue;
    if (!s.includes(word)) continue;
    s = s.split(word).join(SYNONYM_CANON.get(word));
  }
  return s;
}

const p2 = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** 从一段话里抽可比较的关键词（中文按 2~4 字滑窗里的高频片段，去停用词）。 */
const STOP = new Set([
  '老大', '这个', '那个', '就是', '不要', '可以', '什么', '时候', '自己', '一下',
  '觉得', '还是', '已经', '因为', '所以', '但是', '如果', '这样', '那样', '我们', '你们'
]);

export function keywordsOf(text, minLen = 2, maxLen = 4) {
  // 先做同义归一化：「我好难受」和「今天心情很差」都能落到「难受」上
  const s = normalizeSynonyms(text).replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, ' ');
  const out = new Set();
  for (const chunk of s.split(/\s+/)) {
    if (!chunk) continue;
    for (let len = maxLen; len >= minLen; len -= 1) {
      for (let i = 0; i + len <= chunk.length; i += 1) {
        const w = chunk.slice(i, i + len);
        if (STOP.has(w)) continue;
        out.add(w);
      }
    }
  }
  return out;
}

/**
 * 读经验库（4.0 / 1.5.4）。
 *
 * 额外挂一个不可枚举的 __base：读的时候每条长什么样。
 * writeStore 拿它算增量 —— hits / corrections 是**累加值**，两个进程
 * 各读一份旧快照再各加 1，直接覆盖会丢掉一次（2026-11-01 验收同款问题）。
 */
function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
    const store = { version: 1, items: Array.isArray(j?.items) ? j.items : [] };
    try {
      Object.defineProperty(store, '__base', {
        value: new Map(store.items.map((i) => [String(i.id), JSON.stringify(i)])),
        enumerable: false,
        writable: true,
        configurable: true
      });
    } catch { /* 极端情况下降级为整体覆盖 */ }
    return store;
  } catch {
    return { version: 1, items: [] };
  }
}

/**
 * 写经验库（4.0 / 1.5.4 起是单写者：锁内重新读 → 按条目合并 → 原子替换）。
 *
 * 合并规则（针对机主点名的「不能丢 hits / corrections / history」）：
 *   · hits / corrections → **增量相加**：本轮涨了多少，就加到锁内那份上；
 *     两边同时涨（10→13 和 10→12）结果是 15，不是 13 也不是 12。
 *   · 其余字段（text/status/tags/updatedAt/lastUsedAt/history…）→ 只覆盖
 *     **本轮真正改过**的，没碰过的保留锁内别人写的值。
 *   · 锁内有、本轮没有的条目 → 保留（不删）。
 *   · 本轮新增的条目 → 追加。
 */
function writeStore(store) {
  const base = store.__base instanceof Map ? store.__base : null;
  const deleted = store.__deleted instanceof Set ? store.__deleted : null;
  const r = withState(LEARNED_FILE, (cur) => {
    if (!cur.version) cur.version = 1;
    if (!Array.isArray(cur.items)) cur.items = [];
    const byId = new Map(cur.items.map((i) => [String(i.id), i]));

    // 显式删除（不是"本轮没带"——那可能只是别的进程刚加的）
    if (deleted) {
      for (const id of deleted) {
        const idx = cur.items.findIndex((i) => String(i.id) === id);
        if (idx >= 0) cur.items.splice(idx, 1);
      }
    }

    for (const item of store.items || []) {
      const id = String(item.id);
      const existing = byId.get(id);

      if (!existing) {
        cur.items.push(item);
        byId.set(id, item);
        continue;
      }

      // 增量字段
      const beforeRaw = base?.get(id);
      const before = beforeRaw ? JSON.parse(beforeRaw) : null;
      if (before) {
        const dHits = (Number(item.hits) || 0) - (Number(before.hits) || 0);
        const dCorr = (Number(item.corrections) || 0) - (Number(before.corrections) || 0);
        existing.hits = (Number(existing.hits) || 0) + Math.max(0, dHits);
        existing.corrections = (Number(existing.corrections) || 0) + Math.max(0, dCorr);
      } else {
        existing.hits = Number(item.hits) || 0;
        existing.corrections = Number(item.corrections) || 0;
      }

      // 其余字段：只覆盖改过的
      for (const k of Object.keys(item)) {
        if (k === 'id' || k === 'hits' || k === 'corrections') continue;
        if (before) {
          const now = JSON.stringify(item[k]);
          const was = JSON.stringify(before[k]);
          if (now === was) continue;   // 本轮没碰 → 保留锁内值
        }
        existing[k] = item[k];
      }
    }
  }, { fallback: { version: 1, items: [] } });

  if (!r.ok) throw new Error(r.error || '经验库写入失败');
  return r.state;
}

function newId(now = Date.now()) {
  return `l-${now.toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

/** 两条经验的共同关键词数。 */
function overlapOf(a, b) {
  const ka = keywordsOf(a);
  const kb = keywordsOf(b);
  let hit = 0;
  for (const w of ka) if (kb.has(w)) hit += 1;
  return { hit, min: Math.min(ka.size, kb.size) };
}

/** 两条经验的相似度：共享关键词 / 较短那条的关键词数（0~1）。 */
export function similarity(a, b) {
  const { hit, min } = overlapOf(a, b);
  return min ? hit / min : 0;
}

/* ── 记忆元数据（4.0 / 3.0-R2）────────────────────────────────────── */
//
// 机主 2026-11-02 定的两个正交维度：
//   · contentType   ：这条记忆在说什么（fact / preference / event / plan / other）
//   · epistemicType ：怎么知道的（direct / inferred / unknown）
// 加上独立的 correction（纠正事件），三者正交。
//
// **只加字段，不改现有字段**；旧数据读作默认值，读操作不写盘。

/** 内容类别。 */
export const CONTENT_TYPES = ['fact', 'preference', 'event', 'plan', 'other'];

// ══ R8-B：晋升候选的规则版本与常量（2026-11-03）════════════════════
//
// **规则版本**：每次改规则都要 +1，候选记录里会带这个号，
// 这样以后回头看"这条候选是按哪版规则推出来的"。
export const PROMOTION_RULE_VERSION = 1;

/** 14 天：只是**时间门槛**，不是可靠性证据。机主明确说过。 */
export const STABLE_MIN_AGE_DAYS = 14;

/**
 * 哪些 origin.kind 算"用户直接说的"。
 *
 * ⚠️ 注意：实际的 ORIGIN_KINDS 是
 *    ['chat', 'autonomous', 'diary', 'user_stated', 'inferred', 'unknown']
 * **不是**我方案初稿里假设的 'owner'。
 */
export const USER_STATED_KINDS = ['user_stated'];

/** 哪些 origin.kind 算"有明确外部来源"（比 user_stated 弱，比 inferred 强）。 */
export const STRONG_ORIGIN_KINDS = ['user_stated', 'diary', 'chat'];


/** 认知性质。 */
export const EPISTEMIC_TYPES = ['direct', 'inferred', 'unknown'];

/** 来源类别。 */
export const ORIGIN_KINDS = ['chat', 'autonomous', 'diary', 'user_stated', 'inferred', 'unknown'];

const DEFAULT_META = {
  contentType: 'other',
  epistemicType: 'unknown',
  origin: { kind: 'unknown', ref: '', at: '', quote: '' },
  // 默认是「未知」，不是「没有纠正」——不能拿默认值当事实。
  correction: { state: 'unknown', count: 0, events: [] }
};

/** 纠正状态的规范取值（R8-B v2）。 */
export const CORRECTION_STATES = ['clear', 'unresolved', 'unknown'];

/** 旧格式里「用户认可」的事件来源。 */
const ACKED_EVENT_SOURCES = ['owner', 'user_stated'];

/**
 * 纠正状态的**唯一解释器**（R8-B v2）。
 *
 * 纯函数：不修改入参、不做 I/O、不调模型。
 *
 * 证据优先级（命中即返回）：
 *   1. correction.state 是合法三态 → 它（显式声明最高）
 *   2. correction.historicalUnresolved === true → unresolved（明确未解决）
 *   3. historicalUnresolved === false 且 events 最后一条是 owner/user_stated → clear
 *   4. 其余 → unknown
 *
 * **clear 只能来自显式声明或明确的用户认可记录。**
 * count、空 events、false 单独出现，都不能推出 clear。
 */
export function resolveCorrectionState(item) {
  const c = item && typeof item === 'object' && item.correction && typeof item.correction === 'object'
    ? item.correction
    : null;

  const explicit = c && typeof c.state === 'string' ? c.state.trim().toLowerCase() : '';
  if (CORRECTION_STATES.includes(explicit)) return explicit;

  if (c && c.historicalUnresolved === true) return 'unresolved';

  if (c && c.historicalUnresolved === false) {
    const events = Array.isArray(c.events) ? c.events : [];
    const last = events.length ? events[events.length - 1] : null;
    const src = String(last?.source || last?.kind || last?.by || '').toLowerCase();
    if (last && ACKED_EVENT_SOURCES.includes(src)) return 'clear';
  }

  return 'unknown';
}

function pickEnum(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

/**
 * 给一条经验补上元数据默认值（**只读，不写盘**）。
 *
 * ⚠️ 这里的设计原则：**旧数据不认识，就老实说 unknown**。
 * 不从文本里猜「这是事实还是推测」—— 那是模型该做的事，不是读函数该做的。
 */
export function withMeta(item) {
  if (!item || typeof item !== 'object') return item;
  const ct = pickEnum(item.contentType, CONTENT_TYPES, DEFAULT_META.contentType);
  const et = pickEnum(item.epistemicType, EPISTEMIC_TYPES, DEFAULT_META.epistemicType);
  const o = item.origin && typeof item.origin === 'object' ? item.origin : null;
  const origin = {
    kind: pickEnum(o?.kind, ORIGIN_KINDS, DEFAULT_META.origin.kind),
    ref: String(o?.ref ?? ''),
    at: String(o?.at ?? ''),
    quote: String(o?.quote ?? '').slice(0, 200)
  };
  const c = item.correction && typeof item.correction === 'object' ? item.correction : null;
  const legacyCount = Number(item.corrections) || 0;
  const correction = {
    count: Number.isFinite(Number(c?.count)) ? Number(c.count) : legacyCount,
    events: Array.isArray(c?.events) ? c.events : [],
    // 读时计算，不写盘；历史缺状态就是 unknown，不补 clear、也不补 true
    state: resolveCorrectionState(item)
  };
  // 旧字段保留用于兼容（原值是什么就带出什么，不制造默认值）
  if (c && typeof c.historicalUnresolved === 'boolean') correction.historicalUnresolved = c.historicalUnresolved;
  return { ...item, contentType: ct, epistemicType: et, origin, correction };
}

/**
 * 入库：同义条目合并、不新增。
 *
 * 合并规则（对应机主说的「合并」和「更新」）：
 *   · 相似度 ≥ 0.5 → 视为同一条：文本更新为新表述，corrections+1，状态打回 pending
 *   · 否则新增一条 pending
 * 这样「不要每次都叫老大」「别每句话都叫老大」不会并存成三条。
 */
export function addExperience({
  text,
  sourceDay = '',
  tags = [],
  now = Date.now(),
  // 4.0 / 3.0-R2：元数据（可选）。不传就是 unknown —— 不猜。
  contentType = 'other',
  epistemicType = 'unknown',
  origin = null
} = {}) {
  const body = String(text ?? '').trim();
  if (body.length < 4) return { ok: false, reason: '太短' };
  const ct = pickEnum(contentType, CONTENT_TYPES, 'other');
  const et = pickEnum(epistemicType, EPISTEMIC_TYPES, 'unknown');
  const org = origin && typeof origin === 'object'
    ? {
      kind: pickEnum(origin.kind, ORIGIN_KINDS, 'unknown'),
      ref: String(origin.ref ?? ''),
      at: String(origin.at ?? ''),
      quote: String(origin.quote ?? '').slice(0, 200)
    }
    : { kind: 'unknown', ref: '', at: new Date(now).toISOString(), quote: '' };
  const store = readStore();
  let merged = null;
  for (const item of store.items) {
    if (item.status === 'archived') continue;
    const { hit, min } = overlapOf(body, item.text);
    const sim = min ? hit / min : 0;
    // 0.28 是实测出来的线：
    //   「不要每次都叫老大」vs「别每句话都叫老大，称呼自然点」= 0.31（该合并）
    //   不同主题的两条通常在 0.05 以下（不该合并）
    // 再加 hit>=3 兜底，避免"两条都很短、碰巧撞一个词"就合并。
    if ((sim >= 0.28 && hit >= 3) || sim >= 0.5) { merged = item; break; }
  }
  if (merged) {
    // 不直接覆盖：旧表述进 history，避免「越纠正越偏」——
    // 新说法可能理解错了，原文是最原始的证据，丢了就找不回来。
    merged.history = Array.isArray(merged.history) ? merged.history : [];
    merged.history.push({
      text: merged.text,
      at: merged.updatedAt || merged.createdAt,
      corrections: Number(merged.corrections) || 1
    });
    // 4.0 / 3.0-R2：同时记一条结构化的纠正事件（**不推测，直接取真实旧文本**）
    const prevText = merged.text;
    merged.correction = merged.correction && typeof merged.correction === 'object'
      ? merged.correction
      : { count: Number(merged.corrections) || 0, events: [], state: 'unknown' };
    merged.correction.events = Array.isArray(merged.correction.events) ? merged.correction.events : [];
    merged.correction.events.push({
      at: new Date(now).toISOString(),
      correctedFrom: String(prevText ?? ''),
      correctedTo: body,
      by: 'user_directed',        // 现在只有机主纠正会走到合并分支
      quote: ''
    });
    if (merged.correction.events.length > 20) merged.correction.events = merged.correction.events.slice(-20);
    merged.correction.count = (Number(merged.correction.count) || 0) + 1;
    // 被纠正了，新版本还没被确认 → unresolved（不是 clear）
    merged.correction.state = 'unresolved';
    if (merged.history.length > 10) merged.history = merged.history.slice(-10);
    merged.text = body;
    merged.corrections = (Number(merged.corrections) || 1) + 1;
    // 又被纠正 = 之前的状态不可信了，退回去重新盯
    merged.status = 'pending';
    merged.updatedAt = new Date(now).toISOString();
    if (sourceDay) merged.sourceDay = sourceDay;
    merged.tags = [...new Set([...(merged.tags || []), ...tags])].slice(0, 8);
    writeStore(store);
    return {
      ok: true, merged: true, id: merged.id,
      corrections: merged.corrections, previous: merged.history.at(-1)?.text || ''
    };
  }
  const item = {
    id: newId(now),
    text: body,
    status: 'pending',
    tags: tags.slice(0, 8),
    sourceDay: sourceDay || dayKey(new Date(now)),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    lastUsedAt: null,
    hits: 0,
    corrections: 1,
    // 4.0 / 3.0-R2：元数据（新建时 corrections=1 是"首次修订"，不是"被纠正"）
    contentType: ct,
    epistemicType: et,
    origin: org,
    correction: { state: 'clear', count: 1, events: [] }
  };
  store.items.push(item);
  writeStore(store);
  return { ok: true, merged: false, id: item.id };
}

/**
 * 改状态。
 *
 * ⚠️ 机主明确要求「不能让她自己认定学会了」：
 *   · pending → verified 必须由**机主明确反馈**触发（面板里点，或者他说「这次对了」）
 *   · 程序侧只允许「回退」（verified/stable → pending），那是客观发生的再犯
 * 所以这个函数带 source 参数，调用方必须说明是谁改的。
 */
export function setStatus(id, status, { source = 'owner', now = Date.now() } = {}) {
  const allowed = ['pending', 'verified', 'stable', 'archived'];
  if (!allowed.includes(status)) return { ok: false, reason: '状态不合法' };
  const store = readStore();
  const item = store.items.find((x) => x.id === id);
  if (!item) return { ok: false, reason: '没这条经验' };
  // 自己往上报 = 拒绝；只能由机主操作，或者程序因「再犯」把它打回 pending
  const escalating = (status === 'verified' || status === 'stable')
    && (item.status === 'pending' || item.status === 'verified');
  if (escalating && source !== 'owner') {
    return { ok: false, reason: '状态只能由机主确认，不能自己升级' };
  }
  item.status = status;
  item.updatedAt = new Date(now).toISOString();
  writeStore(store);
  return { ok: true, id, status };
}

/**
 * 编辑一条经验。
 *
 * 输入**一行** = 改这一条；
 * 输入**多行** = 拆成多条（第一行留给原条目，其余新增）。
 *
 * 为什么要拆：一条经验里塞两件事，检索时只能整条带进上下文 ——
 * 明明只相关一半，另一半也跟着占位置；而且以后改其中一条会连累另一条。
 *
 * 拆开之后状态一律回 pending：内容变了，之前的「已验证」不再算数。
 */
export function saveItem(id, rawText, { now = Date.now() } = {}) {
  const lines = String(rawText ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return { ok: false, reason: '内容不能为空' };
  if (lines.some((s) => s.length < 4)) return { ok: false, reason: '每行至少 4 个字' };

  const store = readStore();
  const item = store.items.find((x) => x.id === id);
  if (!item) return { ok: false, reason: '没这条经验' };

  item.text = lines[0];
  item.updatedAt = new Date(now).toISOString();
  if (lines.length > 1) item.status = 'pending';

  let created = 0;
  for (const line of lines.slice(1)) {
    store.items.push({
      id: newId(now + created + 1),
      text: line,
      status: 'pending',
      tags: Array.isArray(item.tags) ? [...item.tags] : [],
      sourceDay: item.sourceDay || dayKey(new Date(now)),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      lastUsedAt: null,
      hits: 0,
      corrections: 1
    });
    created += 1;
  }
  writeStore(store);
  return { ok: true, updated: 1, created, total: lines.length };
}

/** 删掉一条经验（真的删，不留档；要留档用归档）。B5：删前唯一备份 + 失败返回而不是抛错。 */
export function removeItem(id) {
  const store = readStore();
  const i = store.items.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, reason: '没这条经验' };
  const [gone] = store.items.splice(i, 1);
  // 4.0 / 1.5.4：writeStore 现在会保留「锁内有、本轮没有」的条目（防并发丢数据），
  // 所以删除必须显式标记，否则删了会被合并回来。
  try {
    Object.defineProperty(store, '__deleted', {
      value: new Set([String(id)]), enumerable: false, writable: true, configurable: true
    });
  } catch { /* 降级：靠下面的 items 缺失检测 */ }

  let backup = { backupDir: '' };
  try {
    backup = backupLearnedFile(id);
  } catch (e) {
    return { ok: false, reason: `备份失败，已拒绝删除：${String(e?.message ?? e)}` };
  }
  try {
    writeStore(store);
  } catch (e) {
    return { ok: false, reason: `写入失败（备份保留在 ${backup.backupDir || '无'}）：${String(e?.message ?? e)}`, backupDir: backup.backupDir || '' };
  }
  try {
    fs.appendFileSync(LEARNED_BACKUP_AUDIT, JSON.stringify({
      at: new Date().toISOString(), op: 'learned.delete', id: String(id), backupDir: backup.backupDir || '', result: 'ok'
    }) + '\n', 'utf8');
  } catch { /* ignore */ }
  return { ok: true, removed: gone?.text || '', backupDir: backup.backupDir || '' };
}

/** 把长期没用到的稳定经验归档（不删，检索时才翻出来）。 */
/**
 * ══ R8-B：晋升候选（2026-11-03）══════════════════════════════════
 *
 * **这个函数只产出候选，不改变任何 status。**
 *
 * 机主要求：
 *   · 不能按 hits / lastUsedAt 自动晋升 ——
 *     "如果错误记忆被频繁注入，它反而可能因为频繁使用而晋升，形成自我强化"
 *   · historicalUnresolved=true 禁止生成候选
 *   · 有 correction events 时，必须确认最新版本得到用户明确认可
 *   · 14 天只是时间门槛，不是可靠性证据
 *   · 候选记录含规则版本、生成时间、理由、阻止理由
 *
 * @param {{items: object[]}} store
 * @param {{now?: number}} [opts]
 * @returns {{candidates: object[], blocked: object[]}}
 */
/**
 * 晋升门禁用的纠正证据（R8-B v2）。
 * 状态只由 resolveCorrectionState 解释；这里额外给「最新版本是否被用户认可」。
 */
function correctionGate(item) {
  const cs = resolveCorrectionState(item);
  const events = Array.isArray(item?.correction?.events) ? item.correction.events : [];
  const last = events.length ? events[events.length - 1] : null;
  const lastSrc = String(last?.source || last?.kind || last?.by || '').toLowerCase();
  const latestAcked = !last || lastSrc === 'owner' || lastSrc === 'user_stated';
  return { cs, hasEvents: events.length > 0, last, lastSrc, latestAcked };
}

export function suggestPromotion(store, { now = Date.now() } = {}) {
  const items = Array.isArray(store?.items) ? store.items : [];
  const candidates = [];
  const blocked = [];

  const ageDays = (t) => {
    const ts = Date.parse(t || 0) || 0;
    return ts ? (now - ts) / 86400000 : Infinity;
  };

  for (const e of items) {
    if (!e || !e.id) continue;
    const st = String(e.status || 'pending');
    const gate = correctionGate(e);
    const cs = gate.cs;
    const reasons = [];
    const blockedReasons = [];

    // ── pending → verified ──────────────────────────────────
    if (st === 'pending') {
      // 阻止条件（R8-B v2）
      if (cs === 'unresolved') {
        blockedReasons.push('纠正未解决（unresolved）');
      } else if (cs === 'unknown') {
        blockedReasons.push('纠正历史不明（unknown），保守阻止');
      }
      if (cs === 'clear' && gate.hasEvents && !gate.latestAcked) {
        blockedReasons.push('最新版本没有得到用户明确认可（最后一条来源=' + (gate.lastSrc || '(空)') + '）');
      }

      if (blockedReasons.length) {
        blocked.push({ id: e.id, from: st, to: 'verified', ruleVersion: PROMOTION_RULE_VERSION, at: new Date(now).toISOString(), blockedReasons });
        continue;
      }

      // 通过条件（满足任一）
      const kind = String(e.origin?.kind || 'unknown').toLowerCase();
      const et = String(e.epistemicType || 'unknown').toLowerCase();
      const corrCount = Number(e.corrections) || 0;

      if (USER_STATED_KINDS.includes(kind)) {
        reasons.push('来源是用户直接陈述（origin.kind=' + kind + '）');
      } else if (et === 'direct' && corrCount <= 1) {
        // corrCount <= 1：因为创建时默认写 1，>1 才说明被合并/纠正过
        reasons.push('直接观察到的事实（epistemicType=direct）且没有合并历史（corrections=' + corrCount + '）');
      } else if (cs === 'clear' && gate.hasEvents && gate.latestAcked) {
        reasons.push('纠正过且已解决（最后一条来源=' + (gate.lastSrc || '(空)') + '）');
      }

      if (reasons.length) {
        candidates.push({ id: e.id, from: st, to: 'verified', ruleVersion: PROMOTION_RULE_VERSION, at: new Date(now).toISOString(), reasons, preview: String(e.text || '').slice(0, 40) });
      }
    }

    // ── verified → stable ───────────────────────────────────
    if (st === 'verified') {
      if (cs === 'unresolved') blockedReasons.push('纠正未解决（unresolved）');
      else if (cs === 'unknown') blockedReasons.push('纠正历史不明（unknown），保守阻止');
      const et = String(e.epistemicType || 'unknown').toLowerCase();
      if (et !== 'direct') blockedReasons.push('epistemicType=' + et + '：推断的内容不能进 stable');
      const age = ageDays(e.createdAt);
      if (age < STABLE_MIN_AGE_DAYS) blockedReasons.push('创建才 ' + age.toFixed(1) + ' 天，未满 ' + STABLE_MIN_AGE_DAYS + ' 天门槛');

      if (blockedReasons.length) {
        blocked.push({ id: e.id, from: st, to: 'stable', ruleVersion: PROMOTION_RULE_VERSION, at: new Date(now).toISOString(), blockedReasons });
        continue;
      }

      reasons.push('epistemicType=direct 且创建已 ' + age.toFixed(0) + ' 天（时间门槛，不是可靠性证据）');
      if (cs.hasEvents) reasons.push('纠正历史：' + cs.detail);
      candidates.push({ id: e.id, from: st, to: 'stable', ruleVersion: PROMOTION_RULE_VERSION, at: new Date(now).toISOString(), reasons, preview: String(e.text || '').slice(0, 40) });
    }
  }

  return { candidates, blocked };
}

/**
 * 从磁盘读一遍再算候选（给面板用）。
 * **只读，不写回。**
 */
export function getPromotionCandidates({ now = Date.now() } = {}) {
  try {
    const store = readStore();
    return suggestPromotion(store, { now });
  } catch (e) {
    return { candidates: [], blocked: [], error: String(e?.message ?? e) };
  }
}

/**
 * 归档长期未用的 stable 条目（2026-11-03 加保护）。
 *
 * **衰减 = 降级，不是删除。** 条目还在文件里，只是 status 变成 archived，
 * selectForContext 不再默认召回它。
 *
 * ══ 机主要求的硬保护（这些条目**永不衰减**）═══════════════════
 *   · historicalUnresolved=true（未解决的纠正）
 *   · 有未解决冲突（conflicts 字段非空）
 *   · importance === 'important'（重要日记来源的）
 *
 * ⚠️ 仍然**只处理 stable** —— 其他状态不碰。
 *
 * @param {{days?: number, now?: number, dryRun?: boolean}} [opts]
 * @returns {{archived: number, skipped: object[], dryRun: boolean}}
 */
export function archiveStale({ days = 30, now = Date.now(), dryRun = false, store: storeOverride = null } = {}) {
  // dry-run / 测试可以注入只读 store：不读盘、更不写盘。
  const store = storeOverride || readStore();
  const cutoff = now - days * 86400_000;
  const skipped = [];
  const hits = [];

  for (const item of store.items) {
    if (item.status !== 'stable') continue;

    // ── 硬保护（R8-B v2：统一走 resolveCorrectionState）──────────
    const cs = resolveCorrectionState(item);
    if (cs === 'unresolved') {
      skipped.push({ id: item.id, reason: '未解决的纠正（unresolved）' });
      continue;
    }
    if (cs === 'unknown') {
      skipped.push({ id: item.id, reason: '纠正历史不明（unknown），保守跳过' });
      continue;
    }
    if (Array.isArray(item.conflicts) && item.conflicts.length) {
      skipped.push({ id: item.id, reason: '有未解决冲突（conflicts 非空）' });
      continue;
    }
    if (String(item.importance || '') === 'important') {
      skipped.push({ id: item.id, reason: '重要条目（importance=important）' });
      continue;
    }

    // ── 时间判断 ──────────────────────────────────────────
    // lastUsedAt 是"最近一次被使用"，只要还在用就会刷新 —— 这是对的。
    // ⚠️ 但机主明确说过：lastUsedAt 不该被当成唯一衰减时钟。
    //    所以这里用 **createdAt 和 lastUsedAt 都超过 cutoff** 才算过期，
    //    避免"刚创建但还没被用过"的新条目被误判。
    const last = Date.parse(item.lastUsedAt || item.updatedAt || item.createdAt || 0) || 0;
    const born = Date.parse(item.createdAt || 0) || 0;
    if (last && last < cutoff && born && born < cutoff) {
      hits.push(item);
    }
  }

  if (!dryRun) {
    for (const item of hits) item.status = 'archived';
    if (hits.length) writeStore(store);
  }

  return { archived: hits.length, skipped, dryRun: Boolean(dryRun), ids: hits.map((x) => x.id) };
}

/**
 * 选这一轮要带哪几条。
 *
 * 打分不是「取最新 15 条」——那样新经验会不停挤掉重要的旧经验。
 *   status 权重（pending 最高）
 * + 相关性（和最近这几句对话的关键词重叠）
 * + 时效（最近 7 天写过）
 * + 久未使用（该提醒了）
 *
 * @returns {{items:Array, total:number}}
 */
export function selectForContext({ contextText = '', limit = DEFAULT_PICK, now = Date.now() } = {}) {
  const store = readStore();
  // 归档的不再被排除：它只是「不主动常驻」，强相关时仍要被捞回来。
  // 2026-10-27 机主指出「30 天归档不等于遗忘」——尤其反复纠正过的行为。
  const live = store.items.filter((x) => x.status !== 'deleted');
  if (!live.length) return { items: [], total: 0 };
  const ctx = keywordsOf(contextText);
  const cap = Math.max(1, Math.min(HARD_CAP, Number(limit) || DEFAULT_PICK));
  const scored = live.map((item) => {
    let score = STATUS_WEIGHT[item.status] ?? 0;
    if (ctx.size) {
      const kw = keywordsOf(item.text);
      let hit = 0;
      for (const w of kw) if (ctx.has(w)) hit += 1;
      // 归档条目的相关性权重加倍：平时压着，一旦真的相关就该冒出来
      const weight = item.status === 'archived' ? 2 : 1;
      score += Math.min(60 * weight, hit * 12 * weight);
    }
    const created = Date.parse(item.createdAt || 0) || 0;
    if (created && now - created < 7 * 86400_000) score += 10;   // 新鲜
    // 笔记：「稳定且从没用过就扣分」这条已删（2026-10-27 机主指出）——
    // 稳定经验本来就不该常加载，再扣分等于让它永远检索不到。
    // 稳定性只通过 STATUS_WEIGHT 体现（0 分），不额外惩罚。
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // 归档的要有「正分」才进：无关话题时它稳拿 -60，不该出现；
  // 但真相关（3 个以上关键词重合）时分会翻正，就能被捞回来。
  const eligible = scored.filter((x) => x.item.status !== 'archived' || x.score > 0);
  const picked = eligible.slice(0, cap).map((x) => x.item);
  // 记账：带了谁、带了几次（归档和后续统计都靠它）
  if (picked.length) {
    const iso = new Date(now).toISOString();
    for (const p of picked) {
      const t = store.items.find((x) => x.id === p.id);
      if (!t) continue;
      t.lastUsedAt = iso;
      t.hits = (Number(t.hits) || 0) + 1;
    }
    writeStore(store);
  }
  return { items: picked, total: live.length };
}

/**
 * 给 system prompt 用的一段文本。
 *
 * @param {object} [opts]
 * @param {string[]|null} [opts.collect] 传入数组时，把本轮**实际选中**的条目 id 收进去 ——
 *   提示词指纹要用（2026-10-29）。注意不能在外面再调一次 selectForContext 拿 id：
 *   那次调用会给每条的 hits +1，等于凭空多记一次"用过"。
 */
export function renderForPrompt({ contextText = '', limit = DEFAULT_PICK, now = Date.now(), collect = null } = {}) {
  const { items, total } = selectForContext({ contextText, limit, now });
  if (Array.isArray(collect)) collect.push(...items.map((x) => x.id));
  if (!items.length) return '';
  const mark = (s) => (s === 'pending' ? '（待验证）' : s === 'verified' ? '（已验证）' : '');
  const lines = items.map((x) => `- ${x.text}${mark(x.status)}`);
  const hidden = Math.max(0, total - items.length);
  const tail = hidden ? `\n（库里还有 ${hidden} 条没带，需要时先翻日记再答）` : '';
  return `【你记住的经验】\n${lines.join('\n')}${tail}`;
}

export function stats() {
  const store = readStore();
  const by = { pending: 0, verified: 0, stable: 0, archived: 0 };
  for (const x of store.items) by[x.status] = (by[x.status] || 0) + 1;
  return { total: store.items.length, by, file: LEARNED_FILE };
}

export function listAll({ status = '' } = {}) {
  const store = readStore();
  const list = status ? store.items.filter((x) => x.status === status) : store.items;
  // 4.0 / 3.0-R2：读时补元数据默认值（**只读，不写盘**）
  return list.map((x) => withMeta(x));
}
