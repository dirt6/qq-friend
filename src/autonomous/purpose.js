// 5.0-A1：Purpose 候选纯逻辑。
// 边界：无 I/O、无模型、无时间/随机、无全局状态；不创建/修改 Goal/Pending/Round/Action。
// PurposeHypothesis 只是“本轮可能值得做什么”的假设，不是 Goal。

export const PURPOSE_KINDS = Object.freeze([
  'advance_goal', 'continue_pending', 'interest_exploration', 'record_only'
]);
export const PURPOSE_OWNERS = Object.freeze(['user', 'partner', 'inferred', 'external', 'unknown']);
export const PURPOSE_EPISTEMICS = Object.freeze(['explicit', 'observed', 'inferred', 'unknown']);

const TERMINAL_GOAL = new Set(['completed', 'cancelled', 'superseded']);
const ACTIVE_PENDING = new Set(['pending', 'waiting']);
const TERMINAL_PENDING = new Set(['done', 'cancelled', 'expired']);
const MIN_CONFIDENCE = 0.3;

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n)));
const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const normText = (v) => textOf(v).toLowerCase();

function ownerOf(raw, intent) {
  const s = String(raw ?? '').toLowerCase();
  if (['user', 'master', 'owner', 'human'].includes(s)) return 'user';
  if (['partner', 'self', 'assistant', 'autonomous', 'ai'].includes(s)) return 'partner';
  if (['external', 'third_party', 'third-party', 'group', 'video', 'other', 'friend'].includes(s)) return 'external';
  if (s === 'inferred') return 'inferred';
  // 只有明确的外部/工具材料才允许 external；未知不猜。
  if (intent === 'observation') return 'external';
  return 'unknown';
}

function epistemicOf(raw, explicit) {
  const s = String(raw ?? '').toLowerCase();
  if (PURPOSE_EPISTEMICS.includes(s)) return s;
  if (explicit === true) return 'explicit';
  if (s === 'observed' || s === 'observation') return 'observed';
  if (s === 'inferred' || s === 'guess') return 'inferred';
  return 'unknown';
}

function intentOf(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (['long_term', 'long-term', 'goal', 'direction', 'commitment'].includes(s)) return 'long_term';
  if (['one_off', 'one-off', 'task', 'request', 'todo'].includes(s)) return 'one_off';
  if (['interest', 'hobby', 'curiosity'].includes(s)) return 'interest';
  if (['chat', 'conversation', 'smalltalk', 'ordinary'].includes(s)) return 'chat';
  if (['observation', 'observed', 'external_info', 'external-info'].includes(s)) return 'observation';
  return 'unknown';
}

function evidence(type, id, text, strength = 1) {
  return { type, id: String(id || ''), text: textOf(text).slice(0, 200), strength: clamp01(strength) };
}

function baseConfidence(epistemic, owner) {
  const e = { explicit: 0.9, observed: 0.65, inferred: 0.38, unknown: 0.2 }[epistemic] ?? 0.2;
  const o = { user: 1, partner: 0.86, inferred: 0.62, external: 0.45, unknown: 0.3 }[owner] ?? 0.3;
  return e * o;
}

function makeCandidate({ kind, title, owner, epistemic, longTerm, confidence, value, urgency, risk, evidenceList, key, reasons, uncertainties, needsConfirmation = false }) {
  return {
    candidateId: `purpose:${key}`,
    kind,
    title: textOf(title).slice(0, 120),
    owner,
    epistemic,
    longTerm: Boolean(longTerm),
    confidence: clamp01(confidence),
    value: clamp01(value),
    urgency: clamp01(urgency),
    risk: clamp01(risk),
    score: 0,
    evidence: evidenceList,
    sourceRefs: evidenceList.map((e) => ({ type: e.type, id: e.id })),
    reasons: [...new Set(reasons)],
    uncertainties: [...new Set(uncertainties)],
    needsConfirmation: Boolean(needsConfirmation)
  };
}

function addUncertainty(list, code, detail) {
  if (!list.some((x) => x.code === code && x.detail === detail)) list.push({ code, detail });
}

function dedupeCandidates(raw) {
  const map = new Map();
  for (const c of raw) {
    const prev = map.get(c.candidateId);
    if (!prev) { map.set(c.candidateId, c); continue; }
    // 同 id/同 key：合并证据，保留更高置信度；归属冲突在后续处理。
    prev.evidence = [...prev.evidence, ...c.evidence.filter((e) => !prev.evidence.some((x) => x.type === e.type && x.id === e.id && x.text === e.text))];
    prev.confidence = Math.max(prev.confidence, c.confidence);
    prev.value = Math.max(prev.value, c.value);
    prev.urgency = Math.max(prev.urgency, c.urgency);
    prev.reasons = [...new Set([...prev.reasons, ...c.reasons])];
    prev.uncertainties = [...new Set([...prev.uncertainties, ...c.uncertainties])];
    prev.needsConfirmation = prev.needsConfirmation || c.needsConfirmation;
    prev._owners = new Set([...(prev._owners || [prev.owner]), c.owner]);
    prev._epistemics = new Set([...(prev._epistemics || [prev.epistemic]), c.epistemic]);
    prev.sourceRefs = prev.evidence.map((e) => ({ type: e.type, id: e.id }));
  }
  return [...map.values()];
}

function resolveOwnershipConflict(c, uncertainties) {
  const owners = c._owners || new Set([c.owner]);
  delete c._owners;
  delete c._epistemics;
  if (owners.size <= 1) return c;
  // 安全优先：同一 subject 出现多个归属，无法可靠判断“这是谁的目标”，
  // 不做 user/external 升级，也不猜一个 owner；直接丢弃并要求人工确认。
  addUncertainty(uncertainties, 'conflicting_owner', `同一材料归属冲突：${[...owners].join('/')}`);
  return null;
}

function finalize(candidates, uncertainties) {
  const out = [];
  for (const c of candidates) {
    const resolved = resolveOwnershipConflict(c, uncertainties);
    if (!resolved) continue;
    resolved.score = clamp01(resolved.confidence * 0.55 + resolved.value * 0.25 + resolved.urgency * 0.2 - resolved.risk * 0.15);
    if (resolved.confidence < MIN_CONFIDENCE) {
      addUncertainty(uncertainties, 'low_confidence', resolved.title);
      continue;
    }
    out.push(resolved);
  }
  const kindRank = { advance_goal: 3, continue_pending: 2, interest_exploration: 1, record_only: 0 };
  out.sort((a, b) => b.score - a.score
    || kindRank[b.kind] - kindRank[a.kind]
    || a.candidateId.localeCompare(b.candidateId));
  return out;
}

/**
 * 构建 Purpose 候选。
 * @param {object} input 只读快照；不修改输入
 * @returns {{ok:true,candidates:Array,noAction:boolean,reason:string,uncertainties:Array,diagnostics:object}|{ok:false,code:string,error:string}}
 */
export function buildPurposeCandidates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'input 必须是对象' };
  }
  const listKeys = ['goals', 'pending', 'topics', 'materials', 'rounds', 'activities', 'messages'];
  for (const k of listKeys) {
    if (input[k] !== undefined && !Array.isArray(input[k])) {
      return { ok: false, code: 'INVALID_INPUT', error: `${k} 必须是数组` };
    }
  }
  let now = 0;
  if (input.now !== undefined && input.now !== null) {
    const n = typeof input.now === 'number' ? input.now : Date.parse(String(input.now));
    if (!Number.isFinite(n)) return { ok: false, code: 'INVALID_INPUT', error: 'now 不是有效时间' };
    now = n;
  }

  const uncertainties = [];
  const diagnostics = { goalsRead: 0, pendingRead: 0, materialsRead: 0, topicsRead: 0, skipped: 0, deduped: 0 };
  const raw = [];

  // 1) 现有 Goal：只读，不修改；用户 Goal 是明确长期方向，自主 Goal 需要证据。
  for (const g of input.goals || []) {
    if (!g || typeof g !== 'object' || !g.id || !textOf(g.text)) { diagnostics.skipped += 1; continue; }
    const status = String(g.status || 'active');
    if (TERMINAL_GOAL.has(status)) continue;
    diagnostics.goalsRead += 1;
    const owner = g.source === 'user_directed' ? 'user' : 'partner';
    const hasEvidence = Boolean(textOf(g.reason) || (Array.isArray(g.evidence) && g.evidence.length));
    const epistemic = owner === 'user' ? 'explicit' : (hasEvidence ? 'observed' : 'inferred');
    const conf = owner === 'user' ? 0.86 : (hasEvidence ? 0.6 : 0.42);
    const c = makeCandidate({
      kind: 'advance_goal', title: g.text, owner, epistemic, longTerm: true,
      confidence: conf, value: 0.75, urgency: 0.35, risk: 0.1,
      evidenceList: [evidence('goal', g.id, g.text, owner === 'user' ? 1 : 0.7)],
      key: `subject:${normText(g.text)}`,
      reasons: ['existing_goal', owner === 'user' ? 'user_directed' : 'partner_direction'],
      uncertainties: owner === 'partner' && !hasEvidence ? ['autonomous_goal_without_evidence'] : [],
      needsConfirmation: owner === 'partner' && !hasEvidence
    });
    if (status === 'paused') { c.confidence = clamp01(c.confidence - 0.15); c.uncertainties.push('goal_paused'); }
    raw.push(c);
  }

  // 2) Pending：具体事项，不是长期方向；一次性只作为可继续任务。
  for (const p of input.pending || []) {
    if (!p || typeof p !== 'object' || !p.id || !textOf(p.text)) { diagnostics.skipped += 1; continue; }
    const status = String(p.status || 'pending');
    if (TERMINAL_PENDING.has(status) || !ACTIVE_PENDING.has(status)) continue;
    diagnostics.pendingRead += 1;
    if (p.expiresAt && now > 0) {
      const exp = Date.parse(String(p.expiresAt));
      if (Number.isFinite(exp) && exp < now) { addUncertainty(uncertainties, 'pending_expired', p.text); continue; }
    }
    const src = String(p.source || '').toLowerCase();
    const owner = ['user', 'master', 'user_directed'].includes(src) ? 'user'
      : ['autonomous', 'partner'].includes(src) ? 'partner' : 'unknown';
    const explicit = p.explicit === true || src === 'user_directed';
    const epistemic = explicit ? 'explicit' : 'observed';
    const conf = owner === 'unknown' ? 0.28 : (explicit ? 0.78 : 0.56);
    raw.push(makeCandidate({
      kind: 'continue_pending', title: p.text, owner, epistemic, longTerm: false,
      confidence: conf, value: 0.58, urgency: status === 'waiting' ? 0.5 : 0.38, risk: 0.08,
      evidenceList: [evidence('pending', p.id, p.text, explicit ? 1 : 0.65)],
      key: `subject:${normText(p.text)}`,
      reasons: ['active_pending', explicit ? 'explicit_task' : 'observed_task'],
      uncertainties: owner === 'unknown' ? ['pending_owner_unknown'] : [],
      needsConfirmation: owner === 'unknown' || !explicit
    }));
  }

  // 3) 材料：聊天/外部信息/伙伴兴趣。必须带归属与意图，不能从文本猜目标。
  for (let i = 0; i < (input.materials || []).length; i += 1) {
    const m = input.materials[i];
    if (!m || typeof m !== 'object' || !textOf(m.text)) { diagnostics.skipped += 1; continue; }
    diagnostics.materialsRead += 1;
    const intent = intentOf(m.intent ?? m.kind);
    const owner = ownerOf(m.owner ?? m.declaredOwner ?? m.authorRole, intent);
    const explicit = m.explicit === true || intent === 'long_term' || intent === 'one_off';
    const epistemic = epistemicOf(m.epistemic, explicit);
    const key = `subject:${normText(m.dedupeKey || m.text).slice(0, 120)}`;
    const base = {
      owner, epistemic, key,
      evidenceList: [evidence('material', m.id || `m-${i}`, m.text, explicit ? 1 : 0.6)],
      uncertainties: [], reasons: []
    };
    if (owner === 'unknown') {
      addUncertainty(uncertainties, 'owner_unknown', textOf(m.text).slice(0, 80));
      continue; // 无法确定归属 → 不生成候选
    }
    if (!intent || intent === 'unknown') {
      // 普通材料不自动成为目的；只有显式 intent 才处理。
      diagnostics.skipped += 1;
      continue;
    }
    if (intent === 'chat') continue; // 普通聊天不产生 Purpose
    if (intent === 'observation') {
      raw.push(makeCandidate({
        ...base, kind: 'record_only', title: m.text, longTerm: false,
        confidence: Math.max(0.32, baseConfidence(epistemic, owner) * 0.75), value: 0.25, urgency: 0.2, risk: 0.05,
        reasons: ['external_observation', 'record_not_goal'],
        uncertainties: ['record_only_not_user_goal']
      }));
      continue;
    }
    if (owner === 'external') {
      // 第三方目标/内容：最多记录，绝不升级为用户目标。
      raw.push(makeCandidate({
        ...base, kind: 'record_only', title: m.text, longTerm: false,
        confidence: Math.max(0.32, baseConfidence(epistemic, 'external') * 0.8), value: 0.3, urgency: 0.2, risk: 0.05,
        reasons: ['third_party_content', 'never_user_goal'],
        uncertainties: ['external_not_user_goal', 'intent_from_third_party']
      }));
      continue;
    }
    if (intent === 'long_term') {
      if (owner === 'inferred') {
        raw.push(makeCandidate({
          ...base, kind: 'record_only', title: m.text, longTerm: false,
        confidence: Math.max(0.34, baseConfidence('inferred', 'inferred') * 0.9), value: 0.3, urgency: 0.2, risk: 0.1,
          reasons: ['inferred_only', 'never_user_goal'],
          uncertainties: ['inferred_not_user_goal', 'requires_confirmation'],
          needsConfirmation: true
        }));
        continue;
      }
      raw.push(makeCandidate({
        ...base, kind: 'advance_goal', title: m.text, longTerm: true,
        confidence: baseConfidence(epistemic, owner) * 0.95, value: 0.7, urgency: 0.35, risk: 0.12,
        reasons: ['explicit_long_term', owner === 'user' ? 'user_direction' : 'partner_interest'],
        uncertainties: [],
        needsConfirmation: false
      }));
      continue;
    }
    if (intent === 'one_off') {
      raw.push(makeCandidate({
        ...base, kind: 'continue_pending', title: m.text, longTerm: false,
        confidence: baseConfidence(epistemic, owner) * 0.9, value: 0.5, urgency: 0.45, risk: 0.08,
        reasons: ['one_off_request', 'not_a_goal'],
        uncertainties: ['one_off_not_long_term']
      }));
      continue;
    }
    if (intent === 'interest') {
      raw.push(makeCandidate({
        ...base, kind: 'interest_exploration', title: m.text, longTerm: false,
        confidence: baseConfidence(epistemic, owner) * 0.85, value: 0.45, urgency: 0.25, risk: 0.1,
        reasons: ['partner_interest', 'requires_history'],
        uncertainties: owner === 'partner' ? ['interest_requires_history'] : ['inferred_interest'],
        needsConfirmation: owner !== 'partner'
      }));
    }
  }

  for (const t of input.topics || []) {
    if (t && typeof t === 'object' && textOf(t.text)) diagnostics.topicsRead += 1;
    else diagnostics.skipped += 1;
  }
  // topics 只作为上下文，不直接生成 Purpose（普通聊天不能变 Goal）。

  const merged = dedupeCandidates(raw);
  diagnostics.deduped = Math.max(0, raw.length - merged.length);
  const candidates = finalize(merged, uncertainties);
  const reason = candidates.length ? 'has_candidates'
    : (input.goals?.length || input.pending?.length || input.materials?.length || input.topics?.length || input.messages?.length) ? 'no_worthwhile_work'
      : 'no_input';
  return {
    ok: true,
    candidates,
    noAction: candidates.length === 0,
    reason,
    uncertainties,
    diagnostics
  };
}

export default buildPurposeCandidates;
