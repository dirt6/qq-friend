// 5.0-C：自主分享与用户体验纯逻辑。
// 只判断“发现是否值得分享”，不发送、不写历史、不调用模型/工具。
// share_now 不是发送授权；执行层必须再次检查用户设置/权限。

export const SHARE_DECISIONS = Object.freeze(['share_now', 'save_for_later', 'record_only', 'do_not_share', 'undetermined']);

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => textOf(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const parseTime = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n)));
const uncertainty = (code, detail) => ({ code, detail: String(detail || '') });

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
function fingerprintOf(d) {
  if (d.contentFingerprint) return String(d.contentFingerprint);
  return `share:${hash32(norm(`${d.title || ''}|${d.summary || ''}|${d.source || ''}`))}`;
}
function tokens(s) {
  const n = norm(s);
  const out = new Set(n.split(' ').filter((x) => x.length > 1));
  // 中文没有空格：用双字片段做相似度，避免“轻微改写”完全匹配不到。
  const han = n.replace(/[^\p{Script=Han}]/gu, '');
  for (let i = 0; i + 1 < han.length; i += 1) out.add(han.slice(i, i + 2));
  return out;
}
function similarity(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * @returns {{ok:true,decision:string,reason:string,fingerprint:string,duplicate:boolean,similarTo:string,needsConfirmation:boolean,sendAuthorized:false,risk:string,uncertainties:Array,diagnostics:object}|{ok:false,code:string,error:string}}
 */
export function decideShare(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'input 必须是对象' };
  }
  for (const k of ['recentShares']) {
    if (input[k] !== undefined && !Array.isArray(input[k])) return { ok: false, code: 'INVALID_INPUT', error: `${k} 必须是数组` };
  }
  for (const k of ['discovery', 'user', 'conversation', 'limits']) {
    if (input[k] !== undefined && (typeof input[k] !== 'object' || Array.isArray(input[k]) || input[k] === null)) {
      return { ok: false, code: 'INVALID_INPUT', error: `${k} 必须是对象` };
    }
  }
  const d = input.discovery || {};
  const user = input.user || {};
  const conv = input.conversation || {};
  const limits = input.limits || {};
  const now = input.now !== undefined ? parseTime(input.now) : null;
  if (input.now !== undefined && now === null) return { ok: false, code: 'INVALID_INPUT', error: 'now 不是有效时间' };
  const uncertainties = [];
  const diagnostics = { hasTitle: Boolean(textOf(d.title)), hasSummary: Boolean(textOf(d.summary)), recentCount: Array.isArray(input.recentShares) ? input.recentShares.length : 0 };

  if (!textOf(d.title) && !textOf(d.summary)) {
    return { ok: true, decision: 'undetermined', reason: 'missing_content', fingerprint: '', duplicate: false, similarTo: '', needsConfirmation: false, sendAuthorized: false, risk: 'none', uncertainties: [uncertainty('missing_content', '')], diagnostics };
  }
  if (Array.isArray(d.sources) && d.sources.length > 1) {
    const rel = [...new Set(d.sources.map((s) => Number(s?.reliability) || 0).map((x) => x.toFixed(2)))];
    if (rel.length > 1) {
      return { ok: true, decision: 'undetermined', reason: 'conflicting_sources', fingerprint: fingerprintOf(d), duplicate: false, similarTo: '', needsConfirmation: true, sendAuthorized: false, risk: 'unknown', uncertainties: [uncertainty('conflicting_sources', rel.join('/'))], diagnostics };
    }
  }

  const fingerprint = fingerprintOf(d);
  const recent = Array.isArray(input.recentShares) ? input.recentShares : [];
  const cooldownMs = Number.isFinite(Number(limits.cooldownMs)) ? Number(limits.cooldownMs) : 24 * 3600e3;
  const maxPerDay = Number.isFinite(Number(limits.maxPerDay)) ? Number(limits.maxPerDay) : 3;
  const relevance = clamp01(d.relevance);
  const value = clamp01(d.value);
  const reliability = clamp01(d.reliability ?? d.sourceReliability ?? 0.5);
  const sensitivity = clamp01(d.sensitivity ?? 0);
  const source = String(d.source || '');
  const blockSource = (user.blockedSources || []).map(String).includes(source);
  const blockTopic = (user.blockedTopics || []).some((t) => norm(d.title).includes(norm(t)) || norm(d.summary).includes(norm(t)));

  const within = (r) => {
    if (!r || typeof r !== 'object') return false;
    const at = parseTime(r.at);
    return now === null || at === null || now - at <= cooldownMs;
  };
  const similar = recent.find((r) => {
    if (!within(r)) return false;
    if (String(r.fingerprint || '') === fingerprint) return true;
    return String(r.source || d.source || '') === source && similarity(`${r.title || ''} ${r.summary || ''}`, `${d.title || ''} ${d.summary || ''}`) >= 0.6;
  });
  const duplicate = Boolean(similar);
  if (duplicate) uncertainties.push(uncertainty('duplicate_discovery', String(similar.fingerprint || similar.title || '')));

  const recentWindow = recent.filter((r) => within(r));
  const overLimit = recentWindow.length >= maxPerDay;
  if (overLimit) uncertainties.push(uncertainty('share_rate_limited', `${recentWindow.length}/${maxPerDay}`));

  const base = {
    ok: true, fingerprint, duplicate, similarTo: String(similar?.fingerprint || similar?.title || ''),
    needsConfirmation: false, sendAuthorized: false, risk: sensitivity >= 0.7 ? 'high' : sensitivity >= 0.35 ? 'medium' : 'low',
    uncertainties, diagnostics
  };

  if (user.allowAutonomousShare === false || user.doNotDisturb === true || user.shareEnabled === false) {
    return { ...base, decision: 'do_not_share', reason: 'user_opt_out' };
  }
  if (blockSource || blockTopic) return { ...base, decision: 'do_not_share', reason: blockSource ? 'blocked_source' : 'blocked_topic' };
  if (sensitivity >= 0.7) return { ...base, decision: 'do_not_share', reason: 'sensitive_content', risk: 'high' };
  if (duplicate) return { ...base, decision: 'record_only', reason: 'duplicate_discovery', needsConfirmation: false };
  if (overLimit) return { ...base, decision: 'save_for_later', reason: 'share_rate_limited' };
  if (conv.userAskingForHelp === true || conv.busy === true || ['continue', 'hold'].includes(String(conv.closureDecision))) {
    return { ...base, decision: 'save_for_later', reason: 'conversation_busy_or_active' };
  }
  if (reliability < 0.5) return { ...base, decision: 'record_only', reason: 'unreliable_source', risk: 'low' };
  if (relevance < 0.5 || value < 0.4) return { ...base, decision: 'record_only', reason: 'low_relevance_or_value' };
  if (relevance >= 0.6 && value >= 0.5) {
    return { ...base, decision: 'share_now', reason: 'high_relevance_value_reliable', needsConfirmation: false, sendAuthorized: false };
  }
  return { ...base, decision: 'save_for_later', reason: 'moderate_relevance' };
}

export default decideShare;
