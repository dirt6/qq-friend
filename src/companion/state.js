// Companion State —— 聊天和自主活动共享的「当前正在发生的事」（4.0 · 阶段 2.2）。
//
// ── 它解决什么问题 ────────────────────────────────────────────────
// 以前她在自主活动里决定「把视频花费的事说开」，这个目标写进 autonomous.json；
// 但你在 QQ 里跟她说话时，她完全不知道自己在等什么 —— 只有下次自主醒来才读得回来。
// 跨模式连续是断的。
//
// ── 它装什么（2.6 起）────────────────────────────────────────────
//   · goals  ：**长期方向**，带生命周期（active/paused/completed/cancelled/superseded）
//              同一时间只有一个 active；其余状态保留历史，不删。
//   · topic  ：当前正在关注的话题
//   · pending：尚未完成的具体事项，**可以多条**，带 id 和明确状态
//   · **不放 mood** —— 日记里的心情是"某个时刻的感受"，不等于"现在仍处于";
//     硬塞一个字段只会变成过期数据。
//
// ── Goal / Pending / Topic 的职责边界（2.6 设计第五节）───────────
//   Goal    长期方向（"想多了解老大的学习状态"）
//   Pending 具体没做完的事（"等老大回复上次的问题"）
//   Topic   最近聊过的话题（"昨晚睡得怎么样"）
//   **三者可以同时存在，没有必须绑定的关系。**
//   Pending 完成 ≠ Goal 完成；Goal 完成也不让 Pending 自动完成。
//
// ── 谁能改（机主要求"明确状态转换、程序控制写入"）────────────────
//   聊天和自主活动都可以**提出**修改，但都经过这里：
//     · 走 state-store 的单写者（跨进程锁 + 原子替换）
//     · 程序负责校验（状态合法、id 存在）、合并（不覆盖别人的修改）、落盘
//     · 模型不直接重写整个文件
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { withState } from '../state-store.js';

export const COMPANION_FILE = path.join(DATA_DIR, 'companion-state.json');

/**
 * pending 的合法状态。
 *
 * · pending    ：还没做，小鲸鱼可以主动推进
 * · waiting    ：在等外部事件（等老大回话 / 等第三方恢复）
 * · done       ：做完了
 * · cancelled  ：主动放弃
 * · **expired**：超过 expiresAt 还没处理（4.0 / 2.6-B2）
 *   —— 和 cancelled 不同：expired 是"放着放着过时了"，不是"主动不做了"。
 *   —— 和 done 不同：什么都没发生，不能当成做完了。
 */
export const PENDING_STATUS = ['pending', 'waiting', 'done', 'cancelled', 'expired'];

/* ── Goal 状态模型（4.0 / 2.6.1）──────────────────────────────────── */

/**
 * Goal 的五个状态。
 *
 * · active     ：当前正在关注（**注入聊天上下文**）
 * · paused     ：暂时搁置，但仍有价值（不注入）
 * · completed  ：已经实现（终态，不注入）
 * · cancelled  ：已明确放弃（终态，不注入）
 * · superseded ：已被新方向取代，原方向不再需要追踪（终态，不注入）
 *
 * paused 和 superseded 必须分清：前者以后还可能恢复，后者是"这个方向不用再跟了"。
 */
export const GOAL_STATUS = ['active', 'paused', 'completed', 'cancelled', 'superseded'];

/** 终态：进入后不能再转。 */
export const GOAL_STATUS_TERMINAL = ['completed', 'cancelled', 'superseded'];

/** Goal 的来源。 */
export const GOAL_SOURCE = ['autonomous', 'user_directed'];

/**
 * 允许的状态转换（2.6 设计第五节）。
 * 终态没有出口 —— 要重新开始就建一个新的 Goal。
 */
export const GOAL_ALLOWED_TRANSITIONS = {
  active: ['paused', 'completed', 'cancelled', 'superseded'],
  paused: ['active', 'cancelled', 'superseded'],
  completed: [],
  cancelled: [],
  superseded: []
};

/**
 * 谁有权限做哪些操作（2.6 设计第三节 + 第五节）。
 *
 * autonomous   ：她自己起的方向，可以自主完成/取消/取代。
 * user_directed：老大明确交代的，**不能擅自完成/取消/取代** —— 要得到老大认可。
 *                （暂停/恢复可以，但要有合理原因。）
 */
export const GOAL_PERMISSION = {
  autonomous: { pause: true, resume: true, complete: true, cancel: true, supersede: true },
  user_directed: { pause: true, resume: true, complete: false, cancel: false, supersede: false }
};

/** 同时最多一个 active —— 4.0 / 2.6.4a 起真正检查。 */
export const MAX_ACTIVE_GOALS = 1;

/**
 * 最多保留几个 paused —— 4.0 / 2.6.4a 起真正检查。
 *
 * **容量不够时只拒绝，不删任何东西。**
 * user_directed 是老大的明确承诺，系统无权判断"哪个不重要"；
 * autonomous 的容量淘汰（by: 'capacity'）留给 2.6.4c。
 */
export const MAX_PAUSED_GOALS = 3;

const MAX_PENDING = 20;            // 当前事项最多 20 条，超出丢最老的已结算项
const SETTLED_KEEP_DAYS = 7;       // 已完成/取消的保留 7 天（方便排查"状态为什么消失"）
const DEFAULT_EXPIRE_DAYS = 30;    // 默认 30 天过期（过期 ≠ 完成）

function emptyState() {
  return {
    version: 2,
    goals: [],
    // goal 是 2.5 的旧字段，现在只作为**兼容视图**（取 active 那条），不再单独存
    goal: null,
    topic: null,
    pending: [],
    updatedAt: ''
  };
}

function newId() {
  return `p-${crypto.randomBytes(3).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 把文件里的 goals 归一成标准结构（4.0 / 2.6.1）。
 *
 * 两种输入：
 *   ① 新格式：j.goals 是数组
 *   ② 旧格式（2.5）：j.goal 是单个对象 —— 包成 goals[0]，标 id 'g-legacy-1'
 *
 * **只读兼容，不回写** —— 什么时候迁移由 2.6.1 的迁移步骤单独决定。
 */
export function normalizeGoals(j) {
  if (!j || typeof j !== 'object') return [];

  if (Array.isArray(j.goals)) {
    return j.goals
      .filter((g) => g && g.id && g.text)
      .map((g) => {
        const since = String(g.since || '');
        return {
          id: String(g.id),
          text: String(g.text).slice(0, 200),
          source: GOAL_SOURCE.includes(g.source) ? g.source : 'autonomous',
          status: GOAL_STATUS.includes(g.status) ? g.status : 'active',
          since,
          updatedAt: String(g.updatedAt || since),
          statusSince: String(g.statusSince || since),
          reason: String(g.reason || ''),
          // 2.6.3：字段从 completion 改名成 proposal（2.6.1 预留的 completion 从没用过，
          // 但旧文件可能手写过，读的时候兼容一下）
          proposal: (g.proposal && typeof g.proposal === 'object') ? g.proposal
            : ((g.completion && typeof g.completion === 'object') ? g.completion : null),
          history: Array.isArray(g.history) ? g.history.slice(-20) : [],
          // 4.0 / 2.6.4a：来源升级的审计（和 history 分开，因为 from/to 的语义不同）
          sourceHistory: Array.isArray(g.sourceHistory) ? g.sourceHistory.slice(-20) : []
        };
      });
  }

  // 旧格式：2.5 的单 goal
  if (j.goal && typeof j.goal === 'object' && j.goal.text) {
    const since = String(j.goal.since || '');
    return [{
      id: 'g-legacy-1',
      text: String(j.goal.text).slice(0, 200),
      source: GOAL_SOURCE.includes(j.goal.source) ? j.goal.source : 'autonomous',
      status: 'active',
      since,
      updatedAt: since,
      statusSince: since,
      reason: '从 2.5 的单 goal 兼容读取',
      completion: null,
      history: []
    }];
  }

  return [];
}

/** 这个状态能不能转到那个状态。 */
export function canTransition(from, to) {
  const list = GOAL_ALLOWED_TRANSITIONS[String(from)] || [];
  return list.includes(String(to));
}

/**
 * 这个来源有没有权限做这个操作。
 * @param {'autonomous'|'user_directed'} source
 * @param {'pause'|'resume'|'complete'|'cancel'|'supersede'} op
 */
export function canOperate(source, op) {
  const perm = GOAL_PERMISSION[String(source)] || null;
  if (!perm) return false;
  return perm[String(op)] === true;
}

/** 当前 active 的 Goal（最多一条）。 */
export function activeGoal(state) {
  const st = state || readCompanion();
  return (st.goals || []).find((g) => g.status === 'active') || null;
}

/** 所有 paused 的 Goal（按 statusSince 正序）。 */
export function pausedGoals(state) {
  const st = state || readCompanion();
  return (st.goals || [])
    .filter((g) => g.status === 'paused')
    .sort((a, b) => Date.parse(a.statusSince || 0) - Date.parse(b.statusSince || 0));
}

/**
 * 校验一条 Goal 的结构是否合法（迁移/写入前用）。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateGoal(g) {
  const errors = [];
  if (!g || typeof g !== 'object') return { ok: false, errors: ['不是对象'] };
  if (!g.id) errors.push('缺 id');
  if (!g.text || typeof g.text !== 'string') errors.push('缺 text');
  if (typeof g.text === 'string' && g.text.length > 200) errors.push('text 超过 200 字');
  if (!GOAL_SOURCE.includes(g.source)) errors.push('source 不合法：' + g.source);
  if (!GOAL_STATUS.includes(g.status)) errors.push('status 不合法：' + g.status);
  for (const k of ['since', 'updatedAt', 'statusSince']) {
    if (g[k] && !Number.isFinite(Date.parse(g[k]))) errors.push(k + ' 不是有效时间');
  }
  return { ok: errors.length === 0, errors };
}

/** 新 Goal 的 id。 */
function newGoalId() {
  return `g-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 读 Companion State（只读）。
 * 文件不存在 / 坏掉都给空状态 —— 调用方不需要处理 null。
 */
export function readCompanion() {
  try {
    const j = JSON.parse(fs.readFileSync(COMPANION_FILE, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return emptyState();
    const goals = normalizeGoals(j);
    return {
      version: 2,
      goals,
      // 兼容视图：2.5 的调用点（promptSection / summary / settleChatPending）还在用 state.goal
      goal: goals.find((g) => g.status === 'active') || null,
      topic: j.topic && typeof j.topic === 'object' && j.topic.text ? j.topic : null,
      pending: Array.isArray(j.pending) ? j.pending.filter((p) => p && p.id && p.text) : [],
      updatedAt: String(j.updatedAt || '')
    };
  } catch {
    return emptyState();
  }
}

/**
 * 锁内读-改-写（唯一写入口）。
 *
 * @param {(st:object) => void} fn 原地改
 * @returns {{ok:boolean, state?:object, error?:string}}
 */
export function updateCompanion(fn) {
  const r = withState(COMPANION_FILE, (cur) => {
    // 文件可能是旧的/空的，先补全结构再改
    if (!cur || typeof cur !== 'object') cur = emptyState();
    if (!Array.isArray(cur.pending)) cur.pending = [];
    if (!('topic' in cur)) cur.topic = null;
    // 2.6.1：写盘永远用 goals 数组。旧的 goal 在第一次写入时被归一进来。
    if (!Array.isArray(cur.goals)) cur.goals = normalizeGoals(cur);
    cur.version = 2;

    fn(cur);

    // 顺手做两件维护：清掉过期太久的已结算项、限制总条数
    cur.pending = tidyPending(cur.pending);
    cur.updatedAt = nowIso();
    // 2.6.1：数据结构升级到 goals 数组
    cur.version = 2;
  }, { fallback: emptyState() });

  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, state: readCompanion() };
}

/** 清理 + 限流（不删未结算的）。 */
/**
 * 锁内惰性清理过期 pending（4.0 / 2.6-B2）。
 *
 * **只改状态，不删记录** —— 过期的转成 'expired'，保留 7 天（和 done/cancelled 一样），
 * 之后由 tidyPending 按 settledAt 清掉。
 *
 * 为什么不在 readCompanion 里做：读操作频繁（每轮聊天 / 面板 / 注入），
 * 不能一读就写盘。只在写入接口的锁内顺手清。
 *
 * @param {object} st  状态（会被原地修改）
 * @param {number} now 统一时间快照（同一批操作共用，避免判断到一半时间变了）
 * @returns {string[]} 被标记为过期的 pending id
 */
function expirePendingIn(st, now) {
  const out = [];
  for (const p of st.pending || []) {
    // 已经结算的不动
    if (p.status === 'done' || p.status === 'cancelled' || p.status === 'expired') continue;
    const t = Date.parse(p.expiresAt || '');
    if (!Number.isFinite(t) || t >= now) continue;
    p.status = 'expired';
    p.settledAt = new Date(now).toISOString();
    p.settledBy = 'expiry';
    p.expiredAt = new Date(now).toISOString();
    out.push(p.id);
  }
  return out;
}

function tidyPending(list) {
  const cutoff = Date.now() - SETTLED_KEEP_DAYS * 86400e3;
  const kept = [];
  for (const p of list) {
    // 4.0 / 2.6-B2：expired 也算已结算（有 settledAt，按同样规则保留 7 天）
    const settled = p.status === 'done' || p.status === 'cancelled' || p.status === 'expired';
    if (settled) {
      const t = Date.parse(p.settledAt || p.at || '');
      // 结算超过 7 天的丢掉；时间解析不出来的也丢（避免永远赖着）
      if (!Number.isFinite(t) || t < cutoff) continue;
    }
    kept.push(p);
  }
  if (kept.length <= MAX_PENDING) return kept;
  // 超上限：只截「已结算」，**未结算的一条都不丢**（宁可超上限，也不清未完成项）。
  const active = kept.filter((p) => p.status !== 'done' && p.status !== 'cancelled' && p.status !== 'expired');
  const settled = kept.filter((p) => p.status === 'done' || p.status === 'cancelled' || p.status === 'expired')
    .sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
  if (active.length >= MAX_PENDING) {
    console.warn(`[companion] 未结算 pending 已达 ${active.length} 条（上限 ${MAX_PENDING}），保留全部未结算项`);
    return kept.filter((p) => active.includes(p));
  }
  const room = Math.max(0, MAX_PENDING - active.length);
  const keepSettled = new Set(settled.slice(Math.max(0, settled.length - room)).map((p) => p.id));
  return kept.filter((p) => active.includes(p) || keepSettled.has(p.id));
}

/* ── goal ──────────────────────────────────────────────────────────── */

/* ── Goal 生命周期接口（4.0 / 2.6.2）────────────────────────────── */
//
// 四个接口：createGoal / updateGoal / pauseGoal / resumeGoal。
//
// 共同约定：
//   · 全部走 updateCompanion（锁内读-改-写），所以同一时刻只有一个写者
//   · 每次状态变化都写 history：{ at, from, to, by, reason }
//   · history 保留最近 20 条
//   · 返回 { ok: true, goal } 或 { ok: false, error }
//
// **本阶段不做**：user_directed 的完成/取消/取代权限确认（2.6.3）、
// 暂停容量管理（2.6.4）。

/**
 * Goal 文本的规范化（4.0 / 2.6.4a）。
 *
 * 保守方案：只做 trim + 连续空白归一 + 截断，**不删标点、不改写、不做语义相似**。
 * 「准备 CSP。」和「准备CSP」仍然是不同文本。
 */
function normalizeGoalText(text) {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/**
 * 算"如果执行这个操作，容量会变成多少"（4.0 / 2.6.4a）。
 *
 * **纯函数，只读不写。** createGoal / pauseGoal / resumeGoal 共用这一套，
 * 避免三个接口各写一份判断导致规则不一致。
 *
 * @param {object} st    当前状态（锁内读到的）
 * @param {object} plan  操作意图：
 *   · { kind: 'create' }              新建（旧的 active 会让位）
 *   · { kind: 'restore', id }         createGoal 去重路径里恢复一条 paused
 *   · { kind: 'pause', id }           暂停一条 active
 *   · { kind: 'resume', id }          恢复一条 paused（resumeGoal）
 * @returns {{ok:boolean, capacity:object|null}}
 */
function computeCapacity(st, plan) {
  const goals = Array.isArray(st.goals) ? st.goals : [];
  const activeUsed = goals.filter((g) => g.status === 'active').length;
  const pausedUsed = goals.filter((g) => g.status === 'paused').length;

  let activeAfter = activeUsed;
  let pausedAfter = pausedUsed;

  switch (plan && plan.kind) {
    case 'create':
      // 新建：如果已有 active，它会让位（-1 +1 换个身份），新的占 active
      activeAfter = 1;
      pausedAfter = pausedUsed + (activeUsed > 0 ? 1 : 0);
      break;

    case 'restore':   // createGoal 碰到同文本 paused
    case 'resume':    // resumeGoal
      // 被恢复的从 paused 转出（-1），原 active 让位转入（+1）→ 净 0
      activeAfter = 1;
      pausedAfter = pausedUsed - 1 + (activeUsed > 0 ? 1 : 0);
      break;

    case 'pause':
      // 防御性兜底：正常情况下只有 active 的能走到这里，activeUsed >= 1
      activeAfter = Math.max(0, activeUsed - 1);
      pausedAfter = pausedUsed + 1;
      break;

    default:
      return { ok: true, capacity: null };
  }

  const capacity = {
    activeMax: MAX_ACTIVE_GOALS,
    activeUsed,
    activeAfter,
    pausedMax: MAX_PAUSED_GOALS,
    pausedUsed,
    pausedAfter
  };
  // capacity 反映**这个操作之后**的状态，不只是当前用量 —— 聊天层要能说"再记一件就 4 件了"
  const ok = activeAfter <= MAX_ACTIVE_GOALS && pausedAfter <= MAX_PAUSED_GOALS;
  return { ok, capacity };
}

/** 容量不足时的标准返回（结构稳定，机主要求）。 */
function capacityError(message, capacity) {
  return { error: message, code: 'CAPACITY_FULL', capacity };
}

/** 把一条 goal 的状态改掉，并记 history。 */
function transition(g, to, { by = 'unknown', reason = '' } = {}) {
  const from = g.status;
  const now = nowIso();
  g.status = to;
  g.statusSince = now;
  g.updatedAt = now;
  if (reason) g.reason = String(reason).slice(0, 200);
  g.history = (g.history || []).concat([{
    at: now,
    from,
    to,
    by: String(by).slice(0, 40),
    reason: String(reason || '').slice(0, 200)
  }]).slice(-20);
}

/**
 * 创建一条 Goal（4.0 / 2.6.2）。
 *
 * 规则（机主 2026-11-01 定稿）：
 *   · 相同文本已 active  → 不操作，返回那条（created: false）
 *   · 相同文本已 paused  → **恢复原记录**，保留 ID 和历史（created: false）
 *     · 多条同文本 paused 时，恢复 `statusSince` **最新**的那条
 *       （最近搁置的，最可能还想继续；其余的保持不动）
 *   · 相同文本已终态    → 新建（那是旧的一轮结束，现在重新开始）
 *   · 有别的 active     → 旧的转 paused，带 history
 *
 * @param {object} o
 * @param {string} o.text 方向描述（≤ 200 字，超长截断）
 * @param {'autonomous'|'user_directed'} [o.source]
 * @returns {{ok:boolean, goal?:object, created?:boolean, error?:string}}
 */
/**
 * **内部**：真正的 Goal 创建实现（4.0 / 2.6-P1-1）。
 *
 * ⚠️ **不导出。** 外部只能用三个公开入口：
 *   · createAutonomousGoal（必须带跨轮证据）
 *   · createUserGoal（用户明确交代的长��方向）
 *   · createGoal（2.5 兼容层，**不允许**建 autonomous）
 *
 * 这里不校验来源权限 —— 权限在三个公开入口里各自把关。
 */
function createGoalCore({ text, source = 'autonomous' } = {}) {
  // 4.0 / 2.6.4a：规范化（trim + 连续空白归一 + 截断），让「准备  CSP」和「准备 CSP」算同一个
  const t = normalizeGoalText(text);
  if (!t) return { ok: false, error: 'goal 不能为空' };
  const src = GOAL_SOURCE.includes(source) ? source : 'autonomous';

  let out = null;
  let created = false;
  let err = null;

  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = [];
    const same = st.goals.filter((g) => g.text === t);

    // ① 已经有同样文本的 active → 什么都不做
    const sameActive = same.find((g) => g.status === 'active');
    if (sameActive) {
      // 4.0 / 2.6.4a：来源升级 —— 只允许 autonomous → user_directed，不允许反向。
      // **只在真正变化时才记**，已经是 user_directed 时不重复写。
      // 审计放**单独的 sourceHistory**，不混进 history（history 的 from/to 是 status 值）。
      if (src === 'user_directed' && sameActive.source === 'autonomous') {
        const upAt = nowIso();
        sameActive.source = 'user_directed';
        sameActive.sourceSince = upAt;
        sameActive.sourceHistory = (sameActive.sourceHistory || []).concat([{
          at: upAt,
          from: 'autonomous',
          to: 'user_directed',
          by: 'createGoal',
          reason: '老大明确交代长期保留'
        }]).slice(-20);
      }
      // 2.6.3：方向还在，旧的结束提议作废（同一次写入里清掉）
      sameActive.proposal = null;
      sameActive.updatedAt = nowIso();
      out = sameActive;
      created = false;
      return;
    }

    // ② 有同样文本的 paused → 恢复最近暂停的那条（保留 ID 和历史）
    const samePaused = same
      .filter((g) => g.status === 'paused')
      .sort((a, b) => Date.parse(b.statusSince || 0) - Date.parse(a.statusSince || 0));
    if (samePaused.length) {
      const target = samePaused[0];
      // 4.0 / 2.6.4a：容量检查**在改任何字段之前**
      const cap = computeCapacity(st, { kind: 'restore', id: target.id });
      if (!cap.ok) {
        err = capacityError('恢复它会变成 ' + cap.capacity.pausedAfter + ' 件搁置的事，超过上限 ' + MAX_PAUSED_GOALS, cap.capacity);
        return;
      }
      // 有别的 active 就先让位
      const other = st.goals.find((g) => g.status === 'active' && g.id !== target.id);
      if (other) transition(other, 'paused', { by: src, reason: '被恢复的方向让位' });
      transition(target, 'active', { by: src, reason: '原方向恢复关注' });
      target.proposal = null;   // 2.6.3：恢复方向时清掉旧的结束提议
      out = target;
      created = false;
      return;
    }

    // ③ 新建：**先做容量检查，通过了才动任何字段**
    const cap = computeCapacity(st, { kind: 'create' });
    if (!cap.ok) {
      err = capacityError('已经记了 ' + cap.capacity.pausedUsed + ' 件搁置的事，再记一件就 ' + cap.capacity.pausedAfter + ' 件了（上限 ' + MAX_PAUSED_GOALS + '）', cap.capacity);
      return;
    }
    // 先把旧的 active 转 paused
    const cur = st.goals.find((g) => g.status === 'active');
    if (cur) transition(cur, 'paused', { by: src, reason: '出现新的方向，暂时搁置' });

    const now = nowIso();
    const goal = {
      id: newGoalId(),
      text: t,
      source: src,
      status: 'active',
      since: now,
      updatedAt: now,
      statusSince: now,
      reason: '',
      completion: null,
      history: []
    };
    st.goals.push(goal);
    out = goal;
    created = true;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (err) return { ok: false, ...err };
  return { ok: true, goal: out, created };
}
/**
 * 创建一条**用户明确交代**的长期 Goal（4.0 / 2.6-P1-1）。
 *
 * 不需要跨轮证据 —— 老大说"这个你记着"就够了。
 * 去重、来源升级、容量、并发全部复用 createGoalCore。
 *
 * @param {object} o
 * @param {string} o.text
 * @returns {{ok:boolean, goal?:object, created?:boolean, error?:string, code?:string}}
 */
export function createUserGoal({ text } = {}) {
  return createGoalCore({ text, source: 'user_directed' });
}

/**
 * 2.5 兼容层（4.0 / 2.6-P1-1）。
 *
 * **不允许创建 autonomous Goal** —— 那是 createAutonomousGoal 的事，必须带证据。
 * source 不在合法枚举里时**安全失败**（不猜、不归一）。
 *
 * @deprecated 新代码用 createAutonomousGoal 或 createUserGoal。
 * @param {object} o
 * @param {string} o.text
 * @param {'user_directed'} [o.source] 只接受 user_directed
 */
export function createGoal({ text, source = 'autonomous' } = {}) {
  // ① 显式请求 autonomous → 拒绝（必须走带证据的入口）
  if (source === 'autonomous') {
    return {
      ok: false,
      code: 'EVIDENCE_REQUIRED',
      error: '自主 Goal 必须走 createAutonomousGoal（要带跨轮证据）'
    };
  }
  // ② 来源不在合法枚举 → 安全失败（不归一、不猜）
  //    以前这里会把未知来源归一成 autonomous，等于给了一条绕过证据的后门。
  if (!GOAL_SOURCE.includes(source)) {
    return {
      ok: false,
      code: 'INVALID_SOURCE',
      error: 'source 不合法（只支持 ' + GOAL_SOURCE.join(' / ') + '，且 autonomous 必须走 createAutonomousGoal）'
    };
  }
  return createGoalCore({ text, source });
}


/**
 * 更新一条 Goal 的**描述**（4.0 / 2.6.2）。
 *
 * **不改状态、不改 source。** source 是来源事实，不属于普通文本更新字段；
 * autonomous 升级成 user_directed 的场景留给后续阶段设计。
 *
 * @param {string} id
 * @param {object} o
 * @param {string} o.text 新描述
 * @param {string} [o.by]
 * @returns {{ok:boolean, goal?:object, changed?:boolean, error?:string}}
 */
export function updateGoal(id, { text, by = 'unknown' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空' };
  const t = String(text ?? '').trim().slice(0, 200);
  if (!t) return { ok: false, error: 'goal 不能为空' };

  let out = null;
  let changed = false;
  let err = '';

  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = [];
    const g = st.goals.find((x) => x.id === want);
    if (!g) { err = '没有这条 Goal'; return; }
    // 改成和别的 goal 一样的文本 → 拒绝（避免两条一模一样的方 向）
    const dup = st.goals.find((x) => x.id !== want && x.text === t);
    if (dup) { err = '已经有同样描述的 Goal（' + dup.id + '）'; return; }
    if (g.text === t) { out = g; changed = false; return; }   // 幂等
    g.text = t;
    g.updatedAt = nowIso();
    out = g;
    changed = true;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (err) return { ok: false, error: err };
  return { ok: true, goal: out, changed };
}

/**
 * 暂停一条 Goal（4.0 / 2.6.2）。
 *
 * · 已经是 paused → 幂等返回，**不重复写 history**
 * · 终态 → 报错
 *
 * @param {string} id
 * @param {object} o
 * @param {string} [o.reason]
 * @param {string} [o.by]
 */
export function pauseGoal(id, { reason = '', by = 'unknown' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空' };

  let out = null;
  let err = '';

  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = [];
    const g = st.goals.find((x) => x.id === want);
    if (!g) { err = '没有这条 Goal'; return; }
    if (g.status === 'paused') { out = g; return; }            // 幂等，不写 history、不检查容量
    if (GOAL_STATUS_TERMINAL.includes(g.status)) { err = '终态不能再暂停（当前 ' + g.status + '）'; return; }
    if (!canTransition(g.status, 'paused')) { err = '不允许从 ' + g.status + ' 转到 paused'; return; }

    // 4.0 / 2.6.4a：容量检查。**前置状态校验不能省**（上面三条已经先过了），
    // 容量只在"真正要转"的时候才拦，而且检查通过前不动任何字段。
    const cap = computeCapacity(st, { kind: 'pause', id: g.id });
    if (!cap.ok) {
      err = capacityError('已经搁置了 ' + cap.capacity.pausedUsed + ' 件事，再暂停就 ' + cap.capacity.pausedAfter + ' 件了（上限 ' + MAX_PAUSED_GOALS + '）', cap.capacity);
      return;
    }

    transition(g, 'paused', { by, reason: reason || '暂时搁置' });
    out = g;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (err) return typeof err === 'string' ? { ok: false, error: err } : { ok: false, ...err };
  return { ok: true, goal: out };
}

/**
 * 恢复一条 paused 的 Goal（4.0 / 2.6.2）。
 *
 * **如果此刻有别的 active，必须在同一次锁内把它转成 paused** ——
 * 保证任何时刻最多一个 active。
 *
 * · 已经是 active → 幂等
 * · 终态 → 报错
 *
 * @param {string} id
 * @param {object} o
 * @param {string} [o.reason]
 * @param {string} [o.by]
 * @returns {{ok:boolean, goal?:object, pausedPrevious?:string|null, error?:string}}
 */
export function resumeGoal(id, { reason = '', by = 'unknown' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空' };

  let out = null;
  let pausedPrevious = null;
  let err = '';

  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = [];
    const g = st.goals.find((x) => x.id === want);
    if (!g) { err = '没有这条 Goal'; return; }
    if (g.status === 'active') { out = g; return; }            // 幂等
    if (GOAL_STATUS_TERMINAL.includes(g.status)) { err = '终态不能恢复（当前 ' + g.status + '）'; return; }
    if (!canTransition(g.status, 'active')) { err = '不允许从 ' + g.status + ' 转到 active'; return; }

    // 4.0 / 2.6.4a：防御性容量检查。
    // 实测 resume 的净效果是 paused 不变（-1 转出 +1 原 active 转入），永远能过；
    // 但显式检查比"靠推理保证"可靠 —— 将来语义变了这里不会漏。
    const cap = computeCapacity(st, { kind: 'resume', id: g.id });
    if (!cap.ok) {
      err = capacityError('恢复后搁置的事会变成 ' + cap.capacity.pausedAfter + ' 件，超过上限 ' + MAX_PAUSED_GOALS, cap.capacity);
      return;
    }

    // 同一个锁里先让位，再恢复 —— 不会有中间状态出现两个 active
    const other = st.goals.find((x) => x.status === 'active' && x.id !== g.id);
    if (other) {
      transition(other, 'paused', { by, reason: '被恢复的方向让位' });
      pausedPrevious = other.id;
    }
    transition(g, 'active', { by, reason: reason || '恢复关注' });
    out = g;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (err) return typeof err === 'string' ? { ok: false, error: err } : { ok: false, ...err };
  return { ok: true, goal: out, pausedPrevious };
}

/* ── Goal 终态与确认（4.0 / 2.6.3）────────────────────────────────── */
//
// 三种结束语义**不能共用**一个确认标记：
//   complete  → 老大确认「这件事做完了」
//   cancel    → 老大**明确放弃**
//   supersede → 老大确认「这个旧方向失去意义了」
//
// 流程（只有 user_directed 需要）：
//   proposeCompletion()  → 写下 proposal（**不改 status**）
//   markConfirmationAsked() → 记下"问了"，开始 7 天倒计时
//   answerConfirmation() → 老大答 yes/no/later
//        yes   → 执行，转终态
//        其他  → 清掉 proposal，状态不变
//
// **最要防的**：把"暂时不提 / 暂时搁置"当成取消或取代。
// 所以：没问过不执行、没答 yes 不执行、过期不执行。

/** 提议的种类。 */
export const PROPOSAL_KIND = ['complete', 'cancel', 'supersede'];

/** 询问后多久过期（天）。**未询问的 proposal 不启动倒计时。** */
const PROPOSAL_TTL_DAYS = 7;

/** 这条 proposal 过期了吗（只看 expiresAt，没设就不算过期）。 */
function isProposalExpired(p, now = Date.now()) {
  if (!p) return false;
  const t = Date.parse(p.expiresAt || '');
  return Number.isFinite(t) && t < now;
}

/**
 * 锁内惰性清理过期 proposal（4.0 / 2.6.3）。
 *
 * **只清 proposal，不动 status** —— 过期不是取消、不是完成、不是拒绝。
 * @returns {string[]} 被清理的 goal id
 */
function expireProposalsIn(st, now) {
  const out = [];
  for (const g of st.goals || []) {
    if (!g.proposal) continue;
    if (isProposalExpired(g.proposal, now)) {
      g.proposal = null;
      out.push(g.id);
    }
  }
  return out;
}

/**
 * 手动清理过期 proposal（供测试 / 将来手动维护）。
 * **读接口永远不调它** —— 读不应该写盘。
 */
export function expireProposals(now = Date.now()) {
  let expired = [];
  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = normalizeGoals(st);
    expired = expireProposalsIn(st, now);
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, expired };
}

/**
 * 提议结束一条 Goal（4.0 / 2.6.3）。
 *
 * **不改 status** —— 提议只是"她认为可以了"，要不要执行看老大的回答。
 *
 * 覆盖规则：**整块替换**，不继承旧的 askedAt / answer / answerQuote。
 */
export function proposeCompletion(id, { kind, reason = '' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空', code: 'NOT_FOUND' };
  if (!PROPOSAL_KIND.includes(kind)) {
    return { ok: false, error: 'kind 不合法（只能是 ' + PROPOSAL_KIND.join(' / ') + '）', code: 'INVALID_KIND' };
  }

  let out = null;
  let err = null;
  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = normalizeGoals(st);
    const now = Date.now();
    expireProposalsIn(st, now);

    const g = st.goals.find((x) => x.id === want);
    if (!g) { err = { error: '没有这条 Goal', code: 'NOT_FOUND' }; return; }
    if (GOAL_STATUS_TERMINAL.includes(g.status)) {
      err = { error: '终态不能再提议（当前 ' + g.status + '）', code: 'TERMINAL_STATE' };
      return;
    }

    // 整块替换 —— 不继承任何旧字段
    g.proposal = {
      kind,
      proposedAt: nowIso(),
      proposedBy: 'autonomous',
      reason: String(reason || '').slice(0, 200),
      askedAt: null,
      askedRound: null,
      expiresAt: null,
      answerAt: null,
      answer: '',
      answerQuote: ''
    };
    g.updatedAt = nowIso();
    out = g;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (err) return { ok: false, ...err };
  return { ok: true, goal: out, proposal: out.proposal };
}

/**
 * 标记"已经问过老大了"（4.0 / 2.6.3）。
 *
 * 第一次问才返回 shouldAsk: true，并写 askedAt + askedRound + **expiresAt（askedAt + 7 天）**。
 * 已经问过（且未过期）→ shouldAsk: false，**不重复问**。
 */
export function markConfirmationAsked(id, { roundId = '' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空', code: 'NOT_FOUND' };

  let shouldAsk = false;
  let out = null;
  let err = null;
  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = normalizeGoals(st);
    const now = Date.now();
    expireProposalsIn(st, now);

    const g = st.goals.find((x) => x.id === want);
    if (!g) { err = { error: '没有这条 Goal', code: 'NOT_FOUND' }; return; }
    if (!g.proposal) { err = { error: '还没有提议', code: 'NO_PROPOSAL' }; return; }

    if (g.proposal.askedAt) {
      // 已经问过（且刚才的清理说明它还没过期）→ 不重复问
      shouldAsk = false;
      out = g;
      return;
    }

    const nowIsoStr = nowIso();
    g.proposal.askedAt = nowIsoStr;
    g.proposal.askedRound = String(roundId || '').slice(0, 80);
    // **倒计时从这里才开始**
    g.proposal.expiresAt = new Date(now + PROPOSAL_TTL_DAYS * 86400e3).toISOString();
    shouldAsk = true;
    out = g;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (err) return { ok: false, ...err };
  return { ok: true, shouldAsk, proposal: out.proposal };
}

/**
 * 老大回答确认（4.0 / 2.6.3）。
 *
 * ⚠️ **特殊顺序**（机主 2026-11-01 明确要求）：
 *   不能一进来就全局清理过期 proposal —— 那样过期记录已经被删掉，
 *   只能返回 NO_PROPOSAL，丢失了"它确实存在过、只是过期了"的信息。
 *
 * 所以这里：先定位 → 过期就清掉并返回 PROPOSAL_EXPIRED → 不存在才 NO_PROPOSAL。
 */
export function answerConfirmation(id, { answer, quote = '' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空', code: 'NOT_FOUND' };
  const ans = String(answer || '');
  if (!['yes', 'no', 'later'].includes(ans)) {
    return { ok: false, error: 'answer 只能是 yes / no / later', code: 'INVALID_ANSWER' };
  }

  let out = null;
  let applied = false;
  let err = null;
  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = normalizeGoals(st);
    const now = Date.now();

    const g = st.goals.find((x) => x.id === want);
    if (!g) { err = { error: '没有这条 Goal', code: 'NOT_FOUND' }; return; }

    // ① 先看 proposal 在不在
    if (!g.proposal) {
      // 顺手清掉别的过期项，但**不影响本条的判定**
      expireProposalsIn(st, now);
      err = { error: '没有待确认的提议', code: 'NO_PROPOSAL' };
      return;
    }

    // ② 存在但过期 → 清掉它，返回 PROPOSAL_EXPIRED（不说成"没有"）
    if (isProposalExpired(g.proposal, now)) {
      g.proposal = null;
      expireProposalsIn(st, now);
      err = { error: '这条确认已经过期（' + PROPOSAL_TTL_DAYS + ' 天），需要重新提议', code: 'PROPOSAL_EXPIRED' };
      return;
    }

    // ③ 没问过就答？不合流程
    if (!g.proposal.askedAt) {
      err = { error: '这个提议还没有问过，不能先答', code: 'NOT_ASKED' };
      return;
    }

    // ④ 拿到 kind（先不写任何字段）
    const kind = g.proposal.kind;

    if (ans !== 'yes') {
      // no / later → 清掉 proposal，状态不变
      g.proposal = null;
      g.updatedAt = nowIso();
      out = g;
      applied = false;
      return;
    }

    // yes → **先尝试执行，成功了才写审计信息**。
    //
    // 2026-11-01 修：以前是先写 answer='yes' 再调 applyEnd。如果 applyEnd 失败
    // （比如并发把状态改成 paused，paused→completed 不允许），fn 正常返回 →
    // updateCompanion 照样写盘 → 留下「已确认、但未执行」的中间状态，
    // 下次 completeGoal 会拿这个过期的 yes 直接执行。
    // 现在：applyEnd 失败时 proposal **一个字节都没动**，还是待确认状态。
    const reasonText = (kind === 'complete' ? '老大确认已完成'
      : kind === 'cancel' ? '老大明确放弃'
        : '老大确认旧方向失去意义')
      + (quote ? '：' + String(quote).slice(0, 50) : '');

    const res = applyEnd(g, kind, { by: 'owner', reason: reasonText });
    if (!res.ok) { err = res; return; }

    // 成功后才记录确认审计信息（applyEnd 不清 proposal，留给这里写）
    g.proposal.answer = 'yes';
    g.proposal.answerAt = nowIso();
    g.proposal.answerQuote = String(quote || '').slice(0, 100);
    g.proposal.usedAt = nowIso();
    out = g;
    applied = true;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (err) return { ok: false, ...err };
  return { ok: true, goal: out, applied };
}

/**
 * 真正把 goal 转到终态（**内部函数，不导出**）。
 * 转完清掉 proposal（已经用掉了）。
 */
function applyEnd(g, kind, { by = 'unknown', reason = '' } = {}) {
  const target = kind === 'complete' ? 'completed'
    : kind === 'cancel' ? 'cancelled'
      : 'superseded';
  if (GOAL_STATUS_TERMINAL.includes(g.status)) {
    return { ok: false, error: '已经是终态（' + g.status + '）', code: 'TERMINAL_STATE' };
  }
  if (!canTransition(g.status, target)) {
    return { ok: false, error: '不允许从 ' + g.status + ' 转到 ' + target, code: 'INVALID_TRANSITION' };
  }
  transition(g, target, { by, reason: reason || (kind === 'complete' ? '目标完成' : kind === 'cancel' ? '目标取消' : '目标被取代') });
  // 2.6.3 补丁：**不在这里清 proposal** ——
  // answerConfirmation 要在执行成功之后才写 answer/answerAt/answerQuote，
  // 这里清了它就没地方写了。清理交给调用方。
  return { ok: true };
}

/**
 * 执行结束操作（**内部函数，不导出**）。
 *
 * 权限检查全在这里：
 *   · autonomous    → 直接过，**完全不看 proposal**
 *   · user_directed → 必须有 kind 匹配、问过、答 yes、未过期的 proposal
 */
function endGoal(id, kind, { by = 'unknown', reason = '' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空', code: 'NOT_FOUND' };

  let out = null;
  let err = null;
  let already = false;
  const r = updateCompanion((st) => {
    if (!Array.isArray(st.goals)) st.goals = normalizeGoals(st);
    const now = Date.now();
    expireProposalsIn(st, now);

    const g = st.goals.find((x) => x.id === want);
    if (!g) { err = { error: '没有这条 Goal', code: 'NOT_FOUND' }; return; }

    const target = kind === 'complete' ? 'completed'
      : kind === 'cancel' ? 'cancelled'
        : 'superseded';

    // 已经就是这个终态 → 幂等
    if (g.status === target) { already = true; out = g; return; }
    if (GOAL_STATUS_TERMINAL.includes(g.status)) {
      err = { error: '已经是终态（' + g.status + '）', code: 'TERMINAL_STATE' };
      return;
    }
    if (!canTransition(g.status, target)) {
      err = { error: '不允许从 ' + g.status + ' 转到 ' + target, code: 'INVALID_TRANSITION' };
      return;
    }

    // 权限：autonomous 直接过
    if (g.source !== 'autonomous') {
      const p = g.proposal;
      if (!p) {
        err = { error: '这是老大交代的方向，需要他确认才能' + (kind === 'complete' ? '标记完成' : kind === 'cancel' ? '取消' : '取代'), code: 'CONFIRMATION_REQUIRED' };
        return;
      }
      if (p.kind !== kind) {
        err = { error: '提议的是「' + p.kind + '」，不能当「' + kind + '」执行', code: 'KIND_MISMATCH' };
        return;
      }
      if (!p.askedAt) {
        err = { error: '还没问过老大，不能执行', code: 'NOT_ASKED' };
        return;
      }
      if (p.answer !== 'yes') {
        err = { error: '老大还没有确认（当前回答：' + (p.answer || '未答') + '）', code: 'NOT_CONFIRMED' };
        return;
      }
    }

    const res = applyEnd(g, kind, { by, reason });
    if (!res.ok) { err = res; return; }
    // endGoal 是"直接执行"路径（autonomous，或 user_directed 已经有 yes 的 proposal），
    // 执行完把 proposal 清掉 —— 已经用掉了，不该留着让下一次误判。
    g.proposal = null;
    out = g;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (err) return { ok: false, ...err };
  if (already) return { ok: true, goal: out, already: true };
  return { ok: true, goal: out };
}

/** 标记完成。 */
export function completeGoal(id, opts = {}) { return endGoal(id, 'complete', opts); }
/** 取消。 */
export function cancelGoal(id, opts = {}) { return endGoal(id, 'cancel', opts); }
/** 取代。 */
export function supersedeGoal(id, opts = {}) { return endGoal(id, 'supersede', opts); }

/**
 * 找"看起来像同一个方向"的 Goal（4.0 / 2.6.4a）。
 *
 * ⚠️ **只是查询，不做任何修改。** 本阶段**不在任何接口里自动调用它** ——
 * 自动合并、自动恢复、自动覆盖都不允许。
 *
 * "相似"不等于"重复"：「准备 CSP」和「准备考研」可能有关联，但不能合并。
 * 返回的 score 只是字面重叠度，**不是可靠的业务判断标准**。
 *
 * @param {string} text
 * @param {{limit?:number}} [o]
 * @returns {Array<{goal:object, score:number}>}
 */
export function findSimilarGoals(text, { limit = 3 } = {}) {
  const t = normalizeGoalText(text);
  if (!t) return [];
  const st = readCompanion();
  // 只查"还活着"的方向；终态是过去的事，不该提示"你好像记过这个"
  const live = (st.goals || []).filter((g) => g.status === 'active' || g.status === 'paused');
  const out = [];
  for (const g of live) {
    const g2 = normalizeGoalText(g.text);
    if (!g2 || g2 === t) continue;              // 完全相同走正常去重，不在这里
    if (!g2.includes(t) && !t.includes(g2)) continue;
    const score = Math.min(g2.length, t.length) / Math.max(g2.length, t.length);
    if (score < 0.6) continue;                  // 实验阈值，不是业务标准
    out.push({ goal: g, score: Number(score.toFixed(2)) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ── 兼容接口 ──────────────────────────────────────────────────────── */

/* ── 自主 Goal 的证据校验（4.0 / 2.6-B3）──────────────────────────── */
//
// 为什么需要这个：以前 `decision.goal`（**Action Objective**）被直接写成了长期 Goal，
// 一轮活动 3 个动作就塞 3 个。现在自主创建必须带**跨轮证据**，程序负责校验。
//
// 设计原则（A2）：
//   · 模型提出方向 + 依据，程序验证规则和权限
//   · 不靠关键词/计数硬编码判断"是否长期"
//   · 禁止同一轮多个 Action 冒充跨轮证据
//   · 禁止仅凭一次活动 / 一个 Action / 一次失败创建 Goal

/** 自主证据里允许的 type。 */
export const EVIDENCE_TYPE = ['cross_round_continuity'];

/** 至少需要几个**不同的** Round 才算跨轮。 */
const MIN_EVIDENCE_ROUNDS = 2;

/**
 * 从 autonomous.json 读所有存在过的 roundId。
 * 读失败给空集合 —— 调用方会因此拒绝创建（宁可拒绝，也不要凭空通过）。
 */
function knownRoundIds() {
  try {
    const f = path.join(DATA_DIR, 'autonomous.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const out = new Set();
    for (const r of j.history || []) {
      if (r && r.roundId) out.add(String(r.roundId));
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * 校验自主 Goal 的证据（4.0 / 2.6-B3）。
 *
 * @param {object} evidence  { type, roundIds, reason }
 * @param {{knownRounds?:Set<string>}} [opts] 测试可以注入已知 Round 集合
 * @returns {{ok:boolean, error?:string, code?:string, rounds?:string[]}}
 */
export function validateGoalEvidence(evidence, { knownRounds = null } = {}) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, code: 'EVIDENCE_REQUIRED', error: '自主创建长期 Goal 必须带证据' };
  }
  if (!EVIDENCE_TYPE.includes(evidence.type)) {
    return {
      ok: false,
      code: 'EVIDENCE_INVALID_TYPE',
      error: '证据类型不合法（只支持 ' + EVIDENCE_TYPE.join(' / ') + '）'
    };
  }
  if (!Array.isArray(evidence.roundIds) || evidence.roundIds.length === 0) {
    return { ok: false, code: 'EVIDENCE_NO_ROUNDS', error: '证据里没有引用任何 Round' };
  }

  // 去重：同一个 Round 写两遍不算两轮
  const ids = [...new Set(evidence.roundIds.map((x) => String(x || '')).filter(Boolean))];
  if (ids.length < MIN_EVIDENCE_ROUNDS) {
    return {
      ok: false,
      code: 'EVIDENCE_SINGLE_ROUND',
      error: '至少要有 ' + MIN_EVIDENCE_ROUNDS + ' 个**不同的** Round 才算跨轮证据'
        + '（同一个 Round 的多个 Action 不算）'
    };
  }

  const known = knownRounds instanceof Set ? knownRounds : knownRoundIds();
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    return {
      ok: false,
      code: 'EVIDENCE_ROUND_NOT_FOUND',
      error: '证据引用了不存在的 Round：' + missing.join(', ')
    };
  }

  if (!String(evidence.reason || '').trim()) {
    return { ok: false, code: 'EVIDENCE_NO_REASON', error: '证据必须写清为什么认为这是长期方向' };
  }

  return { ok: true, rounds: ids };
}

/**
 * 创建自主 Goal（4.0 / 2.6-B3）。
 *
 * **必须带通过校验的证据** —— 这是和 createGoal 的唯一区别。
 * 权限、容量、去重全部复用 createGoal（不重复实现）。
 *
 * @param {object} o
 * @param {string} o.text
 * @param {object} o.evidence
 * @param {Set<string>} [o.knownRounds] 测试注入
 */
export function createAutonomousGoal({ text, evidence, knownRounds = null } = {}) {
  const v = validateGoalEvidence(evidence, { knownRounds });
  if (!v.ok) return { ok: false, error: v.error, code: v.code };

  // 走内部实现（公开的 createGoal 兼容层会拒绝 autonomous，那是对的）
  const r = createGoalCore({ text, source: 'autonomous' });
  if (!r.ok) return { ok: false, error: r.error, code: r.code, capacity: r.capacity };
  return { ok: true, goal: r.goal, created: r.created, evidence: { ...evidence, roundIds: v.rounds } };
}

/**
 * 设当前目标（兼容接口，2.5 及以前就在这里）。
 *
 * @deprecated 2.6.2 起它只是 createGoal 的薄封装 —— **新代码请直接用 createGoal**，
 * 那样能拿到 created 标志，也能显式区分"恢复"和"新建"。
 *
 * 行为（全部由 createGoal 决定）：
 *   · 相同文本已 active → 不新建，只更新 updatedAt
 *   · 相同文本已 paused → **恢复那条**（2.6.2 起的行为变化；2.6.1 是新建）
 *   · 相同文本已终态   → 新建
 */
export function setGoal(text, { source = 'unknown' } = {}) {
  // 4.0 / 2.6-P1-1：显式请求 autonomous → 拒绝。自主 Goal 必须走 createAutonomousGoal。
  // （这条路径以前能直接建成 autonomous，是 P1-1 报告里指出的那个后门。）
  if (source === 'autonomous') {
    return {
      ok: false,
      code: 'EVIDENCE_REQUIRED',
      error: '自主 Goal 必须走 createAutonomousGoal（要带跨轮证据）'
    };
  }
  // 其它来源：保持兼容（默认 'unknown' 会走兼容层，由它决定能不能建）
  const r = createGoal({ text, source });
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  return { ok: true, state: readCompanion() };
}

/**
 * @deprecated 2.6.3 起它**内部委托 completeGoal** —— 也就是说会走完整的权限检查。
 *
 * 变化（机主 2026-11-01 确认的方案 B）：
 *   · autonomous 的 active  → 正常转 completed（和以前一样）
 *   · **user_directed 的 active（没经过老大确认）→ 失败**，返回 CONFIRMATION_REQUIRED
 *
 * **不能绕过权限**：宁可清不掉，也不要偷偷把老大交代的方向标成完成。
 * 返回值从 `{ ok, state }` 改成 `{ ok } / { ok: false, error, code }`。
 */
export function clearGoal({ source = 'unknown' } = {}) {
  const cur = activeGoal();
  if (!cur) return { ok: true, skipped: 'no-active-goal' };
  const r = completeGoal(cur.id, { by: source, reason: '方向变成完成状态（clearGoal 兼容入口）' });
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  return { ok: true };
}

/* ── topic ─────────────────────────────────────────────────────────── */

/** 设当前话题（同样是"现在在聊什么"，不是长期记忆）。 */
export function setTopic(text, { source = 'unknown' } = {}) {
  const t = String(text ?? '').trim().slice(0, 100);
  if (!t) return { ok: false, error: 'topic 不能为空' };
  return updateCompanion((st) => {
    if (st.topic && st.topic.text === t) return;
    st.topic = { text: t, source: String(source), since: nowIso() };
  });
}

/* ── pending ───────────────────────────────────────────────────────── */

/**
 * 加一条待办。
 *
 * 机主要求"保守触发"：只有**明确表达的未来事项**才加。判断在调用方做
 * （模型提出 → 程序用 canAddPending 校验 → 这里落盘）。
 *
 * @param {object} o
 * @param {string} o.text 事项
 * @param {'chat'|'autonomous'|'owner'} o.source
 * @param {'pending'|'waiting'} [o.status]
 * @param {number} [o.expiresInDays] 过期天数（默认 30）；**过期 ≠ 完成**
 */
/* ── Pending 去重与询问计数（4.0 / P0）──────────────────────────────── */
//
// 修的问题（2026-11-02 查实）：
//   ① 去重只看**完全相同文本** → 换种说法就当成新事项，同一件事堆 7 条
//   ② 没有"问过几次"的计数 → 每轮都去问，无限循环
//   ③ prompt 按 at 正序取最早 5 条 → 最老的"等回话"永远在注入列表里
//
// 三条叠起来的循环：写 pending → 判不准状态 → 不结算 → 老的在 prompt 里 → 又去问。
//
// **本批只做止血**：不改 settleChatPending 的结算条件、不改状态机、不清理生产数据。

/** 询问上限（集中配置，不散落硬编码）。 */
export const ASK_LIMIT = 3;

/** 语义去重的相似度阈值（保守：宁可保留两条，也不错误合并）。 */
// 4.0 / P0 实测修正：0.7 太松 ——
//   「占位待办 1」vs「占位待办 10」是**前缀关系**，n-gram 重叠 100%，
//   sim=0.833 会被判同（但它们是不同编号的条目）。
// 提到 0.85 后：真实同义（sim ≈ 0.3~0.6）本来也够不着，所以不会误伤；
// 而模板+编号这种高重叠的会被挡住。
const DEDUP_SIM_THRESHOLD = 0.85;

/** 语义去重的长度比下限。 */
const DEDUP_LEN_RATIO = 0.5;

/** 常见同义说法归一（只处理"等回话"这一类，不做通用语义）。 */
const SYNONYMS = [
  [/等(着|候)?/g, '等'],
  [/(老大|你|他)/g, '对方'],
  [/(回话|回复|回一句|回个话|答复|回应|回没回|回了)/g, '回复'],
  [/(瞄一眼|看一眼|看看|看|瞧)/g, '看'],
  [/(一起|一块)/g, '一起'],
  [/(翻翻|翻一翻|翻)/g, '翻'],
  [/(评论|评论区)/g, '评论']
];

/** 归一化：去标点/空白 + 同义说法替换。**只读**，不改原文本。 */
export function normalizeForDedup(text) {
  let s = String(text ?? '').toLowerCase().trim();
  // 全角标点 → 去
  s = s.replace(/[，。；：、,.!?！？;:'"「」『』（）()《》【】\-—…\s]/g, '');
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);
  return s;
}

/** 关键词集合（2~4 字片段，去掉停用词）。 */
function keywordsOf(text) {
  const s = normalizeForDedup(text);
  const out = new Set();
  const STOP = new Set(['等等', '对方', '回复', '一起', '这个', '那个', '什么']);
  for (let len = 2; len <= 4; len += 1) {
    for (let i = 0; i + len <= s.length; i += 1) {
      const w = s.slice(i, i + len);
      if (STOP.has(w)) continue;
      out.add(w);
    }
  }
  return out;
}

/** 两条文本的相似度（关键词重叠率 + 长度比，取较小者作为保守值）。 */
export function similarityOf(a, b) {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ka = keywordsOf(a);
  const kb = keywordsOf(b);
  if (!ka.size || !kb.size) return 0;

  let hit = 0;
  const [small, big] = ka.size <= kb.size ? [ka, kb] : [kb, ka];
  for (const w of small) if (big.has(w)) hit += 1;
  const overlap = hit / small.size;

  const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  // 取较小者：两个条件都得达标，宁可低估
  return Math.min(overlap, lenRatio);
}

/**
 * 冲突检查（4.0 / P0）。
 *
 * 关键词重叠高 ≠ 同一件事：
 *   「等老大回复后翻评论」vs「等老大回复后决定是否修改架构」
 * 共享"等老大回复"，但**后续动作不同** → 不该合并。
 *
 * 这里只做**粗粒度**的后续动作冲突检测：归一化后剔除公共的"等待"部分，
 * 剩下的尾巴如果差异很大，就判冲突。
 *
 * @returns {boolean} true = 有明显冲突，不该合并
 */
export function hasActionConflict(a, b) {
  const strip = (t) => {
    let s = normalizeForDedup(t);
    // 去掉"等对方回复"这类固定前缀/片段
    s = s.replace(/等对方回复/g, '').replace(/等对方/g, '').replace(/对方回复/g, '');
    return s;
  };
  const ta = strip(a);
  const tb = strip(b);
  if (!ta || !tb) return false;             // 一方没有后续动作 → 不判冲突
  if (ta === tb) return false;               // 后续完全一样 → 没冲突

  // 两条尾巴的关键词重叠
  const ka = keywordsOf(ta);
  const kb = keywordsOf(tb);
  if (!ka.size || !kb.size) return false;
  let hit = 0;
  const [small, big] = ka.size <= kb.size ? [ka, kb] : [kb, ka];
  for (const w of small) if (big.has(w)) hit += 1;
  const overlap = hit / small.size;

  // 尾巴重叠 < 0.35 → 后续动作明显不同 → 冲突
  //
  // 为什么从 0.5 降到 0.35（2026-11-02 实测）：
  //   「等老大回一句，再翻翻评论里有没有人吐槽这架构」
  //   「等他回话，再决定要不要翻架构评论」
  // 后半句字面不同（"翻翻评论" vs "决定要不要翻"），但**是同一件事**。
  // 0.5 太严会把这种也判成冲突。
  //
  // 真正的不同事项（比如"翻评论" vs "改架构"）尾巴重叠通常 < 0.2，
  // 0.35 仍然能挡住。
  return overlap < 0.35;
}

/**
 * 判断两条 pending 是否是"同一件事"（4.0 / P0）。
 *
 * 三个条件都满足才算：
 *   ① 相似度 >= 0.7
 *   ② 长度比 >= 0.5
 *   ③ 没有明显的后续动作冲突
 *
 * **宁可返回 false（保留两条），也不错误合并。**
 */
export function isSamePendingItem(a, b) {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (!na || !nb) return false;
  if (na === nb) return true;                // 完全一样

  // 4.0 / P0：**末尾数字不同 → 不同事项**。
  // 针对「占位待办 1」vs「占位待办 10」这种模板+编号的文本：
  // n-gram 会把它们算成 100% 重叠（前缀关系），但那显然是两条。
  const numA = na.match(/\d+$/);
  const numB = nb.match(/\d+$/);
  if (numA && numB && numA[0] !== numB[0]) return false;

  const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  if (lenRatio < DEDUP_LEN_RATIO) return false;

  const sim = similarityOf(a, b);
  if (sim < DEDUP_SIM_THRESHOLD) return false;

  if (hasActionConflict(a, b)) return false;
  return true;
}

/**
 * 文本启发式：这条 pending 是不是「在等对方回话」（4.0 / P0）。
 *
 * ⚠️ **只用于 prompt 注入分类，不改变数据状态。**
 * 为什么需要它：旧数据（P0 之前创建的）status 是 `pending`，
 * 但文本明显是"等老大回话" —— 如果不用文本兜底，它们会继续以普通待办形式注入。
 *
 * 识别不了的（比如"看老大怎么答"这种）**不强行归类**，留给人工清单。
 */
export function looksLikeWaitingText(text) {
  const t = String(text ?? '');
  if (!t) return false;
  // 说法一：等 [老大|你|他] …… [回|说|答|应]
  if (/等(着|候)?[^，。；]{0,12}(老大|你|他)[^，。；]{0,12}(回|说|答|应)/.test(t)) return true;
  // 说法二：等 …… [回一句|回话|回复|答复|回应]
  if (/等[^，。；]{0,12}(回一句|回个话|回话|回复|答复|回应)/.test(t)) return true;
  // 说法三：[老大|他|你] …… 回了 / 回话 / 回没回（主语在前）
  // ⚠️ "回了" 后面必须跟条件词（就/再/的话）或是 "回没回"，
  // 否则「他昨天回了，但我没回他」这种陈述也会被误判成"在等他"。
  if (/(老大|他|你)[^，。；]{0,8}(回没回|回了[^。；]{0,8}(就|再|的话)|回话[^。；]{0,6}(就|再|的话|后))/.test(t)) return true;
  // 说法四：看/瞄一眼 [老大|他|你] 回没回
  if (/(看|瞄一眼|瞧)[^，。；]{0,6}(老大|他|你)[^，。；]{0,6}(回没回|回了|回话)/.test(t)) return true;
  // 说法五（P0.1 补）：看/等 [老大|他|你] **怎么**答/说/回
  //   · "看老大怎么答" → 在等他表态 ✅
  //   · **"查看回复情况"** → 不是等待（"情况"是名词，没有"怎么"）❌
  if (/(看|等|瞅)[^，。；]{0,6}(老大|他|你)[^，。；]{0,4}(怎么|如何)(答|说|回|讲|想)/.test(t)) return true;
  // 说法六（P0.1 补）：**"回了就…，没回就…"** 这种条件式 —— 明显在等
  // 注意：要**允许中间有逗号**（"回了就一起翻评论，没回就下次再问"），
  // 但不要跨句号/分号（那可能已经是两件事了）。
  // ⚠️ 必须要求"没回"后面跟着"就/再/的话"（条件式），
  // 否则「他昨天回了，但我没回他」这种也会被误判成"在等他"。
  if (/回了[^。；]{0,20}没回[^。；]{0,8}(就|再|的话)/.test(t)) return true;
  if (/没回[^。；]{0,20}回了[^。；]{0,8}(就|再|的话)/.test(t)) return true;
  return false;
}

/** 旧数据的询问计数默认值（**不写盘**，读时补）。 */
export function askMetaOf(p) {
  return {
    askCount: Number(p?.askCount) || 0,
    lastAskedAt: String(p?.lastAskedAt || ''),
    lastAskRoundId: String(p?.lastAskRoundId || ''),
    waitingSince: String(p?.waitingSince || p?.at || ''),
    silent: Boolean(p?.silent)
  };
}

/** 是否已经"问够次数、该静默了"。 */
export function isSilentWaiting(p) {
  const m = askMetaOf(p);
  return m.askCount >= ASK_LIMIT;
}

/**
 * 记录一次**真实发出的询问**（4.0 / P0）。
 *
 * ⚠️ 调用方必须确保 `out.mode === 'live'`（真的发出去了）才调。
 * `out.result === 'success'` **不等于**发出了（演练也算 success）。
 *
 * 幂等：同一 `roundId` 不重复计数。
 *
 * @param {string} id
 * @param {{roundId?:string, at?:string}} [o]
 * @returns {{ok:boolean, pending?:object, counted?:boolean, error?:string}}
 */
export function bumpAskCount(id, { roundId = '', at = '' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空' };

  let found = null;
  let counted = false;
  const r = updateCompanion((st) => {
    const now = Date.now();
    expirePendingIn(st, now);
    const p = st.pending.find((x) => x.id === want);
    if (!p) return;
    // 已结算的不再加
    if (p.status === 'done' || p.status === 'cancelled' || p.status === 'expired') { found = p; return; }

    const prevRound = String(p.lastAskRoundId || '');
    const thisRound = String(roundId || '');
    // **幂等**：同一 Round 重复执行不重复计数
    if (thisRound && prevRound === thisRound) { found = p; counted = false; return; }

    p.askCount = (Number(p.askCount) || 0) + 1;
    p.lastAskedAt = String(at || nowIso());
    p.lastAskRoundId = thisRound;
    if (!p.waitingSince) p.waitingSince = String(p.at || nowIso());
    // 达到上限 → 标记静默（**不是终态，用户回复仍可结算**）
    p.silent = p.askCount >= ASK_LIMIT;
    found = p;
    counted = true;
  });

  if (!r.ok) return { ok: false, error: r.error };
  if (!found) return { ok: false, error: '没有这条待办' };
  return { ok: true, pending: found, counted };
}

export function addPending({
  text,
  source = 'unknown',
  status = 'pending',
  expiresInDays = DEFAULT_EXPIRE_DAYS,
  roundId = ''
} = {}) {
  const t = String(text ?? '').trim().slice(0, 200);
  if (!t) return { ok: false, error: 'pending 文本不能为空' };
  const st_ = PENDING_STATUS.includes(status) && status !== 'done' && status !== 'cancelled' ? status : 'pending';
  // 不能用 Number(x) || 默认值 —— 0 是 falsy，会被当成"没传"变成 30 天。
  // （2026-11-01 测试抓到的：expiresInDays: 0 期望"永不过期"，实际给了 30 天）
  const raw = (expiresInDays === undefined || expiresInDays === null)
    ? DEFAULT_EXPIRE_DAYS
    : Number(expiresInDays);
  const days = Math.max(0, Math.min(365, Number.isFinite(raw) ? raw : DEFAULT_EXPIRE_DAYS));

  let added = null;
  const r = updateCompanion((st) => {
    // 4.0 / 2.6-B2：锁内惰性清理过期项（**同一批操作用同一个时间快照**）。
    // 不在 readCompanion 里做 —— 读操作频繁，不能一读就写盘。
    const now = Date.now();
    expirePendingIn(st, now);

    // 4.0 / P0：**语义去重**（原来只比完全相同文本，换种说法就新建）。
    // 条件：相似度 >= 0.7 + 长度比 >= 0.5 + 无后续动作冲突（见 isSamePendingItem）。
    // **宁可保留两条，也不错误合并。**
    const live = st.pending.filter((p) => p.status !== 'done' && p.status !== 'cancelled' && p.status !== 'expired');
    const dup = live.find((p) => p.text === t || isSamePendingItem(p.text, t));
    if (dup) {
      // 命中已有条目 → 不新增；补上 roundId 上下文（不覆盖已有的）
      if (roundId && !dup.createdByRoundId) dup.createdByRoundId = String(roundId);
      added = dup;
      return;
    }
    added = {
      id: newId(),
      text: t,
      status: st_,
      source: String(source),
      at: nowIso(),
      expiresAt: days > 0 ? new Date(now + days * 86400e3).toISOString() : null,
      // 4.0 / P0：询问计数（旧数据没有这些字段，读时用 askMetaOf 补默认）
      askCount: 0,
      lastAskedAt: '',
      lastAskRoundId: '',
      waitingSince: st_ === 'waiting' ? nowIso() : '',
      silent: false,
      createdByRoundId: String(roundId || '')
    };
    st.pending.push(added);
  });

  if (!r.ok) return r;
  return { ok: true, pending: added, state: r.state };
}

/**
 * 结算一条待办（done / cancelled）。
 *
 * 幂等：已经结算过的不再改 settledAt。
 * 不立刻删 —— 保留 7 天，方便排查"这件事为什么消失了"。
 */
export function settlePending(id, outcome = 'done', { source = 'unknown' } = {}) {
  const want = String(id || '');
  if (!want) return { ok: false, error: 'id 不能为空' };
  const status = outcome === 'cancelled' ? 'cancelled' : 'done';

  let found = null;
  const r = updateCompanion((st) => {
    // 4.0 / 2.6-B2：同一个时间快照 + 惰性清理
    const now = Date.now();
    expirePendingIn(st, now);

    const p = st.pending.find((x) => x.id === want);
    if (!p) return;
    // 幂等：已经结算过的不再改（expired 也是已结算 —— 过期了再手动作废没有意义）
    if (p.status === 'done' || p.status === 'cancelled' || p.status === 'expired') { found = p; return; }
    p.status = status;
    p.settledAt = nowIso();
    p.settledBy = String(source);
    found = p;
  });

  if (!r.ok) return r;
  if (!found) return { ok: false, error: '没有这条待办' };
  return { ok: true, pending: found, state: r.state };
}

/**
 * 检查过期（只标记，**不判定完成** —— 机主明确要求）。
 * @returns 过期的条目列表
 */
/**
 * 查"已经过期"的 pending（4.0 / 2.6-B2）。
 *
 * 注意：**这是只读查询**，返回的是**已经被 expirePendingIn 标记成 expired** 的记录。
 * 如果某条只是"到了 expiresAt 但还没被写入接口清过"，它不在这个列表里 ——
 * 读操作不该因为查询就写盘。
 */
export function expiredPending() {
  return readCompanion().pending.filter((p) => p.status === 'expired');
}

/* ── 注入 / 展示 ───────────────────────────────────────────────────── */

/** 还没结算的待办（按时间正序）。 */
export function activePending() {
  return readCompanion().pending
    .filter((p) => p.status !== 'done' && p.status !== 'cancelled' && p.status !== 'expired')
    .sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
}

/**
 * 给 prompt 用的一小段（**很短**，她本来就有记忆库和日记）。
 *
 * 内容为空时返回 ''，调用方直接拼就行。
 */
export function promptSection({ maxPending = 5 } = {}) {
  const st = readCompanion();
  const bits = [];
  // 只注入 active —— paused / completed / cancelled / superseded 都不进聊天上下文
  const ag = (st.goals || []).find((g) => g.status === 'active');
  if (ag?.text) bits.push(`现在的方向：${ag.text}`);
  if (st.topic?.text) bits.push(`刚才在聊：${st.topic.text}`);
  // 4.0 / P0：**普通待办和等待回复分开筛选**。
  // 原来按 at 正序取最早 5 条 → 最老的"等回话"永远在注入列表里。
  // 现在：
  //   · 普通 pending   → 按 at **倒序**取最新的（较新的事项更可能是当前关心的）
  //   · 等待回复       → 单独一段，且**明确标注"已经问过，等他自己说"**
  //     （机主明确：这段只能作状态背景，**不能作为新的行动指令**）
  const all = activePending();
  // 4.0 / P0：**文本兜底** —— 旧数据的 status 可能是 pending，但文本明显在等回话。
  // 机主要求：修复后的 prompt 应能识别旧数据里的等待回复事项，
  // 避免它们继续以普通待办形式反复触发询问。
  const isWaitish = (p) => p.status === 'waiting' || isSilentWaiting(p) || looksLikeWaitingText(p.text);
  const waits = all.filter((p) => isWaitish(p));
  const normals = all.filter((p) => !isWaitish(p));

  // 普通待办：最新的优先
  const act = normals.slice().reverse().slice(0, maxPending);
  if (act.length) {
    bits.push(`还没做完的：${act.map((p) => p.text).join('；')}`);
  }

  // 等待回复：**只作状态提示，不诱导提问**。
  //
  // ⚠️ 4.0 / P0：**最多只列 1 条**。
  // 为什么不在 prompt 里列全部：
  //   语义去重的阈值保守（宁可保留两条也不错误合并），所以同类事项可能有多条；
  //   如果全列出来，模型看到"有这么多件都在等他"，反而更容易再问一遍。
  //   **真正止血的是 askCount + 静默**，不是让模型看到全部。
  const silent = waits.filter((p) => isSilentWaiting(p));
  const activeWait = waits.filter((p) => !isSilentWaiting(p));
  if (activeWait.length) {
    // 取最新的一条（at 倒序的第一条）
    const latest = activeWait.slice().sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0))[0];
    const more = activeWait.length > 1 ? `（另有 ${activeWait.length - 1} 件类似的）` : '';
    bits.push(`在等他回的：${latest.text}${more}`);
  }
  if (silent.length) {
    // 静默的也只列 1 条 + 数量
    const latest = silent.slice().sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0))[0];
    const more = silent.length > 1 ? `（另有 ${silent.length - 1} 件）` : '';
    bits.push(`还在等的（已经问过，等他自己说，别再问了）：${latest.text}${more}`);
  }
  if (!bits.length) return '';
  return `【你现在】\n${bits.join('\n')}`;
}

/** 面板用的一行摘要。 */
export function summary() {
  const st = readCompanion();
  const act = st.pending.filter((p) => p.status !== 'done' && p.status !== 'cancelled');
  return {
    goal: (st.goals || []).find((g) => g.status === 'active')?.text || '',
    goalCounts: {
      active: (st.goals || []).filter((g) => g.status === 'active').length,
      paused: (st.goals || []).filter((g) => g.status === 'paused').length,
      completed: (st.goals || []).filter((g) => g.status === 'completed').length,
      cancelled: (st.goals || []).filter((g) => g.status === 'cancelled').length,
      superseded: (st.goals || []).filter((g) => g.status === 'superseded').length
    },
    topic: st.topic?.text || '',
    active: act.length,
    waiting: act.filter((p) => p.status === 'waiting').length,
    settled: st.pending.length - act.length,
    updatedAt: st.updatedAt
  };
}

/* ── 校验：聊天侧"要不要记这条待办" ────────────────────────────────── */

/**
 * 机主要求的两个条件，程序侧再兜一层：
 *   ① 这句话表达了一个**未来需要继续处理**的事项
 *   ② 事项确实处于**未完成或等待**状态
 *
 * 模型负责从对话里提取候选，这里负责把明显不该记的挡掉。
 * **故意保守**：宁可漏记，也不要记一堆"回头再说吧"。
 *
 * @param {string} text 候选文本
 * @returns {{ok:boolean, reason:string}}
 */
export function canAddPending(text) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, reason: '空' };
  if (t.length < 4) return { ok: false, reason: '太短，不像具体事项' };

  // 明确表达"以后要继续"的信号
  const continueSignals = [
    /等(你|老大|他|她|有空|回来|回复)/,
    /(明天|后天|下次|回头|晚点|改天|之后|待会)/,
    /再(说|聊|查|看|讨论|继续)/,
    /继续/,
    /还没(做|答|回|查|看完)/,
    /回头/
  ];
  const hasSignal = continueSignals.some((re) => re.test(t));
  if (!hasSignal) return { ok: false, reason: '没看出"以后要继续"的意思' };

  // 明确"不再继续"的信号 —— 这种不该记成待办
  const cancelSignals = [/不用了/, /算了/, /不聊了/, /忘了吧/, /结束吧/];
  if (cancelSignals.some((re) => re.test(t))) return { ok: false, reason: '看起来是要放弃这件事' };

  // 已经在库里（同文本未结算）就不重复加
  const dup = activePending().find((p) => p.text === t);
  if (dup) return { ok: false, reason: '已经在待办里了' };

  return { ok: true, reason: '' };
}

export const __internals = {
  emptyState, tidyPending, MAX_PENDING, SETTLED_KEEP_DAYS, DEFAULT_EXPIRE_DAYS,
  normalizeGoalText, computeCapacity, capacityError
};
