// 5.0 今晚：Coordinator 的真实 Action executor。
// 只处理显式 plan.kind=learned 或 qq；不调度、不自动触发、不调模型。
import { createMemoryWriter } from './memory-writer.js';
import { sendShare } from './qq-sender.js';

const asArray = (v) => (Array.isArray(v) ? v : []);

export function createActionExecutor({
  learnedAdapter = null,
  qqAdapter = null,
  readonlyAdapter = null,
  drawAdapter = null,
  authorizationService = null,
  paused = () => false,
  recentSends = [],
  now = () => Date.now()
} = {}) {
  const memoryWriter = learnedAdapter ? createMemoryWriter({ adapters: { learned: learnedAdapter }, now }) : null;

  async function execute({ receipt, activity, plan, authorization } = {}) {
    if (paused()) return { ok: false, sideEffect: 'none', error: 'paused' };
    if (!receipt?.receiptId) return { ok: false, sideEffect: 'none', error: 'receipt_required' };
    const kind = String(plan?.kind || '');
    if (kind === 'learned') {
      if (!memoryWriter) return { ok: false, sideEffect: 'none', error: 'learned_adapter_missing' };
      const r = await memoryWriter.execute({ intents: asArray(plan.intents), accepted: asArray(plan.accepted), receiptId: receipt.receiptId });
      if (!r.ok) return { ok: false, sideEffect: 'none', error: r.error || 'memory_write_failed' };
      if (r.unknown) return { unknown: true, evidence: 'memory_write_unknown', result: r };
      const failed = r.results.filter((x) => x.state === 'failed' || x.state === 'unknown');
      if (failed.length) return { ok: false, sideEffect: 'none', error: 'memory_write_failed', result: r };
      return { ok: true, result: r };
    }
    if (kind === 'draw') {
      if (!drawAdapter) return { ok: false, sideEffect: 'none', error: 'draw_adapter_missing' };
      const r = await drawAdapter.draw({ preset: plan.preset, title: plan.title, note: plan.note });
      if (r?.sideEffect === 'unknown') return { unknown: true, evidence: r.error || 'draw_unknown' };
      if (!r?.ok) return { ok: false, sideEffect: 'none', error: r?.error || 'draw_failed' };
      return { ok: true, result: r };
    }
    if (kind === 'readonly') {
      if (!readonlyAdapter) return { ok: false, sideEffect: 'none', error: 'readonly_adapter_missing' };
      const r = String(plan.op || 'list') === 'search'
        ? await readonlyAdapter.search({ keyword: plan.keyword, limit: Number(plan.limit) || 8 })
        : await readonlyAdapter.read({ limit: Number(plan.limit) || 8 });
      if (!r?.ok) return { ok: false, sideEffect: 'none', error: r?.error || 'readonly_failed' };
      return { ok: true, result: r };
    }
    if (kind === 'qq') {
      if (!qqAdapter) return { ok: false, sideEffect: 'none', error: 'qq_adapter_missing' };
      if (!authorizationService) return { ok: false, sideEffect: 'none', error: 'authorization_service_missing' };
      const r = await sendShare({
        decision: plan.decision,
        shareId: String(receipt.receiptId),
        target: String(plan.qqTarget || plan.target || ''),
        text: String(plan.text || ''),
        authorization: plan.shareAuthorization || authorization || null,
        authorizationService,
        sender: qqAdapter,
        allowedTargets: [qqAdapter.target],
        paused: paused(),
        recentSends,
        now: now()
      });
      if (r.state === 'sent' || r.state === 'duplicate') return { ok: true, result: r };
      if (r.state === 'unknown') return { unknown: true, evidence: r.reason || 'send_unknown', result: r };
      return { ok: false, sideEffect: 'none', error: r.reason || r.state, result: r };
    }
    return { ok: false, sideEffect: 'none', error: 'plan_kind_not_allowed' };
  }

  return { execute };
}

export default createActionExecutor;
