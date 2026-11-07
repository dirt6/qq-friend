// 5.0-A7：空闲窗口的 Goal/Purpose 规划（纯逻辑）。
//
// 定位：把已有的 A1（Purpose 候选）、A2（Conversation Closure）、A3（Activity 选择）
// 接进空闲 think，让“醒来”先看自己的长期方向/未完成事项，而不是随机挑活动。
//
// 边界：
//   · 无 I/O、无模型、无工具、无全局状态；
//   · 不创建/修改 Goal/Pending，不执行任何动作，不写账本；
//   · 只是“本轮可以考虑做什么”的建议，执行仍由 idle-activities 在既有安全边界内完成。
import { buildPurposeCandidates } from './purpose.js';
import { assessConversationClosure } from './closure.js';
import { selectActivity } from './activity.js';

/** 空闲窗口允许的自主活动类型（不含 conversation_continue：那属于聊天本身）。 */
export const IDLE_ALLOWED_ACTIVITIES = Object.freeze([
  'advance_goal', 'continue_pending', 'interest_exploration', 'memory_maintenance'
]);

/**
 * 空闲默认限制。
 * minConfidence 比聊天场景（0.5）略低：她自己的兴趣候选只有 observed 级置信度，
 * 且空闲只允许低风险动作（浏览/日记/本子/分享/聊天）。
 */
export const IDLE_LIMITS = Object.freeze({ minConfidence: 0.45, cooldownMs: 6 * 3600e3 });

/**
 * 停止条件（R8）：同一个方向连续 N 轮没有进展 → 暂停 24 小时再试，
 * 避免“每 3 小时醒来重试一次、永远失败”的无限循环。
 * 有任一成功进展就清零（不需要人工解除）。
 */
export const PROGRESS_LIMITS = Object.freeze({ maxStrikes: 3, pauseMs: 24 * 3600e3 });

const TYPE_TEXT = Object.freeze({
  advance_goal: '推进一个长期方向',
  continue_pending: '继续一件没做完的事',
  interest_exploration: '顺着自己的兴趣看看',
  memory_maintenance: '整理日记/记忆'
});

/**
 * 每种活动类型允许的“动作”。restricted think 只能从这里选。
 * · diary          = 整理已有日记（diary_review，只读原文）
 * · write_diary    = 把这一轮看到/想到的写进当天日记
 * · write_notebook = 写进她自己的本子
 */
export const ACTIONS_BY_TYPE = Object.freeze({
  advance_goal: Object.freeze(['browse', 'diary', 'write_diary', 'write_notebook', 'share', 'chat', 'sleep', 'none']),
  continue_pending: Object.freeze(['browse', 'diary', 'write_diary', 'write_notebook', 'share', 'chat', 'sleep', 'none']),
  interest_exploration: Object.freeze(['browse', 'diary', 'write_diary', 'write_notebook', 'share', 'sleep', 'none']),
  memory_maintenance: Object.freeze(['diary', 'write_diary', 'write_notebook', 'sleep', 'none'])
});

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => textOf(v).toLowerCase();

/** ChatStore 消息 → closure 输入（role/at）。只映射，不改语义。 */
export function toClosureMessages(messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => ({
    role: m?.self ? 'assistant' : 'user',
    text: String(m?.text ?? m?.content ?? ''),
    // 缺失时间时留 undefined：closure 会标记“顺序不可验证”，不会瞎猜。
    at: Number.isFinite(Number(m?.ts ?? m?.at)) ? Number(m?.ts ?? m?.at) : undefined
  }));
}

/**
 * 对话是否允许她自主做事。
 * · 有未解决请求 / 需要她回话 → 不做（先回应主人，不能跑去逛 B 站）；
 * · 主人忙、等她回话、话题暂停 → 允许（这正是空闲窗口的场景）；
 * · 无聊天记录 → 允许。
 */
export function gateOf(closure) {
  if (!closure || closure.ok !== true) return { allow: false, reason: 'closure_failed' };
  if (Array.isArray(closure.unresolvedRequests) && closure.unresolvedRequests.length) {
    return { allow: false, reason: 'unresolved_requests' };
  }
  if (closure.decision === 'continue') return { allow: false, reason: 'conversation_open' };
  return { allow: true, reason: closure.decision === 'close' ? 'conversation_closed' : 'conversation_paused' };
}

function findTarget(selected, { goals, pending, purpose }) {
  if (!selected) return null;
  const gid = (selected.sourceGoalIds || [])[0];
  const pid = (selected.sourcePendingIds || [])[0];
  if (gid) {
    const g = (goals || []).find((x) => String(x?.id) === String(gid));
    if (g) return { kind: 'goal', id: String(g.id), text: textOf(g.text), source: String(g.source || '') };
  }
  if (pid) {
    const p = (pending || []).find((x) => String(x?.id) === String(pid));
    if (p) return { kind: 'pending', id: String(p.id), text: textOf(p.text), source: String(p.source || '') };
  }
  const c = (purpose?.candidates || []).find((x) => String(x?.candidateId || '') === String(selected.candidateId || ''));
  if (c) return { kind: c.kind === 'interest_exploration' ? 'interest' : 'candidate', id: String(c.candidateId || ''), text: textOf(c.title), source: String(c.owner || '') };
  return { kind: 'unknown', id: '', text: textOf(selected.title), source: '' };
}

/** 最近是否刚做过同一件兴趣（措辞常变，用包含关系近似）。 */
export function recentlyDone(title, entries = [], now, withinMs = 7 * 86400e3) {
  const t = norm(title);
  if (!t) return false;
  return entries.some((e) => {
    if (e?.ok !== true || !e?.title) return false;
    const at = Number(e.at);
    if (Number.isFinite(at) && now - at > withinMs) return false;
    const prev = norm(e.title);
    if (!prev) return false;
    return prev === t || prev.includes(t) || t.includes(prev);
  });
}

/**
 * 停止条件（R8）：按“方向”聚合最近记录，连续无进展达到阈值 → 暂停 pauseMs。
 * 记录可能是账本原始条目（ok/done）或 recentActions 形状（result）。
 */
function entryKey(e) {
  if (e?.goalId) return `goal:${e.goalId}`;
  if (e?.pendingId) return `pending:${e.pendingId}`;
  const t = norm(e?.target || e?.title);
  return t ? `title:${t}` : '';
}
function isProgress(e) {
  if (!e || typeof e !== 'object') return false;
  if ('result' in e) return String(e.result) === 'success';
  return e.ok === true && e.done !== false;
}

export function assessProgress(entries = [], { now = Date.now(), maxStrikes = PROGRESS_LIMITS.maxStrikes, pauseMs = PROGRESS_LIMITS.pauseMs } = {}) {
  const map = new Map();
  const sorted = entries.filter((e) => e && typeof e === 'object').slice()
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  for (const e of sorted) {
    const key = entryKey(e);
    if (!key) continue;
    const cur = map.get(key) || { key, strikes: 0, lastAt: 0, title: '' };
    if (isProgress(e)) cur.strikes = 0; else cur.strikes += 1;
    const at = Number(e.at);
    if (Number.isFinite(at)) cur.lastAt = Math.max(cur.lastAt, at);
    cur.title = String(e.target || e.title || cur.title || '').slice(0, 120);
    map.set(key, cur);
  }
  const paused = [];
  for (const cur of map.values()) {
    if (cur.strikes >= maxStrikes && cur.lastAt > 0 && now - cur.lastAt < pauseMs) {
      paused.push({ key: cur.key, strikes: cur.strikes, title: cur.title, lastAt: cur.lastAt, until: cur.lastAt + pauseMs });
    }
  }
  return { paused, all: [...map.values()] };
}

/**
 * 规划一轮空闲。
 *
 * @param {object} input
 * @param {number|Date} [input.now]
 * @param {Array} [input.goals]          只读 Goal 快照（active/paused）
 * @param {Array} [input.pending]        只读 Pending 快照（activePending）
 * @param {Array} [input.messages]       ChatStore 最近消息（{self,text,ts}）
 * @param {Array} [input.materials]      额外 Purpose 材料（如她自己本子里的兴趣）
 * @param {Array} [input.recentActions]  运行账本（用于 6h 冷却去重）
 * @param {object} [input.limits]
 * @param {object|null} [input.budget]
 */
export function planIdleCycle(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'input 必须是对象' };
  }
  for (const k of ['goals', 'pending', 'messages', 'materials', 'recentActions']) {
    if (input[k] !== undefined && !Array.isArray(input[k])) {
      return { ok: false, code: 'INVALID_INPUT', error: `${k} 必须是数组` };
    }
  }
  let now = Date.now();
  if (input.now !== undefined && input.now !== null) {
    const n = typeof input.now === 'number' ? input.now : Date.parse(String(input.now));
    if (!Number.isFinite(n)) return { ok: false, code: 'INVALID_INPUT', error: 'now 不是有效时间' };
    now = n;
  }

  const goals = Array.isArray(input.goals) ? input.goals : [];
  const pending = Array.isArray(input.pending) ? input.pending : [];
  const recentActions = Array.isArray(input.recentActions) ? input.recentActions : [];
  const messages = toClosureMessages(input.messages || []);
  const limits = { ...IDLE_LIMITS, ...(input.limits && typeof input.limits === 'object' ? input.limits : {}) };

  // R8 停止条件：连续无进展的方向先暂停，不参与本轮选择（成功一次即自动恢复）。
  const progress = assessProgress(recentActions, {
    now,
    ...(limits.progress && typeof limits.progress === 'object' ? limits.progress : {})
  });
  const pausedGoalIds = new Set(progress.paused.filter((p) => p.key.startsWith('goal:')).map((p) => p.key.slice(5)));
  const pausedPendingIds = new Set(progress.paused.filter((p) => p.key.startsWith('pending:')).map((p) => p.key.slice(8)));
  const activeGoals = goals.filter((g) => !pausedGoalIds.has(String(g?.id)));
  const activePending = pending.filter((p) => !pausedPendingIds.has(String(p?.id)));
  const pausedCount = (goals.length - activeGoals.length) + (pending.length - activePending.length);

  // 空闲窗口视为“这次会话暂时闭合”：主人可能已经走开。
  // 但 closure 的未解决请求/提问优先规则不受影响（仍会拦下自主活动）。
  const closure = assessConversationClosure({
    now,
    messages,
    conversation: { status: 'closed', allowNextOpening: false }
  });
  const gate = gateOf(closure);
  const base = {
    now, gate,
    closure: closure?.ok === true
      ? { decision: closure.decision, reason: closure.reason, unresolved: (closure.unresolvedRequests || []).length }
      : { decision: 'unknown', reason: closure?.error || 'closure_failed', unresolved: 0 }
  };
  if (!gate.allow) {
    return {
      ok: true, ...base, selected: null, target: null, purpose: null, activity: null,
      progress: { paused: progress.paused, pausedCount }, skipReason: gate.reason
    };
  }

  // 兴趣材料：只保留“她自己 + 没刚做过”的条目。
  const materials = (input.materials || [])
    .filter((m) => m && typeof m === 'object' && textOf(m.text))
    .filter((m) => String(m.owner || '') === 'partner' && String(m.intent || '') === 'interest')
    .filter((m) => !recentlyDone(m.text, recentActions, now));
  const dropped = (input.materials || []).length - materials.length;

  const purpose = buildPurposeCandidates({
    now,
    goals: activeGoals,
    pending: activePending,
    materials,
    topics: (input.messages || []).slice(-5).map((m) => ({ text: String(m?.text ?? '') }))
  });
  if (!purpose.ok) return { ok: false, ...base, code: purpose.code, error: purpose.error };

  const activityInput = {
    now,
    purpose,
    state: { goals: activeGoals, pending: activePending, recentActions },
    limits: { ...limits, allowedActivities: [...IDLE_ALLOWED_ACTIVITIES] },
    budget: input.budget || null
  };
  // 空闲已确认“可以自主”，A3 的 close/hold 两种收尾语义都安全：
  //   close → advance_goal / interest_exploration / memory_maintenance
  //   hold  → continue_pending / memory_maintenance
  // 各跑一次，取优先级更高者（pending 80 > goal 70 > interest 50），不改 A3 的语义。
  const attempts = ['close', 'hold']
    .map((decision) => selectActivity({ ...activityInput, closure: { ...closure, decision, reason: 'idle_window' } }))
    .filter((x) => x.ok === true);
  if (!attempts.length) {
    return { ok: false, ...base, code: 'ACTIVITY_FAILED', error: '两个 closure 语义都失败' };
  }
  attempts.sort((a, b) => (b.selectedActivity?.priority ?? -1) - (a.selectedActivity?.priority ?? -1));
  const activity = attempts[0];

  const selected = activity.selectedActivity || null;
  const target = findTarget(selected, { goals: activeGoals, pending: activePending, purpose });
  const skipReason = selected ? ''
    : (pausedCount > 0 && !purpose.candidates.length ? 'no_progress_pause'
      : (purpose.candidates.length ? activity.reason : 'no_purpose_candidates'));
  return {
    ok: true,
    ...base,
    selected,
    target,
    purpose: {
      ok: true, count: purpose.candidates.length, noAction: purpose.noAction,
      reason: purpose.reason, candidates: purpose.candidates
    },
    activity,
    progress: { paused: progress.paused, pausedCount },
    droppedMaterials: Math.max(0, dropped),
    skipReason
  };
}

/**
 * 把规划结果写成给模型的约束说明（restricted think 用）。
 * 只描述，不扩容：动作清单来自 ACTIONS_BY_TYPE。
 */
export function describePlanForPrompt(plan, allowedActions = null) {
  if (!plan?.ok || !plan?.selected) return '';
  const type = String(plan.selected.type || '');
  const lines = [];
  lines.push('这一轮你已经有一个明确的方向（来自你自己的长期方向、没做完的事，或者你记录下来的兴趣）：');
  lines.push(`- 类型：${TYPE_TEXT[type] || type}`);
  lines.push(`- 内容：${textOf(plan.selected.title)}`);
  if (plan.target?.source) lines.push(`- 来源：${plan.target.source}`);
  if (plan.activity?.reason) lines.push(`- 为什么是它：${plan.activity.reason}`);
  const actions = Array.isArray(allowedActions) && allowedActions.length
    ? allowedActions
    : (ACTIONS_BY_TYPE[type] || ['sleep', 'none']);
  lines.push(`- 这一轮只能做：${actions.join(' / ')}`);
  lines.push('不要换话题、不要顺手做别的；如果现在不适合做，就选 sleep 或 none，并说明原因。');
  return lines.join('\n');
}

export default planIdleCycle;
