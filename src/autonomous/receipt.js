// 5.0-A4：Decision Receipt 纯逻辑。
// 只记录“决策已产生”；不授权、不执行、不写 Goal/Pending/Round/Action。
// 无 I/O、无模型、无系统时钟/随机/全局状态。

export const RECEIPT_VERSION = '5.0-A4';
export const RECEIPT_STATUS = Object.freeze(['decision_recorded']);
export const EXECUTION_STATES = Object.freeze([
  'decision_recorded', 'authorized', 'started', 'succeeded', 'failed', 'unknown', 'cancelled'
]);
const NEXT = {
  decision_recorded: ['authorized', 'cancelled'],
  authorized: ['started', 'cancelled'],
  started: ['succeeded', 'failed', 'unknown'],
  unknown: ['succeeded', 'failed'],
  failed: ['authorized'],
  succeeded: [],
  cancelled: []
};

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const parseTime = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};
const uncertainty = (code, detail) => ({ code, detail: String(detail || '') });

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
export function stableReceiptId(parts) {
  return `rcpt:${hash32(stableStringify(parts))}`;
}

export function canTransitionExecution(from, to) {
  return Boolean(NEXT[from]?.includes(to));
}

/**
 * @param {object} input { now, purpose, closure, activity, inputRef?, summary?, decisionVersion?, existingReceipts? }
 * @returns {{ok:true,receipt:object,duplicate:boolean,receiptId:string}|{ok:false,code:string,error:string}}
 */
export function createDecisionReceipt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'input 必须是对象' };
  }
  for (const k of ['purpose', 'closure', 'activity']) {
    if (!input[k] || typeof input[k] !== 'object' || Array.isArray(input[k])) {
      return { ok: false, code: 'MISSING_INPUT', error: `缺少 ${k}` };
    }
    if (input[k].ok === false) return { ok: false, code: 'INPUT_FAILED', error: `${k}: ${input[k].error || input[k].code || 'failed'}` };
  }
  const now = parseTime(input.now);
  if (now === null) return { ok: false, code: 'MISSING_TIME', error: 'now 必须有效' };
  if (input.existingReceipts !== undefined && !Array.isArray(input.existingReceipts)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'existingReceipts 必须是数组' };
  }

  const purposeCandidates = Array.isArray(input.purpose.candidates) ? input.purpose.candidates : [];
  const purposeIds = purposeCandidates.map((c) => String(c?.candidateId || '')).filter(Boolean);
  const rejected = Array.isArray(input.activity.rejectedAlternatives) ? input.activity.rejectedAlternatives : [];
  const selected = input.activity.selectedActivity && typeof input.activity.selectedActivity === 'object' ? input.activity.selectedActivity : null;
  const sourceGoalIds = [...new Set([...(input.activity.sourceGoalIds || []), ...(selected?.sourceGoalIds || [])].map(String).filter(Boolean))];
  const sourcePendingIds = [...new Set([...(input.activity.sourcePendingIds || []), ...(selected?.sourcePendingIds || [])].map(String).filter(Boolean))];
  const sourceTopicIds = [...new Set((input.closure.sourceTopicIds || []).map(String).filter(Boolean))];
  const unresolved = Array.isArray(input.closure.unresolvedRequests) ? input.closure.unresolvedRequests : [];
  const unresolvedIds = unresolved.map((r) => String(r?.id || '')).filter(Boolean);

  const decisionParts = {
    version: String(input.decisionVersion || RECEIPT_VERSION),
    purposeIds: [...purposeIds].sort(),
    closure: { decision: input.closure.decision, reason: input.closure.reason || '', unresolvedIds: [...unresolvedIds].sort() },
    activity: {
      decision: input.activity.decision, type: selected?.type || '', candidateId: selected?.candidateId || '',
      sourceGoalIds: [...sourceGoalIds].sort(), sourcePendingIds: [...sourcePendingIds].sort(), reason: input.activity.reason || ''
    },
    rejected: rejected.map((r) => ({ candidateId: r?.candidateId || '', reason: r?.reason || '' })).sort((a, b) => a.candidateId.localeCompare(b.candidateId) || a.reason.localeCompare(b.reason))
  };
  const receiptId = stableReceiptId(decisionParts);
  const existing = (input.existingReceipts || []).find((r) => r && String(r.receiptId || '') === receiptId);
  if (existing) return { ok: true, duplicate: true, receipt: existing, receiptId };

  const uncertainties = [];
  for (const list of [input.purpose.uncertainties, input.closure.uncertainties, input.activity.uncertainties]) {
    if (Array.isArray(list)) uncertainties.push(...list.map((u) => (u && typeof u === 'object' ? { code: String(u.code || ''), detail: String(u.detail || '') } : uncertainty('uncertain', String(u)))));
  }
  const receipt = {
    receiptId,
    version: String(input.decisionVersion || RECEIPT_VERSION),
    status: 'decision_recorded',
    createdAt: new Date(now).toISOString(),
    inputRef: textOf(input.inputRef || '').slice(0, 200),
    summary: textOf(input.summary || '').slice(0, 300),
    purpose: { count: purposeIds.length, candidateIds: [...purposeIds], noAction: input.purpose.noAction === true, reason: input.purpose.reason || '' },
    closure: { decision: input.closure.decision, reason: input.closure.reason || '', unresolvedRequests: unresolved.map((r) => ({ id: String(r?.id || ''), text: textOf(r?.text || '').slice(0, 200), kind: String(r?.kind || '') })) },
    activity: {
      decision: input.activity.decision, reason: input.activity.reason || '',
      selectedActivity: selected ? {
        type: selected.type, title: textOf(selected.title).slice(0, 120), priority: selected.priority ?? null,
        risk: selected.risk || 'none', candidateId: selected.candidateId || '', sourceGoalIds, sourcePendingIds,
        budgetEstimate: selected.budgetEstimate || input.activity.budgetEstimate || null
      } : null,
      rejectedAlternatives: rejected.map((r) => ({ candidateId: String(r?.candidateId || ''), type: String(r?.type || ''), title: textOf(r?.title || '').slice(0, 120), reason: String(r?.reason || '') })),
      risk: input.activity.risk || 'none',
      budgetEstimate: input.activity.budgetEstimate || null,
      needsConfirmation: input.activity.needsConfirmation === true
    },
    sourcePurposeIds: [...purposeIds],
    sourceGoalIds,
    sourcePendingIds,
    sourceTopicIds,
    risk: input.activity.risk || 'none',
    budgetEstimate: input.activity.budgetEstimate || null,
    needsConfirmation: input.activity.needsConfirmation === true,
    uncertainties,
    execution: {
      state: 'decision_recorded',
      authorized: false,
      startedAt: null,
      finishedAt: null,
      history: [],
      allowedNext: [...(NEXT.decision_recorded || [])]
    }
  };
  return { ok: true, duplicate: false, receipt, receiptId };
}

export default createDecisionReceipt;
