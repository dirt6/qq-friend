// 5.0-A3：Activity Selection 纯逻辑。
// 只选择“本轮可考虑的活动”，不执行、不写状态、不调用模型/工具。
// Purpose 是候选，Activity 是本轮选择；selectedActivity 不是执行授权。

export const ACTIVITY_TYPES = Object.freeze([
  'advance_goal', 'continue_pending', 'interest_exploration',
  'memory_maintenance', 'conversation_continue', 'wait', 'no_action'
]);

const TERMINAL_GOAL = new Set(['completed', 'cancelled', 'superseded']);
const ACTIVE_GOAL = 'active';
const ACTIVE_PENDING = new Set(['pending', 'waiting']);
const TERMINAL_PENDING = new Set(['done', 'cancelled', 'expired']);
const RISK_RANK = { low: 0, medium: 1, high: 2 };
const PRIORITY = {
  conversation_continue: 100,
  continue_pending: 80,
  advance_goal: 70,
  interest_exploration: 50,
  memory_maintenance: 40
};
const COST = {
  advance_goal: { cost: 2, tokens: 2500, actions: 2 },
  continue_pending: { cost: 1, tokens: 1500, actions: 1 },
  interest_exploration: { cost: 1, tokens: 1200, actions: 1 },
  memory_maintenance: { cost: 1, tokens: 1000, actions: 1 },
  conversation_continue: { cost: 0.5, tokens: 800, actions: 1 },
  wait: { cost: 0, tokens: 0, actions: 0 },
  no_action: { cost: 0, tokens: 0, actions: 0 }
};
const CLOSURE_ALLOWED = {
  continue: new Set(['conversation_continue']),
  close: new Set(['advance_goal', 'interest_exploration', 'memory_maintenance']),
  hold: new Set(['continue_pending', 'memory_maintenance']),
  undetermined: new Set(['wait', 'no_action'])
};

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n)));
const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => textOf(v).toLowerCase();
const parseTime = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};
const uncertainty = (code, detail) => ({ code, detail: String(detail || '') });

function refs(candidate) {
  const out = { goalIds: [], pendingIds: [] };
  for (const r of candidate?.sourceRefs || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'goal' && r.id) out.goalIds.push(String(r.id));
    if (r.type === 'pending' && r.id) out.pendingIds.push(String(r.id));
  }
  return out;
}

function findGoal(state, candidate) {
  const goals = Array.isArray(state.goals) ? state.goals : [];
  const ids = refs(candidate).goalIds;
  if (ids.length) return goals.find((g) => ids.includes(String(g.id))) || null;
  const t = norm(candidate.title);
  return goals.find((g) => norm(g.text) === t) || null;
}
function findPending(state, candidate, now) {
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const ids = refs(candidate).pendingIds;
  let p = null;
  if (ids.length) p = pending.find((x) => ids.includes(String(x.id))) || null;
  else {
    const t = norm(candidate.title);
    p = pending.find((x) => norm(x.text) === t) || null;
  }
  if (!p) return { pending: null, reason: 'no_matching_pending' };
  if (TERMINAL_PENDING.has(String(p.status))) return { pending: p, reason: `pending_${p.status}` };
  if (!ACTIVE_PENDING.has(String(p.status || 'pending'))) return { pending: p, reason: 'pending_not_active' };
  if (p.expiresAt && now !== null) {
    const exp = parseTime(p.expiresAt);
    if (exp !== null && exp < now) return { pending: p, reason: 'pending_expired' };
  }
  return { pending: p, reason: '' };
}

function riskLevel(n) {
  const r = clamp01(n);
  return r >= 0.7 ? 'high' : r >= 0.35 ? 'medium' : 'low';
}
function riskTooHigh(level, maxRisk) {
  const max = String(maxRisk || 'high');
  return (RISK_RANK[level] ?? 2) > (RISK_RANK[max] ?? 2);
}
function budgetCanAfford(cost, budget) {
  if (!budget || typeof budget !== 'object') return { ok: true };
  const checks = [
    ['remainingCost', cost.cost], ['remainingTokens', cost.tokens], ['remainingActions', cost.actions]
  ];
  const missing = [];
  for (const [key, need] of checks) {
    if (budget[key] === undefined || budget[key] === null) continue;
    const have = Number(budget[key]);
    if (!Number.isFinite(have) || have < need) missing.push(key);
  }
  return { ok: missing.length === 0, missing };
}

function recentActionMatch(action, { goalId, pendingId, title }, now, cooldownMs) {
  if (!action || typeof action !== 'object') return false;
  const result = String(action.result || action.status || '').toLowerCase();
  if (!['success', 'done', 'completed', 'ok'].includes(result)) return false;
  const gid = action.goalId || action.sourceGoalId || action.targetGoalId;
  const pid = action.pendingId || action.sourcePendingId || action.targetPendingId;
  const target = textOf(action.target || action.title);
  const idMatch = (goalId && String(gid || '') === String(goalId))
    || (pendingId && String(pid || '') === String(pendingId))
    || (!gid && !pid && target && norm(target) === norm(title));
  if (!idMatch) return false;
  const at = parseTime(action.at || action.endedAt || action.completedAt || action.ts);
  if (now !== null && at !== null && cooldownMs > 0 && now - at < cooldownMs) return true;
  if (now === null) return true;
  return false;
}

function normalizeClosure(closure, uncertainties) {
  if (!closure || typeof closure !== 'object' || Array.isArray(closure)) {
    uncertainties.push(uncertainty('closure_missing', '缺少 Closure 输出'));
    return { decision: 'undetermined', unresolvedRequests: [], reason: 'closure_missing' };
  }
  const decision = ['continue', 'close', 'hold', 'undetermined'].includes(closure.decision)
    ? closure.decision : 'undetermined';
  if (decision !== closure.decision) uncertainties.push(uncertainty('closure_invalid', String(closure.decision)));
  return { ...closure, decision, unresolvedRequests: Array.isArray(closure.unresolvedRequests) ? closure.unresolvedRequests : [] };
}

function candidateReject(c, code) {
  return { candidateId: c.candidateId || '', type: c.kind || '', title: c.title || '', reason: code };
}

/**
 * @returns {{ok:true,decision:'selected'|'wait'|'no_action',selectedActivity:object|null,sourcePurposeIds:Array,sourceGoalIds:Array,sourcePendingIds:Array,reason:string,rejectedAlternatives:Array,risk:string,budgetEstimate:object,needsConfirmation:boolean,uncertainties:Array,diagnostics:object}|{ok:false,code:string,error:string}}
 */
export function selectActivity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'input 必须是对象' };
  }
  for (const k of ['goals', 'pending', 'recentRounds', 'recentActions', 'topics']) {
    if (input[k] !== undefined && !Array.isArray(input[k])) return { ok: false, code: 'INVALID_INPUT', error: `${k} 必须是数组` };
  }
  const state = input.state && typeof input.state === 'object' && !Array.isArray(input.state) ? input.state : {};
  for (const k of ['goals', 'pending', 'recentRounds', 'recentActions', 'topics']) {
    if (state[k] !== undefined && !Array.isArray(state[k])) return { ok: false, code: 'INVALID_INPUT', error: `state.${k} 必须是数组` };
  }
  if (input.purpose !== undefined && input.purpose !== null && typeof input.purpose !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', error: 'purpose 必须是 A1 输出/数组' };
  }
  if (input.state !== undefined && (typeof input.state !== 'object' || Array.isArray(input.state) || input.state === null)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'state 必须是对象' };
  }
  if (input.closure !== undefined && input.closure !== null && (typeof input.closure !== 'object' || Array.isArray(input.closure))) {
    return { ok: false, code: 'INVALID_INPUT', error: 'closure 必须是 A2 输出' };
  }
  if (input.budget !== undefined && (typeof input.budget !== 'object' || Array.isArray(input.budget))) {
    return { ok: false, code: 'INVALID_INPUT', error: 'budget 必须是对象' };
  }
  if (input.limits !== undefined && (typeof input.limits !== 'object' || Array.isArray(input.limits))) {
    return { ok: false, code: 'INVALID_INPUT', error: 'limits 必须是对象' };
  }

  let now = null;
  if (input.now !== undefined && input.now !== null) {
    now = parseTime(input.now);
    if (now === null) return { ok: false, code: 'INVALID_INPUT', error: 'now 不是有效时间' };
  }
  const uncertainties = [];
  const closure = normalizeClosure(input.closure, uncertainties);
  const purpose = input.purpose;
  let candidates = [];
  if (Array.isArray(purpose)) candidates = purpose;
  else if (purpose && typeof purpose === 'object' && Array.isArray(purpose.candidates)) candidates = purpose.candidates;
  else if (purpose && typeof purpose === 'object' && purpose.ok === false) {
    uncertainties.push(uncertainty('purpose_unavailable', purpose.error || purpose.code || ''));
  } else if (purpose !== undefined && purpose !== null) {
    uncertainties.push(uncertainty('purpose_invalid', 'purpose 既不是候选数组也不是 A1 输出'));
  }

  const goals = Array.isArray(state.goals) ? state.goals : [];
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const actions = Array.isArray(state.recentActions) ? state.recentActions : [];
  const limits = input.limits || {};
  const budget = input.budget || state.budget || null;
  const maxRisk = limits.maxRisk || budget?.maxRisk || 'high';
  const cooldownMs = Number.isFinite(Number(limits.cooldownMs)) ? Number(limits.cooldownMs) : 6 * 3600e3;
  const minConfidence = Number.isFinite(Number(limits.minConfidence)) ? Number(limits.minConfidence) : 0.5;
  const allowed = Array.isArray(limits.allowedActivities) ? new Set(limits.allowedActivities) : null;
  const rejected = [];
  const diagnostics = {
    closureDecision: closure.decision, closureReason: closure.reason || '', purposeCount: candidates.length,
    goalsRead: goals.length, pendingRead: pending.length, recentActionsRead: actions.length,
    maxRisk, minConfidence, cooldownMs, priority: PRIORITY
  };

  const makeConversation = (reason) => {
    const cost = COST.conversation_continue;
    const budgetCheck = budgetCanAfford(cost, budget);
    if (!budgetCheck.ok) {
      return {
        ok: true, decision: 'wait', selectedActivity: null, sourcePurposeIds: [], sourceGoalIds: [], sourcePendingIds: [],
        reason: 'budget_insufficient_conversation', rejectedAlternatives: [], risk: 'low', budgetEstimate: cost,
        needsConfirmation: false, uncertainties: [...uncertainties, uncertainty('budget_insufficient', budgetCheck.missing.join(','))], diagnostics
      };
    }
    return {
      ok: true, decision: 'selected',
      selectedActivity: {
        type: 'conversation_continue', title: '继续当前交流', priority: PRIORITY.conversation_continue,
        risk: 'low', budgetEstimate: cost, candidateId: '', needsConfirmation: false
      },
      sourcePurposeIds: [], sourceGoalIds: [], sourcePendingIds: [],
      reason,
      rejectedAlternatives: candidates.map((c) => candidateReject(c, 'conversation_priority')),
      risk: 'low', budgetEstimate: cost, needsConfirmation: false, uncertainties, diagnostics
    };
  };

  // 硬约束 1：未解决用户请求/当前交流继续，优先于任何自主探索。
  if (closure.unresolvedRequests.length > 0) {
    if (closure.decision === 'close') uncertainties.push(uncertainty('closure_inconsistent', 'closure=close 但存在未解决请求'));
    return makeConversation(closure.decision === 'close' ? 'unresolved_request_overrides_close' : 'unresolved_user_request');
  }
  if (closure.decision === 'continue') return makeConversation('closure_continue');

  // 硬约束 2：undetermined 不做高风险自主选择。
  if (closure.decision === 'undetermined') {
    return {
      ok: true, decision: 'wait', selectedActivity: null, sourcePurposeIds: [], sourceGoalIds: [], sourcePendingIds: [],
      reason: 'closure_undetermined', rejectedAlternatives: candidates.map((c) => candidateReject(c, 'closure_undetermined')),
      risk: 'none', budgetEstimate: COST.wait, needsConfirmation: false, uncertainties, diagnostics
    };
  }

  const allowedForClosure = CLOSURE_ALLOWED[closure.decision] || new Set(['wait', 'no_action']);
  const evaluated = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || !textOf(c.title)) { rejected.push({ candidateId: c?.candidateId || '', type: c?.kind || '', title: '', reason: 'malformed_candidate' }); continue; }
    const type = String(c.kind || '').trim();
    if (!ACTIVITY_TYPES.includes(type) || ['wait', 'no_action', 'conversation_continue'].includes(type)) {
      rejected.push(candidateReject(c, type === 'record_only' ? 'record_only_not_executable' : 'unsupported_activity_type'));
      continue;
    }
    if (allowed && !allowed.has(type)) { rejected.push(candidateReject(c, 'activity_not_allowed')); continue; }
    if (!allowedForClosure.has(type)) { rejected.push(candidateReject(c, `closure_${closure.decision}_incompatible`)); continue; }
    if (c.needsConfirmation === true) { rejected.push(candidateReject(c, 'needs_confirmation')); continue; }
    if ((c.uncertainties || []).some((u) => String(u).includes('conflicting_owner') || String(u?.code || '').includes('conflicting_owner'))) {
      rejected.push(candidateReject(c, 'conflicting_owner')); continue;
    }
    if ((Number(c.confidence) || 0) < minConfidence) { rejected.push(candidateReject(c, 'low_confidence')); continue; }
    if (c.owner === 'external') { rejected.push(candidateReject(c, 'external_owner')); continue; }

    let goalId = '';
    let pendingId = '';
    let title = c.title;
    if (type === 'advance_goal') {
      const g = findGoal({ goals }, c);
      if (!g) { rejected.push(candidateReject(c, 'no_matching_goal')); continue; }
      if (TERMINAL_GOAL.has(String(g.status))) { rejected.push(candidateReject(c, `goal_${g.status}`)); continue; }
      if (String(g.status) !== ACTIVE_GOAL) { rejected.push(candidateReject(c, `goal_${g.status || 'inactive'}`)); continue; }
      goalId = String(g.id); title = g.text;
    } else if (type === 'continue_pending') {
      const m = findPending({ pending }, c, now);
      if (!m.pending) { rejected.push(candidateReject(c, m.reason)); continue; }
      if (m.reason) { rejected.push(candidateReject(c, m.reason)); continue; }
      pendingId = String(m.pending.id); title = m.pending.text;
    } else if (type === 'interest_exploration') {
      if (c.owner !== 'partner' && c.owner !== 'inferred') { rejected.push(candidateReject(c, 'not_partner_interest')); continue; }
    } else if (type === 'memory_maintenance') {
      // 允许，但必须来自明确候选，不能凭空生成；风险由候选给出。
    } else {
      rejected.push(candidateReject(c, 'unsupported_activity_type')); continue;
    }

    const level = riskLevel(c.risk);
    if (riskTooHigh(level, maxRisk)) { rejected.push(candidateReject(c, 'risk_too_high')); continue; }
    const cost = COST[type];
    const bc = budgetCanAfford(cost, budget);
    if (!bc.ok) { rejected.push(candidateReject(c, 'budget_insufficient')); continue; }
    if (actions.some((a) => recentActionMatch(a, { goalId, pendingId, title }, now, cooldownMs)) && c.newEvidenceSince !== true) {
      rejected.push(candidateReject(c, 'recently_completed')); continue;
    }

    const key = `${type}:${goalId || pendingId || norm(title)}`;
    if (seen.has(key)) { rejected.push(candidateReject(c, 'duplicate_candidate')); continue; }
    seen.add(key);
    evaluated.push({ c, type, title, goalId, pendingId, risk: level, cost, priority: PRIORITY[type] || 0 });
  }

  evaluated.sort((a, b) => b.priority - a.priority
    || (Number(b.c.confidence) || 0) - (Number(a.c.confidence) || 0)
    || String(a.c.candidateId || '').localeCompare(String(b.c.candidateId || '')));

  if (!evaluated.length) {
    const decision = candidates.length ? 'wait' : 'no_action';
    return {
      ok: true, decision, selectedActivity: null, sourcePurposeIds: [], sourceGoalIds: [], sourcePendingIds: [],
      reason: candidates.length ? 'all_candidates_rejected' : 'no_purpose_candidates',
      rejectedAlternatives: rejected, risk: 'none', budgetEstimate: COST[decision] || COST.wait,
      needsConfirmation: false, uncertainties, diagnostics
    };
  }

  const chosen = evaluated[0];
  const selected = {
    type: chosen.type, title: chosen.title, priority: chosen.priority, risk: chosen.risk,
    budgetEstimate: chosen.cost, candidateId: chosen.c.candidateId || '',
    sourceGoalIds: chosen.goalId ? [chosen.goalId] : [],
    sourcePendingIds: chosen.pendingId ? [chosen.pendingId] : [],
    needsConfirmation: false
  };
  return {
    ok: true,
    decision: 'selected',
    selectedActivity: selected,
    sourcePurposeIds: chosen.c.candidateId ? [chosen.c.candidateId] : [],
    sourceGoalIds: selected.sourceGoalIds,
    sourcePendingIds: selected.sourcePendingIds,
    reason: `selected_${chosen.type}`,
    rejectedAlternatives: [...rejected, ...evaluated.slice(1).map((x) => candidateReject(x.c, 'lower_priority'))],
    risk: chosen.risk,
    budgetEstimate: chosen.cost,
    needsConfirmation: false,
    uncertainties,
    diagnostics: { ...diagnostics, selectedPriority: chosen.priority }
  };
}

export default selectActivity;
