// 5.0-B：长期连续性与活动恢复纯逻辑。
// 从既有 Goal/Pending/Round/Action 构建上下文与恢复建议；不建第二套任务系统。
// 无 I/O、无模型、无系统时钟/随机/全局状态，不写任何领域状态。

const ACTIVE_GOAL = 'active';
const TERMINAL_GOAL = new Set(['completed', 'cancelled', 'superseded']);
const ACTIVE_PENDING = new Set(['pending', 'waiting']);
const TERMINAL_PENDING = new Set(['done', 'cancelled', 'expired']);
const SUCCESS = new Set(['success', 'succeeded', 'done', 'completed', 'ok']);
const FAILED = new Set(['failed', 'error', 'rejected']);
const RUNNING = new Set(['started', 'running', 'in_progress', 'in-progress']);
const NOT_STARTED = new Set(['authorized', 'decision_recorded', 'decided']);
const UNKNOWN = new Set(['unknown', 'uncertain', 'lost']);
const CANCELLED = new Set(['cancelled', 'canceled']);

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => textOf(v).toLowerCase();
const parseTime = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};
const uncertainty = (code, detail) => ({ code, detail: String(detail || '') });
const stateOf = (a) => String(a?.state || a?.result || a?.status || '').toLowerCase();

function idempotencyKey(kind, sourceId, roundId = '') {
  return `cont:${kind}:${String(sourceId || '')}:${String(roundId || '')}`;
}

function normalizeActions(rounds, actions) {
  const out = [];
  const push = (a, roundId = '') => {
    if (!a || typeof a !== 'object') return;
    out.push({
      ...a,
      actionId: String(a.actionId || a.id || ''),
      roundId: String(a.roundId || roundId || ''),
      targetGoalId: String(a.targetGoalId || a.sourceGoalId || a.goalId || ''),
      targetPendingId: String(a.targetPendingId || a.sourcePendingId || a.pendingId || ''),
      title: textOf(a.title || a.action || a.summary),
      state: stateOf(a),
      attempts: Number(a.attempts) || 0,
      safeToRetry: a.safeToRetry === true || a.retryable === true,
      createdAt: parseTime(a.createdAt || a.startedAt || a.at || a.endedAt)
    });
  };
  for (const r of Array.isArray(rounds) ? rounds : []) {
    if (!r || typeof r !== 'object') continue;
    for (const a of Array.isArray(r.actions) ? r.actions : []) push(a, r.roundId || r.id);
  }
  for (const a of Array.isArray(actions) ? actions : []) push(a, a.roundId);
  const seen = new Set();
  return out.filter((a) => {
    const key = a.actionId || `${a.roundId}:${a.title}:${a.state}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/**
 * @param {object} input { now?, goals?, pending?, rounds?, actions?, topics?, processedTicks?, processedKeys?, tickId?, limits? }
 */
export function buildContinuityContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'input 必须是对象' };
  }
  for (const k of ['goals', 'pending', 'rounds', 'actions', 'topics', 'processedTicks', 'processedKeys', 'newEvidence']) {
    if (input[k] !== undefined && !Array.isArray(input[k])) return { ok: false, code: 'INVALID_INPUT', error: `${k} 必须是数组` };
  }
  const now = input.now !== undefined ? parseTime(input.now) : null;
  if (input.now !== undefined && now === null) return { ok: false, code: 'INVALID_INPUT', error: 'now 不是有效时间' };

  const uncertainties = [];
  const goals = Array.isArray(input.goals) ? input.goals.filter((g) => g && g.id && textOf(g.text)) : [];
  const pending = Array.isArray(input.pending) ? input.pending.filter((p) => p && p.id && textOf(p.text)) : [];
  const rounds = Array.isArray(input.rounds) ? input.rounds.filter((r) => r && typeof r === 'object') : [];
  const topics = Array.isArray(input.topics) ? input.topics.filter((t) => t && textOf(t.text || t.title)) : [];
  const actions = normalizeActions(rounds, input.actions);
  const processedKeys = new Set((input.processedKeys || []).map(String));
  const processedTicks = new Set((input.processedTicks || []).map(String));
  const tickId = String(input.tickId || '');
  const maxRetries = Number.isFinite(Number(input.limits?.maxRetries)) ? Number(input.limits.maxRetries) : 1;

  if (tickId && processedTicks.has(tickId)) {
    return {
      ok: true, duplicateTick: true, context: { tickId }, resumeCandidates: [], blocked: [],
      completedItems: [], uncertainties: [uncertainty('duplicate_tick', tickId)], diagnostics: { actionsRead: actions.length, goalsRead: goals.length, pendingRead: pending.length }
    };
  }

  const activeGoals = goals.filter((g) => String(g.status) === ACTIVE_GOAL);
  const inactiveGoals = goals.filter((g) => TERMINAL_GOAL.has(String(g.status)) || String(g.status) !== ACTIVE_GOAL);
  const activePending = pending.filter((p) => ACTIVE_PENDING.has(String(p.status || 'pending')));
  const expiredPending = activePending.filter((p) => p.expiresAt && now !== null && (parseTime(p.expiresAt) ?? Infinity) < now);
  const validPending = activePending.filter((p) => !expiredPending.includes(p));
  const terminalPending = pending.filter((p) => TERMINAL_PENDING.has(String(p.status)));
  for (const p of expiredPending) uncertainties.push(uncertainty('pending_expired', p.id));

  const sortedRounds = [...rounds].sort((a, b) => (parseTime(a.endedAt || a.at || a.startedAt) ?? 0) - (parseTime(b.endedAt || b.at || b.startedAt) ?? 0));
  const lastRound = sortedRounds[sortedRounds.length - 1] || null;
  const sortedActions = [...actions].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const lastAction = sortedActions[sortedActions.length - 1] || null;

  const resumeCandidates = [];
  const blocked = [];
  const completedItems = [];
  const seen = new Set();
  const addCandidate = (kind, type, id, title, reason, extra = {}) => {
    const key = idempotencyKey(kind, id, extra.roundId || '');
    if (seen.has(key)) return;
    seen.add(key);
    if (processedKeys.has(key) && extra.newEvidence !== true) {
      blocked.push({ kind, sourceType: type, sourceId: id, reason: 'already_processed', idempotencyKey: key });
      return;
    }
    resumeCandidates.push({
      kind, sourceType: type, sourceId: id, title: textOf(title).slice(0, 160), reason,
      idempotencyKey: key, requiresConfirmation: extra.requiresConfirmation === true,
      risk: extra.risk || 'low', roundId: extra.roundId || ''
    });
  };

  // 1) Action 恢复：结果未知/执行中 → 不得盲目重试；失败可安全重试才给候选。
  for (const a of actions) {
    const linked = a.targetPendingId || a.targetGoalId;
    if (!a.actionId && !linked) {
      uncertainties.push(uncertainty('legacy_unlinked_action', a.title || ''));
      blocked.push({ kind: 'action', sourceId: '', reason: 'legacy_missing_link', title: a.title });
      continue;
    }
    if (NOT_STARTED.has(a.state)) {
      blocked.push({ kind: 'action', actionId: a.actionId, sourceId: linked, reason: 'not_started_requires_execution_authorization', idempotencyKey: idempotencyKey('action', a.actionId || linked, a.roundId) });
      continue;
    }
    if (RUNNING.has(a.state)) {
      blocked.push({ kind: 'action', actionId: a.actionId, sourceId: linked, reason: 'outcome_unknown_running', idempotencyKey: idempotencyKey('action', a.actionId || linked, a.roundId) });
      uncertainties.push(uncertainty('outcome_unknown', a.actionId || linked));
      continue;
    }
    if (UNKNOWN.has(a.state)) {
      blocked.push({ kind: 'action', actionId: a.actionId, sourceId: linked, reason: 'outcome_unknown_no_retry', idempotencyKey: idempotencyKey('action', a.actionId || linked, a.roundId) });
      uncertainties.push(uncertainty('outcome_unknown', a.actionId || linked));
      continue;
    }
    if (SUCCESS.has(a.state)) {
      if (linked) completedItems.push({ sourceType: a.targetPendingId ? 'pending' : 'goal', sourceId: linked, actionId: a.actionId, completedAt: a.endedAt || a.at || '' });
      continue;
    }
    if (CANCELLED.has(a.state)) continue;
    if (FAILED.has(a.state)) {
      if (a.safeToRetry && a.attempts < maxRetries) {
        addCandidate('retry_action', 'action', a.actionId || linked, a.title, 'failed_safe_to_retry', { roundId: a.roundId, risk: 'medium', requiresConfirmation: false });
      } else {
        blocked.push({ kind: 'action', actionId: a.actionId, sourceId: linked, reason: a.safeToRetry ? 'retry_limit' : 'retry_not_safe', idempotencyKey: idempotencyKey('action', a.actionId || linked, a.roundId) });
        uncertainties.push(uncertainty('retry_blocked', a.actionId || linked));
      }
    }
  }

  // 2) Pending 连续性：只按稳定 ID；过期/终态不进入；已完成 Action 防止重复。
  for (const p of validPending) {
    if (processedKeys.has(idempotencyKey('pending', p.id)) && !(input.newEvidence || []).some((e) => String(e?.id || '') === String(p.id))) {
      blocked.push({ kind: 'pending', sourceType: 'pending', sourceId: p.id, reason: 'already_processed', idempotencyKey: idempotencyKey('pending', p.id) });
      continue;
    }
    const doneAction = actions.find((a) => a.targetPendingId === String(p.id) && SUCCESS.has(a.state));
    if (doneAction) {
      completedItems.push({ sourceType: 'pending', sourceId: p.id, actionId: doneAction.actionId, completedAt: doneAction.endedAt || doneAction.at || '' });
      blocked.push({ kind: 'pending', sourceType: 'pending', sourceId: p.id, reason: 'already_completed_action', idempotencyKey: idempotencyKey('pending', p.id) });
      continue;
    }
    const linkedUnknown = actions.some((a) => a.targetPendingId === String(p.id) && (UNKNOWN.has(a.state) || RUNNING.has(a.state)));
    if (linkedUnknown) {
      blocked.push({ kind: 'pending', sourceType: 'pending', sourceId: p.id, reason: 'linked_action_outcome_unknown', idempotencyKey: idempotencyKey('pending', p.id) });
      continue;
    }
    addCandidate('continue_pending', 'pending', p.id, p.text, 'active_pending', { risk: 'low', requiresConfirmation: false });
  }

  // 3) Goal 连续性：只 active；终态/暂停不复活；不自动把 Pending 完成当 Goal 完成。
  for (const g of activeGoals) {
    if (processedKeys.has(idempotencyKey('goal', g.id))) {
      blocked.push({ kind: 'goal', sourceType: 'goal', sourceId: g.id, reason: 'already_processed', idempotencyKey: idempotencyKey('goal', g.id) });
      continue;
    }
    addCandidate('advance_goal', 'goal', g.id, g.text, 'active_goal', { risk: 'medium', requiresConfirmation: false });
  }
  for (const g of inactiveGoals) {
    blocked.push({ kind: 'goal', sourceType: 'goal', sourceId: g.id, reason: `goal_${g.status || 'inactive'}` });
  }

  // 4) 同一事项多个相似 Pending：不按标题合并；按 ID 分别保留，但标记需确认。
  const byTitle = new Map();
  for (const p of validPending) {
    const t = norm(p.text);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(p.id);
  }
  for (const [, ids] of byTitle) {
    if (ids.length > 1) uncertainties.push(uncertainty('similar_pending_items', ids.join(',')));
  }

  return {
    ok: true,
    duplicateTick: false,
    context: {
      activeGoalIds: activeGoals.map((g) => String(g.id)),
      inactiveGoalIds: inactiveGoals.map((g) => String(g.id)),
      activePendingIds: validPending.map((p) => String(p.id)),
      expiredPendingIds: expiredPending.map((p) => String(p.id)),
      terminalPendingIds: terminalPending.map((p) => String(p.id)),
      lastRoundId: lastRound ? String(lastRound.roundId || lastRound.id || '') : '',
      lastActionId: lastAction ? String(lastAction.actionId || '') : '',
      unfinishedActionIds: actions.filter((a) => RUNNING.has(a.state) || UNKNOWN.has(a.state)).map((a) => a.actionId),
      topicIds: topics.slice(-5).map((t) => String(t.id || t.topicId || ''))
    },
    resumeCandidates: resumeCandidates.sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)),
    blocked: blocked.sort((a, b) => String(a.idempotencyKey || a.sourceId).localeCompare(String(b.idempotencyKey || b.sourceId))),
    completedItems,
    uncertainties,
    diagnostics: { goalsRead: goals.length, pendingRead: pending.length, roundsRead: rounds.length, actionsRead: actions.length, maxRetries, duplicateTick: false }
  };
}

export default buildContinuityContext;
