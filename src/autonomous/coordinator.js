// 5.0-E2：统一执行协调器。
// 只串联决策/回执/持久化；执行必须显式授权且由注入的 execute 完成；
// 不发送分享、不写记忆、不调用任意工具。
import { buildPurposeCandidates } from './purpose.js';
import { assessConversationClosure } from './closure.js';
import { selectActivity } from './activity.js';
import { createDecisionReceipt, stableReceiptId } from './receipt.js';
import { buildContinuityContext } from './continuity.js';
import { decideShare } from './sharing.js';
import { governMemory } from './memory-governance.js';
import { classifyExecutionOutcome } from './execution-result.js';
import { validateExecution } from './executor-gate.js';

export function planHashOf(receipt) {
  return stableReceiptId({ receiptId: receipt.receiptId, activity: receipt.activity, sourceGoalIds: receipt.sourceGoalIds, sourcePendingIds: receipt.sourcePendingIds });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('execution_timeout'), { code: 'TIMEOUT' })), ms); })
  ]).finally(() => clearTimeout(timer));
}

export function createCoordinator({ store, execute = null, now = () => Date.now(), timeoutMs = 30000, maxSteps = 1 } = {}) {
  if (!store) throw new Error('coordinator 需要 execution store');
  const emit = async (receiptId, eventId, to, reason, extra = {}) => store.apply(receiptId, { eventId, to, reason, now: now(), ...extra });

  async function run(input = {}) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'input_required' };
    const at = Number(input.now ?? now());
    const tickId = String(input.tickId || '');
    const purpose = input.purpose || (input.purposeInput ? buildPurposeCandidates(input.purposeInput) : { ok: true, candidates: [], noAction: true, reason: 'no_input' });
    const closure = input.closure || (input.closureInput ? assessConversationClosure(input.closureInput) : { ok: false, code: 'MISSING_INPUT', error: 'closure required' });
    const activity = input.activity || (input.activityState ? selectActivity({ closure, purpose, state: input.activityState, now: at, budget: input.budget, limits: input.limits }) : { ok: false, code: 'MISSING_INPUT', error: 'activity required' });
    if (!closure.ok || !activity.ok) return { ok: false, error: 'decision_failed', closure, activity };
    const continuity = input.continuity || (input.continuityInput ? buildContinuityContext({ ...input.continuityInput, now: input.continuityInput.now ?? at }) : null);
    const sharing = input.sharing || (input.sharingInput ? decideShare({ ...input.sharingInput, now: input.sharingInput.now ?? at }) : null);
    const memory = input.memory || (input.memoryInput ? governMemory({ ...input.memoryInput, now: input.memoryInput.now ?? at }) : null);

    const receipt = createDecisionReceipt({ now: at, purpose, closure, activity, inputRef: input.inputRef, summary: input.summary, decisionVersion: input.decisionVersion, existingReceipts: input.existingReceipts });
    if (!receipt.ok) return { ok: false, error: 'receipt_failed', receipt };
    const rec = {
      ...receipt.receipt,
      integrations: {
        continuity: continuity ? { activeGoalIds: continuity.context?.activeGoalIds || [], blocked: continuity.blocked?.length || 0 } : null,
        sharing: sharing ? { decision: sharing.decision, sendAuthorized: false } : null,
        memory: memory ? { accepted: memory.accepted?.length || 0, rejected: memory.rejected?.length || 0, routed: true } : null
      }
    };
    const recorded = await store.recordReceipt(rec, { now: at });
    if (!recorded.ok) return { ok: false, error: recorded.error };
    if (recorded.duplicate && ['succeeded', 'failed', 'unknown', 'cancelled', 'started'].includes(recorded.record.state)) {
      return { ok: true, receipt: rec, state: recorded.record.state, duplicate: true, executed: false, continuity, sharing, memory };
    }
    if (!activity.selectedActivity) {
      return { ok: true, receipt: rec, state: recorded.record.state, executed: false, continuity, sharing, memory };
    }
    // 对话继续不是自主执行；执行层只处理明确的活动类型。
    if (activity.selectedActivity.type === 'conversation_continue') {
      return { ok: true, receipt: rec, state: recorded.record.state, executed: false, reason: 'conversation_not_autonomous_execution', continuity, sharing, memory };
    }
    if (!execute) return { ok: true, receipt: rec, state: recorded.record.state, executed: false, reason: 'no_executor', continuity, sharing, memory };
    if (store.list && (await store.list()).paused) return { ok: true, receipt: rec, state: recorded.record.state, executed: false, reason: 'paused', continuity, sharing, memory };

    const token = typeof input.authorizationFactory === 'function' ? await input.authorizationFactory(rec) : input.authorization;
    if (!token) return { ok: true, receipt: rec, state: recorded.record.state, executed: false, reason: 'authorization_required', continuity, sharing, memory };
    const expectedPlan = planHashOf(rec);
    const actionType = String(activity.selectedActivity.type);
    const target = String(activity.selectedActivity.title || '');
    const params = input.executionPlan?.params || {};
    let authPayload = token;
    if (input.authorizationService && typeof input.authorizationService.verify === 'function') {
      const v = input.authorizationService.verify(token, { expected: { receiptId: rec.receiptId, planHash: expectedPlan, actionType, target, params, scope: 'execute' } });
      if (!v.ok) return { ok: false, receipt: rec, state: recorded.record.state, executed: false, reason: `authorization_${v.error}`, continuity, sharing, memory };
      authPayload = v.payload;
    } else if (String(token.planHash || '') !== expectedPlan || String(token.receiptId || '') !== rec.receiptId) {
      return { ok: false, receipt: rec, state: recorded.record.state, executed: false, reason: 'authorization_plan_mismatch', continuity, sharing, memory };
    }
    if (input.executionPlan) {
      const gate = validateExecution({
        activity: activity.selectedActivity, plan: input.executionPlan, authorization: authPayload,
        tools: input.tools, paused: (await store.list()).paused, budget: input.budget,
        runs: Number(recorded.record.attempts) || 0
      });
      if (!gate.ok) return { ok: false, receipt: rec, state: recorded.record.state, executed: false, reason: `permission_${gate.reason}`, continuity, sharing, memory };
    }
    const auth = await store.authorize(rec.receiptId, { eventId: `auth:${tickId || rec.receiptId}`, authorization: { ...token, ...(token.payload || authPayload), receiptId: rec.receiptId }, now: at });
    if (!auth.ok) return { ok: false, receipt: rec, state: (await store.get(rec.receiptId))?.state || 'decision_recorded', executed: false, reason: `authorization_${auth.error}`, continuity, sharing, memory };
    if ((await store.list()).paused) return { ok: true, receipt: rec, state: 'authorized', executed: false, reason: 'paused', continuity, sharing, memory };

    await emit(rec.receiptId, `start:${tickId || rec.receiptId}`, 'started', 'execution_started');
    let outcome;
    try {
      outcome = await withTimeout(execute({ receipt: rec, activity: activity.selectedActivity, authorization: authPayload, plan: input.executionPlan || null, maxSteps }), timeoutMs);
    } catch (e) {
      if (e?.code === 'TIMEOUT') {
        await emit(rec.receiptId, `unknown:${tickId || rec.receiptId}`, 'unknown', 'execution_timeout', { evidence: 'timeout' });
        return { ok: true, receipt: rec, state: 'unknown', executed: true, reason: 'execution_timeout', continuity, sharing, memory };
      }
      // 抛异常无法证明副作用未发生 → unknown，禁止按异常类型猜 failed。
      await emit(rec.receiptId, `unknown:${tickId || rec.receiptId}`, 'unknown', 'exception_side_effect_unknown', { evidence: String(e?.message || e) });
      return { ok: true, receipt: rec, state: 'unknown', executed: true, reason: 'exception_side_effect_unknown', continuity, sharing, memory };
    }
    const cls = classifyExecutionOutcome(outcome, { threw: false, timedOut: false });
    if (cls.state === 'unknown') {
      await emit(rec.receiptId, `unknown:${tickId || rec.receiptId}`, 'unknown', cls.reason, { evidence: String(outcome?.evidence || '') });
      return { ok: true, receipt: rec, state: 'unknown', executed: true, reason: cls.reason, continuity, sharing, memory };
    }
    if (cls.state === 'failed') {
      await emit(rec.receiptId, `fail:${tickId || rec.receiptId}`, 'failed', cls.reason, { meta: { error: String(outcome?.error || '') } });
      return { ok: false, receipt: rec, state: 'failed', executed: true, reason: cls.reason, continuity, sharing, memory };
    }
    await emit(rec.receiptId, `success:${tickId || rec.receiptId}`, 'succeeded', 'execution_succeeded');
    return { ok: true, receipt: rec, state: 'succeeded', executed: true, continuity, sharing, memory };
  }
  return { run, store };
}

export default createCoordinator;
