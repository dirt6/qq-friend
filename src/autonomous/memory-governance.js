// 5.0-D：统一记忆治理纯逻辑。
// 只校验/路由读取与写入意图；Memory Hub/Core 是读入口，写入仍由领域模块执行。
// 无 I/O、无模型、无系统时钟/随机/全局状态；不修改任何记忆。

const DOMAINS = new Set(['learned', 'diary', 'memory', 'companion', 'chat']);
const WRITE_DOMAINS = new Set(['learned', 'diary', 'memory', 'companion']);
const REQUESTERS = new Set(['chat', 'autonomous', 'core', 'admin']);
const OPS = new Set(['write', 'correct', 'archive', 'expire', 'review']);
const OWNERS = new Set(['user', 'partner', 'inferred', 'external', 'unknown']);
const EPISTEMICS = new Set(['explicit', 'observed', 'inferred', 'unknown']);

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const parseTime = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};
const uncertainty = (code, detail) => ({ code, detail: String(detail || '') });

export function canReadDomain({ requester, domain, purpose } = {}) {
  if (!REQUESTERS.has(String(requester))) return { ok: false, reason: 'requester_not_allowed' };
  if (!DOMAINS.has(String(domain))) return { ok: false, reason: 'domain_not_allowed' };
  if (!textOf(purpose)) return { ok: false, reason: 'purpose_required' };
  return { ok: true, via: 'memory_hub/core', write: false };
}

/**
 * @param {object} input { now?, intents?, existing?, requester? }
 * @returns {{ok:true,accepted:Array,rejected:Array,corrections:Array,lifecycle:Array,uncertainties:Array,diagnostics:object}|{ok:false,code:string,error:string}}
 */
export function governMemory(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'input 必须是对象' };
  }
  for (const k of ['intents', 'existing']) {
    if (input[k] !== undefined && !Array.isArray(input[k])) return { ok: false, code: 'INVALID_INPUT', error: `${k} 必须是数组` };
  }
  const now = input.now !== undefined ? parseTime(input.now) : null;
  if (input.now !== undefined && now === null) return { ok: false, code: 'INVALID_INPUT', error: 'now 不是有效时间' };
  const existing = (input.existing || []).filter((x) => x && typeof x === 'object' && x.id);
  const accepted = [];
  const rejected = [];
  const corrections = [];
  const lifecycle = [];
  const uncertainties = [];
  const diagnostics = { intentsRead: (input.intents || []).length, existingRead: existing.length, domains: [...DOMAINS] };

  const reject = (intent, reason) => rejected.push({ intentId: String(intent?.id || ''), reason, domain: String(intent?.domain || '') });
  const findTarget = (id) => existing.find((x) => String(x.id) === String(id)) || null;

  for (const intent of input.intents || []) {
    if (!intent || typeof intent !== 'object') { rejected.push({ intentId: '', reason: 'malformed_intent' }); continue; }
    const id = String(intent.id || '');
    const domain = String(intent.domain || '');
    const op = String(intent.op || 'write');
    if (!DOMAINS.has(domain)) { reject(intent, 'domain_not_allowed'); continue; }
    if (domain === 'chat') { reject(intent, 'chatstore_owned_read_only'); continue; }
    if (!WRITE_DOMAINS.has(domain)) { reject(intent, 'write_domain_not_allowed'); continue; }
    if (!OPS.has(op)) { reject(intent, 'op_not_allowed'); continue; }
    if (!textOf(intent.content) && op !== 'archive' && op !== 'expire') { reject(intent, 'content_required'); continue; }
    if (!textOf(intent.source)) { reject(intent, 'source_required'); continue; }
    const owner = String(intent.owner || 'unknown');
    const epistemic = String(intent.epistemicType || 'unknown');
    if (!OWNERS.has(owner) || !EPISTEMICS.has(epistemic)) { reject(intent, 'owner_or_epistemic_invalid'); continue; }
    if (epistemic === 'inferred' && !(Array.isArray(intent.evidence) ? intent.evidence.length : textOf(intent.evidence))) {
      reject(intent, 'inferred_requires_evidence'); continue;
    }
    if (owner === 'external' && !textOf(intent.source)) { reject(intent, 'external_requires_source'); continue; }
    const at = parseTime(intent.at);
    if (intent.at !== undefined && at === null) { reject(intent, 'invalid_at'); continue; }

    // 1) 纠正：必须显式 target；找不到就保留 historicalUnresolved，不猜文本。
    if (op === 'correct') {
      const targetId = String(intent.correctsId || intent.targetId || '');
      if (!targetId) { reject(intent, 'correction_target_required'); continue; }
      const target = findTarget(targetId);
      if (!target) {
        corrections.push({ intentId: id, targetId, domain, targetResolved: false, historicalUnresolved: true, requiresConfirmation: true });
        uncertainties.push(uncertainty('historical_unresolved', targetId));
        accepted.push({ intentId: id, domain, op, routedTo: domain, status: 'needs_confirmation', historicalUnresolved: true });
        continue;
      }
      if (target.explicitCorrected === true || (Array.isArray(target.corrections) && target.corrections.some((c) => String(c?.owner || '') === 'user'))) {
        if (owner !== 'user') { reject(intent, 'correction_protected'); continue; }
      }
      const versions = intent.expectedVersion !== undefined && target.version !== undefined && String(intent.expectedVersion) !== String(target.version);
      if (versions) { reject(intent, 'version_conflict'); continue; }
      corrections.push({ intentId: id, targetId, domain, targetResolved: true, historicalUnresolved: target.historicalUnresolved === true, oldPreserved: true, explicit: owner === 'user' || target.explicitCorrected === true });
      if (target.historicalUnresolved === true) uncertainties.push(uncertainty('historical_unresolved_preserved', targetId));
      accepted.push({ intentId: id, domain, op, routedTo: domain, status: 'accepted', requiresConfirmation: owner !== 'user' });
      continue;
    }

    // 2) 生命周期：重要日记不归档；临时事项才可过期；Goal 生命周期不由 Hub 改。
    if (op === 'archive') {
      if (domain === 'diary' && (intent.importance === 'high' || intent.important === true)) { reject(intent, 'important_diary_archive_forbidden'); continue; }
      lifecycle.push({ intentId: id, domain, op: 'archive', important: false, action: 'archive_allowed' });
      accepted.push({ intentId: id, domain, op, routedTo: domain, status: 'accepted' });
      continue;
    }
    if (op === 'expire') {
      if (intent.kind === 'goal' || domain === 'companion' && intent.kind === 'goal') { reject(intent, 'goal_lifecycle_domain_owned'); continue; }
      if (intent.temporary !== true && intent.volatile !== true) { reject(intent, 'expire_requires_temporary'); continue; }
      lifecycle.push({ intentId: id, domain, op: 'expire', temporary: true, goalCompleted: false });
      accepted.push({ intentId: id, domain, op, routedTo: domain, status: 'accepted' });
      continue;
    }
    if (op === 'review') {
      lifecycle.push({ intentId: id, domain, op: 'review', needsReview: true, reviewAt: intent.reviewAt || null });
      accepted.push({ intentId: id, domain, op, routedTo: domain, status: 'accepted', needsReview: true });
      continue;
    }

    // 3) 普通写入：冲突版本拒绝；可变事实标记待复核；旧数据不猜测。
    if (intent.expectedVersion !== undefined) {
      const target = intent.targetId ? findTarget(intent.targetId) : null;
      if (target && target.version !== undefined && String(intent.expectedVersion) !== String(target.version)) { reject(intent, 'version_conflict'); continue; }
    }
    const needsReview = intent.volatile === true || intent.epistemicType === 'inferred';
    if (needsReview) lifecycle.push({ intentId: id, domain, op: 'review', needsReview: true, reviewAt: intent.reviewAt || null });
    accepted.push({ intentId: id, domain, op, routedTo: domain, status: 'accepted', requiresConfirmation: intent.requiresConfirmation === true, needsReview });
    if (!intent.evidence && epistemic !== 'explicit') uncertainties.push(uncertainty('weak_evidence', id));
  }

  // 旧数据兼容：缺 version/corrections 不重写，只标记。
  for (const x of existing) {
    if (x.version === undefined || x.corrections === undefined) uncertainties.push(uncertainty('legacy_record', String(x.id)));
    if (x.historicalUnresolved === true) uncertainties.push(uncertainty('historical_unresolved_preserved', String(x.id)));
  }

  return {
    ok: true,
    accepted,
    rejected,
    corrections,
    lifecycle,
    uncertainties,
    diagnostics
  };
}

export default governMemory;
